---
name: verify
description: Run the slop desktop locally (relay + nextjs) and drive it headless with Playwright to verify UI changes end-to-end. Use when a change to packages/nextjs or packages/relay needs runtime verification before deploy.
---

# Verify a desktop change locally

Recipe worked 2026-07 (z-order fix). ~2 min once servers are up.

## Gotchas that cost time (read first)

- **The harness injects `PORT=8787` into your env.** Both `next dev` and
  the relay honor `PORT`, so without an explicit override they land on
  8787 and collide with clawd-harness / other sessions. ALWAYS set
  `PORT=` explicitly (e.g. next on 3210, relay on 8180).
- **`packages/nextjs/.env.local` points at PROD** (`live.slop.computer`).
  Never let a test client connect there — override
  `NEXT_PUBLIC_RELAY_URL` / `NEXT_PUBLIC_RELAY_HTTP_URL` in the shell
  (shell env beats .env.local in Next).
- Relay state is cwd-relative (`./.slop-data/...`) — run it from a
  scratch cwd so the repo checkout and other sessions stay clean.
  Wipe `<scratch>/.slop-data/rooms` between probe runs if a previous
  run left windows covering the desktop icons.
- Relay refuses to boot without `ALCHEMY_API_KEY` — reuse
  `NEXT_PUBLIC_ALCHEMY_API_KEY` from `packages/nextjs/.env.local`.
- CORS: relay default allows only :3000/:3001 — pass
  `CORS_ORIGINS=http://localhost:<next-port>`.

## Start the stack

```bash
SCRATCH=<scratchpad>/relaydata; mkdir -p $SCRATCH/.slop-data
# seed a known invite password BEFORE first auth call (file is read lazily)
printf 'probe-invite-pw' > $SCRATCH/.slop-data/invite_password.txt
AK=$(grep '^NEXT_PUBLIC_ALCHEMY_API_KEY=' packages/nextjs/.env.local | cut -d= -f2)
cd $SCRATCH && PORT=8180 ALCHEMY_API_KEY="$AK" CORS_ORIGINS="http://localhost:3210" \
  <repo>/packages/relay/node_modules/.bin/tsx <repo>/packages/relay/src/index.ts &

cd <repo>/packages/nextjs && PORT=3210 \
  NEXT_PUBLIC_RELAY_URL=ws://localhost:8180/signal \
  NEXT_PUBLIC_RELAY_HTTP_URL=http://localhost:8180 \
  NEXT_PUBLIC_BROWSER_HOST_URL= yarn dev &
```

Room URL: `http://localhost:3210/debug` — the `debug` slug is the
passwordless always-on sandbox (root `/` redirects to the marketing
site; other slugs need a room password).

## Drive it headless

Playwright-core + cached chromium live at
`/Users/clawd/clawd-harness/tools/node_modules` (symlink it as
`node_modules` next to your script — `NODE_PATH` doesn't work for ESM)
and `~/Library/Caches/ms-playwright/chromium_headless_shell-*`.

In the page, before any UI interaction:

```js
// skip the first-visit hint (it hides most desktop icons)
page.addInitScript(() => localStorage.setItem('slop-has-been-here-v1', '1'));
// auth: redeem invite, then anon session, then reload
await fetch('http://localhost:8180/auth/invite', { method:'POST', credentials:'include',
  headers:{'content-type':'application/json'}, body: JSON.stringify({ password:'probe-invite-pw' }) });
await fetch('http://localhost:8180/auth/anon', { method:'POST', credentials:'include' });
```

- Desktop icons: dblclick the label text (`Wallet`, `Chat`, `Bank`, …).
- Windows are `.slop-window` roots; z-order = computed `zIndex`; the
  private wallet's titlebar has class `slop-titlebar--private`.
- When clicking a titlebar, make sure it isn't covered by another
  window — `elementFromPoint` is the ground truth for "who's on top".

Working example probe (z-order assertions): the session scratchpad
pattern in git history of this skill's commit — `zprobe.mjs`.

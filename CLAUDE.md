# slop-computer-live — Claude notes

## "The stream looks like shit" — read this first

**`docs/STREAM-LOOKS-BAD.md`** is the symptom-keyed runbook and the entry
point for any complaint about how the show looks. It carries the whole
capture→broadcast chain (camera menu → Cam Link → OBS canvas → Virtual
Camera → getUserMedia → mesh → composite), the `/eq` reading table, the
**theories already ruled out with evidence** — prod load, clawd-gut, the
publish path, upscaling, low light — and the OBS-websocket recipe for
reading and changing the rig from here.

Two facts from that doc that get missed every single time: **the local
preview always looks perfect and proves nothing** (it never goes through
the mesh), and **the god-mode machine can only show what the interface
machine sends it** — so a bad-looking stream is almost never fixable on
the OBS box.

The sections below are the deep dives it links to.

## Broadcast video quality

If the show looked blocky, smeared or choppy, or you're touching
`applySenderCaps` / `preferEfficientVideoCodecs` in
`packages/nextjs/hooks/usePeerMesh.ts` or the capture constraints in
`useLocalMedia.ts`, read **`docs/VIDEO-QUALITY.md`** first. It has the
`degradationPreference` trap that has now caused one regression, the
rule that cameras are never pinned to `maintain-resolution`, and — most
importantly — the ffmpeg recipe for measuring per-feed framerate out of
the recording instead of arguing about a screenshot. `/eq`'s video
section (composite line first, then per-feed CPU/NET/TURN badges) is the
live version of the same read.

## A voice missing from the broadcast entirely

If someone was **absent** from the stream (not quiet — absent) while
music played fine, read **`docs/BROADCAST-AUDIO-ROUTING.md`** before
touching anything. Membership in the mix depends on the relay's
`pub.streamId` and the WebRTC MSID being the same string, joined by
exact match in `Desktop.tsx` `streamFor()` — when they disagree the
peer's window renders blank, the audio component never mounts, and
the voice vanishes with no error anywhere. There is a **confirmed**
MSID-drift bug after a mic/camera hot-swap (`replaceTrack` stores a new
`MediaStream` under the old key), and a still-**open** question about
what caused the 2026-08-07 outage. The doc has the one diagnostic
question to ask first, the repro, and why reloading god mode is not a
diagnostic. Don't re-derive this from static reading — it already
produced one confident-but-unproven answer.

## Broadcast audio leveling ("The Equalizer")

If a show's voices vs music sounded off (present but wrong level — for
*missing* sources see above), or you're touching
`packages/nextjs/utils/audioBus.ts`, read **`docs/AUDIO-LEVELING.md`**
first — it has the auto-leveler's tuning invariant
(`AUTO_GAIN_MAX = AUTO_TARGET_RMS / AUTO_NOISE_FLOOR`), the 2026-08-01
quiet-voices post-mortem, and the ffmpeg recipe for measuring levels
in the show recordings on the prod box instead of guessing.

## Deploying to production

**Always use `./ops/deploy.sh` from the repo root.** Do NOT ssh into
the prod box and run `yarn next:build` there — prod is RAM-constrained
(7.6G, originally no swap), and Next.js builds have OOM-killed the
whole instance into an unreachable hang in the past. The script avoids
this by building **locally**, then rsyncing the artifact.

### What the script does

1. **Pre-flight** — refuses to ship a dirty tree, non-`main` branch,
   or a local out of sync with `origin/main`. Commit + push first.
2. **Concurrency lock** at `/tmp/slop-deploy.lock` — a second deploy
   yields rather than racing. Two features can't fight over prod.
3. **Local build** of Next.js (~10s on a modern Mac) and relay.
   browser-host is **only** built when something in
   `packages/browser-host/src/` is newer than the existing
   `dist/index.js` — most deploys touch only Next.js or relay, and
   `tsc` is ~2s of pure waste otherwise. Force with
   `BROWSER_FORCE_BUILD=1 ./ops/deploy.sh` if you suspect local dist
   is out of sync with prod.
4. **Rsync** the new `.next/` to `.next.staging/` on prod using
   `--link-dest` (so unchanged files become free hardlinks — the
   transfer stays incremental) and `--exclude='cache/'` (webpack's
   incremental-build cache is hundreds of MB of pure waste on prod).
   Relay `dist/` rsyncs straight into place. browser-host `dist/`
   rsync is skipped on the same condition as the build above.
   Live keeps serving from the existing `.next/` during this.
5. **Atomic swap + restart** — stop slop-live, `mv .next .next.old`,
   `mv .next.staging .next`, start slop-live. HTTPS downtime is ~2s
   (just Node.js port-bind), measured by the script via curl polling.
   slop-relay restarts after. slop-browser-host restarts **only if
   the rsync above actually moved bytes** — the rsync runs in
   `--checksum --itemize-changes` mode and we look for non-no-change
   lines in its output. Using rsync's own opinion is more reliable
   than comparing mtimes on prod (tsc rewrites dist mtimes on every
   build, so an mtime check false-positives). Bouncing Chromium
   kills every active SharedBrowser tab, so this matters.
6. **Health check** — verifies `slop-live`, `slop-relay`, and
   `slop-browser-host` are `active` before exiting non-zero.

### When something goes wrong

- **"Working tree is dirty"** — commit or stash; the script won't
  ship uncommitted changes.
- **"Local main is not in sync with origin/main"** — push (or pull)
  first. The script wants the deployed commit to be on origin so it's
  reachable / rollbackable.
- **"Another deploy is running"** — wait for it. Only force-clear the
  lockfile (`rm /tmp/slop-deploy.lock`) if you're sure the other
  process is actually dead.
- **HTTP didn't recover after the swap** — `ssh slopcomputer`,
  `journalctl -u slop-live -n 50`. The swap leaves `.next.old`
  in place for a moment in case rollback is needed; check disk
  state under `packages/nextjs/` before retrying.

### Prod box facts (for context)

- SSH alias: `slopcomputer` (in `~/.ssh/config`, user `ubuntu`)
- Repo path: `/home/ubuntu/slop-computer-live`
- Services: `slop-live` (Next.js, :3000), `slop-relay` (:8080),
  `slop-browser-host` (Puppeteer/Chromium — heavy memory consumer)
- 4 GB swapfile at `/swapfile` (added after a prior OOM hang;
  persisted via `/etc/fstab`)
- Caddy fronts everything; HTTPS via Let's Encrypt

## Hand gestures ("the eye")

If gestures aren't drawing, someone says "the claw doesn't work", or you're
touching `packages/relay/src/gestures.ts`, `GestureLayer.tsx`, the 👁
button, or `/v1/hands` — read **`docs/GESTURES.md`** first. It has the full
pipeline (one detector on the god machine watches an effects-free ?fx=0
view of the room; the relay attributes hands to camera windows — guests
included, zero setup), the debugging handles (`/v1/hands` echoes eye
geometry; synthetic-hands recipe), and **three failed architectures with
the reasons they failed** — do not reintroduce per-room tokens, page→
localhost bridges, or per-user gesture senders without reading that
history. Show ritual: click 👁 in god mode. Kill switch: close that window.

## Making icons for new apps

**When you add a new app to the desktop, generate its icon BEFORE wiring
the app in.** Icon generation lives in this repo at
`packages/icon-gen/` — do not look elsewhere, do not generate via a
different tool, the style must stay consistent.

### One-shot icon for a new app

```bash
# from repo root:
yarn icon:add <kebab-name> "<prompt describing the subject>"
```

Example:

```bash
yarn icon:add paint "An artist's paint-palette icon with three paint blobs and a paintbrush sticking out."
```

This writes the result to:

- `packages/icon-gen/out/icons/<name>.png` (local cache, gitignored)
- `packages/nextjs/public/icons/<name>.png` (committed — served at `/icons/<name>.png`)

It also appends `{ name, prompt }` to `packages/icon-gen/icons.json` so
the batch regenerator stays in sync.

### Then register the app

In `packages/relay/src/index.ts`, add to `DEFAULT_APPS`:

```ts
{
  id: "<name>",
  label: "<Label>",
  icon: "/icons/<name>.png",
  kind: "<kind>",   // or `url: "..."` for a browser-style app
},
```

### Style guardrails

- The single style reference is `packages/icon-gen/style-ref.png`.
  Every icon is generated by an `images.edit` call that passes this ref,
  so the palette/stroke/lighting stay locked. **Don't regenerate the
  style ref** unless the user explicitly asks for a style refresh.
- Shared style hint lives in `packages/icon-gen/icons.json` under
  `styleHint`. Don't override it per-icon — keep prompts focused on
  _what_ the subject is, not the rendering style.
- Prompt subjects in the chunky Mac OS 9 / cyberdelic vocabulary:
  isometric 3/4, hot magenta + cyan + lime accents on deep purple, no
  text, no captions.
- Names are kebab-case (`[a-z0-9-]+`) and must match the `id` used in
  `DEFAULT_APPS`.

### Setup (only needed once per checkout)

`packages/icon-gen/.env` must contain `OPENAI_API_KEY=...`. If it's
missing, copy `.env.example` and paste a key (the user can grab one at
https://platform.openai.com/api-keys).

### Regenerating everything

`yarn icon:gen` reads `icons.json`, skips icons that already exist in
the local cache, and composites a sheet at
`packages/icon-gen/out/sheet.png` with a manifest. Use this if the
style ref ever changes and we need to rebuild the whole set.

## Privacy Wallet (Railgun / kohaku-cli)

The Privacy Wallet app is **custodial while funds are inside** (the box
holds the kohaku seed) — read `docs/PRIVACY-WALLET.md` before touching
`packages/relay/src/kohaku.ts` or its endpoints. Deploy notes: the relay
spawns an external **kohaku-cli checkout** (`KOHAKU_CLI_DIR`, run via
`npx tsx` — the packaged dist is broken); prod needs that checkout, the
`KOHAKU_*` env block, and the **pre-synced `rg-storage.json`** in the kohaku
data dir (cold Railgun sync needs archive RPC + ~hours; the seeded file
makes every later sync incremental). Feature degrades cleanly when
unconfigured (routes 503, UI says "not configured"), so shipping the code
without the box setup is safe.

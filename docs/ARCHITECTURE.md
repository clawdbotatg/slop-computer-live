# slop-computer-live architecture

A live, multi-user Mac OS 9 desktop where everyone can see and interact with
the same applications — webcam windows, screen shares, shared cursors, and a
**shared browser that impersonates an Ethereum address** so the dapp world
can be explored as anyone (currently `vitalik.eth`).

This file documents what's wired up today, top to bottom. Read this when you
want to add a new "app" to the desktop, debug why a peer can't see what
another peer sees, or move services to new infra.

---

## The three services

| Service | Repo path | Port | What it does |
|---------|-----------|------|--------------|
| Next.js frontend | `packages/nextjs/` | `3000` | The desktop UI. Renders windows, icons, cursors. Browser-side state. |
| Relay | `packages/relay/` | `8081` | Auth (SIWE + password), WS signaling for WebRTC, shared state (slots, cursors, browsers, publications), TURN credential issuer. **All shared-desktop state is here.** |
| Browser-host | `packages/browser-host/` | `8090` | A single headless Chromium process. One tab per shared-browser window. Streams JPEG frames to peers and forwards their input. Injects a fake `window.ethereum`. |

All three live on the same EC2 box. Caddy fronts them with auto-TLS:
- `live.slop.computer` → Next.js (`:3000`) + path-routes for legacy relay endpoints
- `relay.slop.computer` → relay (`:8081`)
- `browser.slop.computer` → browser-host (`:8090`)
- `media.slop.computer` → MediaMTX (`:8888`, HLS for the audience player)

---

## Data flow at a glance

```
┌──────────────────────┐                        ┌────────────────────────┐
│  Browser (peer)      │   wss /signal          │  Relay                 │
│  - mesh state        │ ─────────────────────► │  - in-memory:          │
│  - cursors           │ ◄───── broadcasts ──── │      peers, slots,     │
│  - SharedBrowser UI  │                        │      browsers,         │
│  - desktop icons     │                        │      publications      │
└──────┬───────────────┘                        │  - persisted to disk:  │
       │                                        │      slots.json,       │
       │  wss /stream/<id>                      │      browsers.json     │
       │                                        └────────────────────────┘
       ▼
┌──────────────────────┐    fetch reads
│  Browser-host        │ ──────────────────────► Alchemy RPC (eth_call,
│  - one Chromium      │                          eth_getBalance, …)
│  - one tab per id    │
│  - injects ethereum  │
│  - tx_request via    │
│      Runtime binding │
└──────────────────────┘
```

A single Chromium tab on the browser-host serves **all** peers viewing the
same browser id. They all see the same pixels, any of them can click, and
captured wallet calls are broadcast back to all of them via the same WS.

---

## Auth flow

1. User loads `live.slop.computer`. Frontend calls `GET /auth/me` on the
   relay; if there's a valid session cookie, the desktop renders.
2. Otherwise the JoinCard appears with three options:
   - **SIWE** — sign a SIWE message with a real wallet. Relay validates, sets a session cookie.
   - **Password** — guest mode with the per-show shared password and a chosen handle.
   - **Burner** — auto-generated key (the `0x34aA…` button), SIWE-signed without prompting. Useful for dev/demo.
3. Cookie is `httpOnly + sameSite=lax`, valid 24h.

The `/admin` capabilities (start/stop session, kick peers, control fanouts)
require both `role === "host"` **and** `address ∈ ADMIN_ADDRESSES`. SIWE alone
isn't enough.

The summary above is the happy-path. The **full** auth model — every
sign-in endpoint, the room-password gate, the two symmetric gates (WS
`/signal` and REST `v1AuthFromReq`), defense-in-depth boundaries, and
known caveats (passkey audience chat, debug-room openness) — is in
[`docs/AUTH.md`](./AUTH.md). Read that before touching any `/auth/*`
endpoint, the gates, or adding a new `?slug=` route. The deferred-work
roadmap lives at
[`ops/PLAN-auth-hardening.md`](../ops/PLAN-auth-hardening.md).

---

## Shared state model

The relay holds three kinds of shared state. **The relay is the source of
truth.** Frontend state is a mirror.

### Peers (`packages/relay/src/peers.ts`)

In-memory only. Cleared on disconnect. Each peer entry is
`{ id, role, address, handle, connectedAt, ws }`. The `id` is an ephemeral
8-byte hex generated per WS connection — reload = new id.

### Slots (`packages/relay/src/desktop.ts`)

Keyed by host wallet address (`PRIMARY_HOST_ADDR`, the first address in
`ADMIN_ADDRESSES`). Each entry is a `{ id, x, y, width, height, z }`. Slot
ids are stable strings:

| Slot id pattern | Used for |
|-----------------|----------|
| `owner-<addr-or-handle>-camera` | A peer's camera window |
| `owner-<addr-or-handle>-screen` | A peer's screen-share window |
| `owner-<addr-or-handle>-audio` | A peer's audio-only window |
| `browser-<browserId>` | A shared browser window |
| `icon-<name>` | A draggable desktop icon |

Persisted to `/var/lib/slop-relay/slots.json`. Anyone authenticated can write
any slot — last-write-wins. The relay broadcasts each update.

### Browsers (`packages/relay/src/browsers.ts`)

Same persistence pattern, persisted to `/var/lib/slop-relay/browsers.json`.
Each entry is a `{ id, url, openedBy, openedAt }`. Anyone can `browser_open`,
`browser_navigate`, or `browser_close`.

Browsers persist across page reloads and relay restarts; on `hello` the
relay sends the full list to a new subscriber.

### Publications (in-memory only)

Per-peer streams: `{ streamId, peerId, ownerKey, kind, label }`. Cleared
when the publishing peer disconnects (their tracks are gone too).

---

## WS protocol (relay `/signal`)

All payloads are JSON. The relay accepts:

| `type` | Fields | Effect |
|--------|--------|--------|
| `offer`/`answer`/`ice` | `to`, `payload` | Forwarded to the target peer for WebRTC handshake |
| `cursor` | `x`, `y` | Broadcast to all (throttled ~30 Hz) |
| `publish` | `streamId`, `kind`, `label` | Add publication, broadcast `published` |
| `unpublish` | `streamId` | Remove publication, broadcast `unpublished` |
| `slot_update` | `id`, `x`, `y`, `width`, `height`, `z` | Save and broadcast `slot` |
| `browser_open` | `id`, `url` | Save and broadcast `browser` |
| `browser_navigate` | `id`, `url` | Update and broadcast `browser` |
| `browser_close` | `id` | Delete and broadcast `browser_closed` |
| `tx_request` | `browserId`, `calldata`, `to`, `value`, `chainId` | Broadcast (peers without a host subscription still see calldata) |
| `ping` | — | Heartbeat |

The relay sends:

| `type` | Fields |
|--------|--------|
| `hello` | `id`, `peers`, `publications`, `slots`, `browsers` (initial snapshot) |
| `peer_join` / `peer_leave` | `peer` |
| `signal` | `from`, `kind` (offer/answer/ice), `payload` |
| `cursor` | `from`, `x`, `y` |
| `published` / `unpublished` | publication info |
| `slot` | merged slot |
| `browser` / `browser_closed` | browser info |
| `tx_request` | `from`, `browserId`, `calldata`, `to`, `value`, `chainId` |
| `pong` / `error` / `kicked` | — |

### Internal endpoint

`POST https://relay.slop.computer/internal/browser-tx` — used by the
browser-host (or any trusted insider) to broadcast captured tx calldata over
the relay. Authenticated by `Authorization: Bearer <BROWSER_HOST_INGRESS_SECRET>`.

---

## Shared browser deep dive

The whole point: dapps like Uniswap and Zerion run on a server-side Chrome,
streamed to every viewer's screen, with a fake wallet that says it's
vitalik.eth.

### Why server-side?

We tried client-side iframes first. Two showstoppers:
1. **`X-Frame-Options: DENY`** — most dapps refuse to be iframed.
2. **No way to inject `window.ethereum`** into a cross-origin iframe; the dapp
   sees the host browser's MetaMask, not our impersonator.

Running Chromium **on a server** sidesteps both. The dapp loads at its real
origin, our injected provider runs before the dapp's scripts, and we stream
pixels back instead of HTML.

### How the headless Chrome stays headless-ly invisible to Cloudflare

`puppeteer-extra-plugin-stealth` patches ~20 fingerprint vectors that
Cloudflare/Datadome/Akamai use to spot headless Chrome:

- `navigator.webdriver` returns `false` (default is `true` in headless mode)
- `navigator.plugins` populated with realistic Chrome plugins (was empty)
- `navigator.languages` populated (was `[]`)
- `chrome.runtime` exists with realistic shape
- `permissions.query()` returns realistic results
- WebGL vendor/renderer strings spoofed to a real GPU
- `navigator.userAgentData.brands` rewritten so the version doesn't say `HeadlessChrome`
- Hides `Function.toString()` mismatches from CDP-injected helpers
- ~12 more

Combined with `headless: true` (which is the **new** headless mode in
Puppeteer ≥22, a real Chrome with no UI rather than the old
`chrome-headless-shell` binary), Cloudflare can't distinguish us from a
desktop Chrome on the JS layer. Only TLS fingerprint and IP reputation are
left, and those don't typically score high enough alone to block us.

Result: Zerion, Uniswap, ENS, AAVE, etc. all load.

### Tab lifecycle

`packages/browser-host/src/index.ts`:

1. Frontend opens `wss://browser.slop.computer/stream/<id>?url=<initial>`.
2. Host looks up the tab by `id`. If it doesn't exist, **races are coalesced
   by `tabBoots: Map<id, Promise<Tab>>`** — concurrent subscribers all await
   the same launch.
3. `createTab(id, url)`:
   - `browser.newPage()` → fresh tab.
   - `evaluateOnNewDocument(PROVIDER_INJECT_SCRIPT)` — runs **before** the
     dapp's scripts. Defines `window.ethereum` and announces the EIP-6963
     wallet info.
   - `setRequestInterception(true)` — intercepts our injected provider's
     `fetch("/__slop_rpc", …)` calls and proxies them to Alchemy. Other
     requests are continued unmodified.
   - `cdp.send("Runtime.addBinding", { name: "__slopTxRequest" })` — exposes
     a global function the page can call to surface tx attempts.
   - `cdp.send("Page.startScreencast", …)` — JPEG frames at quality 60.
4. Each `Page.screencastFrame` event broadcasts `{ type: "frame", data }` to
   every WS subscriber for that id.
5. When the last subscriber leaves, a 30-second linger timer starts. If no
   reconnect arrives, the tab is destroyed.

### Why every browser stays alive simultaneously

By default Chromium pauses background tabs. Two things keep all tabs
streaming concurrently:

```
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
--disable-features=CalculateNativeWinOcclusion,IsolateOrigins,site-per-process
```

These tell Chrome to keep rendering even when no tab is "active." For
heavier multi-tab loads we'd switch to per-id `BrowserContext` instances
(each context has its own foreground state).

### Provider injection (`packages/browser-host/src/inject.ts`)

The injected `window.ethereum`:

| Method category | Behavior |
|-----------------|----------|
| **Local synthetic** (`eth_accounts`, `eth_requestAccounts`, `eth_chainId`, `wallet_*`) | Returns vitalik.eth (or whatever `IMPERSONATED_ADDRESS` is set to) and `0x1` (mainnet). |
| **Read** (`eth_call`, `eth_getBalance`, `eth_blockNumber`, etc.) | `fetch("/__slop_rpc", { method: "POST", body: JSON-RPC }) ` → intercepted by the host → forwarded to Alchemy → the dapp gets real on-chain data. |
| **Write** (`eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v*`) | Calls `globalThis.__slopTxRequest(JSON.stringify(payload))` — the CDP runtime binding fires `Runtime.bindingCalled` on the host, which broadcasts the captured calldata. Then throws `code 4001 ("user rejected")` so the dapp surfaces the rejection cleanly. **Nothing is signed.** |

EIP-6963 announcement: We dispatch `eip6963:announceProvider` so modern
dapps with the new wallet-discovery API see "Slop Impersonator" in the
wallet picker. We also re-announce on `eip6963:requestProvider`.

### Streaming protocol (`/stream/<id>`)

Client → host:

| `type` | Fields |
|--------|--------|
| `navigate` | `url` |
| `mouse` | `event` (`down`/`up`/`move`), `x`, `y`, `button` |
| `wheel` | `x`, `y`, `deltaX`, `deltaY` |
| `key` | `event` (`down`/`up`/`char`), `key`, `code`, `text`, `modifiers` |
| `ping` | — |

Host → client:

| `type` | Fields |
|--------|--------|
| `hello` | `id`, `url` (initial state) |
| `frame` | `data` (base64 JPEG), `sessionId` |
| `url` | `url` (in-page navigation happened) |
| `tx_request` | `method`, `params` (captured wallet call) |
| `pong` / `error` | — |

### Frontend rendering (`packages/nextjs/components/desktop/SharedBrowser.tsx`)

- The frame is painted onto an `<img>` with `object-fit: contain` so the
  server's 1280×800 viewport is letterboxed into whatever shape the user
  resizes the window to. Click coordinates are scaled into the actual image
  rect; clicks landing in the letterbox bars are dropped.
- URL bar value is local draft state; "Go" sends `mesh.navigateBrowser(id, url)`
  which updates the relay, broadcasts to peers, and on each peer's
  `browser` mesh event we send `navigate` over the host WS so the headless
  tab follows.
- Tx panel shows `txRequests` from the mesh **and** any `tx_request` events
  that arrive directly over the host WS, deduped on `(calldata, to)`.

---

## Desktop icons (`packages/nextjs/components/desktop/DesktopIcon.tsx`)

A `<DesktopIcon iconSrc label x y onMove onDoubleClick />` is just a draggable
`react-rnd` wrapping an `<img>` + label. The position is stored in the
**slot system** with id `icon-<name>` so it persists per host and syncs to
every peer.

The drag-vs-double-click ambiguity is handled with a `dragMovedRef`: any
`onDrag` event with non-zero delta sets the ref, which suppresses the
following `onDoubleClick`. Without this, accidental drags during a
double-click would fire `spawnBrowser()`.

To add a new icon:

1. Drop the PNG in `packages/nextjs/public/icons/<name>.png`.
2. In `app/page.tsx`, add another `<DesktopIcon>` with:
   - a unique slot id (`icon-mail`, `icon-terminal`, etc.)
   - `x`/`y` defaults somewhere that doesn't overlap
   - `onDoubleClick={() => doSomething()}`

Gate it on `mesh.bootstrapped` (same pattern as the Browser icon) so the
position doesn't flash from default to persisted on reload.

---

## Pixel-flow latency budget

For a typical session (one viewer, broadband):

```
Server tab visual change                          ~0 ms
CDP screencast frame emit                       ~16 ms
JPEG encode (Q60, 1280×800)                     ~10 ms
WS broadcast on EC2 LAN                          ~1 ms
Internet hop EC2 → user                       ~30-80 ms
Browser decode JPEG + paint                     ~10 ms
                                              ────────
                                              ~70-120 ms end-to-end
```

Acceptable for pointing-and-clicking. For a real swap-on-Uniswap demo it
feels responsive. Latency goes up with multiple subscribers because the
host serializes JPEG broadcasts; the right next step is to encode H.264 and
WebRTC out, but JPEG-over-WS gets us shipped today.

---

## Deploying / updating

The whole stack lives on a single Ubuntu EC2 box (current IP `3.208.137.255`,
SSH alias `maxextract`). systemd units in `deploy/`:

- `slop-live.service` → Next.js
- `slop-relay.service` → Relay
- `slop-browser-host.service` → Browser-host

To deploy a change:

```bash
ssh maxextract
cd ~/slop-computer-live
git pull
yarn install
yarn next:build && yarn relay:build && yarn browser:build
sudo systemctl restart slop-live slop-relay slop-browser-host
```

Caddyfile lives at `/etc/caddy/Caddyfile`. Always `sudo caddy validate`
before `sudo systemctl reload caddy`.

Env files (not in git):

- `packages/nextjs/.env.local` — `NEXT_PUBLIC_*` vars (baked at build time)
- `packages/relay/.env` — relay secrets, admin addrs, TURN, Alchemy
- `packages/browser-host/.env` — same Alchemy key, CORS allowlist, viewport

---

## Common gotchas

- **`NEXT_PUBLIC_*` is baked at build time.** Changing the env doesn't take
  effect until you re-run `yarn next:build` AND restart `slop-live`.
- **Restart `slop-relay` after pulling.** New WS message types are no-ops on
  the old binary; symptom is "feature works in-memory but doesn't survive
  reload" because the relay never persisted it.
- **Cloudflare scoring is not stable.** A dapp that loads today might 403
  next week if Cloudflare ratchets up. The fix order is stealth-plugin →
  rebrowser-puppeteer → real Chrome on Xvfb → residential proxy.
- **`object-fit: contain` is mandatory** on the SharedBrowser frame img.
  `fill` stretches; `cover` clips. Click coordinates would be wrong with
  either.
- **The browser-host's CORS allowlist must include the frontend origin.**
  Default in `.env.example` is `https://live.slop.computer`. If you serve
  from a different host, add it.

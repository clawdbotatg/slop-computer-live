# slop-computer-live

The live, interactive desktop at **live.slop.computer**. A Mac OS 9-style virtual computer where the host and guests appear as draggable webcam/screen-share windows with shared cursors. The whole desktop is captured by OBS and broadcast as the show.

## Vision

When you visit `live.slop.computer` while the podcast is on air, you see a Mac OS 9-themed desktop:
- The host's webcam in a window
- Each guest's webcam in their own window
- Optional screen-share windows from anyone connected
- Shared cursors — every connected participant has a labelled cursor visible to all others on the desktop
- Wallet Connect (Scaffold-ETH 2) so onchain interactions can happen *on stream*

The host runs OBS pointed at this page (browser source) and pushes RTMP to a self-hosted MediaMTX instance, which fans out as HLS to anyone watching at `slop.computer` — and to YouTube, Twitter, etc. via OBS Multi-RTMP (keys never leave the host's machine).

## Architecture

```
  Host (Austin)
  +-----------------------------+                       +------------------------------+
  | live.slop.computer/admin    |                       |  EC2 box (slop infra)        |
  |  - SIWE                     |                       |                              |
  |  - webcam + screen-share    |  WebSocket signal +   |  +------------------------+  |
  |  - Go Live -> mainnet tx    |  WebRTC offer/answer  |  |  Caddy (auto-TLS)      |  |
  |  - OBS captures THIS page   |---------------------->|  +--+---------------+-----+  |
  +----------+------------------+                       |     |               |        |
             | RTMP push                                |  +--v-----+   +-----v----+   |
             v                                          |  | relay  |   | mediamtx |   |
                                                        |  | (Node) |   | RTMP->   |   |
  Guests                                                |  | -siwe  |   |  HLS     |   |
  +-----------------------------+                       |  | -pwd   |   +-----+----+   |
  | live.slop.computer?invite=  |                       |  | -sigs  |         |        |
  |  - password OR SIWE         | <- WebSocket signal ->|  | -cursor|         |        |
  |  - webcam + screen-share    | <- WebRTC peers (mesh)|  |  fanout|         |        |
  +-----------------------------+                       |  +--------+         |        |
                                                        +----------------------+--------+
  Audience                                                                    | HLS
  +-----------------------------+                                             |
  | slop.computer  +            | <-- HLS  -----------------------------------+
  | live.slop.computer/         |
  +-----------------------------+
```

**Topology:** Guests are mesh-WebRTC'd to the host (small N, no SFU needed for v1). Host's browser composites all incoming streams into the visible desktop. OBS captures host's browser as a Browser Source and pushes RTMP to MediaMTX. Audience watches HLS — read-only, ~2s latency. Cursor positions piggy-back on the relay WebSocket and are rendered in everyone's connected browser; they aren't part of the HLS stream until OBS captures them.

## Auth

| Role             | Method                                          | Capabilities                                                                          |
|------------------|-------------------------------------------------|---------------------------------------------------------------------------------------|
| Host             | SIWE (allowlist: `ADMIN_ADDRESSES`)             | `/admin`, start/stop session, place windows, control cursors, call `goLive()` on contract |
| Guest (wallet)   | SIWE                                            | join with cam/screen, has labelled cursor (ENS or address)                            |
| Guest (no wallet)| shared `GUEST_PASSWORD` from invite link        | same as wallet guest, cursor labelled with chosen handle                              |
| Audience         | none                                            | read-only HLS player                                                                  |

The host can always SIWE in. The password path exists so a non-crypto guest can still come on the show — that's a hard requirement. Hybrid by design.

## Stack

| Layer            | Choice                                                                          |
|------------------|---------------------------------------------------------------------------------|
| Frontend         | Next.js App Router (NOT static — runs on the EC2 box behind Caddy)              |
| Wallet           | RainbowKit + wagmi + SIWE                                                       |
| Window manager   | `react-rnd` for drag/resize (simpler than Classicy for v1)                      |
| Cursor sync      | WebSocket via relay; throttled ~30 Hz                                           |
| Signaling        | WebSocket via relay; message types: `offer`, `answer`, `ice`, `join`, `leave`, `cursor`, `window` |
| Media in (guest) | WebRTC peer connections (mesh, host-centric)                                    |
| Media out        | OBS browser-source -> RTMP -> MediaMTX -> HLS/LL-HLS                            |
| Contracts        | Reads/writes the same `SlopComputerFrontpage.sol` deployed by the frontpage repo (mainnet) |

## Routes

- `/` — landing for visitors who arrived without an invite. Shows "the show is live now" or "next show TBA" + an audience HLS player when live.
- `/admin` — SIWE-gated host dashboard. Webcam preview, "Go Live" button (sends mainnet tx + starts MediaMTX session), invite-link generator, list of connected guests.
- `/join?invite=<token>` — guest entry. Choose: SIWE OR password. After auth, picks cam/mic/screen and lands on the desktop.
- `/desktop` — the actual live page. Same view for host and guests; audience sees an HLS rendering instead of the live composite.

## Server (`packages/relay/`)

Single Node service. Runs on the EC2 box behind Caddy. Endpoints:
- `POST /auth/siwe` — verify SIWE, return signed cookie
- `POST /auth/password` — verify `GUEST_PASSWORD`, return cookie
- `WS /signal` — WebRTC offer/answer/ice + cursor positions + window state
- `POST /admin/start` — host-only; creates an HLS session in MediaMTX, returns RTMP ingress URL + stream key for the host to paste into OBS
- `POST /admin/stop` — host-only

State is in-memory (single-box deployment). No database for v1.

## EC2 infrastructure

Single instance (suggested: `t3.medium`, us-east-1). Austin gives Claude Code SSH access. Claude Code will:
1. Install Node, MediaMTX, Caddy
2. Configure Caddy with auto-HTTPS for `live.slop.computer` and `media.slop.computer`
3. Reverse-proxy `live.slop.computer` -> Next.js (port 3000) and `live.slop.computer/signal` -> relay (port 8080)
4. Reverse-proxy `media.slop.computer` -> MediaMTX HLS (port 8888); MediaMTX listens for RTMP on 1935
5. Set up `systemd` services for relay and Next.js; MediaMTX runs as its own service
6. Set up a deploy hook: `git pull && yarn install && yarn build && systemctl restart slop-live` so we can push-to-deploy

DNS: `live.slop.computer` and `media.slop.computer` A-records -> EC2 elastic IP.

No docker-compose for v1 — services run directly under systemd. Forks are free to wrap in docker-compose if they prefer.

## Recording (deferred)

Out of scope for v1. The MediaMTX RTMP destination + the host's restream targets (YouTube, Twitter, Twitch via OBS Multi-RTMP) handle recording centrally. Decentralising the recording (server-side capture -> IPFS pin -> `addEpisode` tx) is the next step after v1 ships.

## Design

See DESIGN.md. The desktop chrome IS the design — windows have classic Mac titlebars, close/minimize/zoom boxes, 1px bevels. Same system as the frontpage so the two URLs feel like one product.

## Build phases

### Phase 0 — Repo scaffold *(this commit)*
- [x] PLAN.md, README.md, LICENSE, DESIGN.md, .gitignore
- [x] GitHub repo: `clawdbotatg/slop-computer-live`

### Phase 1 — SE2 scaffold + design system
- [ ] `npx create-eth@latest`
- [ ] Implement DESIGN.md as a CSS module + 6 base components: `<Window>`, `<TitleBar>`, `<Button>`, `<TextField>`, `<Bevel>`, `<MenuBar>`
- [ ] Copy the same 6 components into the frontpage repo so both surfaces match (no shared package — keeps each repo independently forkable)

### Phase 2 — Desktop shell (no networking)
- [ ] `react-rnd` window manager
- [ ] Hardcoded windows for host + 2 placeholder guests
- [ ] Local mouse -> desktop coordinate system
- [ ] Menu bar with system clock + Connect Wallet

### Phase 3 — Auth + relay
- [ ] Relay service: SIWE + password auth, cookie sessions
- [ ] Invite-link generation in `/admin`
- [ ] `/join?invite=` flow
- [ ] Reference `clawd-conclave/packages/relay/` for SIWE patterns

### Phase 4 — WebRTC guest streams
- [ ] Signaling over WebSocket (extend the relay)
- [ ] Mesh WebRTC: each guest opens a peer connection to host
- [ ] Host's incoming streams render into a draggable `<Window>` per guest
- [ ] Screen-share is a separate stream -> its own window
- [ ] Reference `clawd-computer/packages/signaling/` for the existing signaling pattern

### Phase 5 — Shared cursors
- [ ] Cursor positions broadcast at ~30 Hz over the same WebSocket
- [ ] Smooth interpolation client-side
- [ ] Each cursor labelled with handle / ENS / shortened address

### Phase 6 — Broadcast pipeline
- [ ] MediaMTX deployed on EC2
- [ ] Caddy routes `media.slop.computer` -> MediaMTX HLS
- [ ] Host's "Go Live" -> relay creates session, returns RTMP ingress URL
- [ ] OBS pushes the host's browser as RTMP
- [ ] Audience HLS player on `/` plays MediaMTX output
- [ ] Frontpage embeds same HLS source when `isLive` is true

### Phase 7 — Onchain go-live signal
- [ ] "Go Live" button calls `SlopComputerFrontpage.goLive(title, hlsUrl)` on mainnet
- [ ] Frontpage picks up the change within ~12s
- [ ] "Stop" calls `goOffline()`

### Phase 8 — Polish
- [ ] Window snap-to-grid
- [ ] Persistent desktop layout (saved per host wallet on the relay)
- [ ] Mobile-friendly audience view (read-only; the desktop is desktop-only)
- [ ] OBS Multi-RTMP doc for restreaming to YouTube/X (keys never leave host's machine)

## Env

```
# Public
NEXT_PUBLIC_ALCHEMY_API_KEY
NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID
NEXT_PUBLIC_FRONTPAGE_ADDRESS
NEXT_PUBLIC_RELAY_URL=wss://live.slop.computer/signal
NEXT_PUBLIC_HLS_URL=https://media.slop.computer/hls/live/index.m3u8

# Server-only
ADMIN_ADDRESSES=                 # comma-separated; host's wallet
GUEST_PASSWORD=                  # rotated per show
SIWE_SESSION_SECRET
MEDIAMTX_RTMP_INGRESS_URL=rtmp://media.slop.computer/live
MEDIAMTX_ADMIN_API=http://localhost:9997
```

No public RPCs ever. Per CLAUDE.md, mainnet calls go through Alchemy.

## Reference

Existing prototypes in `~/clawd/`:
- `clawd-computer/` — Mac OS 9 desktop shell, SIWE, draggable windows, signaling package. Port the WebRTC + window-manager patterns; do not adopt the Classicy library (overkill for v1 — use react-rnd).
- `clawd-conclave/` — relay service, MediaMTX config, Caddy setup, RTMP ingress pattern. Port the relay shape and infra docs.
- `clawd-computer-frontpage/` — for the contract pattern (frontpage repo handles this).

# Per-room live.slop.computer

Design doc for splitting `live.slop.computer` into independent rooms at
`live.slop.computer/<slug>`, persistent across restarts, gated by a per-room
password + an identity sign-in (SIWE or passkey), with a hot/cold lifecycle so
inactive rooms don't consume server resources.

Status: **Phases 1–7 shipped.** Phase 8 (x402/EIP-8004/Base contract)
deferred until the contract lands; everything else is in place and
builds clean. See "Implementation phases" below for a per-phase
status line.

---

## Goals

- `live.slop.computer/ep0` and `live.slop.computer/ep1` are independent rooms.
  Cursors, chess games, todos, files, browser tabs, music, chat, wallet — all
  isolated.
- A handful of feeds are *shared* across all rooms: ticker, gas, headlines,
  news digest, polymarket, twitter timeline, glossary. These are world-state,
  not room-state, and polling them per-room would waste API quota.
- Rooms persist forever on disk. You can come back to `/ep0` a week later
  and the chess game, wallet, files, chat history are all there.
- Each room has a password. Anyone with the password can enter. Once inside,
  the user signs in with Ethereum (SIWE) or a passkey to establish identity.
- Identity is *not* automatic multisig signer status. The multisig is an
  optional ritual artifact created during an episode; its signer set is
  curated by the host and can include people not in the room.
- Inactive rooms hibernate to disk. Reviving a cold room costs an on-chain
  fee (x402 / 8004 on Base — eventual; stubbed in dev).

---

## Slug = room identity

The slug comes from the `SlopComputer` contract via `slop-computer-frontpage`
— see `types/episode.ts:slugify` in that repo. Format is the same as the
contract's on-chain validation: `^[a-z0-9-]{1,64}$`.

The live relay **does not** read the contract. It trusts the slug it gets at
WS handshake / HTTP path. The frontend (which already talks to the contract)
is responsible for handing valid slugs to the relay. The relay does enforce
the regex on the slug locally — partly for consistency, partly because the
slug ends up in a filesystem path (`.slop-data/rooms/${slug}/`) and we need
to reject `../` traversal.

The default route `/` resolves to `liveEpisode.slug` from the contract (the
current canonical room). If there is no live episode, redirect to a
configured fallback slug.

---

## State model

### Global (one poller per process, fans out to every hot room)

These all poll external APIs on a cadence. Running them N times for N rooms
wastes calls and risks rate limits, so they run once at the process level and
broadcast into every active room.

- `ticker` (crypto + AI stocks + private valuations + $CLAWD)
- `gas`
- `headlines`
- `news-digest`
- `polymarket`
- `timeline` (twitter)
- `glossary`

### Per-room (isolated state, persisted to disk)

Everything else. Each becomes a member of a `Room` instance, replacing the
current module-level singletons in `relay/src/index.ts`.

- `peers` / cursors
- `chess` (game + history + AI players)
- `todos`
- `notes`
- `files` (desktop FS)
- `music` (genre + custom tracks + clock state)
- `clock`
- `browser` (with tab-id namespacing — see below)
- `chat`
- `slot`
- `ai-mover` (per-room because it hooks the per-room chess broadcast cycle)
- `wallet` (current multisig + history + tx queue)
- `skill` endpoints (the docs text is global, but the URLs it advertises are
  all room-scoped: `${BASE}/v1/${slug}/chat`, etc.)

### Code shape

```ts
class Room {
  readonly id: string; // slug
  peers = new Map<string, Peer>();
  chess = newChessGame();
  todos: TodoItem[] = [];
  wallet = newWalletState();
  browser = newBrowserState();
  // ...one field per per-room subsystem
  paidUntil: number = 0;
  lastSeenAt: number = Date.now();

  broadcast(msg: unknown, exceptId?: string): void {
    for (const [id, peer] of this.peers) {
      if (id === exceptId) continue;
      send(peer.ws, msg);
    }
  }
}

const rooms = new Map<string, Room>();

// Globals call into every hot room:
onTickerUpdate(state => {
  for (const r of rooms.values()) r.broadcast({ type: "ticker", state });
});
```

---

## Persistence

One directory per room. JSON-per-subsystem follows the pattern already in
`relay/src/wallet.ts` — atomic writes via tempfile + rename, one file per
concern so a corrupted `chat.json` doesn't take down the wallet.

```
.slop-data/
  rooms/
    ep0/
      room.json         # slug, name, passwordHash, createdAt, lastSeenAt, paidUntil
      wallet.json       # current multisig + history + tx queue
      chat.json         # last N messages
      todos.json
      notes.json
      files.json        # file index — blobs live on IPFS as ipfs:// CIDs (see Decisions)
      chess.json        # game + history
      music.json        # genre + custom tracks
      browser.json      # tab metadata (live CDP state stays in browser-host)
```

In-memory `Room` state is the source of truth while the room is hot; flush
on mutation. When hibernating, do one final flush, then drop the in-memory
slice. On revive, read every file back into a fresh `Room`.

Bounded data only (chat capped at N, todos/notes are short strings, file
*index* is small). Any actual blob bigger than plain text (uploaded
images/audio/archives) goes to BGIPFS at upload time; the room's
`files.json` stores only `{ name, cid, size, mime, addedBy, addedAt }`.
See the IPFS decision below.

---

## Auth

Two independent gates, two independent cookies.

### Gate 1 — password (room access)

- Host creates the room with `POST /v1/rooms { slug, password }`. Relay
  writes `room.json` with `passwordHash` (bcrypt or scrypt — both built-in
  via node `crypto`, no new dep). Refuses to create without a password.
- User hits `/ep0`. Frontend checks for a room cookie; if absent, prompts
  for password. `POST /v1/rooms/ep0/auth` → verify hash → set
  HMAC-signed cookie. **The cookie payload includes the slug**, so a cookie
  for `ep0` cannot be replayed at `ep1`.
- Cookie TTL is long (months). Re-prompting defeats "click in and see
  everything." Cookie is **not** cleared by sign-out — switching wallets
  shouldn't make you re-enter the room password.

### Gate 2 — identity (SIWE or passkey)

- With a valid room cookie, the frontend prompts for SIWE or passkey.
- SIWE: client signs `Sign in to ep0 — nonce=…`; relay verifies signature
  and recovers the address.
- Passkey: WebAuthn create-on-first-visit or get-on-return. Library handles
  the cryptographic verification.
- Either way, relay attaches the address (lowercased 0x…) to the peer
  record on the next WS connect. This becomes the peer's identity for chat
  attribution, cursor label, presence.
- **Identity ≠ multisig signer.** Signing in does not add you to the room's
  multisig. The multisig is a separate ritual.
- Identity cookie has its own TTL (long). Sign-out clears *this* cookie
  only; the room password cookie stays.

### Cookie summary

| Cookie         | Scope          | Cleared by sign-out? |
| -------------- | -------------- | -------------------- |
| `room_${slug}` | one room       | no                   |
| `identity`     | global         | yes                  |

---

## Hot / cold lifecycle

Rooms accumulate over time. Most will be inactive most of the time. The
lifecycle solves both resource consumption and the future monetization
hook.

### States

- **Hot**: entry exists in `rooms` Map. Accepting WS connections, receiving
  ticker broadcasts, in-memory state is authoritative (flushed to disk on
  mutation).
- **Cold**: files exist in `.slop-data/rooms/${slug}/`, no in-memory slice.
  WS connect attempt returns `HTTP 402 Payment Required` with x402-shaped
  payment requirements.

### Transitions

- **Hibernate** (hot → cold): triggered when (a) the room has been idle for
  N hours (no peers connected + no mutations in window) and (b) `paidUntil <
  now`. Flush all subsystem state to JSON, remove the entry from `rooms`.
- **Revive** (cold → hot): a client hits the WS endpoint, gets 402, pays
  via x402 against the Base contract, retries with payment proof. Relay
  verifies on-chain (via Alchemy Base RPC — per global rule, no public
  RPCs), updates `paidUntil`, reads files into a fresh `Room`, accepts the
  connection.

### Cost model

Subscription, not pay-per-revive. Reviving every visit would punish
returning visitors. `$X keeps slug Y hot for N days` is the right shape —
`paidUntil` in `room.json` is the canonical state, set by a verified
payment receipt.

### Fee mechanism (eventual)

Smart contract on Base. x402 for the HTTP payment dance; 8004 for agent
identity / attestation. Until that ships:

```ts
function verifyPaid(slug: string, proof: unknown): boolean {
  if (process.env.PAYMENTS_DISABLED === "1") return true; // dev mode
  if (HOST_WHITELIST.includes(slug)) return true;        // ops escape hatch
  return false; // gate everything else until contract ships
}
```

The rest of the system doesn't care how `verifyPaid` decides — only that it
returns a boolean. When the contract ships, replace the body; nothing else
moves.

---

## Browser-host

`packages/browser-host` runs **one** Puppeteer/Chromium process and today
maintains a single global `tabs: Map<string, Tab>` keyed by browser-id
(see `src/index.ts`). For multi-room we keep the one-Chromium-per-process
model — the prod box is 7.6 GB and Chromium is already the heavy memory
consumer — but we change *how tabs are partitioned inside it*.

### RAM budget

Light tabs ~50–150 MB, heavy ones (X, YouTube, etc.) ~300–500 MB. After
Node + relay + Next.js + base Chromium overhead, the prod box has roughly
5 GB available for page objects. That's ~15–25 mixed tabs in flight at
once. Three concurrent live rooms with a couple tabs each is well within
budget; the design just needs to prevent any single room from grabbing
all of it.

### One `BrowserContext` per room — not just tab-id namespacing

Tab-id prefixing alone has a **privacy bug**: one Chromium with multiple
unrelated tabs hits a single shared cookie jar. If `ep1` logs into Twitter
in its browser app, `ep2` opening twitter.com sees `ep1`'s session. Bad.

Fix: each room gets its own Puppeteer `BrowserContext` (incognito-style
isolated context — separate cookies, localStorage, IndexedDB). Same
Chromium process, negligible RAM cost beyond the page objects themselves.
Tabs live inside a context; closing the context closes all its tabs at
once, which is also useful for room hibernation.

```ts
type RoomBrowser = {
  slug: string;
  context: BrowserContext;      // isolated cookies / storage
  tabs: Map<string, Tab>;        // tab-id space scoped to this room
  lastActivity: number;
};
const roomBrowsers = new Map<string, RoomBrowser>();
```

WS endpoint becomes `/stream/${slug}/${tabId}`. Lookup is
`roomBrowsers.get(slug)?.tabs.get(tabId)`. No `${slug}:` prefix on the tab
id itself — the namespacing happens via the outer map.

### Tab limits

Today there is **no cap** on tab count. With multiple rooms, that's a
liability — one busy room could starve every other.

- **Per-room cap**: 5 tabs. Trying to open a 6th rejects with a clear
  error. (Number is a guess; tune with telemetry.)
- **Process-wide cap**: 30 tabs as a backstop. Even within per-room
  limits, N rooms × M tabs compound; a hard cap lets the host reject the
  *next* new tab rather than getting OOM-killed mid-screencast.

### Idle policy

The existing 30s linger after the last WS subscriber drops
(`TAB_LINGER_MS` in `src/index.ts:527`) covers the "user closed the app"
case. The gap is **subscriber attached but no human input** — someone in
the room with the browser app open but the tab just sitting there.

Layered timers:

- **30 min no input** → soft pause: show an overlay ("Tab idle — click to
  resume"), pause the CDP screencast to save CPU. Cheap to keep alive.
- **2 h no input** → destroy the tab. Persist last URL to `browser.json`
  so reopening is a one-click resume.

"No input" = no keyboard / mouse / scroll events arriving via the
`mcp__claude-in-chrome__computer`-style input pipeline that the relay
already proxies into browser-host. The watchdog mechanism for wedged tabs
(silent screencast for 6s+, see `src/index.ts:543`) is unrelated — keep
it as-is.

### Room hibernation interaction

When a room hibernates (no peers, idle), the relay closes its
`BrowserContext`. All that room's tabs vanish from Chromium in one call.
On revive, the relay reads `browser.json`, creates a fresh
`BrowserContext`, and lazily re-opens tabs as users click them. We do
**not** auto-reopen every tab — that'd spike RAM on revive for no UX win.

### Why this isn't a major rewrite

The existing `tabs` Map becomes one Map per RoomBrowser; the lifecycle
code (`createTab`, `destroyTab`, the watchdog, the screencast pipeline)
is mostly unchanged — it just operates on a Tab fetched via the nested
lookup instead of the flat global Map. The genuinely new code is:

1. `BrowserContext` creation/teardown tied to room lifecycle.
2. WS route parsing the `(slug, tabId)` tuple.
3. Tab-count enforcement (per-room + global).
4. Input-idle timers.

Probably a couple days of work, not a rewrite. Worth doing in Phase 2 of
the implementation plan so the rest of the room work has a clean browser
substrate to build on.

---

## Implementation phases

Each phase is independently shippable and leaves the system working.

1. ✅ **Per-room state in memory.** 15 subsystem classes (chess, wallet,
   chat, transcript, todos, notes, files, browsers, desktop, music,
   jamendo, clock, episode, windows, ai-mover) on a `Room` class. Peers
   per-room; cross-room shim in `peers.ts`. Global feeds (ticker, news,
   etc.) fan out via `broadcastToAllRooms`. Legacy file fallback so the
   `main` room inherits pre-Phase-1 prod data.
2. ✅ **Browser-host BrowserContext per room.** One Chromium, one
   `BrowserContext` per room (cookie/storage isolation). Per-room tab
   cap (5), process cap (30). Input-idle policy: soft pause at 30 min,
   destroy at 2 h. `POST /admin/rooms/:slug/close` for hibernation.
3. ✅ **Frontend routing.** `app/[slug]/page.tsx` dynamic route;
   `RoomSlugContext` provider; `usePeerMesh` + `SharedBrowser` send slug
   to relay + browser-host. Root `/` redirects to `/main`.
4. ✅ **Per-room JSON persistence.** `.slop-data/rooms/${slug}/` layout
   in place from Phase 1. Atomic writes via `fs-atomic.ts` (tempfile +
   rename, applied to all 13 persist sites). BGIPFS pinning for file
   blobs: every upload is pinned in the background, `FileEntry.cid`
   records the result, `GET /files/:id` 302-redirects to the gateway
   when CID is present. Local storage stays as fallback.
5. ✅ **Password gate.** `RoomAuth` (scrypt hashes in `auth.json`);
   HMAC-signed slug-scoped cookies (`slop_room_<slug>`); endpoints:
   `POST /v1/rooms` (host claim), `POST /v1/rooms/:slug/password`
   (rotate), `POST /v1/rooms/:slug/auth` (verify), `GET …/auth`
   (status). WS handshake enforces the cookie. Frontend `PasswordGate`
   is slug-aware with legacy-invite fallback. Admin page has a "Create
   a room" form.
6. ✅ **Identity gate.** Existing SIWE + passkey infra in
   `siwe.ts`/`passkey.ts`/`sessions.ts` is the identity layer.
   `POST /auth/logout` clears the session cookie only (room cookie
   stays per user's design). `useSession.signOut()` + `MenuBar` wire
   the button.
7. ✅ **Hot/cold lifecycle.** `RoomMeta` persists `paidUntil` +
   `lastSeenAt`. Lifecycle tick (5 min) hibernates rooms idle past
   `IDLE_HIBERNATE_MS` (3 d default) when unpaid and unpeered.
   `hibernateRoom()` drops the in-memory slice and POSTs
   browser-host's `/admin/rooms/:slug/close`. WS handshake gates on
   payment; `POST /v1/rooms/:slug/revive` with `verifyPaid` stub
   (`PAYMENTS_DISABLED=1` for dev, `HOST_WHITELIST` for always-on
   rooms, otherwise rejects until Phase 8 ships).
8. ⏳ **x402 / EIP-8004 / Base contract integration.** Deferred. Swap
   the body of `verifyPaid()` in `relay/src/index.ts` to read the
   SlopComputer payment contract via Alchemy Base RPC. Nothing else
   needs to change.

Phases 1–3 unlock multi-room. Phases 4–6 unlock persistence + privacy.
Phase 7 is the lifecycle. Phase 8 is the billing.

---

## Decisions

- **EIP-8004 (agent identity).** Confirmed as the eventual mechanism for
  agents authenticating to paid rooms. **Deferred** — pick up once the
  rest of the system is working end-to-end. Nothing in phases 1–7 needs
  to know about it; phase 8 (`verifyPaid` integration) is where it lands.
- **Hibernate idle threshold.** Start with **a few days** (say 3 d) as
  the default. The right value depends on (a) how much state would be
  lost on cold→hot revive — answer: nothing, persistence is full — and
  (b) revive latency, which is just "read N JSON files + open a
  BrowserContext." So idle can be aggressive without UX cost. Tune later
  with telemetry.
- **Subscription price / duration.** Lives in the Base contract, not the
  relay. Relay only reads `paidUntil`. Defer pricing decisions to whoever
  writes the contract.
- **Admin UI for room creation.** Use the existing `app/admin/` page for
  now: small form taking `{ slug, password, optional name }`, gated by
  host signature. Will scale into a richer UI (room list, paidUntil
  display, manual revive, password rotation) as load grows. Not blocking
  the refactor.
- **File blob storage — IPFS via BGIPFS.** Anything bigger than plain
  text (uploads, images, audio, archives) gets pushed to the BuidlGuidl
  IPFS cluster on upload and the room's `files.json` stores only the
  reference: `{ name, cid, size, mime, addedBy, addedAt }`. Small inline
  text (todo items, notes, chat) stays in its own JSON file as today.
  Two nice consequences:
  - **Hibernation moves zero bytes of blob data** — blobs are already
    content-addressed and externally pinned; only the index JSON travels
    with the room.
  - **Future NFT-ization is much easier** — every file in the room is
    already a `ipfs://CID` reference, so a manifest of the room's state
    is trivially mintable.
  Gateway: `https://media.slop.computer/ipfs/<cid>` (already used by
  `slop-computer-frontpage`).
- **GC of cold rooms — never.** Rooms are valuable artifacts and may
  eventually become NFTs you really don't want to lose. If disk pressure
  ever forces the question, the move is to push the room's JSON state
  itself into IPFS and keep only a CID locally — not delete. Worry about
  it then.

// Skill file generators.
//
// The skill file is a markdown doc handed to a BYO-AI agent so it
// can drive the slop-computer desktop via the /v1 REST API. As we
// added apps the single file grew past the point where you'd want
// it always in an agent's context — so it's now split into a small
// top-level INDEX and per-app SUB-SKILLS. The agent reads the index
// once, then GETs whichever sub-skill it actually needs before
// acting on that surface.
//
// Each generator is a pure function of (token, isHost). Both the
// index and sub-skills embed `Authorization: Bearer <token>` examples
// so an agent can copy-paste a curl line and have it work.

const BASE = "https://relay.slop.computer";

/** Banner shared across every doc — auth reminder + how to fetch
 *  related sub-skills. Cheap to include everywhere so an agent who
 *  only loads one sub-skill still has the basics. */
function header(token: string, scope: string, hostOnlyNote: string): string {
  return `# slop-computer-live agent

You are an agent participating in a live multi-user desktop session at
\`live.slop.computer\`. Authenticate every call with:

\`\`\`
Authorization: Bearer ${token}
\`\`\`

Token is yours, scoped \`${scope}\`, valid 7 days.${hostOnlyNote}`;
}

/** Topic list for the index page + the router. Order matters — this
 *  is how they're listed in the directory. */
export const SKILL_TOPICS = [
  "chess",
  "music",
  "browser",
  "windows",
  "slots",
  "apps",
  "todo",
  "notes",
  "gas",
  "avatars",
  "files",
] as const;
export type SkillTopic = (typeof SKILL_TOPICS)[number];

export function isSkillTopic(s: string): s is SkillTopic {
  return (SKILL_TOPICS as readonly string[]).includes(s);
}

// =============================================================================
// Index — short orientation + directory
// =============================================================================

export function skillIndex(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  const hostNote = isHost
    ? ""
    : "\n\n> ⚠ Some sub-skills (apps catalog) require **host** scope. Yours is **peer** — those endpoints return 403.";

  return `${header(token, scope, hostNote)}

## Quick start (the 30-second loop)

1. \`GET ${BASE}/v1/state\` → snapshot of everything on the desktop
   right now. Returns \`you\` (your identity), \`peers\` (other humans +
   agents online), and every app's current state inline.
2. Pick what to react to. Each app has a sub-skill at
   \`${BASE}/v1/skill/<topic>\` (see the directory below). Fetch the
   sub-skill ONCE and cache it.
3. Use the sub-skill's long-poll or SSE wait (chess, music, chat) to
   block server-side until something changes — **never \`sleep()\` in
   your own loop**. The wait IS your sleep.
4. Mutate via the documented POST/DELETE endpoints. Every mutation
   broadcasts to every peer in real time; nothing is local-to-you.

Host names — every path below works against either of these:
- \`${BASE}\` — direct relay
- \`https://live.slop.computer\` — Caddy proxies \`/v1/*\`, \`/music/*\`,
  \`/files/*\`, \`/avatars/*\`, \`/signal\`, \`/auth/*\` to the relay
Pick whichever; results are identical. The skill examples all use
\`${BASE}\` for explicitness.

## Core endpoints — always available

### State snapshot

\`\`\`
GET ${BASE}/v1/state
\`\`\`

Returns the canonical desktop snapshot. Top-level fields:

| Field | Shape | What it is |
| --- | --- | --- |
| \`you\` | \`{ address, handle, role, isHost, ownerKey }\` | Your identity. \`ownerKey\` = lowercased address ?? handle |
| \`peers\` | \`Peer[]\` | Live WS peers (real humans + other agents) |
| \`publications\` | \`Publication[]\` | Active camera/screen/mic streams — read-only for agents (you can see who's sharing, can't publish yourself) |
| \`slots\` | \`Record<id, {x,y,width,height,z}>\` | Every window/icon's position |
| \`browsers\` | \`Record<id, Browser>\` | Open shared browsers |
| \`apps\` | \`AppEntry[]\` | Desktop icon catalog |
| \`avatars\` | \`Record<ownerKey, url>\` | Uploaded PFPs |
| \`hiddenAvatars\` | \`ownerKey[]\` | Owners that opted out of any PFP |
| \`openWindowIds\` | \`string[]\` | Singleton windows currently open |
| \`musicState\` | \`MusicState \\| null\` | SLOPAMP head |
| \`chessGame\` | \`ChessGame \\| null\` | Active chess game |
| \`chessHistory\` | \`ChessResult[]\` | Finished games |
| \`aiPlayers\` | \`AIPlayer[]\` | Server-side chess opponents |
| \`todos\` | \`TodoItem[]\` | Shared todo list |
| \`notes\` | \`Note[]\` | Shared notes |
| \`gasState\` | \`GasState \\| null\` | Latest Ethereum gas snapshot |
| \`files\` | \`FileEntry[]\` | User-uploaded files on the shared desktop |

Don't poll \`/v1/state\` faster than 1 Hz. For fast reactions to a
specific app (e.g. "wake me when it's my chess turn"), use that
app's long-poll or SSE endpoint documented in its sub-skill.

### Agent token (bootstrap)

\`\`\`
GET ${BASE}/v1/agent-token
# → { token, expiresAt, scope: "host" | "peer",
#     identity: { address, handle, role } }
\`\`\`

Mints a new bearer token tied to the calling session (cookie or
existing bearer). 7-day expiry. Hand the returned \`token\` to your
agent and use it as \`Authorization: Bearer <token>\` for every
subsequent call. Hosts mint host-scoped tokens; peer sessions mint
peer-scoped tokens.

### Agent presence

\`\`\`
POST ${BASE}/v1/cursor   { "x": 800, "y": 400 }   # show a labelled cursor
POST ${BASE}/v1/click    { "x": 800, "y": 400 }   # colored ripple
\`\`\`

Cursor positions persist on every peer's screen and are labelled
with your identity. Click ripples render in your blockie's palette.
Use these to "be present" — point at things, react. Cursor cap:
< 30 msgs/sec.

### Chat

\`\`\`
POST ${BASE}/v1/chat        { "text": "gm everyone" }
GET  ${BASE}/v1/chat                              # last 200 messages
GET  ${BASE}/v1/chat/stream                       # SSE stream
\`\`\`

Visible to live desktop users AND to spectators on slop.computer.
500 chars per message, ~1/sec soft rate limit. Bearer-token posts
are tagged \`source: "agent"\`.

### Icons (asset paths)

\`\`\`
GET ${BASE}/v1/icons       # → { icons: [{ name, url }] }
\`\`\`

List of icon PNGs available to use as \`apps[].icon\` paths.

## Sub-skills — fetch BEFORE acting on the relevant app

The desktop has app-specific surfaces (chess, music, browsers, etc).
Each has its own focused doc. **Read the sub-skill before submitting
moves / state changes for that app** — the surfaces have validation
rules and recommended loops that aren't repeated here.

| App | Get the sub-skill |
| --- | --- |
| **Chess** (multiplayer game + AI opponents) | \`GET ${BASE}/v1/skill/chess\` |
| **Music** (shared SLOPAMP player) | \`GET ${BASE}/v1/skill/music\` |
| **Browser** (shared iframes + impersonator + tx) | \`GET ${BASE}/v1/skill/browser\` |
| **Windows** (open/close singleton apps) | \`GET ${BASE}/v1/skill/windows\` |
| **Slots** (move/resize windows) | \`GET ${BASE}/v1/skill/slots\` |
| **Apps catalog** (add/remove desktop icons, host-only) | \`GET ${BASE}/v1/skill/apps\` |
| **Todo** (shared todo list — add/toggle/edit/reorder) | \`GET ${BASE}/v1/skill/todo\` |
| **Notes** (shared free-form notes) | \`GET ${BASE}/v1/skill/notes\` |
| **Gas** (Ethereum gas tracker, read-only) | \`GET ${BASE}/v1/skill/gas\` |
| **Avatars** (your PFP — upload / hide / clear) | \`GET ${BASE}/v1/skill/avatars\` |
| **Files** (drag-and-drop desktop files — upload / download / delete) | \`GET ${BASE}/v1/skill/files\` |

Each sub-skill is small (< 100 lines). Cache them; only re-fetch on
unexpected 4xx from an endpoint they documented.

## Conventions

- 200/2xx = success. 400 = bad input. 401 = bad/expired token.
  403 = host-only or "not your turn" / "illegal move" (chess).
  404 = id doesn't exist. 409 = state conflict (e.g. game already
  active). 500 = relay misconfig.
- Mutations broadcast to live WS peers in real time — everyone sees
  your change. There is no undo. Be intentional.
- Cursor coords are viewport pixels at the host's resolution
  (~1440×900 typical). Stay inside the screen.
- The WS at \`wss://relay.slop.computer/signal\` is out of scope for
  this skill — sub-skills use REST + long-poll / SSE instead.
`;
}

// =============================================================================
// Chess
// =============================================================================

export function skillChess(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Chess sub-skill

Server-authoritative singleton chess game. The relay validates every
move via chess.js — agents can't fake legal moves. Players are
identified by **ownerKey** = lowercased wallet address ?? lowercased
handle. The relay also hosts server-side AI players (see below); pick
one as the opponent and the relay plays for them.

### Read state

\`\`\`
GET ${BASE}/v1/chess
# → {
#     version: 17,                      # bumps on every state change
#     game: { whiteKey, blackKey, fen, moves, status, ... } | null,
#     toMove: "white" | "black" | null,
#     yourTurn: true | false,           # derived from your bearer token
#     history: [ { winner, status, ... }, ... ]
#   }
\`\`\`

### Long-poll the next change

\`\`\`
GET ${BASE}/v1/chess/wait?since=<version>&timeout=25
\`\`\`

Returns immediately if \`chessStateVersion > since\`. Otherwise blocks
up to \`timeout\` seconds (default 25, max 60) waiting for the next
create / move / resign / abort, then returns the same shape as
\`/v1/chess\`. **This is the right wait — see the autonomous play
loop below.**

### Start a game

\`\`\`
POST ${BASE}/v1/chess/create {
  "whiteKey": "0x123...",
  "blackKey": "ai:venice-uncensored",
  "whiteLabel": "vitalik.eth",
  "blackLabel": "Venice"
}
\`\`\`

The chess slot is a singleton — fails with 409 if a game is already
active. Use \`POST /v1/chess/close\` to abort an active game (any peer
can do this — see Stop conditions). Available AI \`ownerKey\` values
are listed in \`GET /v1/state\`'s \`aiPlayers\` array; they all start
with \`ai:\`.

### Submit a move

\`\`\`
POST ${BASE}/v1/chess/move { "from": "e2", "to": "e4" }
# pawn promotion → include "promotion": "q" | "r" | "b" | "n"
\`\`\`

Server checks: it's an active game, your session's ownerKey ==
side-to-move's ownerKey, the move is legal per chess.js. On success
it broadcasts the new state. 403 = not your turn or illegal move;
409 = no active game; 400 = bad input.

### Resign / abort

\`\`\`
POST ${BASE}/v1/chess/resign     # your side resigns; records a loss
POST ${BASE}/v1/chess/close      # wipes the slot. Active game → abort
                                 # (no result recorded). Finished game →
                                 # makes room for a new one.
\`\`\`

### Autonomous play loop

**TIGHT LOOP. NO SLEEP. Use the long-poll endpoint as your only wait.**

The pattern is:

1. \`GET /v1/chess/wait?since=<v>&timeout=25\` blocks on the server
   side until the position actually changes (or 25s elapses). It
   returns ~instantly when the opponent moves.
2. If the response says \`yourTurn: true\`, think, then
   \`POST /v1/chess/move\`. Then immediately go to step 1 with the new
   \`version\`.
3. If \`yourTurn: false\` or the wait timed out, just go to step 1
   again. **Don't sleep, don't back off, don't add jitter.**

The long-poll handles the wait for you. Sleeping between calls adds
latency without saving anything — the wait is already free. The
right behavior is move → poll → move → poll, where \`poll\` blocks
inside the relay until there's actually news.

Stop conditions: \`game.status != "active"\` (resigned, checkmate,
draw, abort), or \`game === null\` (lobby cleared by someone). On a
\`403 illegal_move\` (the position changed under you mid-think),
re-read \`/v1/chess\` and replan from the fresh \`version\`.

Drop-in bash recipe:

\`\`\`bash
me=$(curl -s -H "Authorization: Bearer ${token}" ${BASE}/v1/state | jq -r '.you.ownerKey')

state=$(curl -s -H "Authorization: Bearer ${token}" ${BASE}/v1/chess)
version=$(echo "$state" | jq -r '.version')

while true; do
  resp=$(curl -s -H "Authorization: Bearer ${token}" \\
    "${BASE}/v1/chess/wait?since=$version&timeout=25")
  version=$(echo "$resp" | jq -r '.version')
  status=$(echo "$resp" | jq -r '.game.status // "none"')
  yourTurn=$(echo "$resp" | jq -r '.yourTurn')

  if [ "$status" != "active" ]; then break; fi          # game over
  if [ "$yourTurn" != "true" ]; then continue; fi       # opponent's turn

  curl -s -X POST -H "Authorization: Bearer ${token}" \\
    -H "content-type: application/json" \\
    ${BASE}/v1/chess/move -d '{"from":"e2","to":"e4"}'
done
\`\`\`

**Common mistake to avoid:** wrapping the \`/v1/chess/wait\` call in
a \`sleep 60\` (or any sleep). That defeats the whole point of
long-poll — the wait IS your sleep.
`;
}

// =============================================================================
// Music
// =============================================================================

export function skillMusic(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Music sub-skill (slopamp)

Playback is one shared snapshot — track src + index, playing/paused,
position-at-timestamp, and master volume. Anyone can mutate it; all
peers' \`<audio>\` elements re-sync. Per-peer mute is local-only and
isn't exposed here (mute is "I don't want to hear it", not a global
decision).

### Read state

\`\`\`
GET ${BASE}/v1/music
# → {
#     state: { src, index, playing, position, at, volume } | null,
#     version: 42  # bumps on every state change
#   }
\`\`\`

### Long-poll the next change (DJ loop)

\`\`\`
GET ${BASE}/v1/music/wait?since=<version>&timeout=25
\`\`\`

Returns immediately if \`musicStateVersion > since\`. Otherwise blocks
up to \`timeout\` seconds (default 25, max 60) waiting for the next
change (set / play / pause / volume / track-swap), then returns the
same shape as \`/v1/music\`.

**Use this as the agent DJ loop's only wait.** Don't \`sleep()\` — the
long-poll already blocks server-side until something happens. The
pattern:

1. \`GET /v1/music/wait?since=<v>\` blocks until any peer changes
   the snapshot, OR for \`timeout\` seconds (whichever comes first).
2. On wake, check the new state:
   - If \`state.playing\` and the current track is about to end
     (\`state.position + (Date.now() - state.at)/1000 >= duration\`),
     pick the next track and POST a fresh snapshot.
   - Otherwise, just re-enter step 1 with the new \`version\`.

Track duration isn't in the playlist metadata. Options when you need
it: HEAD the MP3 to get \`content-length\`, fetch the first few KB to
parse the ID3v2 \`TLEN\` frame, or maintain your own duration map keyed
by \`src\`. Adding a \`duration\` field to playlist.json (see "Add a
track" below) is the cheap fix if you control the catalog.

### Playlist

\`\`\`
GET ${BASE}/v1/music/playlist
# → { tracks: [{ title, artist, src, license?, source? }, ...],
#     _credit: "..." }
\`\`\`

The relay reads this from disk on every request (no cache —
\`/var/lib/slop-relay/music/playlist.json\` on the prod box). Auth-
gated. Also exposed un-authed at \`${BASE}/music/playlist.json\` for
the in-browser player.

Each track's \`src\` is a root-relative path like \`/music/foo.mp3\`,
served by the relay (or proxied through live.slop.computer's Caddy
at \`/music/*\`). Set state with this exact \`src\` value — the audio
element resolves the absolute URL itself.

### How to add a track

No runtime upload endpoint (intentional — bulk audio belongs out of
the request path). To add music:

1. SCP the MP3 to the prod box: \`scp foo.mp3 box:/var/lib/slop-relay/music/\`
2. Edit \`/var/lib/slop-relay/music/playlist.json\` on the box to
   append an entry: \`{"title": "Foo", "artist": "Bar", "src": "/music/foo.mp3"}\`
3. No restart needed — the relay reads playlist.json on every request.

### Set state

\`\`\`
POST ${BASE}/v1/music/state {
  "src": "/music/cyborg-ninja.mp3",
  "index": 0,
  "playing": true,
  "position": 0,
  "at": 1730000000000,
  "volume": 0.7
}
\`\`\`

**Always set \`src\` and \`index\` together** — they're both stored,
but nothing on the server enforces \`src === playlist[index].src\`.
The window UI shows \`index\` as the "currently playing" highlight,
while \`<audio>\` plays \`src\`. Sending one without the other is the
fast path to a desynced UI.

Useful patterns:
- **Pause** — repost the same snapshot with \`playing: false\`.
- **Skip to next** — bump \`index\`, set the matching \`src\`, set
  \`position: 0\`, set \`playing: true\`.
- **Volume change** — keep all the other fields the same, change
  \`volume\` (range \`0..1\`, server clamps).
- **\`at\`** — should be roughly \`Date.now()\` when you build the
  snapshot. Peers compute the live head as
  \`position + (Date.now() - at) / 1000\` while playing. Omitting
  \`at\` defaults to "now" on the server.

Response also echoes the new \`version\` so a DJ loop can chain
straight into \`/v1/music/wait?since=<new-version>\`.
`;
}

// =============================================================================
// Browser
// =============================================================================

export function skillBrowser(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Browser sub-skill

The desktop hosts shared browser windows — iframes whose URL is
synchronized across every peer. The headless Chrome backing them
auto-impersonates \`vitalik.eth\`, so any dapp the iframe loads sees a
funded wallet. Captured \`eth_sendTransaction\` payloads land in every
peer's tx panel so the audience can see what dapps are trying to do.

### Open / navigate / close

\`\`\`
POST   ${BASE}/v1/browsers                 { "url": "https://app.ens.domains" }
POST   ${BASE}/v1/browsers/:id/navigate    { "url": "https://uniswap.org" }
DELETE ${BASE}/v1/browsers/:id
\`\`\`

\`POST /v1/browsers\` accepts an optional \`id\`; if omitted, the relay
generates a stable one (\`browser-<hex>\`) and returns it. The
response includes the full browser entity:

\`\`\`json
{ "ok": true, "browser": { "id": "browser-abc123", "url": "...",
                          "openedBy": "agent", "openedAt": 1730000000 } }
\`\`\`

### Move / resize the browser window

Use the slots sub-skill — browser window position is just a slot
keyed \`browser-<id>\`. See \`GET /v1/skill/slots\`.

### Reading what's open

\`GET /v1/state\` includes \`browsers\` keyed by id.

### Tx capture

When the iframe's dapp triggers \`eth_sendTransaction\`, the
browser-host posts the captured calldata to the relay and it
broadcasts to every peer. There's no \`/v1\` endpoint to read past
captures right now — they're realtime-only via WS. If you need
this, ask the host.

### ENS contenthash resolution

\`\`\`
GET ${BASE}/v1/ens/resolve?name=clawdbotatg.eth
# → { ok: true, name, protocol: "ipfs"|"ipns"|"swarm",
#     value, gateway: "https://<cid>.ipfs.community.bgipfs.com/" }
# → { ok: false, error: "no-contenthash" | ... }
\`\`\`

Resolves an ENS name's contenthash record directly via Alchemy and
decodes it (IPFS CIDv0/CIDv1, IPNS, Swarm) into a ready-to-load
gateway URL on \`community.bgipfs.com\` (subdomain-style, origin-
isolated; Swarm falls back to \`api.gateway.ethswarm.org\` path-style).
No \`eth.link\` / \`eth.limo\` indirection. Cached on the relay for
10 minutes. CIDv0 multihashes are auto-upgraded to CIDv1 base32 so
the result is always a DNS-safe subdomain label.

The slop-computer browser URL bar uses this transparently: typing
\`foo.eth\` (or \`foo.eth/some/path\`) auto-resolves before navigation.
Agents can hit the endpoint directly when they want to point a shared
browser at a \`.eth\` site without manually constructing IPFS URLs.

No auth required — read-only public lookup.
`;
}

// =============================================================================
// Singleton windows
// =============================================================================

export function skillWindows(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Windows sub-skill

The desktop has "singleton" apps whose visibility is shared across
all peers. Anyone can open or close them; everyone sees the change.
Distinct from browsers (which are multi-instance, one shared entity
per id) and publications (camera, mic, screen — one per peer).

### Open / close

\`\`\`
POST   ${BASE}/v1/windows         { "id": "chess" }   # opens for all
DELETE ${BASE}/v1/windows/chess                       # closes for all
\`\`\`

Known ids and their interactive surfaces:

| id | What it is | Agent interaction |
| --- | --- | --- |
| \`chat\` | Shared chat panel | \`POST /v1/chat\` (see index) |
| \`music\` | SLOPAMP player | \`GET /v1/skill/music\` |
| \`chess\` | Chess game | \`GET /v1/skill/chess\` |
| \`todo\` | Shared todo list | \`GET /v1/skill/todo\` |
| \`notes\` | Shared notes | \`GET /v1/skill/notes\` |
| \`gas\` | Gas tracker | \`GET /v1/skill/gas\` (read-only) |
| \`qr\` | QR generator | **per-peer local state** — opening shows the window for everyone but the input text + center logo are private to each viewer. No agent mutate surface. |
| \`clock\` | Clock + timer + countdown | **per-peer local state** — no agent mutate surface. Each viewer has their own selected timezone, running stopwatch, and countdown. |

The corresponding apps must exist in the catalog (\`GET /v1/state\`'s
\`apps\` array, matched by \`kind\`); use \`GET /v1/skill/apps\` to add
new ones (host-only).

### Reading what's open

\`GET /v1/state\` includes \`openWindowIds: string[]\`.

### Position

Each open window has a slot keyed \`app-<id>\` (e.g. \`app-chess\`).
Use the slots sub-skill to move / resize. See
\`GET /v1/skill/slots\`.

### Minimize / restore

Windows minimize to a 200×36 "pill" at the bottom of the viewport.
Minimize state isn't a separate field — it's encoded in the slot
geometry. If a slot's \`height\` is 36 and the window is open, that
window is currently minimized. Restore by writing a normal-size
slot back (or by hitting the slot with any reasonable size).
`;
}

// =============================================================================
// Slots (window positions)
// =============================================================================

export function skillSlots(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Slots sub-skill

Window positions on the desktop are stored as "slots" — shared
across every peer, persistent across reloads. Moving a window moves
it for everyone.

### Update a slot

\`\`\`
POST ${BASE}/v1/slots
{ "id": "browser-abc123", "x": 200, "y": 80, "width": 800, "height": 610 }
\`\`\`

You can omit any of \`x\`, \`y\`, \`width\`, \`height\`, \`z\` and the
existing value is preserved. Pass all four when creating a new slot
or you risk the merge falling back to generic defaults.

### Slot id conventions

| Pattern | What it positions |
| --- | --- |
| \`icon-<appId>\` | Desktop icon for app \`appId\` (e.g. \`icon-chess\`) |
| \`app-<appId>\` | Singleton app window (chess, music, chat) |
| \`browser-<hex>\` | A specific shared browser window |
| \`file-<hex>\` | A user-uploaded desktop file icon (see Files sub-skill) |
| \`owner-<addr>-camera\` | Someone's camera publication window |
| \`owner-<addr>-screen\` | Someone's screen-share window |
| \`owner-<addr>-audio\` | Someone's audio publication window |

### Reading

\`GET /v1/state\` returns \`slots: Record<id, {x,y,width,height,z}>\`.

### Recipes

Tile two browser windows side-by-side:

\`\`\`bash
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  ${BASE}/v1/slots -d '{"id":"browser-abc","x":40,"y":80,"width":600,"height":600}'
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  ${BASE}/v1/slots -d '{"id":"browser-def","x":660,"y":80,"width":600,"height":600}'
\`\`\`
`;
}

// =============================================================================
// Apps catalog (host-only)
// =============================================================================

export function skillApps(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  const hostNote = isHost ? "" : "\n\n> ⚠ These endpoints are **host-only**. Your scope is **peer** — they return 403.";
  return `${header(token, scope, hostNote)}

## Apps catalog sub-skill (host-only)

The set of desktop icons users see on \`live.slop.computer\` is a
JSON catalog on the relay. Host can add/remove entries; new page
loads pick them up.

### Read the catalog

\`\`\`
GET ${BASE}/v1/apps        # or read \`apps\` from /v1/state
\`\`\`

### Add (or update) an app

\`\`\`
POST ${BASE}/v1/apps {
  "id":    "ens",
  "label": "ENS",
  "icon":  "/icons/ens.png",
  "url":   "https://app.ens.domains"
}
\`\`\`

The optional \`kind\` field selects what the icon spawns when
double-clicked. Without it, the icon opens a shared browser to
\`url\`. With \`kind\` set:

| \`kind\` | What double-click does |
| --- | --- |
| omitted / \`"browser"\` | shared iframe at \`url\` |
| \`"chat"\` | opens the chat singleton window |
| \`"music"\` | opens the slopamp singleton window |
| \`"chess"\` | opens the chess singleton window |
| \`"audio"\` | opens the audio share dialog (peer-only) |
| \`"video"\` | opens the camera share dialog (peer-only) |
| \`"screen"\` | starts a screen-share (peer-only) |
| \`"qr"\` | opens the QR generator (per-user content, shared window) |
| \`"todo"\` | opens the shared todo list |
| \`"notes"\` | opens the shared notes app |
| \`"gas"\` | opens the Ethereum gas tracker |
| \`"clock"\` | opens the clock + countdown timer (local per-user) |

### Delete an app

\`\`\`
DELETE ${BASE}/v1/apps/:id
\`\`\`

### Adding a new icon image

\`GET ${BASE}/v1/icons\` lists available PNGs. To add a new icon
image, drop it in \`packages/nextjs/public/icons/\` in the repo and
redeploy — there's no runtime upload endpoint.
`;
}

// =============================================================================
// Todo
// =============================================================================

export function skillTodo(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Todo sub-skill

Shared todo list. All peers see the same items; anyone (humans or
agents) can add, toggle, edit, delete, reorder, or clear-done. The
relay persists the list as JSON on disk (\`/var/lib/slop-relay/todos.json\`),
capped at 200 items / 500 chars per item.

### Read

\`\`\`
GET ${BASE}/v1/todos
# → { items: [{ id, ts, address, handle, text, done }, ...] }
\`\`\`

Also embedded in \`GET /v1/state\` under \`todos\`.

### Add an item

\`\`\`
POST ${BASE}/v1/todos { "text": "buy milk" }
# → { ok: true, item: { id, ts, address, handle, text, done } }
\`\`\`

### Toggle done

\`\`\`
POST ${BASE}/v1/todos/:id/toggle
\`\`\`

### Update text

\`\`\`
POST ${BASE}/v1/todos/:id { "text": "buy oat milk" }
\`\`\`

### Delete

\`\`\`
DELETE ${BASE}/v1/todos/:id
\`\`\`

### Clear all completed items

\`\`\`
POST ${BASE}/v1/todos/clear-done
\`\`\`

### Reorder

\`\`\`
POST ${BASE}/v1/todos/reorder { "ids": ["abc", "def", "ghi", ...] }
\`\`\`

Pass the full id list in the desired order. Unknown ids are ignored;
ids you leave out are appended at the end (defensive against a race
with concurrent adds). The order broadcast is what every peer renders.
`;
}

// =============================================================================
// Notes
// =============================================================================

export function skillNotes(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Notes sub-skill

Shared free-form notes. All peers see all notes; anyone can create /
edit / delete any note. Persisted as JSON on disk
(\`/var/lib/slop-relay/notes.json\`), capped at 200 notes / 10k chars
per note.

The first line of a note's text doubles as its title in the sidebar.
No separate title field — keep the first line short and put body
underneath.

### Read

\`\`\`
GET ${BASE}/v1/notes
# → { items: [{ id, createdTs, updatedTs, address, handle, text }, ...] }
\`\`\`

Also embedded in \`GET /v1/state\` under \`notes\`.

### Create

\`\`\`
POST ${BASE}/v1/notes { "text": "Title line\\nBody body body" }
# → { ok: true, note: { id, createdTs, updatedTs, ..., text } }
\`\`\`

Empty text is allowed (creates a blank note).

### Update text

\`\`\`
POST ${BASE}/v1/notes/:id { "text": "new full body" }
\`\`\`

This replaces the entire note text; there's no append / patch endpoint.
\`updatedTs\` is bumped server-side.

### Delete

\`\`\`
DELETE ${BASE}/v1/notes/:id
\`\`\`
`;
}

// =============================================================================
// Gas
// =============================================================================

export function skillGas(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Gas sub-skill (read-only)

Ethereum gas tracker. The relay polls Alchemy
(\`eth_feeHistory\`, 5 blocks, 10/50/90th-percentile priority fees) and
the Chainlink mainnet ETH/USD oracle every ~12s and exposes the latest
snapshot. There's no mutate surface — agents read this to decide when
to broadcast a "gas is low" note or to size out a hypothetical tx
cost.

### Read

\`\`\`
GET ${BASE}/v1/gas
# → { state: { baseFeeGwei, slowGwei, mediumGwei, fastGwei,
#              ethUsd, updatedAt } | null }
\`\`\`

\`updatedAt\` is ms epoch. Snapshot may be \`null\` for ~12s after the
relay restarts (first poll hasn't landed yet).

\`slowGwei\` / \`mediumGwei\` / \`fastGwei\` already include the next
block's predicted base fee — they're the all-in gwei prices, not just
priority tips. So a 21k-gas ETH send at "medium" costs:

\`\`\`
mediumGwei × 21000 × 1e-9 × ethUsd  (USD)
\`\`\`

Also embedded in \`GET /v1/state\` under \`gasState\`.
`;
}

// =============================================================================
// Avatars
// =============================================================================

export function skillAvatars(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Avatars sub-skill

Each user has an optional PFP keyed by their \`ownerKey\` (lowercased
address ?? lowercased handle). The PFP appears on cursors, the audio-
publication window, and anywhere else the desktop renders identity.
Agents have ownerKeys too and can manage their own PFP.

Three states for any owner:

1. **Has an uploaded image** — \`avatars[ownerKey]\` is the URL.
2. **Explicitly hidden** — \`ownerKey\` is in \`hiddenAvatars\`. The
   client skips the ENS-avatar fallback for this user.
3. **No upload, no hide** — \`avatars[ownerKey]\` is absent. The client
   falls back to the wallet's ENS avatar record if any.

### Read

\`\`\`
GET ${BASE}/v1/state    # → state.avatars, state.hiddenAvatars
\`\`\`

\`state.avatars\` is \`{ "0xaddr...": "https://relay.../avatars/0xaddr.jpg", ... }\`.
\`state.hiddenAvatars\` is the list of owner keys that have opted out.

### Upload (your own PFP only)

\`\`\`
POST ${BASE}/v1/avatars
Content-Type: image/jpeg | image/png | image/webp
Body: raw image bytes (max ~5 MB)
# → { ok: true, url, key }
\`\`\`

The relay overwrites any previous file for your \`ownerKey\`. Any
existing \`.hidden\` marker is cleared automatically. Broadcasts an
\`avatar\` event so live peers update without a reload. Most agents
won't upload PFPs (binary body, image needed), but text-to-image
agents can — they POST the generated bytes here.

### Hide (opt out — your own only)

\`\`\`
POST ${BASE}/v1/avatars/hide
# → { ok: true, hidden: true, key }
\`\`\`

Drops any uploaded image AND records a \`.hidden\` marker so the
client doesn't fall back to ENS. Re-upload to undo (image overrides),
or hit DELETE to clear both the image and the marker (returns to
default ENS-fallback behavior).

### Clear (your own only)

\`\`\`
DELETE ${BASE}/v1/avatars
# → { ok: true, removed: true | false, key }
\`\`\`

Removes both any uploaded image and any \`.hidden\` marker, restoring
the default state. Use this to "reset to ENS fallback".

### Identity boundaries

You can only manage your own PFP — the relay derives the target
\`ownerKey\` from your bearer token. There's no admin override.
`;
}

// =============================================================================
// Files (shared desktop drag-and-drop)
// =============================================================================

export function skillFiles(token: string, isHost: boolean): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Files sub-skill

The shared desktop has a file system. Anyone can drag-and-drop files
onto the desktop background; the relay stores them and broadcasts
an event so every peer renders an icon at the drop position. Double-
click downloads / opens the file (the relay serves it with
\`Content-Disposition: attachment\`, so most browsers save it; image
mime types may inline-preview). The uploader (or host) gets a hover
"×" button to delete. Position lives in the slot system keyed
\`file-<id>\` — move/resize via the slots sub-skill.

Storage layout on the relay: \`/var/lib/slop-relay/files/<id>.<ext>\`
plus a \`files.json\` metadata index. Capped at 500 items total and
50 MB per file. Older items get evicted (oldest first) when the cap
is hit.

### Read the list

\`\`\`
GET ${BASE}/v1/files
# → { items: [{ id, name, size, mime, ownerKey, uploaderLabel,
#               ts, storedAs }, ...] }
\`\`\`

Also embedded in \`GET /v1/state\` under \`files\`.

### Upload

\`\`\`
POST ${BASE}/v1/files?name=<original-filename>
Content-Type: application/octet-stream
X-Mime: <real-mime-type>
Body: raw file bytes (≤ 50 MB)
# → { ok: true, item: { id, name, size, mime, ... } }
\`\`\`

The body is always shipped as \`application/octet-stream\`; the file's
real MIME type goes in the \`X-Mime\` header (or, if omitted, the
relay falls back to whatever Content-Type came in). Filename goes in
the \`?name=\` query (URL-encoded) or the \`X-Filename\` header.

Errors: 400 \`empty\`, 413 \`too-large\`, 400 \`write-failed:<reason>\`.

After a successful upload the relay broadcasts \`file_added\` with
the full \`item\` to every peer; the desktop UI auto-renders the new
icon. Agents that want a specific drop position should also POST a
slot update keyed \`file-<id>\` (see slots sub-skill).

### Download

\`\`\`
GET ${BASE}/files/<id>
\`\`\`

**No auth.** File ids are unguessable (16 hex chars) so listing is
the only enumeration path, and listing IS auth-gated. The relay
serves the original bytes with \`Content-Disposition: attachment\` and
the uploaded filename intact, so browsers download with the right
name.

### Delete

\`\`\`
DELETE ${BASE}/v1/files/<id>
\`\`\`

Uploader-only OR host (the relay enforces). 403 = forbidden, 404 =
not-found. On success the relay broadcasts \`file_removed\` with the
id.

### File slot positioning

The drop position when a user uploads a file is just a slot update
keyed \`file-<id>\`. To place a file programmatically after upload:

\`\`\`bash
# 1. Upload, capture the returned id
ID=$(curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/octet-stream" \\
  -H "x-mime: image/png" \\
  --data-binary @cat.png \\
  "${BASE}/v1/files?name=cat.png" | jq -r .item.id)

# 2. Place the icon at (400, 200)
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  ${BASE}/v1/slots \\
  -d "{\\"id\\":\\"file-$ID\\",\\"x\\":400,\\"y\\":200,\\"width\\":88,\\"height\\":110}"
\`\`\`
`;
}

// =============================================================================
// Router
// =============================================================================

export function skillForTopic(topic: SkillTopic, token: string, isHost: boolean): string {
  switch (topic) {
    case "chess":
      return skillChess(token, isHost);
    case "music":
      return skillMusic(token, isHost);
    case "browser":
      return skillBrowser(token, isHost);
    case "windows":
      return skillWindows(token, isHost);
    case "slots":
      return skillSlots(token, isHost);
    case "apps":
      return skillApps(token, isHost);
    case "todo":
      return skillTodo(token, isHost);
    case "notes":
      return skillNotes(token, isHost);
    case "gas":
      return skillGas(token, isHost);
    case "avatars":
      return skillAvatars(token, isHost);
    case "files":
      return skillFiles(token, isHost);
  }
}

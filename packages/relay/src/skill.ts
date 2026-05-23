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
// Each generator is a pure function of (token, isHost, slug?). When
// slug is provided every example is pre-filled with it; otherwise
// the doc shows `<slug>` placeholders and tells the agent to substitute.

const BASE = "https://live.slop.computer";

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

/** Slug placeholder used in every example. If a concrete slug was
 *  threaded into this skill (via `?slug=` on /v1/skill), every example
 *  is pre-filled with it; otherwise the placeholder `<slug>` stays
 *  literal so the agent (or human) knows to substitute. */
function slugStr(slug: string | null): string {
  return slug ?? "<slug>";
}

/** Per-room routing note pasted near the top of every sub-skill.
 *  Wording changes based on whether we have a concrete slug bound to
 *  this skill rendering. */
function slugNote(slug: string | null): string {
  if (slug) {
    return `> **Routing.** This skill was generated bound to slug \`${slug}\` —
> every \`?slug=${slug}\` example below targets that room. To work
> against a different room, either change \`slug=${slug}\` in the URLs
> or fetch the skill again with \`?slug=<other>\` to re-render with the
> new slug pre-filled.`;
  }
  return `> **Per-room routing.** Every endpoint below takes \`?slug=${slugStr(slug)}\`
> on the query string to target a specific room. Omit it and you hit
> the default \`debug\` room. **Tip:** re-fetch this skill with
> \`?slug=<your-room>\` and every example will be pre-filled. The slug
> humans are sitting in shows up as the URL path on
> \`live.slop.computer/<slug>\`. Re-read \`GET /v1/skill/rooms\` if you
> need to create / authenticate to one.`;
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
  "glossary",
  "gas",
  "avatars",
  "files",
  "transcript",
  "research",
  "news",
  "feeds",
  "wallet",
  "clock",
  "card",
  "episode",
  "rooms",
  "build",
] as const;
export type SkillTopic = (typeof SKILL_TOPICS)[number];

export function isSkillTopic(s: string): s is SkillTopic {
  return (SKILL_TOPICS as readonly string[]).includes(s);
}

// =============================================================================
// Index — short orientation + directory
// =============================================================================

export function skillIndex(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  const hostNote = isHost
    ? ""
    : "\n\n> ⚠ Some sub-skills (apps catalog, room admin) require **host** scope. Yours is **peer** — those endpoints return 403.";
  const S = slugStr(slug);
  const slugLine = slug
    ? `This skill was generated bound to slug \`${slug}\` — every \`?slug=${slug}\` example below targets that room. Re-fetch \`/v1/skill?token=...&slug=<other>\` to retarget.`
    : `**Tip:** re-fetch this skill as \`/v1/skill?token=...&slug=<your-room>\` and every example will be pre-filled with that slug instead of the literal placeholder. The slug a human is sitting in is the URL path of \`live.slop.computer/<slug>\` — peek at the browser address bar to find it.`;

  return `${header(token, scope, hostNote)}

## Quick start (the 30-second loop)

1. \`GET ${BASE}/v1/state?slug=${S}\` → snapshot of one room right
   now. Returns \`you\` (your identity), \`peers\` (other humans +
   agents online), and every app's current state inline.
2. Pick what to react to. Each app has a sub-skill at
   \`${BASE}/v1/skill/<topic>?slug=${S}\` (see the directory below).
   Fetch the sub-skill ONCE and cache it.
3. Use the sub-skill's long-poll or SSE wait (chess, music, chat) to
   block server-side until something changes — **never \`sleep()\` in
   your own loop**. The wait IS your sleep.
4. Mutate via the documented POST/DELETE endpoints. **Persistent
   state** (chat, todos, music selection, windows-open, chess moves)
   broadcasts to every peer in the room and renders for late joiners.
   **Ephemeral output** (music *playback*, cursor positions, click
   ripples) only exists inside a live peer browser — with
   \`state.peers.length === 0\` your POSTs to
   \`/v1/music/state\`, \`/v1/cursor\`, \`/v1/click\` all return
   \`ok:true\` and produce **nothing audible / visible**. The relay
   has no speakers and no screen; neither do you. Before claiming a
   real-time effect succeeded, check \`peers.length > 0\` and (for
   windowed surfaces) the relevant \`openWindowIds\`.

All endpoints are served from \`${BASE}\` (Caddy proxies \`/v1/*\`,
\`/music/*\`, \`/files/*\`, \`/avatars/*\`, \`/signal\`, \`/auth/*\`,
\`/admin/*\` to the relay).

## Per-room routing — the most important new concept

The relay is **multi-room**. Every state-bearing endpoint takes
\`?slug=${slugStr(slug)}\` on the query string; without it you hit the default
\`debug\` room. ${slugLine}

\`\`\`
GET  ${BASE}/v1/state?slug=${S}
POST ${BASE}/v1/chess/move?slug=${S}      # body: { from, to }
GET  ${BASE}/v1/transcript?slug=${S}
\`\`\`

Cross-room global feeds (ticker, gas, headlines, timeline, news
digest, polymarket) are server-wide and don't take a slug — they're
identical for every room. Everything else is per-room.

Each room has its own:
- chat, transcript, peers, windows, slots, browsers, files
- chess game + history, music state + custom playlist + selected genre
- todos, notes, clock, wallet (multisig), card (title card)
- episode flags (sttOn)

Room creation, password gate, and revive are documented in
\`GET ${BASE}/v1/skill/rooms\`.

## Core endpoints — always available

### State snapshot

\`\`\`
GET ${BASE}/v1/state?slug=${slugStr(slug)}
\`\`\`

Returns the canonical desktop snapshot for one room. Top-level fields:

| Field | Shape | What it is |
| --- | --- | --- |
| \`you\` | \`{ address, handle, role, isHost, ownerKey }\` | Your identity. \`ownerKey\` = lowercased address ?? handle |
| \`peers\` | \`Peer[]\` | Live WS peers in this room (humans + agents) |
| \`publications\` | \`Publication[]\` | Active camera/screen/mic streams — read-only for agents |
| \`slots\` | \`Record<id, {x,y,width,height,z}>\` | Every window/icon's position |
| \`browsers\` | \`Record<id, Browser>\` | Open shared browsers in this room |
| \`apps\` | \`AppEntry[]\` | Desktop icon catalog (global) |
| \`avatars\` | \`Record<ownerKey, url>\` | Uploaded PFPs (global, address-keyed) |
| \`hiddenAvatars\` | \`ownerKey[]\` | Owners who opted out of any PFP |
| \`openWindowIds\` | \`string[]\` | Singleton windows currently open in this room |
| \`musicState\` | \`MusicState \\| null\` | Slopamp head for this room |
| \`chessGame\` | \`ChessGame \\| null\` | Active chess game in this room |
| \`chessHistory\` | \`ChessResult[]\` | Finished games in this room |
| \`aiPlayers\` | \`AIPlayer[]\` | Server-side chess opponents (global) |
| \`todos\` | \`TodoItem[]\` | Shared todo list (this room) |
| \`notes\` | \`Note[]\` | Shared notes (this room) |
| \`glossary\` | \`GlossaryTerm[]\` | Shared glossary with AI TLDRs (global — one list across all rooms) |
| \`gasState\` | \`GasState \\| null\` | Latest Ethereum gas snapshot (global) |
| \`tickerState\` | \`TickerState \\| null\` | Crypto + AI stocks + private valuations + $CLAWD (global) |
| \`headlinesState\` | \`HeadlinesState \\| null\` | Crypto + AI news headlines (global) |
| \`timelineState\` | \`TimelineState \\| null\` | Host's Twitter home feed, ranked (global) |
| \`newsDigestState\` | \`NewsDigestState \\| null\` | AI-curated featured news (global) |
| \`files\` | \`FileEntry[]\` | User-uploaded files on this room's desktop |
| \`musicGenres\` | \`{ id, label }[]\` | Jamendo genre catalog |
| \`musicGenre\` | \`string \\| null\` | Active genre for this room (null = legacy playlist) |
| \`musicCustom\` | \`JamendoTrack[]\` | Per-room user-curated playlist |
| \`clockState\` | \`ClockState\` | Shared clock/timer/countdown for this room |
| \`wallet\` | \`WalletRecord \\| null\` | Current multisig for this room |
| \`walletDraft\` | \`WalletDraft \\| null\` | Collaborative pre-deploy form state |
| \`walletTxs\` | \`WalletTx[]\` | Pending + recent multisig txs for this room |
| \`cardState\` | \`{ version } \\| null\` | Title card image presence (this room) |
| \`cardJob\` | \`CardJob \\| null\` | In-flight card-generation job (this room) |
| \`cardTitle\` | \`CardTitle \\| null\` | Shared title overlay text + position |
| \`researchState\` | \`ResearchSnapshot\` | Per-room shared guest-research dossier + phase machine (see \`/v1/skill/research\`) |

Don't poll \`/v1/state\` faster than 1 Hz. For fast reactions to a
specific app (e.g. "wake me when it's my chess turn"), use that
app's long-poll or SSE endpoint documented in its sub-skill.

### Agent token (bootstrap)

\`\`\`
GET ${BASE}/v1/agent-token?slug=${slugStr(slug)}
# → { token, expiresAt, scope: "host" | "peer",
#     identity: { address, handle, role } }
\`\`\`

Mints a new bearer token tied to the calling session (cookie or
existing bearer). 7-day expiry. Hand the returned \`token\` to your
agent and use it as \`Authorization: Bearer <token>\` for every
subsequent call. Hosts mint host-scoped tokens; peer sessions mint
peer-scoped tokens. The token is **locked to one room** — pass the
\`?slug=\` of the room you're in, and the token only works for that
room. A no-slug re-mint keeps whatever room the calling token was
already scoped to.

### Agent presence (cursor + click)

\`\`\`
POST ${BASE}/v1/cursor?slug=${slugStr(slug)}   { "x": 800, "y": 400 }   # labelled cursor
POST ${BASE}/v1/click?slug=${slugStr(slug)}    { "x": 800, "y": 400 }   # colored ripple
\`\`\`

Cursor positions persist on every peer's screen and are labelled
with your identity. Click ripples render in your blockie's palette.
Use these to "be present" — point at things, react. Cursor cap:
< 30 msgs/sec.

> ⚠ **Ephemeral, same trap as music playback.** Cursor and click
> only render inside browsers currently in the room. With
> \`state.peers.length === 0\` these POSTs return \`ok:true\` but
> nobody sees a thing — you are waving at an empty room. Always
> check \`peers.length\` before claiming you're "pointing at"
> something for the user.

### Chat

\`\`\`
POST ${BASE}/v1/chat?slug=${slugStr(slug)}        { "text": "gm everyone" }
GET  ${BASE}/v1/chat?slug=${slugStr(slug)}                              # last 200 messages
GET  ${BASE}/v1/chat/stream?slug=${slugStr(slug)}                       # SSE stream
\`\`\`

Visible to live desktop users AND to spectators on slop.computer.
500 chars per message, ~1/sec soft rate limit. Bearer-token posts
are tagged \`source: "agent"\`.

### Rename (anon users only)

\`\`\`
POST ${BASE}/auth/handle    { "handle": "Greg" }
\`\`\`

If your session was minted via \`/auth/anon\` (no wallet, no
passkey), this changes the display name humans see for you. SIWE /
passkey users keep their address-derived label. Max 30 chars, ASCII
control chars stripped. Global across rooms.

### Icons (asset paths)

\`\`\`
GET ${BASE}/v1/icons       # → { icons: [{ name, url }] }
\`\`\`

List of icon PNGs available to use as \`apps[].icon\` paths.

## Sub-skills — fetch BEFORE acting on the relevant app

The desktop has app-specific surfaces (chess, music, transcript, etc).
Each has its own focused doc. **Read the sub-skill before submitting
moves / state changes for that app** — the surfaces have validation
rules and recommended loops that aren't repeated here.

| App | Get the sub-skill | Notes |
| --- | --- | --- |
| **Chess** (multiplayer game + AI opponents) | \`GET ${BASE}/v1/skill/chess\` | long-poll loop |
| **Music** (shared SLOPAMP + Jamendo genres + custom playlist) | \`GET ${BASE}/v1/skill/music\` | long-poll loop |
| **Browser** (shared iframes + impersonator + tx capture + ENS resolve) | \`GET ${BASE}/v1/skill/browser\` |  |
| **Windows** (open/close singleton apps) | \`GET ${BASE}/v1/skill/windows\` |  |
| **Slots** (move/resize windows + icons) | \`GET ${BASE}/v1/skill/slots\` |  |
| **Apps catalog** (add/remove desktop icons, host-only) | \`GET ${BASE}/v1/skill/apps\` | host-only mutation |
| **Todo** (shared todo list) | \`GET ${BASE}/v1/skill/todo\` |  |
| **Notes** (shared free-form notes) | \`GET ${BASE}/v1/skill/notes\` |  |
| **Glossary** (shared terms + async AI TLDRs) | \`GET ${BASE}/v1/skill/glossary\` |  |
| **Gas** (Ethereum gas tracker, read-only) | \`GET ${BASE}/v1/skill/gas\` | read-only |
| **Avatars** (your PFP — upload / hide / clear) | \`GET ${BASE}/v1/skill/avatars\` |  |
| **Files** (drag-and-drop desktop files) | \`GET ${BASE}/v1/skill/files\` |  |
| **Transcript** (live STT — read for TLDR + post + clear) | \`GET ${BASE}/v1/skill/transcript\` | core for AI use cases |
| **Research** (AI dossier for a guest — name, socials → questions) | \`GET ${BASE}/v1/skill/research\` | AI-backed, key use case |
| **News** (interleaved + AI-curated crypto/AI/tweets/Polymarket) | \`GET ${BASE}/v1/skill/news\` | read-only |
| **Feeds** (ticker / headlines / timeline / polymarket details) | \`GET ${BASE}/v1/skill/feeds\` | read-only + host refresh |
| **Wallet** (per-room multisig + tx queue) | \`GET ${BASE}/v1/skill/wallet\` | mostly read for agents |
| **Clock** (shared timer / countdown / time-zone) | \`GET ${BASE}/v1/skill/clock\` |  |
| **Card** (per-room title card — AI gen + overlay) | \`GET ${BASE}/v1/skill/card\` |  |
| **Episode** (sttOn flag + SSE stream) | \`GET ${BASE}/v1/skill/episode\` |  |
| **Rooms** (create / auth / list — multi-room) | \`GET ${BASE}/v1/skill/rooms\` | host-only for create |
| **Build** (add a new app — iframe, kind, web3 dapp) | \`GET ${BASE}/v1/skill/build\` | for app authors |

Each sub-skill is small (< 150 lines). Cache them; only re-fetch on
unexpected 4xx from an endpoint they documented.

## Common AI agent recipes

### "Look at the transcript and give me a TLDR"

\`\`\`
GET ${BASE}/v1/transcript?slug=${slugStr(slug)}
# → { segments: [{ ts, address, handle, text, source }, ...] }
\`\`\`

Read the last N segments, summarize them with your own model.
See \`GET /v1/skill/transcript\` for cadence + dedupe details.

### "Research this guest and give me a question to ask"

\`\`\`
POST ${BASE}/v1/guest-lookup       { "query": "@vitalikbuterin" }
POST ${BASE}/v1/guest-research     { "name", "socials", "notes" }
\`\`\`

The relay calls Claude (with web search) for you. You get back
\`{ vanilla, researched, questions[], tweets[], sources[] }\`.
Layer your own follow-up question on top of \`questions\`. Full
flow in \`GET /v1/skill/research\`.

### "Look at everything and write a show title + description"

Pull \`/v1/transcript\`, \`/v1/chat\`, \`/v1/state\` (for guests +
chess + music context), feed it all to your own model. There's no
relay-side endpoint for this — the agent already has Claude. See
the transcript sub-skill for the read path.

## Conventions

- 200/2xx = success. 400 = bad input. 401 = bad/expired token.
  403 = host-only or "not your turn" / "illegal move" (chess).
  404 = id doesn't exist. 409 = state conflict (e.g. game already
  active). 500 = relay misconfig.
- Mutations broadcast to live WS peers in real time — everyone in
  that room sees your change. There is no undo. Be intentional.
- Cursor coords are viewport pixels at the host's resolution
  (~1440×900 typical). Stay inside the screen.
- The WS at \`wss://live.slop.computer/signal\` is out of scope for
  this skill — sub-skills use REST + long-poll / SSE instead.
`;
}

// =============================================================================
// Chess
// =============================================================================

export function skillChess(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Chess sub-skill

${slugNote(slug)}

Server-authoritative singleton chess game **per room**. The relay
validates every move via chess.js — agents can't fake legal moves.
Players are identified by **ownerKey** = lowercased wallet address
?? lowercased handle. The relay also hosts server-side AI players
(see below); pick one as the opponent and the relay plays for them.

### Read state

\`\`\`
GET ${BASE}/v1/chess?slug=${slugStr(slug)}
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
GET ${BASE}/v1/chess/wait?slug=${slugStr(slug)}&since=<version>&timeout=25
\`\`\`

Returns immediately if \`chessStateVersion > since\`. Otherwise blocks
up to \`timeout\` seconds (default 25, max 60) waiting for the next
create / move / resign / abort, then returns the same shape as
\`/v1/chess\`. **This is the right wait — see the autonomous play
loop below.**

### Start a game

\`\`\`
POST ${BASE}/v1/chess/create?slug=${slugStr(slug)} {
  "whiteKey": "0x123...",
  "blackKey": "ai:venice-uncensored",
  "whiteLabel": "vitalik.eth",
  "blackLabel": "Venice"
}
\`\`\`

The chess slot is a singleton — fails with 409 if a game is already
active. Use \`POST /v1/chess/close?slug=${slugStr(slug)}\` to abort an active
game. Available AI \`ownerKey\` values are listed in \`GET /v1/state\`'s
\`aiPlayers\` array; they all start with \`ai:\`.

### Submit a move

\`\`\`
POST ${BASE}/v1/chess/move?slug=${slugStr(slug)} { "from": "e2", "to": "e4" }
# pawn promotion → include "promotion": "q" | "r" | "b" | "n"
\`\`\`

Server checks: it's an active game, your session's ownerKey ==
side-to-move's ownerKey, the move is legal per chess.js. On success
it broadcasts the new state. 403 = not your turn or illegal move;
409 = no active game; 400 = bad input.

### Resign / abort

\`\`\`
POST ${BASE}/v1/chess/resign?slug=${slugStr(slug)}     # records a loss
POST ${BASE}/v1/chess/close?slug=${slugStr(slug)}      # wipes slot. Active → abort
                                             # (no result recorded).
\`\`\`

### Autonomous play loop

**TIGHT LOOP. NO SLEEP. Use the long-poll endpoint as your only wait.**

1. \`GET /v1/chess/wait?slug=${slugStr(slug)}&since=<v>&timeout=25\` blocks
   server-side until the position actually changes (or 25s elapses).
2. If \`yourTurn: true\`, think, then \`POST /v1/chess/move\`. Then
   immediately go to step 1 with the new \`version\`.
3. If \`yourTurn: false\` or the wait timed out, just go to step 1
   again. **Don't sleep, don't back off, don't add jitter.**

Stop conditions: \`game.status != "active"\` (resigned, checkmate,
draw, abort), or \`game === null\` (lobby cleared). On a
\`403 illegal_move\` (the position changed under you mid-think),
re-read \`/v1/chess\` and replan from the fresh \`version\`.
`;
}

// =============================================================================
// Music
// =============================================================================

export function skillMusic(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Music sub-skill (slopamp)

${slugNote(slug)}

> ⚠ **Setting music state ≠ producing sound.** The relay just stores
> a snapshot; only **a peer browser with the slopamp window mounted**
> actually plays audio. The agent has no speakers and neither does
> the relay. Before any \`/v1/music/state\` POST, verify all three —
> none of which \`/v1/music/state\` checks for you:
>
> 1. \`"music" ∈ state.openWindowIds\`. If not, open it first:
>    \`POST ${BASE}/v1/windows?slug=${slugStr(slug)} { "id": "music" }\`.
>    No window mounted = no \`<audio>\` element = no sound, ever.
> 2. \`state.peers.length > 0\`. With zero peers there is literally
>    no browser in the room to play the file. \`/v1/music/state\`
>    will still return \`ok:true\` — it's silently writing to a
>    snapshot no one is reading.
> 3. The peer has clicked once in the slopamp tab (Chrome's
>    autoplay gate). Not checkable server-side; if state shows
>    \`playing: true\` and it's still silent for a connected user,
>    ask them to click in the tab and re-fire with a fresh \`at\`.
>
> Always report back what you **wrote** ("set the room to track X,
> 1 peer connected, window open"), never what you can't verify
> ("now playing"). The user knows the difference and will be
> furious if you lie.

Playback is one shared snapshot **per room** — track src + index,
playing/paused, position-at-timestamp, and master volume. Anyone in
the room can mutate it; all peers' \`<audio>\` elements re-sync.
Per-peer mute is local-only and isn't exposed here.

### Read state

\`\`\`
GET ${BASE}/v1/music?slug=${slugStr(slug)}
# → {
#     state: { src, index, playing, position, at, volume } | null,
#     version: 42
#   }
\`\`\`

### Long-poll the next change (DJ loop)

\`\`\`
GET ${BASE}/v1/music/wait?slug=${slugStr(slug)}&since=<version>&timeout=25
\`\`\`

Same long-poll pattern as chess. **Use this as the DJ loop's only
wait.** Don't \`sleep()\`.

### Genres

Music backends are two-tier:

- **Jamendo genre** (default) — \`musicGenre\` is one of the genre ids
  in \`/v1/music/genres\`. Each genre has 20 auto-refreshed trending
  tracks. \`custom\` is a special **per-room** user-curated genre.
- **Legacy playlist** — when \`musicGenre === null\`, the player uses
  the static Kevin MacLeod set in \`/v1/music/playlist\`.

\`\`\`
GET  ${BASE}/v1/music/genres?slug=${slugStr(slug)}
# → { genres: [{id, label}, ...], current: "rock" | null }

POST ${BASE}/v1/music/genre?slug=${slugStr(slug)}   { "genre": "rock" }
POST ${BASE}/v1/music/genre?slug=${slugStr(slug)}   { "genre": null }     # fall back to legacy
POST ${BASE}/v1/music/genre?slug=${slugStr(slug)}   { "genre": "custom" } # show per-room curated list
\`\`\`

Genre ids: \`pop\`, \`rock\`, \`electronic\`, \`hiphop\`, \`indie\`,
\`dance\`, \`folk\`, \`punk\`, \`country\`, \`house\`, \`custom\`. First-time
switch to a cold genre takes ~30s while the relay downloads trending
MP3s from Jamendo.

\`\`\`
GET ${BASE}/v1/music/genre/<genre>/playlist?slug=${slugStr(slug)}
# → { genre, label, tag, fetchedAt, tracks: [
#       { title, artist, src, duration, jamendoId, license, source }, ...
#     ] }
\`\`\`

### Per-room custom playlist

\`\`\`
POST   ${BASE}/v1/music/custom/add?slug=${slugStr(slug)}    { "track": {<JamendoTrack>} }
DELETE ${BASE}/v1/music/custom/<jamendoId>?slug=${slugStr(slug)}
POST   ${BASE}/v1/music/custom/reorder?slug=${slugStr(slug)} { "ids": ["id1","id2",...] }
\`\`\`

The \`track\` body must include \`{ title, artist, src, jamendoId }\`
at minimum (duration/license/source optional). The underlying MP3
file isn't re-uploaded — \`src\` references an already-on-disk Jamendo
track from some other genre. Add returns the new full list of
tracks.

### Upload your own MP3 → Custom playlist

\`\`\`
POST ${BASE}/v1/music/upload?slug=${slugStr(slug)}&name=<filename.mp3>
  content-type: audio/mpeg
  body: <raw mp3 bytes>
# → { ok: true, track: <JamendoTrack>, tracks: [<JamendoTrack>, ...] }
\`\`\`

Drop raw MP3 bytes into the room and it lands in the Custom
playlist with \`jamendoId: "upload:<hash>"\` and \`source: "upload"\`.
The relay sniffs the magic bytes (ID3 tag or MPEG frame sync) and
rejects non-MP3 payloads with \`415 not-mp3\`. Per-room caps:

| Cap | Default | Env var |
| --- | --- | --- |
| Tracks per room | 30 | \`UPLOAD_MAX_TRACKS_PER_ROOM\` |
| Bytes per room | 200 MB | \`UPLOAD_MAX_BYTES_PER_ROOM\` |
| Bytes per file | 25 MB | \`UPLOAD_MAX_BYTES\` |

Quota errors come back as \`429 track-quota-exceeded\` /
\`429 byte-quota-exceeded\`. \`DELETE /v1/music/custom/upload:<hash>\`
also unlinks the file from disk, freeing room quota.

Typical agent flow: fetch the song bytes (yt-dlp, a local file,
whatever), POST them here, then \`POST /v1/music/state\` with
\`src: track.src\` and \`index: tracks.length - 1\` to actually start
playback. Remember the three preconditions for sound to come out
(music window open, host live, a peer with audio routed in the
room).

### Legacy playlist

\`\`\`
GET ${BASE}/v1/music/playlist?slug=${slugStr(slug)}
# → { tracks: [{ title, artist, src, license?, source? }, ...] }
\`\`\`

Active when \`musicGenre === null\`. Also exposed un-authed at
\`${BASE}/music/playlist.json\` for the in-browser player.

### Set state

\`\`\`
POST ${BASE}/v1/music/state?slug=${slugStr(slug)} {
  "src": "/jamendo-music/rock/12345.mp3",
  "index": 3,
  "playing": true,
  "position": 0,
  "at": 1730000000000,
  "volume": 0.7
}
\`\`\`

**Always set \`src\` and \`index\` together.** They're both stored,
but nothing enforces \`src === playlist[index].src\`. The window
shows \`index\` as the "currently playing" highlight; \`<audio>\`
plays \`src\`. Sending one without the other is the fast path to a
desynced UI.

Useful patterns:
- **Pause** — repost the same snapshot with \`playing: false\`.
- **Skip to next** — bump \`index\`, set the matching \`src\`, set
  \`position: 0\`, set \`playing: true\`.
- **Volume change** — keep all the other fields the same, change
  \`volume\` (range \`0..1\`, server clamps).
- **\`at\`** — should be roughly \`Date.now()\` when you build the
  snapshot. Peers compute the live head as
  \`position + (Date.now() - at) / 1000\` while playing.

### Adding more tracks (legacy)

The Jamendo flow handles the volume case. For the legacy playlist,
SCP the MP3 to \`/var/lib/slop-relay/music/\` on the prod box and
append an entry to \`playlist.json\` there. No restart needed.
`;
}

// =============================================================================
// Browser
// =============================================================================

export function skillBrowser(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Browser sub-skill

${slugNote(slug)}

The desktop hosts shared browser windows — iframes whose URL is
synchronized across every peer in the room. The headless Chrome
backing them auto-impersonates \`vitalik.eth\`, so any dapp the
iframe loads sees a funded wallet. Captured \`eth_sendTransaction\`
payloads land in every peer's tx panel so the audience can see what
dapps are trying to do.

### Open / navigate / close

\`\`\`
POST   ${BASE}/v1/browsers?slug=${slugStr(slug)}             { "url": "https://app.ens.domains" }
POST   ${BASE}/v1/browsers/:id/navigate?slug=${slugStr(slug)} { "url": "https://uniswap.org" }
DELETE ${BASE}/v1/browsers/:id?slug=${slugStr(slug)}
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

\`GET /v1/state?slug=${slugStr(slug)}\` includes \`browsers\` keyed by id.

### ENS contenthash resolution

\`\`\`
GET ${BASE}/v1/ens/resolve?name=clawdbotatg.eth
# → { ok: true, name, protocol: "ipfs"|"ipns"|"swarm",
#     value, gateway: "https://<cid>.ipfs.community.bgipfs.com/" }
\`\`\`

Resolves an ENS name's contenthash record directly via Alchemy and
decodes it into a ready-to-load gateway URL. Cached on the relay for
10 minutes. No auth required.

### Tx capture

\`eth_sendTransaction\` from an iframe dapp gets broadcast as a
\`tx_request\` WS event to every peer in that room (mesh ws only,
no REST endpoint). The wallet sub-skill (\`GET /v1/skill/wallet\`)
covers the multisig path that turns these captures into signable
proposals.
`;
}

// =============================================================================
// Singleton windows
// =============================================================================

export function skillWindows(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Windows sub-skill

${slugNote(slug)}

The desktop has "singleton" apps whose visibility is shared across
all peers in a room. Anyone can open or close them; everyone sees
the change. Distinct from browsers (multi-instance, one shared
entity per id) and publications (camera, mic, screen — one per peer).

### Open / close

\`\`\`
POST   ${BASE}/v1/windows?slug=${slugStr(slug)}         { "id": "chess" }   # opens for all
DELETE ${BASE}/v1/windows/chess?slug=${slugStr(slug)}                       # closes for all
\`\`\`

Known ids and their interactive surfaces:

| id | What it is | Agent interaction |
| --- | --- | --- |
| \`chat\` | Shared chat panel | \`POST /v1/chat\` (see index) |
| \`music\` | SLOPAMP player | \`GET /v1/skill/music\` |
| \`chess\` | Chess game | \`GET /v1/skill/chess\` |
| \`todo\` | Shared todo list | \`GET /v1/skill/todo\` |
| \`notes\` | Shared notes | \`GET /v1/skill/notes\` |
| \`glossary\` | Shared glossary with AI TLDRs | \`GET /v1/skill/glossary\` |
| \`gas\` | Gas tracker | \`GET /v1/skill/gas\` (read-only) |
| \`clock\` | Clock + timer + countdown | \`GET /v1/skill/clock\` (per-room shared) |
| \`wallet\` | Per-room multisig | \`GET /v1/skill/wallet\` |
| \`research\` | Guest research dossier | \`GET /v1/skill/research\` |
| \`news\` | Curated news digest | \`GET /v1/skill/news\` |
| \`transcript\` | Live STT feed | \`GET /v1/skill/transcript\` |
| \`card\` | Title card overlay | \`GET /v1/skill/card\` |
| \`qr\` | QR generator | **per-peer local state** — window shared but input + center logo private to each viewer. No agent mutate surface. |

The corresponding apps must exist in the catalog (\`GET /v1/state\`'s
\`apps\` array, matched by \`kind\`); use \`GET /v1/skill/apps\` to add
new ones (host-only).

### Reading what's open

\`GET /v1/state?slug=${slugStr(slug)}\` includes \`openWindowIds: string[]\`.

### Position + minimize

Each open window has a slot keyed \`app-<id>\` (e.g. \`app-chess\`).
Use the slots sub-skill to move / resize.

Minimize state isn't a separate field — it's encoded in the slot
geometry. If a slot's \`height\` is 36 and the window is open, that
window is currently minimized. Restore by writing a normal-size
slot back.
`;
}

// =============================================================================
// Slots (window positions)
// =============================================================================

export function skillSlots(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Slots sub-skill

${slugNote(slug)}

Window positions on the desktop are stored as "slots" — shared
across every peer in a room, persistent across reloads. Moving a
window moves it for everyone.

### Update a slot

\`\`\`
POST ${BASE}/v1/slots?slug=${slugStr(slug)}
{ "id": "browser-abc123", "x": 200, "y": 80, "width": 800, "height": 610 }
\`\`\`

You can omit any of \`x\`, \`y\`, \`width\`, \`height\`, \`z\` and the
existing value is preserved. Pass all four when creating a new slot
or you risk the merge falling back to generic defaults
(x=80, y=280, w=360, h=260, z=1).

### Slot id conventions

| Pattern | What it positions |
| --- | --- |
| \`icon-<appId>\` | Desktop icon for app \`appId\` (e.g. \`icon-chess\`) |
| \`app-<appId>\` | Singleton app window (chess, music, chat, transcript, etc.) |
| \`browser-<hex>\` | A specific shared browser window |
| \`file-<hex>\` | A user-uploaded desktop file icon (see Files sub-skill) |
| \`peer-<peerId>-<streamId>\` | A guest's camera/screen/audio publication window |
| \`host-camera\` / \`host-screen\` | Host's own publication windows |

### Reading

\`GET /v1/state?slug=${slugStr(slug)}\` returns \`slots: Record<id, {x,y,width,height,z}>\`.

### Recipes

Tile two browser windows side-by-side:

\`\`\`bash
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  "${BASE}/v1/slots?slug=${slugStr(slug)}" -d '{"id":"browser-abc","x":40,"y":80,"width":600,"height":600}'
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  "${BASE}/v1/slots?slug=${slugStr(slug)}" -d '{"id":"browser-def","x":660,"y":80,"width":600,"height":600}'
\`\`\`
`;
}

// =============================================================================
// Apps catalog (host-only)
// =============================================================================

export function skillApps(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  const hostNote = isHost ? "" : "\n\n> ⚠ The POST / DELETE endpoints below are **host-only**. Your scope is **peer** — they return 403. Reads are open to anyone.";
  return `${header(token, scope, hostNote)}

## Apps catalog sub-skill

The set of desktop icons users see on \`live.slop.computer\` is a
JSON catalog on the relay. The catalog is **global** — same apps in
every room. Host can add/remove entries; new page loads pick them up.

### Read the catalog

\`\`\`
GET ${BASE}/v1/state?slug=${slugStr(slug)}        # → state.apps
\`\`\`

There is no standalone \`GET /v1/apps\` route — read the catalog from
the full state snapshot.

### Add (or update) an app — host-only

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
| \`"glossary"\` | opens the glossary window |
| \`"gas"\` | opens the Ethereum gas tracker |
| \`"clock"\` | opens the shared clock / countdown timer |
| \`"wallet"\` | opens the multisig wallet window |
| \`"research"\` | opens the guest-research window |
| \`"news"\` | opens the news digest window |
| \`"transcript"\` | opens the live transcript window |
| \`"card"\` | opens the title-card window |

### Delete an app — host-only

\`\`\`
DELETE ${BASE}/v1/apps/:id
\`\`\`

Built-in apps (those shipped in \`DEFAULT_APPS\`) can't be deleted —
returns 409. Only hot-loaded overrides / additions can be removed.

### Adding a new icon image

\`GET ${BASE}/v1/icons\` lists available PNGs. To add a new icon
image, drop it in \`packages/nextjs/public/icons/\` in the repo and
redeploy — there's no runtime upload endpoint.
`;
}

// =============================================================================
// Todo
// =============================================================================

export function skillTodo(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Todo sub-skill

${slugNote(slug)}

Per-room shared todo list. All peers in the room see the same items;
anyone (humans or agents) can add, toggle, edit, delete, reorder, or
clear-done. Capped at 200 items / 500 chars per item.

### Read

\`\`\`
GET ${BASE}/v1/todos?slug=${slugStr(slug)}
# → { items: [{ id, ts, address, handle, text, done }, ...] }
\`\`\`

Also embedded in \`GET /v1/state\` under \`todos\`.

### Add / toggle / update / delete / clear-done / reorder

\`\`\`
POST   ${BASE}/v1/todos?slug=${slugStr(slug)}            { "text": "buy milk" }
POST   ${BASE}/v1/todos/:id/toggle?slug=${slugStr(slug)}
POST   ${BASE}/v1/todos/:id?slug=${slugStr(slug)}        { "text": "buy oat milk" }
DELETE ${BASE}/v1/todos/:id?slug=${slugStr(slug)}
POST   ${BASE}/v1/todos/clear-done?slug=${slugStr(slug)}
POST   ${BASE}/v1/todos/reorder?slug=${slugStr(slug)}    { "ids": ["abc","def","ghi"] }
\`\`\`

Reorder: pass the full id list in the desired order. Unknown ids are
ignored; ids you leave out are appended at the end (defensive
against a race with concurrent adds).
`;
}

// =============================================================================
// Notes
// =============================================================================

export function skillNotes(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Notes sub-skill

${slugNote(slug)}

Per-room shared free-form notes. All peers see all notes in the
room; anyone can create / edit / delete any note. Capped at 200
notes / 10k chars per note.

The first line of a note's text doubles as its title in the sidebar.
No separate title field — keep the first line short and put body
underneath.

### Read

\`\`\`
GET ${BASE}/v1/notes?slug=${slugStr(slug)}
# → { items: [{ id, createdTs, updatedTs, address, handle, text }, ...] }
\`\`\`

Also embedded in \`GET /v1/state\` under \`notes\`.

### Create / update / delete

\`\`\`
POST   ${BASE}/v1/notes?slug=${slugStr(slug)}      { "text": "Title line\\nBody body body" }
POST   ${BASE}/v1/notes/:id?slug=${slugStr(slug)}  { "text": "new full body" }
DELETE ${BASE}/v1/notes/:id?slug=${slugStr(slug)}
\`\`\`

Update replaces the entire note text; there's no append / patch
endpoint. \`updatedTs\` is bumped server-side. Empty text on create
is allowed (creates a blank note).
`;
}

// =============================================================================
// Glossary
// =============================================================================

export function skillGlossary(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Glossary sub-skill

Shared dictionary of terms + AI-generated TLDRs. Anyone can add a
term; the relay calls Claude in the background and fills in the
TLDR a moment later. State transitions: \`pending\` → \`ready\` (or
\`error\`). Same in-memory + on-disk persistence as notes/todos.

> **Scope note.** Glossary state is currently a single global list,
> not per-room — the relay file is \`./.slop-data/glossary.json\`.
> The \`?slug=\` query is harmless but doesn't partition the list.

### Read

\`\`\`
GET ${BASE}/v1/glossary
# → { items: [{
#       id, term, tldr, status: "pending"|"ready"|"error",
#       createdTs, updatedTs, address, handle, anonId
#     }, ...] }
\`\`\`

Also embedded in \`GET /v1/state\` under \`glossary\`.

### Add a term

\`\`\`
POST ${BASE}/v1/glossary { "term": "MCP" }
# → { ok: true, item: { id, term, tldr: "", status: "pending", ... } }
\`\`\`

Soft-deduped: case-insensitive match against an existing term
returns that entry instead of stacking duplicates. The TLDR call is
fired async — wait a couple seconds, re-read, and \`status\` will be
\`ready\` with the AI-written 1-sentence definition.

### Regenerate (re-run the AI call)

\`\`\`
POST ${BASE}/v1/glossary/:id/regenerate
# → { ok: true }    # status flips back to pending, then ready
\`\`\`

Useful when the first TLDR was wrong or stale.

### Delete

\`\`\`
DELETE ${BASE}/v1/glossary/:id
\`\`\`

### Agent recipes

- **Term spotter** — read \`/v1/transcript\` periodically, scan for
  acronyms / jargon, \`POST /v1/glossary\` for any term not already
  in \`items\`. The AI TLDR drops a few seconds later.
- **Glossary primer** — read the full list, hand it to your own
  model as context when summarizing the show or answering questions.
  The TLDRs cluster around the show's actual domain (AI / crypto)
  because each call passes existing terms as priming.
`;
}

// =============================================================================
// Gas
// =============================================================================

export function skillGas(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Gas sub-skill (read-only, global)

Ethereum gas tracker. The relay polls Alchemy
(\`eth_feeHistory\`, 5 blocks, 10/50/90th-percentile priority fees) and
the Chainlink mainnet ETH/USD oracle every ~12s and exposes the latest
snapshot. **Global** — same data for every room. No mutate surface.

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

export function skillAvatars(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Avatars sub-skill (global)

Each user has an optional PFP keyed by their \`ownerKey\` (lowercased
address ?? slugified handle). The PFP appears on cursors, the audio-
publication window, and anywhere else the desktop renders identity.
**Avatars are global** — the same upload follows you into every room.
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

### Upload / hide / clear (your own PFP only)

\`\`\`
POST ${BASE}/v1/avatars        # Body: raw bytes, Content-Type: image/{jpeg,png,webp}, max ~600KB
POST ${BASE}/v1/avatars/hide   # drop image + write hidden marker
DELETE ${BASE}/v1/avatars      # clean slate: remove image + marker, ENS fallback resumes
\`\`\`

You can only manage your own PFP — the relay derives the target
\`ownerKey\` from your bearer token. There's no admin override.
`;
}

// =============================================================================
// Files (shared desktop drag-and-drop)
// =============================================================================

export function skillFiles(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Files sub-skill

${slugNote(slug)}

Each room has its own file system. Anyone can drag-and-drop files
onto that room's desktop; the relay stores them and broadcasts an
event so every peer renders an icon at the drop position. Double-
click downloads / opens. Capped at 500 items per room and 50 MB per
file. Older items get evicted (oldest first) when the cap is hit.

### Read the list

\`\`\`
GET ${BASE}/v1/files?slug=${slugStr(slug)}
# → { items: [{ id, name, size, mime, ownerKey, uploaderLabel,
#               ts, storedAs }, ...] }
\`\`\`

### Upload

\`\`\`
POST ${BASE}/v1/files?slug=${slugStr(slug)}&name=<original-filename>
Content-Type: application/octet-stream
X-Mime: <real-mime-type>
Body: raw file bytes (≤ 50 MB)
# → { ok: true, item: { id, name, size, mime, ... } }
\`\`\`

After a successful upload the relay broadcasts \`file_added\` to the
room. Agents that want a specific drop position should POST a slot
update keyed \`file-<id>\` (see slots sub-skill).

### Download

\`\`\`
GET ${BASE}/files/<id>
\`\`\`

**No auth.** File ids are unguessable (16 hex chars); listing is the
only enumeration path, and listing IS auth-gated.

### Delete

\`\`\`
DELETE ${BASE}/v1/files/<id>?slug=${slugStr(slug)}
\`\`\`

Uploader-only OR host (the relay enforces). 403 = forbidden, 404 =
not-found.
`;
}

// =============================================================================
// Transcript
// =============================================================================

export function skillTranscript(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  const adminNote = isHost
    ? "\n\nHost: you also have access to \`DELETE /admin/transcript?slug=${slugStr(slug)}\` to wipe pre-show test segments, and an SSE tail at \`GET /admin/transcript/stream?slug=${slugStr(slug)}\`."
    : "";
  return `${header(token, scope, "")}

## Transcript sub-skill

${slugNote(slug)}

Per-room live transcript of what people are saying out loud. Each
peer's browser runs Web Speech (or a god-mode STT relay) and POSTs
final segments here; the relay stamps \`ts\` + identity, dedupes near-
duplicates within a 3.5s window, and persists to JSONL on disk.
Capped at the last 500 segments per room in memory; the on-disk
archive is full. **This is the core read for TLDR / show-summary
agent flows.**${adminNote}

### Read recent segments

\`\`\`
GET ${BASE}/v1/transcript?slug=${slugStr(slug)}
# → { segments: [{
#       id, ts, address, handle, anonId, text,
#       source: "live" | "spectator" | "agent"
#     }, ...] }
\`\`\`

\`ts\` is ms epoch. The list is chronological (oldest → newest).
\`source: "live"\` = real participant in the desktop mesh.
\`source: "spectator"\` = someone watching from \`slop.computer\`.
\`source: "agent"\` = bearer-token poster (you, if you POST).

Also embedded in \`GET /v1/state\` is NOT a thing for transcript —
read this endpoint instead.

### Append a segment

\`\`\`
POST ${BASE}/v1/transcript?slug=${slugStr(slug)} { "text": "the thing I want to say" }
# → { ok: true, seg: { id, ts, address, handle, text, source: "agent" } }
\`\`\`

Agents posting through this endpoint are tagged \`source: "agent"\`.
Use sparingly — humans expect transcripts to reflect spoken audio,
not bot interjections. (For chat, use \`POST /v1/chat\` instead.)

Rate limit: 20-burst, 2/sec sustained per session token. Max 1000
chars per segment.

### Agent recipes

**TLDR of the show so far:**

\`\`\`bash
curl -s -H "Authorization: Bearer ${token}" \\
  "${BASE}/v1/transcript?slug=${slugStr(slug)}" | jq '.segments[-200:] | map("[\\(.handle // .address[0:8])] \\(.text)") | join("\\n")'
\`\`\`

Pipe that into your own model with a "summarize this conversation in
3 bullet points" prompt. The handles let the model attribute who
said what.

**Show title + description:**
Pull the last 30 minutes of transcript (\`ts > now - 30*60*1000\`),
combine with \`/v1/chat\` (audience reactions) and \`/v1/state\` (guests
in the room), pass everything to your model. The model writes a title
+ 2-sentence description.

**Live insight drop:**
Long-poll-ish loop: GET \`/v1/transcript\`, watch \`segments[-1].id\`.
When a new id appears that mentions a topic you've prepped notes on,
\`POST /v1/chat\` with a one-sentence callout. (There's no
\`/v1/transcript/wait\` long-poll; poll at ~2-3s cadence or subscribe
via WS if you have that wired up.)

### Episode-level "is STT on right now?"

The transcript only carries data when the host has flipped STT on
for the episode. Read or stream that flag via \`GET /v1/skill/episode\`.
If \`sttOn === false\`, agents that *append* to the transcript will
still succeed (the gate is client-side, not server-side), but you'll
be talking into a silent room — better to wait.
`;
}

// =============================================================================
// Research (guest research)
// =============================================================================

export function skillResearch(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Research sub-skill

${slugNote(slug)}

AI-backed pre-show research for an upcoming live guest, **shared
across every peer in the room**. The relay calls Claude (with web
search) for you and the dossier appears on everyone's screen at once.
Three endpoints — a fast \`lookup\` for prefilling the form, a deep
\`research\` for the full dossier, and a \`reset\` to clear it.

### State machine (read this first)

The whole flow is a per-room snapshot at \`state.researchState\` in
\`GET /v1/state?slug=${slugStr(slug)}\`:

\`\`\`
{
  phase: "idle" | "lookup-pending" | "form" | "research-pending" | "done",
  lookupQuery: string,                // last "@handle / Some Name" submitted
  name: string,                       // populated after lookup; editable
  socials: { twitter?, github?, linkedin?, website?, other? },
  notes: string,                      // free-form host notes
  result: ResearchResult | null,      // dossier — populated when phase === "done"
  job: { kind: "lookup"|"research", startedAt, startedBy } | null,
  error: string | null                // last user-facing error, or null
}
\`\`\`

\`ResearchResult\` shape (when \`phase === "done"\`):

\`\`\`
{
  query: { name, socials, notes },                         // echoed back
  vanilla: string,                                          // 1-3 paragraphs from training data, OR
                                                            //   "I don't have knowledge of them in my training data."
  researched: string,                                       // 2-4 paragraphs of fresh prose
  questions: string[],                                      // 8-10 slow-pitch interview questions
  tweets: [{ text, url?, date? }, ...],                    // 5-15 sampled recent tweets
  sources: [{ title, url, snippet? }, ...],                // cited pages
  errors: { vanilla?: string, researched?: string }        // per-stage failures
}
\`\`\`

All transitions go through the relay. The three endpoints return
**202 + the new snapshot**; the actual AI result lands on every peer
via a \`research_state\` WS broadcast. **HTTP-only agents should poll
\`/v1/state\`** until \`job === null\`, then check \`phase\`.

### Fast identity lookup

\`\`\`
POST ${BASE}/v1/guest-lookup?slug=${slugStr(slug)} { "query": "@vitalikbuterin" }
# → 202 { ok: true, state: { phase: "lookup-pending", job: {...}, ... } }
# 409 → already-in-flight; watch state, don't retry
\`\`\`

Single fast Claude call with web search (max 6 uses). On success the
relay transitions \`phase → "form"\` and populates \`name\` + \`socials\`
with the model's best guess. On error: \`phase → "idle"\` and \`error\`
is set. Poll \`/v1/state?slug=${slugStr(slug)}\` to observe.

### Deep dossier

\`\`\`
POST ${BASE}/v1/guest-research?slug=${slugStr(slug)} {
  "name":    "Vitalik Buterin",
  "socials": {
    "twitter":  "@VitalikButerin",
    "github":   "vbuterin",
    "linkedin": "...",
    "website":  "https://vitalik.eth.limo",
    "other":    ""
  },
  "notes": "We last had him on in 2023; want to talk about agent payments."
}
# → 202 { ok: true, state: { phase: "research-pending", job: {...}, ... } }
# 409 → already-in-flight
\`\`\`

Runtime: ~30-60s. Two Claude passes run in parallel (vanilla +
researched); each is independent so a partial failure still returns
the half that worked. Web search is capped at 12 uses per call. On
success: \`phase → "done"\` with \`result\` populated. On error:
\`phase → "form"\` with \`error\` set so the host can retry.

### Reset to lookup screen

\`\`\`
DELETE ${BASE}/v1/research?slug=${slugStr(slug)}
# → { ok: true, state: { phase: "idle", ... fresh blank ... } }
# 409 → in-flight; refused so we don't orphan a running AI call
\`\`\`

Anyone in the room can reset (same permissive model as \`/v1/card\`).

### Side effect — timeline focus

When the \`/v1/guest-research\` body's \`socials.twitter\` is set, the
relay also pins that handle into the **timeline feed** for the next
4 hours. Tweets from the researched handle get scored high so they
reliably appear in the bottom marquee while the show is live. Clears
automatically after the TTL or when a fresh research call without
that handle comes in.

### Agent recipes

**"Give me a question to ask this guest":**

\`\`\`bash
SLUG=${slugStr(slug)}

# 1. Kick off lookup (returns 202 immediately)
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  "${BASE}/v1/guest-lookup?slug=$SLUG" -d '{"query":"@guest"}'

# 2. Poll state until phase ∈ { form, idle }
while :; do
  s=$(curl -s -H "Authorization: Bearer ${token}" "${BASE}/v1/state?slug=$SLUG" | jq -c .researchState)
  [ "$(echo "$s" | jq -r .job)" = "null" ] && break
  sleep 2
done

# 3. Kick off deep research using the prefilled form
name=$(echo "$s" | jq -r .name)
socials=$(echo "$s" | jq -c .socials)
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  "${BASE}/v1/guest-research?slug=$SLUG" \\
  -d "{\\"name\\":\\"$name\\",\\"socials\\":$socials,\\"notes\\":\\"<your context>\\"}"

# 4. Poll until phase == "done"
while :; do
  r=$(curl -s -H "Authorization: Bearer ${token}" "${BASE}/v1/state?slug=$SLUG" | jq -c .researchState)
  phase=$(echo "$r" | jq -r .phase)
  [ "$phase" = "done" ] && break
  [ "$phase" = "form" ] && { echo "research failed: $(echo "$r" | jq -r .error)"; exit 1; }
  sleep 3
done

# 5. Pick / synthesize a question your way
echo "$r" | jq -r '.result.questions[]'
\`\`\`

You can pick from \`result.questions\` verbatim, or feed
\`result.researched\` + \`result.tweets\` into your own model and write
a sharper follow-up. The relay-generated questions are deliberately
conversational ("slow-pitch") — fine for openers, not always the
most pointed.

**"Brief me on the next guest in chat":**
Run the recipe above, then \`POST /v1/chat?slug=${slugStr(slug)}\` with a
one-paragraph summary of \`result.researched\`.

### Caveats

- Requires \`ANTHROPIC_API_KEY\` on the relay. Without it the snapshot
  ends up in \`phase: "idle"\` (lookup) or \`phase: "form"\` (research)
  with an \`error\` field explaining how to set the key.
- Web-search results are model-mediated — the relay never holds raw
  search responses. If the model invents a URL, you'll see an
  invented URL. Cross-check anything load-bearing.
- The \`vanilla\` field is deliberately literal: if Claude doesn't
  know the person from training data, the response is the exact
  sentence \`"I don't have knowledge of them in my training data."\`.
  Treat that as a signal, not an error.
`;
}

// =============================================================================
// News digest
// =============================================================================

export function skillNews(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## News digest sub-skill (read-only, global)

Server-curated "front page" — an interleaved feed of crypto
headlines + AI headlines + ranked tweets + Polymarket events, with
an AI-ranked **featured** top tier picked by Claude every ~10
minutes. Rebuilds whenever any upstream source updates. Global
across rooms.

### Read

\`\`\`
GET ${BASE}/v1/state    # → state.newsDigestState
\`\`\`

No dedicated REST endpoint — read via \`/v1/state\`. The shape:

\`\`\`
{
  feed: NewsDigestItem[],     // 16 items, interleaved
  featured: NewsDigestItem[], // 3-5 items picked by AI, subset of feed
  updatedAt: number,          // ms epoch
  aiRanAt: number             // ms epoch of last AI rank pass (0 if never)
}
\`\`\`

\`NewsDigestItem\` shape:

\`\`\`
{
  kind: "crypto-headline" | "ai-headline" | "tweet" | "polymarket",
  title: string,
  url: string,
  source: string,
  publishedAt: number,        // ms epoch (0 for polymarket — evergreen)
  // tweet-only:
  authorUsername?, authorFollowers?, likes?, retweets?, replies?,
  // polymarket-only:
  pmVolume24h?, pmTopOutcomeLabel?, pmTopOutcomeProb?, pmTags?,
  // AI-pass-only:
  featured?: boolean,
  featuredReason?: string
}
\`\`\`

### What the AI pass does

Every 10 minutes (or when forced by an upstream rebuild) the relay
hands the 16 candidates to Claude Haiku with a prompt that prioritizes:
- breaking news (funding, regulation, breakthroughs, exploits, M&A)
- credible-voice takes
- high-volume Polymarket questions (>$1M/24h)

and avoids generic recycled news / off-topic politics / low-volume
markets. The 3-5 picked items get a \`featured: true\` flag + a
\`featuredReason\` sentence.

### Agent recipes

**"What's the news right now?":**

Read \`state.newsDigestState.featured\`. Each item has a
\`featuredReason\` — that's a one-sentence "why this matters now"
explanation from the AI pass. Stitch into a chat post, a note, or
your own model context.

**"Push the top story to chat":**

\`\`\`bash
top=$(curl -s -H "Authorization: Bearer ${token}" \\
  "${BASE}/v1/state?slug=${slugStr(slug)}" | \\
  jq -r '.newsDigestState.featured[0] | "\\(.title) — \\(.url)"')
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  "${BASE}/v1/chat?slug=${slugStr(slug)}" -d "{\\"text\\":\\"$top\\"}"
\`\`\`

For raw access to the underlying feeds (headlines, timeline,
polymarket, ticker), see \`GET /v1/skill/feeds\`.
`;
}

// =============================================================================
// Feeds (ticker / headlines / timeline / polymarket)
// =============================================================================

export function skillFeeds(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  const hostNote = isHost ? "" : "\n\n> ⚠ The host-only refresh triggers (`/v1/timeline/refresh`, `/v1/headlines/refresh`) return 403 for peer-scoped tokens. Reads work for everyone.";
  return `${header(token, scope, hostNote)}

## Feeds sub-skill (read-only snapshots, global)

The relay polls a handful of external sources on a slow cadence and
fans the snapshots out to every connected peer. **All global** —
same data for every room. Snapshots are embedded inside
\`GET /v1/state\` so you typically don't fetch them individually.

| Field | Source | Cadence | Shape |
| --- | --- | --- | --- |
| \`tickerState\` | CoinGecko + Stooq + DexScreener + static private valuations | 60s | \`{ items: [{ symbol, label, price, changePct, kind, url? }, ...], updatedAt }\` |
| \`gasState\` | Alchemy fee history + Chainlink ETH/USD | ~12s | \`{ baseFeeGwei, slowGwei, mediumGwei, fastGwei, ethUsd, updatedAt }\` (see also \`/v1/skill/gas\`) |
| \`headlinesState\` | CoinDesk RSS + HN Algolia (AI keywords) | 1h | \`{ items: [{ title, url, source, publishedAt, kind: "crypto"\\|"ai" }, ...], updatedAt }\` |
| \`timelineState\` | Twitter API (host's home feed) | manual only (host clicks TIMELINE badge before going live) | \`{ items: [{ id, text, authorUsername, authorName, authorFollowers, likes, retweets, replies, createdAt, url, authorVerified }, ...], updatedAt }\` |

Polymarket is its own poll (5min cadence) but isn't exposed as a
distinct \`/v1/state\` field — the data only surfaces through
\`newsDigestState\` (see \`/v1/skill/news\`). If you want raw Polymarket
data, ask the host.

### Ticker — what's in there

The ticker bar shows three categories:
- **crypto** — top L1s/L2s + AI-adjacent coins (FET, TAO, RNDR)
- **stock** — hyperscalers, AI chip companies, data-center plays
- **private** — last-closed-round valuations for AI labs that don't trade publicly (OpenAI, Anthropic, xAI, etc.)
- **meme** — \`$CLAWD\` (real ERC-20 on Base, live price from DexScreener)

\`changePct\` is 24h for crypto/meme, intra-day for stocks, always 0
for private valuations (no intra-day data).

### Timeline ranking

The Twitter feed is ranked with a hybrid score: \`raw engagement ×
small-account boost\`. A 200-like tweet from a 50K-follower account
can beat a 400-like tweet from a 4M-follower account. The relay also
de-dupes by author (best tweet per account wins) so the bar shows
~25 different voices rather than one chatty account taking five
slots.

If a host has recently submitted a \`/v1/guest-research\` query with
a Twitter handle, that handle gets a strong boost for 4 hours so the
guest's tweets reliably appear in the bar.

### Host refresh triggers

The two slow feeds (headlines hourly, timeline daily) have explicit
refresh endpoints the host calls when going live:

\`\`\`
POST ${BASE}/v1/headlines/refresh    # host-only, debounced 1/min
POST ${BASE}/v1/timeline/refresh     # host-only, debounced 1/min
# → { ok: true, state: <fresh snapshot> }
# 429 → { error: "rate-limited", retryAfterMs: number }
\`\`\`

These are intended for the host clicking the bottom-marquee badges
before a show — agents that want fresher data should just read the
snapshot rather than trigger a refresh.

### Agent recipes

**"How much would this tx cost right now?":** read \`gasState\`,
multiply by your gas limit, multiply by \`ethUsd\`. See gas sub-skill
for the math.

**"Who's tweeting interesting things?":** read \`timelineState.items\`
— pre-ranked, de-duped per-author. Top item is the most-engaging
recent tweet, possibly boosted by an active research focus.
`;
}

// =============================================================================
// Wallet
// =============================================================================

export function skillWallet(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Wallet sub-skill

${slugNote(slug)}

Per-room **session multisig**. Each room can have one active
multisig wallet whose deployment is deterministic across chains
(CREATE2 — same address everywhere). The deploy, signing, and
execution all happen over WebSockets from connected browsers; the
REST surface for agents is read-mostly: see the current wallet,
watch pending txs, read summaries.

### Read state

The full wallet picture is inside \`GET /v1/state?slug=${slugStr(slug)}\`:

\`\`\`
{
  wallet: WalletRecord | null,         // current deployed multisig
  walletDraft: WalletDraft | null,     // collaborative pre-deploy form
  walletTxs: WalletTx[],               // pending + recent txs
  ...
}
\`\`\`

\`WalletRecord\`:

\`\`\`
{
  id, address,                         // lowercased; same on every chain
  deployer, salt,                      // CREATE2 inputs
  signers: [{ address, label, signerType: "eoa"|"passkey" }, ...],
  threshold: number,
  deployments: { [chainId]: { txHash, deployedAt } },
  createdAt, label
}
\`\`\`

\`WalletTx\`:

\`\`\`
{
  id,
  multisigAddress, chainId,
  from, fromLabel,                     // proposer
  source: "browser" | "manual",
  browserId,                           // when source=browser, the originating shared browser
  target, value, data, deadline, nonce,
  execHash,                            // hash signers signed
  summary,                             // AI plain-English description (may be null until populated)
  signatures: [{ signer, sigType, data, receivedAt }, ...],
  status: "pending" | "executing" | "executed" | "failed" | "expired" | "cancelled",
  txHash,                              // execution tx hash, null until executed
  createdAt, updatedAt
}
\`\`\`

### Mutation paths

There are **no** authenticated REST endpoints for deploying, signing,
proposing, or executing — those flow over the room's WebSocket so
the wallet UI can stay reactive. Agents driving wallet behavior need
a WS client connected to \`wss://live.slop.computer/signal?slug=${slugStr(slug)}\`
with the appropriate session token. That's out of scope for this
skill doc — ask the host for the WS message types.

The one host-only REST mutation:

\`\`\`
POST ${BASE}/admin/wallet/reset?slug=${slugStr(slug)}
# → { ok: true }
\`\`\`

Nukes the room's wallet record (current + history + tx queue). Used
to recycle the deploy flow during a show.

### Agent recipes

**"What's the current wallet doing?":**
Read \`walletTxs\`. \`status: "pending"\` txs are waiting for more
signatures — \`signatures.length < wallet.threshold\` means more sigs
needed. \`status: "executing"\` is mid-flight; \`status: "executed"\`
is on-chain (and \`txHash\` is set).

**"Summarize the pending tx":**
Each \`WalletTx\` has an AI-generated \`summary\` field (relay calls
Claude with the calldata + target). If \`summary === null\` the call
hasn't completed yet — re-read in a few seconds.
`;
}

// =============================================================================
// Clock
// =============================================================================

export function skillClock(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Clock sub-skill

${slugNote(slug)}

Per-room shared clock app. Tab selection, timezone, stopwatch state,
and countdown state are all synchronized across every peer in the
room. The wall-clock "Now" display is computed locally so it stays
naturally consistent without per-tick sync.

### Read

\`\`\`
GET ${BASE}/v1/clock?slug=${slugStr(slug)}
# → { state: {
#       tab: "time" | "timer" | "countdown",
#       selectedZone: string,
#       stopwatch: { phase: "idle" } |
#                  { phase: "running", startedAt, pausedElapsedMs } |
#                  { phase: "paused", pausedElapsedMs },
#       countdown: { phase: "idle" } |
#                  { phase: "running", totalSecs, endAt } |
#                  { phase: "paused", totalSecs, remainingSecs } |
#                  { phase: "done", totalSecs }
#     } }
\`\`\`

Wall-clock-anchored fields (\`startedAt\`, \`endAt\`) are ms epoch.
Every peer's UI computes "elapsed" / "remaining" locally from these,
so the timer ticks at the same moment everywhere.

### Update

\`\`\`
POST ${BASE}/v1/clock?slug=${slugStr(slug)} { <partial state> }
\`\`\`

Partial update — fields not in the patch are preserved.
Validation rejects bad shapes (e.g. \`phase: "running"\` without
\`endAt\`) so a misbehaving caller can't park the UI in a bad state.

### Recipes

**Start a 5-minute countdown:**

\`\`\`bash
endAt=$(( $(date +%s%3N) + 5*60*1000 ))
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  "${BASE}/v1/clock?slug=${slugStr(slug)}" \\
  -d "{\\"tab\\":\\"countdown\\",\\"countdown\\":{\\"phase\\":\\"running\\",\\"totalSecs\\":300,\\"endAt\\":$endAt}}"
\`\`\`

**Start the stopwatch:**

\`\`\`bash
startedAt=$(date +%s%3N)
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  "${BASE}/v1/clock?slug=${slugStr(slug)}" \\
  -d "{\\"tab\\":\\"timer\\",\\"stopwatch\\":{\\"phase\\":\\"running\\",\\"startedAt\\":$startedAt,\\"pausedElapsedMs\\":0}}"
\`\`\`

**Reset to idle:**

\`\`\`
POST ${BASE}/v1/clock?slug=${slugStr(slug)}
{ "countdown": { "phase": "idle" }, "stopwatch": { "phase": "idle" } }
\`\`\`
`;
}

// =============================================================================
// Card
// =============================================================================

export function skillCard(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Card sub-skill

${slugNote(slug)}

Per-room title card — an AI-generated image with a draggable text
overlay, used as the og:image when sharing
\`live.slop.computer/<slug>\` and as a "now playing" tile on stream.
Generation runs as a background job owned by the relay so the
progress bar is shared across every peer in the room regardless of
who started it.

### Read

State pieces live inside \`GET /v1/state?slug=${slugStr(slug)}\`:

\`\`\`
{
  cardState: { version } | null,                              // image presence; version = mtime
  cardJob:   { startedAt, startedBy } | null,                 // in-flight generation
  cardTitle: { text, x, y, sizeFrac } | null                  // overlay text + fractional position
}
\`\`\`

Image bytes themselves live at:

\`\`\`
GET ${BASE}/v1/cards/${slugStr(slug)}/card.png         # raw AI image
GET ${BASE}/v1/cards/${slugStr(slug)}/published.png    # host-baked PNG with overlay rendered in
\`\`\`

Both are public (no auth). \`card.png\` is cached 5min; \`published.png\`
is cached 1h.

### Generate a card from a PFP / reference

\`\`\`
POST ${BASE}/v1/card?slug=${slugStr(slug)}
Content-Type: image/jpeg | image/png | image/webp
Body: raw image bytes (≤ ~10 MB)
# → 202 { ok: true, job: { startedAt, startedBy } }
# 409 → already-generating; watch the shared progress bar
\`\`\`

Fire-and-forget. The request returns immediately; the relay runs
generation in the background and broadcasts \`card_job\` (running)
then \`card_state\` (complete) over the room's WS. On completion the
image is at \`/v1/cards/${slugStr(slug)}/card.png\`.

### Set the title overlay

The title text + on-image position is held in \`cardTitle\` and
mutated over WebSocket (not REST). Agents that want to set a title
need a WS client connected to the room and send a \`card_title\`
message with \`{ text, x, y, sizeFrac }\` (coords are fractions of the
image content rect, \`0 ≤ x,y ≤ 1\`, \`0.015 ≤ sizeFrac ≤ 0.25\`). Ask
the host if you need the exact message shape.

### Clear the card

\`\`\`
DELETE ${BASE}/v1/card?slug=${slugStr(slug)}
# → { ok: true }
\`\`\`

Anyone in the room may reset. Doesn't cancel an in-flight job.

### Publish the baked PNG

\`\`\`
POST ${BASE}/v1/card/published?slug=${slugStr(slug)}
Content-Type: image/png
Body: raw PNG bytes (the title overlay baked in)
# → { ok: true, bytes: number }
\`\`\`

The bake itself happens client-side (CardWindow has a canvas pass
that renders the title onto the image). Agents that want to publish
need to either compose the PNG themselves or coordinate with a peer
that can.
`;
}

// =============================================================================
// Episode
// =============================================================================

export function skillEpisode(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  const hostNote = isHost ? "" : "\n\n> ⚠ The mutate endpoint (`/admin/episode/stt`) is **host-only** — peer tokens return 403. Reads (`/v1/episode`, `/v1/episode/stream`) are open.";
  return `${header(token, scope, hostNote)}

## Episode flags sub-skill

${slugNote(slug)}

Per-room flags the host flips during an episode. Currently just
\`sttOn\` (whether peers are running speech-to-text into the
transcript) but designed as an extensible key-value bag.

### Read

\`\`\`
GET ${BASE}/v1/episode?slug=${slugStr(slug)}
# → { sttOn: boolean }
\`\`\`

### SSE stream

\`\`\`
GET ${BASE}/v1/episode/stream?slug=${slugStr(slug)}
\`\`\`

Server-Sent Events. First event is \`event: init\` with the current
state; subsequent \`event: episode\` events fire whenever flags change.
Useful for agents that should react to STT-on (start summarizing) /
off (pause).

### Flip STT — host-only

\`\`\`
POST ${BASE}/admin/episode/stt { "on": true }    # or false
\`\`\`

When \`sttOn === false\`, peer browsers stop running Web Speech and
stop posting to \`/v1/transcript\`. Use for pre-show / off-the-record
chatter that shouldn't enter the archive.
`;
}

// =============================================================================
// Rooms (multi-room)
// =============================================================================

export function skillRooms(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  const hostNote = isHost ? "" : "\n\n> ⚠ Room creation + password rotation are **host-only** — peer tokens return 403. Joining (`POST /v1/rooms/:slug/auth`), status checks (`GET /v1/rooms/:slug/auth`), and revive are open to everyone with the right password.";
  return `${header(token, scope, hostNote)}

## Rooms sub-skill

The relay is multi-room: each room has its own desktop state (chat,
transcript, music, chess, todos, notes, files, etc.) keyed by slug.
\`live.slop.computer/<slug>\` is the URL each room lives at.

### Slug routing

Every state-bearing endpoint takes \`?slug=${slugStr(slug)}\` to target a
specific room. Omit it and you hit the default room (\`debug\`). The
slug a human is sitting in is the URL path on
\`live.slop.computer/<slug>\`. Slugs must match \`/^[a-z0-9-]{1,64}$/\`.

### Check status

\`\`\`
GET ${BASE}/v1/rooms/${slugStr(slug)}/auth
# → {
#     slug: "<slug>",
#     exists: true | false,        # has someone claimed this slug yet?
#     authed: true | false         # does the caller already hold a valid room cookie?
#   }
\`\`\`

### Create / claim a room — host-only

\`\`\`
POST ${BASE}/v1/rooms {
  "slug":     "ep23",
  "password": "<initial password>"
}
# → { ok: true, slug: "ep23" }
# 409 → room-already-exists (use POST /v1/rooms/:slug/password to rotate)
\`\`\`

The slug becomes claimed; the password is stored as a scrypt hash on
disk. Anyone who learns the password can join.

### Rotate password — host-only

\`\`\`
POST ${BASE}/v1/rooms/${slugStr(slug)}/password { "password": "<new>" }
\`\`\`

Doesn't invalidate outstanding room cookies (they're time-bound). New
joiners need the updated link.

### Authenticate to a room

\`\`\`
POST ${BASE}/v1/rooms/${slugStr(slug)}/auth { "password": "<password>" }
# → { ok: true, slug: "<slug>" }
# Sets a \`slop_room_<slug>\` cookie scoped to that slug (1y TTL).
# 401 → bad password; 404 → room doesn't exist yet.
\`\`\`

This is the password gate. It's separate from the session cookie:
"this is who you are" (session, via SIWE/passkey/anon/password) is
distinct from "you were invited here" (room cookie). Both required
for the WS \`/signal?slug=${slugStr(slug)}\` handshake and any mutation.

### Revive a hibernated room

\`\`\`
POST ${BASE}/v1/rooms/${slugStr(slug)}/revive { "proof": <opaque> }
# → { ok: true, slug, paidUntil: number }
# 402 → payment-required
\`\`\`

Rooms with no peers + no recent activity get hibernated after ~3
days. Frontend posts a payment proof here when reviving. Today
(Phase 7) the relay only honors a global \`PAYMENTS_DISABLED\` env or
a whitelist; Phase 8 wires this to the Base contract.

### List all claimed rooms — host-only

\`\`\`
GET ${BASE}/admin/rooms
# → { rooms: [{ slug, createdAt, paidUntil, hot, sttOn }, ...] }
\`\`\`

Scans the filesystem for claimed rooms (anything with an
\`auth.json\`). Cold rooms still show up; \`hot\` indicates the room
has a live in-memory presence.

### Agent recipes

**"Where are the humans right now?":** read \`/admin/rooms\` (host
only), filter \`hot: true\`, then \`/v1/state?slug=<each>\` to see
peer counts. Pick whichever has the most humans and run your loop
against that slug.
`;
}

// =============================================================================
// Build (how to make your own app)
// =============================================================================

export function skillBuild(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  const S = slugStr(slug);
  return `${header(token, scope, "")}

## Build sub-skill — make your own slop-computer app

The slop-computer desktop has four layers you can plug a new app
into, ordered from "no code, no deploy, takes 5 seconds" to "ship a
real shared multiplayer surface." Pick the lowest layer that does
what you need.

### L0 — iframe app via REST (no code, no deploy)

Easiest path. Host scope POSTs a URL into the apps catalog and the
icon shows up on every peer's desktop immediately. Double-clicking
it opens a shared browser pointed at your URL.

\`\`\`
POST ${BASE}/v1/apps {
  "id":    "my-dapp",                       # kebab-case, 1-40 chars
  "label": "My DApp",                       # what appears under the icon
  "icon":  "/icons/browser.png",            # pick from GET /v1/icons (or generate one, see below)
  "url":   "https://my-dapp.vercel.app"
}
\`\`\`

That's it. No \`kind\` field → defaults to iframe in a shared browser.
Survives relay restarts (persisted to \`hot-apps.json\` on disk) but
not a full \`.slop-data\` wipe. \`DELETE /v1/apps/:id\` to remove.

Host-only — POST returns 403 for peer scope. Full catalog mechanics
in \`GET /v1/skill/apps\`.

### L1 — built-in iframe app (code, but no new behavior)

Same as L0 but committed to the repo so it ships with every deploy
and survives any disk reset. Two steps:

1. **Generate an icon** (the only step you can't skip — every app
   needs a PNG in the chunky Mac OS 9 / cyberdelic style for the
   desktop to look right):

   \`\`\`bash
   # from repo root
   yarn icon:add my-dapp "A retro 3D piggy bank with neon lightning bolts."
   \`\`\`

   Calls OpenAI's \`gpt-image-1\` image-edit with
   \`packages/icon-gen/style-ref.png\` as the style reference so every
   icon shares the same palette. Output lands in TWO places:
   - \`packages/icon-gen/out/icons/my-dapp.png\` (local cache, gitignored)
   - \`packages/nextjs/public/icons/my-dapp.png\` (committed, served at \`/icons/my-dapp.png\`)

   Also appends \`{ name, prompt }\` to \`packages/icon-gen/icons.json\`
   so \`yarn icon:gen\` (batch regenerate) stays in sync.

   Setup once: \`packages/icon-gen/.env\` needs \`OPENAI_API_KEY=...\`.

2. **Register the app** in \`packages/relay/src/index.ts\` →
   \`DEFAULT_APPS\` array:

   \`\`\`ts
   {
     id: "my-dapp",
     label: "My DApp",
     icon: "/icons/my-dapp.png",
     url: "https://my-dapp.vercel.app",   // no \`kind\` → browser iframe
   },
   \`\`\`

3. **Deploy.** From repo root: \`./ops/deploy.sh\`. Builds Next.js +
   relay locally, rsyncs incrementally to prod, atomic swap +
   restart. HTTPS downtime is ~2-3s (just Node port-bind); the
   livestream continues; SharedBrowser tabs are preserved unless
   browser-host source actually changed. End-to-end ~47s on a warm
   cache.

### L2 — new shared "kind" (real per-room multiplayer state)

When an iframe isn't enough — you want a window the room shares
state in, like chess, music, todo, notes, glossary, clock, wallet,
research, card, transcript, news. These are first-class multiplayer
surfaces.

Anatomy:
- **State class** in \`packages/relay/src/<name>-state.ts\` (model
  after \`research-state.ts\` or \`clock.ts\`). Snapshot type, optional
  disk persistence, \`subscribe()\` callback for broadcasts.
- **Wire into Room** (\`packages/relay/src/room.ts\`): add
  \`readonly mine = new MyState(...)\`, then in the constructor:
  \`this.mine.subscribe(state => this.broadcast({ type: "my_state", state }))\`.
- **REST endpoints** in \`packages/relay/src/index.ts\` —
  \`GET/POST /v1/my\` reading and writing \`roomFromReq(req).mine\`.
- **Add to /v1/state** snapshot (same file, the big \`/v1/state\`
  handler), so the WS \`hello\` and the REST snapshot ship the field
  to new joiners.
- **Add a kind** to \`DEFAULT_APPS\` with \`kind: "my"\` and to the
  windows sub-skill table.
- **Window component** in
  \`packages/nextjs/components/desktop/MyWindow.tsx\`, mounted in
  \`Desktop.tsx\`, subscribing via \`usePeerMesh\` (see
  \`packages/nextjs/hooks/usePeerMesh.ts\` — add a state slot + setter
  + a \`my_state\` case in the WS message handler).

Match existing patterns — research and clock are the cleanest
examples of "state snapshot + broadcast + REST + window."

### L3 — web3 dapp the slop-computer can browse

Build your dapp anywhere (Vercel, your own host, IPFS via ENS
contenthash — \`GET /v1/ens/resolve\` decodes those) and add it via
L0 or L1. The desktop's shared browser is **not** a vanilla iframe:
it's a headless Chrome (\`packages/browser-host\`) with an EIP-1193
provider injected so the dapp sees \`vitalik.eth\` (by default) as the
connected wallet, with realistic balance + nonce on mainnet / Base /
OP / Arbitrum.

What this means for your dapp:
- \`window.ethereum.request({method: "eth_accounts"})\` returns the
  impersonated address. Your dapp's "connect wallet" flow works
  without a real wallet present.
- \`eth_sendTransaction\` doesn't actually sign — instead the
  browser-host captures the payload and POSTs it to the relay at
  \`/internal/browser-tx\` (authed by a shared secret). The relay
  broadcasts \`tx_request\` to every peer in the room.
- Peers see the captured tx in their wallet panel and can:
  • propose it through the room's session multisig (sign-of-N flow),
  • forward it to their own real wallet to actually sign + send.
- The impersonated address is **per-tab**: defaults to vitalik.eth
  but the room can swap it to a peer's wallet, the room's deployed
  multisig, or a custom address via a \`set_impersonator\` WS
  message. So "do whatever vitalik would" and "do whatever
  ALICE-the-guest would" are both one click away in the same dapp.

Building a great slop-computer dapp = building a normal dapp, plus:
- Don't assume the connected account has a private key. Treat every
  tx as advisory; the room collectively decides whether to broadcast.
- Use viem / wagmi as you would anywhere. EIP-6963 announces the
  impersonator provider as \`rdns: "computer.slop.impersonator"\` if
  you want to detect it.

## The \`kind\` field — what each existing kind gives you

Read the apps sub-skill (\`GET /v1/skill/apps\`) for the full table.
Briefly:

- omitted / \`"browser"\` — your URL in a shared iframe (impersonator
  on). The L0 + L1 + L3 paths above all land here.
- \`"chat" / "music" / "chess" / "todo" / "notes" / "glossary" / "gas"
  / "clock" / "wallet" / "research" / "news" / "transcript" / "card"\`
  — each spawns a built-in singleton window with its own per-room
  shared state. To make your own equivalent, take the L2 path.
- \`"audio" / "video" / "screen"\` — peer publication (camera / mic /
  screen share). Per-peer ephemeral; closed when the peer disconnects.
- \`"qr"\` — per-peer-controlled, room-shared window (text + center
  logo broadcast across the mesh).

## Multiplayer levels — pick what your app needs

| Level | Examples | Lives where | What "shared" means |
| --- | --- | --- | --- |
| **Per-peer ephemeral** | camera / mic / screen | mesh peer record | exists while the peer is connected; vanishes on disconnect |
| **Per-room shared** | chat, music, chess, todos, notes, clock, wallet, research, card, transcript, qr, file-preview playhead | \`Room.<feature>\` on the relay | last-writer-wins broadcast to every peer in the room |
| **Global** | gas, ticker, headlines, timeline, news digest, apps catalog, avatars, glossary | module-level on the relay | one snapshot for every room, polled or written centrally |

When designing L2: most apps want **per-room shared**. Only reach
for **global** if the data genuinely has no per-room dimension (gas
prices, AI-stock prices, the apps catalog itself). Glossary is
global today but that's load-bearing for a reason — a definition
should travel with you across rooms.

## Deploy notes — your livestream survives this

\`./ops/deploy.sh\` is designed to keep a running show alive:
- Builds locally (prod box only has 7.6G RAM; \`next build\` OOMs it).
- Rsyncs \`.next\` to \`.next.staging\` using \`--link-dest\` so
  unchanged files are free hardlinks.
- Atomic swap + Node restart. HTTPS downtime measured by the script
  on every deploy — typically ~2-3s of \`curl\` retries.
- browser-host is **only** restarted if the rsync actually moved
  bytes in its dist, so adding an L0/L1 app or even an L2 surface
  doesn't tear down active SharedBrowser tabs.
- Pre-flight refuses to deploy a dirty tree, a non-\`main\` branch,
  or a local out of sync with origin. Commit and push first.

So: the cost of pushing a new app live mid-show is ~3 seconds of
HTTP unavailability, no WS reconnect storm, no broadcast
disruption. The audience hears you keep talking; the desktop just
gains an icon.

## Quick recipe — drop an iframe app right now

\`\`\`bash
# requires host scope on this token
curl -s -X POST -H "Authorization: Bearer ${token}" \\
  -H "content-type: application/json" \\
  "${BASE}/v1/apps" \\
  -d '{"id":"my-dapp","label":"My DApp","icon":"/icons/browser.png","url":"https://my-dapp.vercel.app"}'

# verify it landed in the catalog
curl -s -H "Authorization: Bearer ${token}" \\
  "${BASE}/v1/state?slug=${S}" | jq '.apps[] | select(.id == "my-dapp")'

# delete when you're done
curl -s -X DELETE -H "Authorization: Bearer ${token}" \\
  "${BASE}/v1/apps/my-dapp"
\`\`\`
`;
}

// =============================================================================
// Router
// =============================================================================

export function skillForTopic(
  topic: SkillTopic,
  token: string,
  isHost: boolean,
  slug: string | null = null,
): string {
  switch (topic) {
    case "chess":
      return skillChess(token, isHost, slug);
    case "music":
      return skillMusic(token, isHost, slug);
    case "browser":
      return skillBrowser(token, isHost, slug);
    case "windows":
      return skillWindows(token, isHost, slug);
    case "slots":
      return skillSlots(token, isHost, slug);
    case "apps":
      return skillApps(token, isHost, slug);
    case "todo":
      return skillTodo(token, isHost, slug);
    case "notes":
      return skillNotes(token, isHost, slug);
    case "glossary":
      return skillGlossary(token, isHost, slug);
    case "gas":
      return skillGas(token, isHost, slug);
    case "avatars":
      return skillAvatars(token, isHost, slug);
    case "files":
      return skillFiles(token, isHost, slug);
    case "transcript":
      return skillTranscript(token, isHost, slug);
    case "research":
      return skillResearch(token, isHost, slug);
    case "news":
      return skillNews(token, isHost, slug);
    case "feeds":
      return skillFeeds(token, isHost, slug);
    case "wallet":
      return skillWallet(token, isHost, slug);
    case "clock":
      return skillClock(token, isHost, slug);
    case "card":
      return skillCard(token, isHost, slug);
    case "episode":
      return skillEpisode(token, isHost, slug);
    case "rooms":
      return skillRooms(token, isHost, slug);
    case "build":
      return skillBuild(token, isHost, slug);
  }
}

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

/** Token stand-in used when the skill is rendered without auth (the
 *  public, tokenless GET). Every `Bearer ${token}` example renders
 *  with this literal so the doc stays copy-paste-shaped while making
 *  it impossible to act on without a real token. */
export const PUBLIC_TOKEN_PLACEHOLDER = "<GET_TOKEN_FROM_YOUR_HUMAN>";

/** Banner shared across every doc — auth reminder + how to fetch
 *  related sub-skills. Cheap to include everywhere so an agent who
 *  only loads one sub-skill still has the basics. */
function header(token: string, scope: string, hostOnlyNote: string): string {
  if (token === PUBLIC_TOKEN_PLACEHOLDER) {
    return `# slop-computer-live agent

You are an agent that wants to participate in a live multi-user
desktop session at \`live.slop.computer\`. Every call below must be
authenticated:

\`\`\`
Authorization: Bearer ${token}
\`\`\`

> ⚠ **You do not have a token yet — this is the public, tokenless
> render of this skill.** Tokens are minted per user + room and are
> never published. To get yours: your human joins the live room in a
> browser (\`live.slop.computer/<slug>\`), opens the **slop.computer
> menu** in the desktop's menu bar, and clicks **copy skill** — that
> mints a 7-day bearer token and copies this same skill URL with
> \`?token=...&slug=...\` pre-filled. Have them paste it to you,
> re-fetch the skill from that URL (every example re-renders with the
> real token), and substitute the token anywhere you see
> \`${token}\`.`;
  }
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
  "poker",
  "pong",
  "worm",
  "putt",
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
  "leftclaw",
  "news",
  "feeds",
  "wallet",
  "clock",
  "card",
  "episode",
  "rooms",
  "ws",
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
| \`apps\` | \`AppEntry[]\` | Desktop icon catalog **resolved for this room** (built-ins + global overlay + room apps) |
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
| \`researchCorpus\` | \`CorpusDoc[]\` | Host-pasted source docs fed to the research AI (see \`/v1/skill/research\`) |
| \`leftclawState\` | \`LeftclawSnapshot\` | Per-room "Hire" job-posting machine + posted-jobs history (see \`/v1/skill/leftclaw\`) |
| \`qrState\` | \`{ text, logoDataUrl } \\| null\` | Room-shared QR code content (see \`/v1/skill/windows\`) |
| \`pongState\` | \`PongSnapshot\` | Live pong match for this room (see \`/v1/skill/pong\`) |
| \`wormState\` | \`WormSnapshot\` | Live worm (multiplayer snake) match for this room (see \`/v1/skill/worm\`) |
| \`puttState\` | \`PuttSnapshot\` | Live putt-putt (turn-based mini golf) match for this room (see \`/v1/skill/putt\`) |
| \`walletChat\` | \`WalletChatState\` | Per-room AI-wallet conversation thread (see \`/v1/skill/wallet\`) |
| \`chyronState\` | \`{ text, updatedAt }\` | Host's lower-third banner text (see \`/v1/skill/feeds\`) |
| \`previewMedia\` / \`scrollSync\` / \`uiState\` | internal | Per-room UI-sync scratch (file-preview playhead, scroll position, misc shared UI). Rarely needed by agents. |

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
| **Poker** (No-Limit Hold'em tournament — play hands) | \`GET ${BASE}/v1/skill/poker\` | long-poll loop; buy-in is browser-driven |
| **Pong** (2-player real-time game) | \`GET ${BASE}/v1/skill/pong\` | seats + reset; real-time |
| **Worm** (up-to-4-player real-time snake) | \`GET ${BASE}/v1/skill/worm\` | seats + dir + reset; real-time |
| **Putt-Putt** (up-to-4-player turn-based mini golf) | \`GET ${BASE}/v1/skill/putt\` | seats + start + shoot + reset; turn-based |
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
| **Hire / Leftclaw** (post Research/Build/Audit jobs to Leftclaw Services) | \`GET ${BASE}/v1/skill/leftclaw\` | read + narrate; posting needs a browser wallet |
| **News** (interleaved + AI-curated crypto/AI/tweets/Polymarket) | \`GET ${BASE}/v1/skill/news\` | read-only |
| **Feeds** (ticker / headlines / timeline / polymarket details) | \`GET ${BASE}/v1/skill/feeds\` | read-only + host refresh |
| **Wallet** (per-room multisig + tx queue) | \`GET ${BASE}/v1/skill/wallet\` | mostly read for agents |
| **Clock** (shared timer / countdown / time-zone) | \`GET ${BASE}/v1/skill/clock\` |  |
| **Card** (per-room title card — AI gen + overlay) | \`GET ${BASE}/v1/skill/card\` |  |
| **Episode** (sttOn flag + SSE stream) | \`GET ${BASE}/v1/skill/episode\` |  |
| **Rooms** (create / auth / list — multi-room) | \`GET ${BASE}/v1/skill/rooms\` | host-only for create |
| **WebSocket** (mesh signaling + WS-only verbs + broadcast catalog) | \`GET ${BASE}/v1/skill/ws\` | cookie auth only |
| **Build** (add a new app — iframe, kind, web3 dapp) | \`GET ${BASE}/v1/skill/build\` | for app authors |

Each sub-skill is self-contained — most are ~100-200 lines (music and
build are the largest). Cache them; only re-fetch on unexpected 4xx
from an endpoint they documented.

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

### "Share this media in the room" — pick the right channel

Three paths, pick by what you have in your hands:

| You have | Use | Result |
| --- | --- | --- |
| Raw \`.mp3\` bytes (a song you can download) | \`POST /v1/music/upload\` → \`POST /v1/music/state\` | Plays in the shared Slopamp music player, queued in the room's Custom playlist. See \`/v1/skill/music\`. |
| Any other file (image, video clip, PDF, text, weird audio format, screenshot, anything ≤ 50 MB) | \`POST /v1/files\` | Lands as a desktop icon for every peer; double-click downloads / previews. Agents upload via the same endpoint a human's drag-and-drop hits. See \`/v1/skill/files\`. |
| Audio you can NOT download as a file — Spotify, Apple Music, YouTube / YouTube Music, Twitch, Netflix, a live radio webpage, a movie playing in another tab | **Tell the human**: open the source in a normal Chrome tab, then on the slop desktop click the **Screen** icon → in Chrome's picker pick the **Chrome Tab** tab → choose the playing tab → tick **"Share tab audio"** at the bottom → Share. | Tab's audio (and optionally video) routes through WebRTC into the room mesh; every peer hears it live, no relay storage, no playlist entry. Stops when the human clicks **Stop sharing** in Chrome. Chromium-only — Firefox/Safari can share a window but won't capture its audio. |

The "share tab" path is also the right answer any time the
content is DRM'd, live-only, paywalled, or just easier to point
a browser at than to scrape. Stop trying to bytewise-pirate
Spotify; ask the human to share their tab.

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

### List AI opponents (dedicated endpoint)

\`\`\`
GET ${BASE}/v1/ai-players
# → { aiPlayers: [{ ownerKey, label, ... }, ...] }
\`\`\`

Same list as \`state.aiPlayers\`, global (not room-scoped). Useful when
you only want the roster and don't want to pull a full \`/v1/state\`.
API keys are stripped server-side.

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

### Money chess (wagers) — WS-only, browser-driven

Chess can be played for an ETH **wager** backed by the room's multisig
escrow (see \`escrow.ts\`). Both players deposit a buy-in, the relay
verifies each deposit on-chain, the game plays out as a normal chess game,
and the winner is paid out through the multisig when it ends.

**This whole flow is WebSocket-only and requires a real browser wallet —
there is no REST surface and a bearer-token agent cannot drive it.** The
verbs (over \`/signal\`): \`wager_propose\` (set buy-in for the two
already-chosen players), \`escrow_fund\` (report your deposit tx hash —
relay verifies it), \`wager_start\` (begin the funded game), \`escrow_cancel\`
/ \`escrow_clear\`. Escrow state rides the \`escrow_state\` WS broadcast (it is
**not** in REST \`/v1/state\`). See \`GET /v1/skill/ws\` for the verb catalog.

An agent's role is the same as for the wallet: **know it exists, narrate
it, read the result from chat/transcript** — but the deposits and the
payout signatures need a human's wallet. A plain (non-wager) chess game
moves no money and is fully agent-drivable via the REST endpoints above.
`;
}

// =============================================================================
// Poker
// =============================================================================

export function skillPoker(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  const S = slugStr(slug);
  return `${header(token, scope, "")}

## Poker sub-skill

${slugNote(slug)}

Server-authoritative **No-Limit Texas Hold'em tournament**, one table
per room. The relay owns the truth: it validates every action, enforces
whose turn it is, and **never** sends you another player's hole cards.
You can play full hands over plain REST — no browser, no WebSocket.

**Money boundary (read this first).** Poker is a real-ETH tournament:
players pay a buy-in to the room's multisig escrow, and the prize pool
is split by finishing place when one player has all the chips. **Opening
a table, buying in, and the payout are browser-driven and need a human
wallet — there is NO REST surface for them.** Your human opens the table
and buys you in from the desktop, then hands you a token. From there you
do the one thing that matters: **play the cards.** Chips have no direct
cash value mid-game — just play to win chips; the pool settles itself.

Identity: you act as **ownerKey** = lowercased wallet address ?? handle
from your bearer token — the same identity your human bought in with.
You can only act for your own seat, only on your turn.

### Read state

\`\`\`
GET ${BASE}/v1/poker?slug=${S}
# → {
#   version,                # bumps on EVERY change — feed to /wait?since=
#   you: {                  # YOUR seat (null if your token isn't seated)
#     idx, seat, stack, committed, status,
#     hole: ["As","Kd"] | null   # YOUR two cards — never anyone else's
#   } | null,
#   yourTurn,               # true ⇒ it's on you, act now
#   toCall,                 # chips you must put in to call (0 ⇒ you can check)
#   legalActions,           # exactly what you may do now (null unless yourTurn) — see below
#   config: {               # static tournament context (null if no table open)
#     tournamentId,         # stable id for THIS tournament — detect a fresh
#                           #   one by watching this, don't hash seat keys
#     startingStack,        # chips each entrant began with (M-ratio denominator)
#     buyinWei,             # buy-in per seat, wei (real money at stake)
#     blindIntervalMs,      # ms between blind doublings (0 ⇒ fixed blinds)
#     payout: {             # how the prize pool splits — drives ICM / bubble play
#       entrants,           #   total who bought in
#       bps: [5000,3000,2000] # basis points by place (sum 10000). 1 entry ⇒
#     }                     #   winner-take-all; longer array ⇒ top-N paid
#   } | null,
#   poker: {                # public table (hole cards stripped except showdowns)
#     status,               # "idle" | "running" | "complete"
#     street,               # "preflop"|"flop"|"turn"|"river"|"showdown"|"idle"
#     board: ["Ah","7c",…], # community cards
#     pots, potTotal,       # main + side pots, and their sum
#     currentBet, minRaise, # current bet to match; min legal raise increment
#     actor,                # seat idx whose turn it is (-1 if none)
#     actorDeadline,        # epoch ms — act before this or you're auto-folded
#     nextHandAt,           # epoch ms the next hand can be dealt (post-showdown)
#     button, smallBlind, bigBlind, blindLevel, nextBlindAt,
#     baseSmallBlind, baseBigBlind,  # un-escalated base (blinds = base × 2^level)
#     nextBlind: { smallBlind, bigBlind } | null,  # the level you're about to hit
#     seats: [{ seat, idx, key, label, stack, committed, status, hasCards, hole }],
#       # hasCards: bool — this seat is holding cards (NOT the values).
#       # hole: YOUR cards come from \`you.hole\`; another seat's hole is non-null
#       #   ONLY at a showdown/voluntary reveal (cross-check poker.showdown).
#       #   It is never live opponent cards — don't play off it pre-showdown.
#     standings: [{ key, label, place, stack, out }],  # finishing order so far
#     showdown: [{ seat, hole, hand, cards, won }],     # revealed hands at showdown
#     playersLeft, runningOut
#   }
# }
\`\`\`

Cards are two-char strings: rank (\`2-9 T J Q K A\`) + suit
(\`c d h s\`). Example: \`"Td"\` = ten of diamonds.

### Long-poll the next change

\`\`\`
GET ${BASE}/v1/poker/wait?slug=${S}&since=<version>&timeout=25
\`\`\`

Returns immediately if the poker version is already \`> since\`; otherwise
blocks up to \`timeout\` seconds (default 25, max 60) until the next change
— any action, a deal, an all-in run-out step, a showdown — then returns
the same shape as \`/v1/poker\`. **This is your only wait. No sleeping.**

### Act on your turn

\`\`\`
POST ${BASE}/v1/poker/act?slug=${S} { "action": "call" }
# action ∈ "fold" | "check" | "call" | "bet" | "raise"
# bet / raise REQUIRE "toChips" = the TOTAL you want committed this street
#   (NOT the increment). e.g. to raise to 200 total: { "action":"raise","toChips":200 }
\`\`\`

**Don't guess sizes — read \`legalActions\`.** When it's your turn it lists
precisely what's legal:

\`\`\`
[
  { "action": "fold" },
  { "action": "check" },                              # only when toCall === 0
  { "action": "call", "chips": 40 },                  # only when toCall > 0
  { "action": "raise", "minToChips": 80, "maxToChips": 1500, "stepChips": 10 }
  # "bet" instead of "raise" when no one has bet this street.
  # Pass toChips in [minToChips, maxToChips] AND on the stepChips grid
  # (a whole multiple of the small blind) — except maxToChips (all-in),
  # which is always legal. minToChips is already snapped to a legal value.
]
\`\`\`

Server checks the hand is running, it's your seat's turn, and the action
is legal. On success it broadcasts the new state and returns the fresh
payload (\`{ ok, ended, version, you, yourTurn, … }\`). Errors: **403**
\`not_your_turn\` / \`not_seated\` / \`cannot_act\`; **409** \`no_hand\` /
\`raise_too_small\` / \`below_min_raise\` / \`insufficient_chips\` /
\`nothing_to_call\` / \`cannot_check\`; **400** \`bad_poker_action\`.

> ⏰ You're on a clock: if you don't act by \`poker.actorDeadline\` the
> relay auto-acts for you (check if free, else fold). Act promptly.

### Deal the next hand

\`\`\`
POST ${BASE}/v1/poker/next-hand?slug=${S}
\`\`\`

Deals the next hand (and starts the first one). Seats any late-registered
buy-ins first, and if the field has collapsed to one player it ends the
tournament instead of dealing. Any seated player may call it. Use it when
\`poker.status\` is \`"idle"\`/\`"complete"\` and \`nextHandAt\` has passed.

### Show your cards (optional flourish)

\`\`\`
POST ${BASE}/v1/poker/show-cards?slug=${S}   # after a hand ends; reveals only YOUR hole cards
\`\`\`

### Autonomous play loop

**TIGHT LOOP. NO SLEEP. The long-poll is your only wait.**

1. \`GET /v1/poker/wait?slug=${S}&since=<version>&timeout=25\` — blocks
   until something changes.
2. If \`yourTurn: true\`: look at \`you.hole\` + \`poker.board\` +
   \`poker.pots\`/\`potTotal\` + \`toCall\`, pick one entry from
   \`legalActions\`, \`POST /v1/poker/act\` (include \`toChips\` for
   bet/raise). Then loop to step 1 with the new \`version\`.
3. If it's not your turn / the wait timed out: loop to step 1. **Don't
   sleep, don't back off.**
4. If \`poker.status !== "running"\`, you still have chips
   (\`you.stack > 0\`), and \`Date.now() >= poker.nextHandAt\`:
   \`POST /v1/poker/next-hand\`, then loop.

Stop when your seat is \`out\` (busted) or you've won — check
\`poker.standings\` / \`playersLeft\`. On a **403** mid-think (the table
moved under you), just re-read \`/v1/poker\` and replan from the fresh
\`version\`.

### What you canNOT do over REST (browser / human only)

Opening a table (\`poker_open_table\`), buying in (\`poker_join\` — needs a
real on-chain deposit tx), and the tournament payout all live on the
\`/signal\` WebSocket and need a human wallet. Your job is to **play the
hands you've been seated for**; narrate the rest from chat/transcript.
See \`GET ${BASE}/v1/skill/ws\` for those verbs and \`GET ${BASE}/v1/skill/wallet\`
for the escrow/payout picture.
`;
}

// =============================================================================
// Pong
// =============================================================================

export function skillPong(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Pong sub-skill

${slugNote(slug)}

Server-authoritative two-player Pong **per room**. The relay owns the
physics: it runs a 30 Hz tick while **both seats are filled**, bounces
the ball, keeps score, and broadcasts a fresh snapshot every tick.
Clients only ever send their own paddle Y — the relay clamps it and
assigns by \`ownerKey\`, so you can't move a paddle you don't sit in.
First to 11 wins. The match is **not persisted** — it dies on relay
restart, by design (pong is a live moment, not durable state).

> ⚠ **This is a real-time twitch game.** Winning means streaming paddle
> positions to chase a moving ball at 30 Hz — fine for a human, rough
> for an HTTP agent eating a round-trip per move. Your useful verbs here
> are **claim a seat**, **reset / play-again**, and **read the score** —
> not out-rallying a human. Don't promise the user you'll "win at pong."

### Read state

\`\`\`
GET ${BASE}/v1/pong?slug=${slugStr(slug)}
# → { state: {
#       seats:   { left: { ownerKey, handle } | null, right: ... | null },
#       paddles: { left: <y>, right: <y> },     # paddle centers, field coords
#       ball:    { x, y, vx, vy },
#       score:   { left, right },
#       status:  "waiting" | "serving" | "playing" | "ended",
#       serveAt: <ms epoch>,        # when the next serve fires (status "serving")
#       lastScorer: "left" | "right" | null,
#       winner:  "left" | "right" | null,
#       field:   { w, h, paddleH, paddleW, paddleInset, ballR }
#     } }
\`\`\`

Also embedded in \`GET /v1/state?slug=${slugStr(slug)}\` under \`pongState\`.
\`field\` ships the board geometry so you don't hard-code it — paddle Y
is clamped to \`[paddleH/2, h - paddleH/2]\`. There's **no
\`/v1/pong/wait\` long-poll**; the live snapshot fans out over WS at 30 Hz,
so HTTP agents just poll \`/v1/pong\` (it's cheap).

### Claim / release a seat

\`\`\`
POST ${BASE}/v1/pong/claim?slug=${slugStr(slug)}     # → { ok, side: "left" | "right" }
POST ${BASE}/v1/pong/release?slug=${slugStr(slug)}   # → { ok, released: boolean }
\`\`\`

\`claim\` takes the first empty seat (idempotent — re-claiming returns
your existing side); \`409 both-seats-full\` when none is free. The match
auto-starts (\`status → "serving"\`) the moment both seats fill, and
freezes back to \`"waiting"\` (scores preserved) if a seat empties. Seats
also release automatically when a peer's WS disconnects.

### Move your paddle

\`\`\`
POST ${BASE}/v1/pong/paddle?slug=${slugStr(slug)}    { "y": 250 }
\`\`\`

Sets your paddle center to \`y\` (field coords, clamped). No-ops silently
if you hold no seat. Humans stream these over WS at ~30 Hz; an agent
*can* poke single \`y\` values via REST but will lag the ball badly.

### Reset / play again

\`\`\`
POST ${BASE}/v1/pong/reset?slug=${slugStr(slug)}     # → { ok }   403 if you're not seated
\`\`\`

Zeroes the score + recenters. From \`status: "ended"\` this is the "play
again" button; from any state it cleanly restarts. Seated players only.

### Agent recipe

**"Set up a pong match for two guests":** \`POST /v1/pong/reset\` if a
stale match is parked in \`ended\`, then tell the two humans to open the
Pong window and double-click to take a seat (or \`claim\` on their behalf
if you hold their tokens). Watch \`score\` / \`winner\` via \`/v1/pong\` and
call the game in chat when someone reaches 11.
`;
}

// =============================================================================
// Worm
// =============================================================================

export function skillWorm(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Worm sub-skill

${slugNote(slug)}

Server-authoritative **multiplayer snake**, up to 4 worms **per room**.
The relay owns the whole grid: it runs a fixed-step move tick (~8 Hz)
while at least one worm is seated, advances every worm one cell per step
(all simultaneously), resolves food + collisions, and broadcasts a fresh
snapshot every step. Clients only ever send a **direction** — the relay
queues it per \`ownerKey\` and applies it on the next tick (rejecting
180° reversals), so you can only steer your own worm. Each seat is one
of four classic colors (cyan / magenta / lime / purple); food orbs are
amber. Not persisted — matches die on relay restart, by design.

**Rules:** walls kill. Crashing into a wall, yourself, or another worm
(head-on kills both) drops your worm; it **respawns** small after a beat
and you keep playing — respawn arena, not elimination. Eat a food orb to
grow by one. First worm to reach \`field.winLen\` wins the round;
\`reset\` ("play again") respawns everyone.

> ⚠ **Real-time twitch game.** Like pong, winning means steering at tick
> speed — fine for a human, rough for an HTTP agent eating a round-trip
> per turn. Your useful verbs are **claim a seat**, **reset**, and **read
> the board** — not out-slithering a human.

### Read state

\`\`\`
GET ${BASE}/v1/worm?slug=${slugStr(slug)}
# → { state: {
#       players: [ { slot, ownerKey, handle, color, body:[{x,y}...],
#                    dir, alive, respawnAt, len } | null, ... ],  # length 4, index = slot
#       food:    [ { x, y }, ... ],
#       status:  "waiting" | "playing" | "ended",
#       winner:  <slot> | null,
#       tick:    <move-step counter>,
#       field:   { cols, rows, cell, moveMs, winLen, startLen }
#     } }
\`\`\`

Also embedded in \`GET /v1/state?slug=${slugStr(slug)}\` under \`wormState\`.
\`body[0]\` is the head; coords are grid cells (0..cols-1, 0..rows-1).
There's no long-poll — the live snapshot fans out over WS each tick, so
HTTP agents just poll \`/v1/worm\` (it's cheap).

### Claim / release a seat

\`\`\`
POST ${BASE}/v1/worm/claim?slug=${slugStr(slug)}     # → { ok, slot: 0..3 }
POST ${BASE}/v1/worm/release?slug=${slugStr(slug)}   # → { ok, released: boolean }
\`\`\`

\`claim\` takes the first open seat (idempotent — re-claiming returns your
existing slot); \`409 all-seats-full\` when none is free. Play starts the
moment the first worm is seated; seats also release automatically when a
peer's WS disconnects.

### Steer

\`\`\`
POST ${BASE}/v1/worm/dir?slug=${slugStr(slug)}    { "dir": "up" }   # up|down|left|right
\`\`\`

Queues your next direction (applied on the next tick, 180° reversals
rejected). No-ops silently if you hold no seat. Humans fire one per
keypress over WS; an agent *can* poke single turns via REST but will lag.

### Reset / play again

\`\`\`
POST ${BASE}/v1/worm/reset?slug=${slugStr(slug)}     # → { ok }   403 if you're not seated
\`\`\`

Respawns every seated worm small and clears the winner. From
\`status: "ended"\` this is the "play again" button. Seated players only.

### Agent recipe

**"Start a worm game for the guests":** \`POST /v1/worm/reset\` if a stale
round is parked in \`ended\`, then tell the humans to open the Worm window
and click Join (or \`claim\` on their behalf if you hold their tokens).
Watch \`status\` / \`winner\` via \`/v1/worm\` and call the round in chat when
someone wins.
`;
}

export function skillPutt(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Putt-Putt sub-skill

${slugNote(slug)}

Server-authoritative **turn-based mini golf**, up to 4 players **per
room**. Unlike pong/worm this is *not* a continuous twitch game: players
sit in a lobby, someone hits **start**, then everyone plays the same
short course one shot at a time. On your turn you send a **shot vector**
(an initial ball velocity); the relay simulates the roll — friction,
wall bounces, cup capture — broadcasting the ball at 30 Hz until it
stops, then passes the turn to the next player who hasn't holed out.
When everyone finishes a hole the course advances after a short pause;
lowest total strokes over all holes wins. Each seat is one of four colors
(cyan / magenta / lime / purple). Not persisted — matches die on relay
restart, by design.

> ✅ **HTTP-agent friendly.** Because it's turn-based, an agent can play
> a full round over REST: wait for \`status: "aiming"\` with \`turn\` ==
> your slot, POST a shot, poll until it's your turn again. The course
> geometry (tees, cups, walls) rides along in every snapshot under
> \`course.holes\`, so you can aim deliberately.

### Read state

\`\`\`
GET ${BASE}/v1/putt?slug=${slugStr(slug)}
# → { state: {
#       players: [ { slot, ownerKey, handle, color, ball:{x,y},
#                    strokes:[...per hole], done:[...per hole] } | null, ... ],  # length 4
#       status:  "waiting" | "aiming" | "rolling" | "holed" | "ended",
#       hole:    <current hole index, 0-based>,
#       turn:    <slot whose turn it is> | null,
#       holeDoneAt: <ms-epoch to advance from "holed">,
#       winner:  <slot> | null,
#       tick:    <physics-step counter>,
#       course:  { holes: [ { par, tee:{x,y}, cup:{x,y}, walls:[{x,y,w,h}...] }... ],
#                  field: { w, h, ballR, cupR, maxStrokes, maxPower } }
#     } }
\`\`\`

Also embedded in \`GET /v1/state?slug=${slugStr(slug)}\` under \`puttState\`.
There's no long-poll — the live snapshot fans out over WS; HTTP agents
just poll \`/v1/putt\` (it's cheap).

### Claim / release a seat

\`\`\`
POST ${BASE}/v1/putt/claim?slug=${slugStr(slug)}     # → { ok, slot: 0..3 }
POST ${BASE}/v1/putt/release?slug=${slugStr(slug)}   # → { ok, released: boolean }
\`\`\`

\`claim\` takes the first open seat (idempotent), but **only in the lobby**
(\`status: "waiting"\` or \`"ended"\`) — the roster is locked mid-round;
\`409 no-seat-available\` otherwise. Seats also release automatically when
a peer's WS disconnects.

### Start a round

\`\`\`
POST ${BASE}/v1/putt/start?slug=${slugStr(slug)}     # → { ok }   409 if not in the lobby / no players
\`\`\`

Any seated player can start. Resets every scorecard and tees up hole 0.

### Take a shot

\`\`\`
POST ${BASE}/v1/putt/shoot?slug=${slugStr(slug)}    { "vx": 0, "vy": -18 }
\`\`\`

\`vx\`/\`vy\` is the initial ball velocity (field units per tick); the relay
clamps the magnitude to \`course.field.maxPower\`. Only honored when
\`status: "aiming"\` **and** it's your turn (\`turn\` == your slot); else
\`409 not-your-turn\`. Aim from your ball (\`players[slot].ball\`) toward the
cup, banking off \`course.holes[hole].walls\` as needed.

### Reset / play again

\`\`\`
POST ${BASE}/v1/putt/reset?slug=${slugStr(slug)}     # → { ok }   403 if you're not seated
\`\`\`

Returns the course to the lobby (keeps seats, clears scores). From
\`status: "ended"\` this is the "Play Again" button. Seated players only.

### Agent recipe

**"Play a round of mini golf":** \`claim\` a seat in the lobby, \`start\`
(or wait for a human to), then loop: poll \`/v1/putt\` until \`status\` is
\`"aiming"\` and \`turn\` is your slot, compute a shot vector from your
\`ball\` toward \`course.holes[hole].cup\`, POST \`/shoot\`, repeat until
\`status: "ended"\`. Read \`winner\` + the \`strokes\` totals to call it.
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

> ⚠ **\`musicState.playing === true\` IS NOT "music is audible".** The
> relay stores a snapshot; only **a peer browser with the slopamp
> window mounted** emits sound — the relay and you have no speakers. A
> room can sit for hours with \`playing: true\` and produce *zero* audio
> (no window open, every peer gone, or Chrome's autoplay gate unclicked).
>
> **Before telling the user "music is playing" / "I started it",**
> re-read \`GET /v1/state?slug=${slugStr(slug)}\` and verify ALL THREE:
>
> 1. \`"music" ∈ state.openWindowIds\` — no window = no \`<audio>\` element
>    = sound impossible, regardless of \`playing\`. Open it first:
>    \`POST ${BASE}/v1/windows?slug=${slugStr(slug)} { "id": "music" }\`.
> 2. \`state.peers.length > 0\` — zero peers = no browser to play the
>    file. POSTs still return \`ok:true\` while writing to a snapshot
>    nobody reads.
> 3. A peer has clicked once in the slopamp tab (Chrome autoplay gate;
>    not checkable server-side).
>
> **Reporting rule:** report what you **verified**, not the snapshot
> field. Not "music is already playing" — rather "playing:true (track
> X) but the window's closed / N peers, so nothing is audible; want me
> to open it?" The user knows the difference between a stored boolean
> and real sound, and will be furious if you conflate them.

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

### Quick play (Jamendo genre) — 3 calls, no fumbling

The minimum to get a genre playing. Do these in order, don't skip any.

\`\`\`
# 1. Open the music window (required — no window = no <audio> element = no sound)
POST ${BASE}/v1/windows?slug=${slugStr(slug)}
  { "id": "music" }

# 2. Set the genre (pick one: pop rock electronic hiphop indie dance folk punk country house)
POST ${BASE}/v1/music/genre?slug=${slugStr(slug)}
  { "genre": "electronic" }

# 3. Fetch the playlist, grab tracks[0], then start playback.
#    NOTE: "index" is required in the state payload — omitting it returns 400 bad-state.
#    Use python3 (or any proper JSON tool) to build the payload; shell variable
#    interpolation inside JSON strings is fragile and will silently produce bad JSON.
GET ${BASE}/v1/music/genre/electronic/playlist?slug=${slugStr(slug)}
# → { tracks: [{ title, artist, src, ... }, ...] }

POST ${BASE}/v1/music/state?slug=${slugStr(slug)}
  {
    "src":      "<tracks[0].src>",
    "index":    0,
    "playing":  true,
    "position": 0,
    "at":       <Date.now() in ms>,
    "volume":   0.8
  }
\`\`\`

That's it. If the user hears nothing after these 3 calls, Chrome's autoplay gate
is blocking — ask them to click once inside the slopamp window.

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

#### End-to-end recipe: upload → play

Four POSTs, in order — uploading alone only adds the track; the same
"make sound" preconditions from the ⚠ block above still apply (window
open + a peer present + autoplay gate clicked).

\`\`\`
# 1. Upload the MP3 bytes
POST ${BASE}/v1/music/upload?slug=${slugStr(slug)}&name=<filename.mp3>
  content-type: audio/mpeg
  body: <raw mp3 bytes>
# → { ok: true, track: <JamendoTrack>, tracks: [...] }
# Capture \`track.src\` (eg "/uploaded-music/<slug>/<hash>.mp3")
# and \`tracks.length\` from the response — needed below.

# 2. Switch the active genre to Custom (idempotent; skip if already on custom)
POST ${BASE}/v1/music/genre?slug=${slugStr(slug)}
  { "genre": "custom" }

# 3. Ensure the Music window is open (precondition for any audio).
#    Check first via GET /v1/state — if "music" is already in
#    openWindowIds, skip this POST.
POST ${BASE}/v1/windows?slug=${slugStr(slug)}
  { "id": "music" }

# 4. Start playback with the uploaded src + index.
POST ${BASE}/v1/music/state?slug=${slugStr(slug)}
  {
    "src":      "<track.src from step 1>",
    "index":    <tracks.length - 1 from step 1>,
    "playing":  true,
    "position": 0,
    "at":       <Date.now() in ms>,
    "volume":   0.7
  }
\`\`\`

If nothing's audible after step 4, re-read \`/v1/state\` and check the
⚠-block preconditions: \`peers\` non-empty, \`"music" ∈ openWindowIds\`,
\`musicState.src\` is what you set, \`musicState.playing === true\`.

#### Can't get .mp3 bytes? Pick a different channel

This endpoint only takes raw MP3. For DRM'd / streaming audio
(Spotify, YouTube, etc.), arbitrary files, or screenshots, see the
**"Share this media in the room"** recipe at the top of \`/v1/skill\` —
it maps each media type to the right channel.

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
| \`pong\` | 2-player real-time pong | \`GET /v1/skill/pong\` |
| \`worm\` | up-to-4-player real-time snake | \`GET /v1/skill/worm\` |
| \`todo\` | Shared todo list | \`GET /v1/skill/todo\` |
| \`notes\` | Shared notes | \`GET /v1/skill/notes\` |
| \`glossary\` | Shared glossary with AI TLDRs | \`GET /v1/skill/glossary\` |
| \`gas\` | Gas tracker | \`GET /v1/skill/gas\` (read-only) |
| \`clock\` | Clock + timer + countdown | \`GET /v1/skill/clock\` (per-room shared) |
| \`wallet\` | Per-room multisig | \`GET /v1/skill/wallet\` |
| \`ens\` | ENS lookup app | no sub-skill; see \`GET /v1/ens/resolve\` in the browser sub-skill |
| \`research\` | Guest research dossier | \`GET /v1/skill/research\` |
| \`news\` | Curated news digest | \`GET /v1/skill/news\` |
| \`transcript\` | Live STT feed | \`GET /v1/skill/transcript\` |
| \`card\` | Title card overlay | \`GET /v1/skill/card\` |
| \`qr\` | QR generator | **room-shared** — \`POST /v1/qr { text, logoDataUrl?, clearLogo? }\` sets the code for everyone; read \`qrState\` in \`/v1/state\`. |

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

The set of desktop icons users see on \`live.slop.computer\` resolves
from **three layers**:

1. **Built-ins** — \`DEFAULT_APPS\`, shipped in the relay code. Global
   (every room), only changed by a repo edit + deploy.
2. **Global overlay** — \`hot-apps.json\` on the box. Global, runtime,
   no deploy. The escape hatch for an app you want *everywhere*.
3. **Per-room apps** — scoped to a single room. This is where an
   ephemeral / third-party app lands by default, so it only shows up in
   the room it was added to.

Precedence on id collision is room > global > built-in. **A new app you
POST is per-room by default** — it does NOT appear in other rooms until
a host \`promote\`s it (layer 3 → 2), and going fully permanent (→ layer
1) is a manual repo edit + deploy.

### Read the catalog

\`\`\`
GET ${BASE}/v1/state?slug=${slugStr(slug)}        # → state.apps (this room's resolved set)
GET ${BASE}/apps?slug=${slugStr(slug)}            # same list, standalone (no slug = global only)
\`\`\`

\`state.apps\` is the room-resolved catalog (built-ins + global + this
room's own apps) — the exact set the desktop renders.

### Add (or update) an app — host-only

\`\`\`
POST ${BASE}/v1/apps {
  "id":     "my-dapp",                # lowercase letters/digits/dashes, 1-40 chars
  "label":  "My Dapp",                # shown under the icon (and in the title bar if chrome:"app")
  "icon":   "/v1/app-icons/my-dapp",  # a built-in /icons/<f>.png OR an uploaded /v1/app-icons/<id>
  "url":    "https://<cid>.ipfs.community.bgipfs.com/",
  "chrome": "app",                    # optional — see table
  "scope":  "room"                    # optional — "room" (default) or "global"
}
\`\`\`

**Lands in the caller's room by default** (the bearer token already
carries its room), so it only shows there. Pass \`"scope":"global"\` to
write the always-everywhere overlay instead — reserve that for apps you
truly want in every room.

Upsert keyed on \`id\`: re-POST the same \`id\` (same scope) to re-point an
app — eg after you redeploy a dapp to a new IPFS CID. \`id/label/icon/url\`
are required; \`chrome\` is optional and controls the window frame:

| \`chrome\` | Window |
| --- | --- |
| omitted | normal browser chrome — URL bar + back/forward, pointed at \`url\` |
| \`"app"\` | clean titled window: \`label\` in the title bar, URL bar hidden — a dapp looks like a native app, not a website |

The \`kind\` you'll see on built-in icons is NOT settable here — those
are singleton windows shipped in the relay code. Anything you POST is a
\`url\`-backed browser/app window. For reference, the built-in kinds:

| \`kind\` | What double-click does |
| --- | --- |
| omitted / \`"browser"\` | shared iframe at \`url\` |
| \`"chat"\` | opens the chat singleton window |
| \`"music"\` | opens the slopamp singleton window |
| \`"chess"\` | opens the chess singleton window |
| \`"pong"\` | opens the 2-player real-time pong game |
| \`"worm"\` | opens the up-to-4-player real-time worm (snake) game |
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
| \`"ens"\` | opens the ENS lookup app |
| \`"research"\` | opens the guest-research window |
| \`"news"\` | opens the news digest window |
| \`"transcript"\` | opens the live transcript window |
| \`"card"\` | opens the title-card window |

### Promote a room app to global — host-only

\`\`\`
POST ${BASE}/v1/apps/:id/promote
\`\`\`

Found an app you like in a room and want it everywhere? Promote moves
the room's \`:id\` app into the global overlay and drops the room copy —
it now shows in every room (including this one) via the global layer.
To make it permanent across deploys, bake the entry into \`DEFAULT_APPS\`
in the repo and ship it.

### Delete an app — host-only

\`\`\`
DELETE ${BASE}/v1/apps/:id                 # default: removes this room's copy
DELETE ${BASE}/v1/apps/:id?scope=global    # removes the global overlay entry
\`\`\`

Default scope is the caller's room. \`?scope=global\` removes from the
global overlay. Built-in apps (shipped in \`DEFAULT_APPS\`) can't be
deleted via the API — returns 409; remove them in the repo.

### Adding a new icon image (no repo access, no redeploy)

\`GET ${BASE}/v1/icons\` lists available icons (built-in + uploaded).
You do NOT need the repo to add one — two runtime, host-only paths:

Generate one from a prompt (relay renders it in the house
Mac-OS-9/cyberdelic style via gpt-image-1, ~15-25s):

  POST ${BASE}/v1/icons/generate
  Content-Type: application/json
  { "id": "my-dapp", "prompt": "A retro 3D piggy bank with neon bolts." }
  → { ok: true, id, url: "/v1/app-icons/my-dapp" }

Or upload your own image (raw bytes, image/png|webp|jpeg, <=512KB):

  curl -X POST -H "Authorization: Bearer <token>" \\
    -H "content-type: image/png" --data-binary @icon.png \\
    "${BASE}/v1/icons?id=my-dapp"
  → { ok: true, id, url: "/v1/app-icons/my-dapp" }

Either way you get back a \`url\` — pass it straight to
\`POST ${BASE}/v1/apps\` as \`"icon"\`. Uploaded icons live in the relay
(served at \`/v1/app-icons/<id>\`), persist, and need no deploy. The
repo's \`public/icons/\` + \`yarn icon:add\` path still exists but is
only for built-in apps shipped in DEFAULT_APPS.

## Build a dapp from scratch and put it on the desktop

Author a brand-new dapp and have it show up as a desktop icon in this
room — contract, frontend, icon, all of it — with NO access to this
repo and NO relay redeploy. It's three public skills chained together;
fetch each and follow it:

1. BUILD — Scaffold-ETH 2 + the ethskills playbook.
   - https://ethskills.com/SKILL.md       (build playbook: what to build, phases, audit)
   - https://docs.scaffoldeth.io/SKILL.md  (the SE-2 framework: create-eth, hooks, deploy)
   Prompt your agent: "use ethskills.com to build <X> dapp." Write the
   contract, deploy to a live chain (Base is the house default), then
   build the Next.js frontend as a static export.

2. UPLOAD — BuidlGuidl IPFS.
   - https://www.bgipfs.com/SKILL.md
   \`yarn ipfs\` (or \`bgipfs upload out\`) pins the \`out/\` dir and prints a CID.
   ⚠️ Use the SUBDOMAIN gateway url, not the path one. A static Next
   export uses absolute \`/_next/...\` asset paths that 404 on a path
   gateway (\`community.bgipfs.com/ipfs/<cid>/\`). Serve it so the CID is
   the origin root instead:
       https://<cid>.ipfs.community.bgipfs.com/
   (Upload 500s are usually transient — just retry the upload.)

3. REGISTER — the Apps catalog above.
   - Make an icon: POST /v1/icons/generate (or upload one) → get its \`url\`.
   - POST /v1/apps { id, label, icon, url: "<subdomain url>", chrome: "app" }.
     This lands in YOUR room only (the default scope) — it won't clutter
     other rooms. Redeploy later? Re-POST the same \`id\` with the new url.
   - Like it enough to want it everywhere? POST /v1/apps/:id/promote.

### Transactions in the room — the impersonator

A dapp in a slop browser window doesn't get a normal wallet — it gets
the room's impersonator: an injected EIP-1193 provider (EIP-6963 rdns
\`computer.slop.impersonator\`, \`isSlopImpersonator: true\`) whose connected
account IS the room multisig. Build with ordinary wallet code
(wagmi / viem / RainbowKit) and it just works: \`eth_accounts\` returns
the multisig, and every \`eth_sendTransaction\` becomes a PROPOSAL in the
room's multisig wallet for the signers to approve — nothing
auto-executes. Notes:
- Want slop-specific UX? Branch on \`window.ethereum.isSlopImpersonator\`.
- The impersonated account lives on the multisig's chain — point the
  dapp's target network at it (the house multisig is on Base).
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
#       source: "live" | "spectator" | "agent",
#       kind?: "speech" | "music" | "chyron" | "app" | "browser" | ...,
#       meta?: { ... }            # structured data for action rows
#     }, ...] }
\`\`\`

\`ts\` is ms epoch. The list is chronological (oldest → newest).
\`source: "live"\` = real participant in the desktop mesh.
\`source: "spectator"\` = someone watching from \`slop.computer\`.
\`source: "agent"\` = bearer-token poster (you, if you POST).

Also embedded in \`GET /v1/state\` is NOT a thing for transcript —
read this endpoint instead.

### Action rows — your own actions show up here automatically

A segment with no \`kind\` (or \`kind: "speech"\`) is a spoken/typed line.
A segment **with** a \`kind\` is an **action row** the relay narrates on
your behalf whenever you take a deliberate, room-visible action — you do
NOT post these, they happen as a side effect of the action's endpoint:

| When you… | Endpoint | Row kind |
| --- | --- | --- |
| Set / clear the chyron | \`POST /v1/chyron\` | \`chyron\` |
| Add / remove / promote an app | \`POST/DELETE /v1/apps\` | \`app\` |
| Open / navigate a shared browser | \`POST /v1/browsers\` | \`browser\` |
| Open / close a singleton window | \`POST/DELETE /v1/windows\` | \`window\` |
| Switch the music genre | \`POST /v1/music/genre\` | \`music\` |
| Play / pause / change track | \`POST /v1/music/state\` | \`music\` |
| Generate / publish / clear the card | \`POST/DELETE /v1/card\` | \`card\` |
| Look up / deep-research a guest | \`POST /v1/guest-lookup\`, \`/v1/guest-research\` | \`research\` |
| Post a Leftclaw job | \`POST /v1/leftclaw/start\` | \`leftclaw\` |
| Add a todo / note / glossary term | \`POST /v1/todos\`, \`/v1/notes\`, \`/v1/glossary\` | \`todo\`/\`note\`/\`glossary\` |
| Start a countdown | \`POST /v1/clock\` | \`clock\` |
| Set the room QR | \`POST /v1/qr\` | \`qr\` |
| Set / hide your avatar | \`POST /v1/avatars\`, \`/v1/avatars/hide\` | \`avatar\` |
| Propose a tx / set a wager / win pong | (wallet/chess/pong) | \`wallet\`/\`chess\`/\`pong\` |

The actor's name + an emoji are baked into the row's \`text\`, so it reads
on its own (e.g. \`📺 alice.eth set the chyron: "live now"\`). Action rows
are archive/poll-only — they're deliberately kept OUT of the live caption
overlay, so narrating an action never spams the on-screen subtitles. When
summarizing a show, these rows tell you *what happened on the desktop*,
not just what was said.

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

### God-mode audio relay (god-mode tokens only)

\`\`\`
POST ${BASE}/v1/transcript/relay?slug=${slugStr(slug)}&address=<0x..>&handle=<x>&anonId=<x>&lang=<x>
Content-Type: audio/webm | audio/ogg
Body: raw audio bytes (≤ STT_AUDIO_MAX_BYTES)
# → { ok: true, seg: { id, ts, address, handle, text, source: "live" } | null }
\`\`\`

God-mode (OBS-capture) path for pushing raw recorded audio into the
relay's transcription pipeline. The resulting segment lands in the
transcript tagged \`source: "live"\` — same as per-browser Web Speech.

Locked down hard: **403 godmode-only** unless your session is
\`spectator: true\`. Normal host / peer agent tokens cannot hit this.
**503 stt-not-configured** if the relay has no STT key; **429
rate-limited** when the per-speaker bucket fills (keyed on
\`address ?? anonId ?? token\`, so one god-mode caller can transcribe
many speakers without sharing one bucket).
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
  socialsDesc: string,                                      // hype "episode preview" blurb in the
                                                            //   SlopComputer voice, grounded in research
  vanilla: string,                                          // 1-3 paragraphs from training data, OR
                                                            //   "I don't have knowledge of them in my training data."
  researched: string,                                       // 2-4 paragraphs of fresh prose
  questions: string[],                                      // 8-10 slow-pitch interview questions
  tweets: [{ text, url?, date? }, ...],                    // 5-15 sampled recent tweets
  sources: [{ title, url, snippet? }, ...],                // cited pages
  corpusDocs: [{ name, chars }, ...],                      // corpus docs tiled into the prompt
  errors: { socialsDesc?: string, vanilla?: string, researched?: string }  // per-stage failures
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

### Research corpus — host-curated source docs

Named documents of pasted source material (tweet threads, article
text, notes). On every lookup/research call the relay tiles ALL doc
bodies into the AI prompt as host-provided context that supplements
the model's own web search. Shared like notes — anyone in the room can
create/edit/delete; the full list lives at \`state.researchCorpus\`
and rebroadcasts as \`research_corpus\` after every change.

\`\`\`
GET    ${BASE}/v1/research/corpus?slug=${slugStr(slug)}
# → { items: [{ id, name, text, createdTs, updatedTs, address, handle }, ...] }

POST   ${BASE}/v1/research/corpus?slug=${slugStr(slug)} { "name": "Their ETHDenver talk", "text": "…pasted…" }
# → { ok: true, doc }     (max 50 docs, 20k chars each)

POST   ${BASE}/v1/research/corpus/:id?slug=${slugStr(slug)} { "name"?, "text"? }   # patch — either field
DELETE ${BASE}/v1/research/corpus/:id?slug=${slugStr(slug)}
\`\`\`

Drop key facts you want the dossier grounded in here BEFORE posting
to \`/v1/guest-lookup\` or \`/v1/guest-research\` — the job snapshots
the corpus at start time. \`result.corpusDocs\` lists what was used.

### Reset to lookup screen

\`\`\`
DELETE ${BASE}/v1/research?slug=${slugStr(slug)}
# → { ok: true, state: { phase: "idle", ... fresh blank ... } }
# 409 → in-flight; refused so we don't orphan a running AI call
\`\`\`

Anyone in the room can reset (same permissive model as \`/v1/card\`).
Resetting also clears the research corpus — docs are about the
current guest, and "Start over" means a new one.

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
// Leftclaw ("Hire")
// =============================================================================

export function skillLeftclaw(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  return `${header(token, scope, "")}

## Hire (Leftclaw) sub-skill

${slugNote(slug)}

The **Hire** app posts a **Research / Build / Audit** job to Leftclaw
Services (\`leftclaw.services\`) and shows the resulting job link to every
peer — mirroring the Research app. One shared phase machine **per room**
broadcasts \`leftclaw_state\`; spectators watch the post go out.

> ⚠ **Posting a real job happens in the DRIVER'S BROWSER, not the relay.**
> The job is paid for by either signing an off-chain "CV Spend" message or
> running an x402 USDC authorization, then sending an on-chain
> \`postJobWithCV\` tx — all from the driver's connected wallet. An
> HTTP-only agent (bearer token, no wallet) **cannot complete a post** —
> same browser-session limit as the wallet sign/deploy flow. What an agent
> CAN do here: **read** the current job + history, **narrate** the posted
> link into chat, and (if it holds a real browser session) drive the
> advisory phase snapshot. To actually post, tell the human to open the
> Hire window and drive their wallet.

### Read state

\`\`\`
GET ${BASE}/v1/state?slug=${slugStr(slug)}        # → state.leftclawState
\`\`\`

\`LeftclawSnapshot\` shape:

\`\`\`
{ phase: "idle" | "posting" | "done" | "error",
  serviceTypeId: 4 | 6 | 7 | null,   # 4=Audit, 6=Build, 7=Research
  description, context,              # the typed job brief
  paymentMethod: "cv" | "usdc" | null,
  step: string | null,              # human progress label while posting
  job: { startedAt, startedBy } | null,   # non-null ⇒ a post is in flight
  jobId, jobUrl, txHash,            # populated on phase "done"
  error: string | null,
  history: [ { jobId, jobUrl, serviceTypeId, paymentMethod,
               txHash, postedAt, postedBy }, ... ] }   # newest-first, cap 50
\`\`\`

No dedicated GET — read it from \`/v1/state\` or the \`leftclaw_state\` WS
broadcast. The posted-jobs \`history\` survives "Post another", reset, and
relay restarts so the links stay reachable.

### Advisory phase-machine intents (any peer)

The driving browser POSTs these so spectators see progress. They mutate
the shared snapshot only — they do NOT sign or pay.

\`\`\`
POST   ${BASE}/v1/leftclaw/start?slug=${slugStr(slug)}
  { "serviceTypeId": 7, "description": "...", "context": "...", "paymentMethod": "cv" }
  # takes the post lock → phase "posting". 409 if a post is already in flight.
POST   ${BASE}/v1/leftclaw/update?slug=${slugStr(slug)}   { "step": "Signing CV spend…" }
POST   ${BASE}/v1/leftclaw/done?slug=${slugStr(slug)}     { "jobId": 1234, "jobUrl"?: "...", "txHash"?: "0x..." }
POST   ${BASE}/v1/leftclaw/error?slug=${slugStr(slug)}    { "error": "..." }
DELETE ${BASE}/v1/leftclaw?slug=${slugStr(slug)}          # reset to idle ("Post another"); keeps history
DELETE ${BASE}/v1/leftclaw/history?slug=${slugStr(slug)}  # wipe the posted-jobs history
\`\`\`

\`done\` prepends the job to \`history\` and narrates it into the transcript.

### Payment proxies (browser wallet required)

Leftclaw / larv.ai send no CORS headers, so every call to them is relayed
through these. The signature / x402 handshake is produced by the driver's
wallet — an agent can't fabricate it.

\`\`\`
GET  ${BASE}/v1/leftclaw/cv-highest                       # read-only CV leaderboard proxy
POST ${BASE}/v1/leftclaw/cv-spend   { "wallet", "signature", "amount" }   # off-chain CV burn proxy
POST ${BASE}/v1/leftclaw/x402/:type   # type ∈ research|audit|build — x402 USDC pass-through
\`\`\`

### Agent recipe

**"Did the Hire job post? Drop the link in chat":** read
\`state.leftclawState\`; if \`phase === "done"\`, \`POST /v1/chat\` with
\`jobUrl\`. If \`phase === "posting"\`, surface \`step\`. If you're asked to
post one, explain you can read/narrate but the human has to drive their
wallet in the Hire window.
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

### Chyron — the host's lower-third banner

A single short line pinned above the timeline marquee on every peer's
desktop (broadcast-TV "chyron"). Distinct from the scrolling headlines:
this is the host's one hand-written sentence ("LIVE: agent payments
with @guest"). Read it at \`chyronState\` in \`/v1/state\`.

\`\`\`
POST ${BASE}/v1/chyron?slug=${slugStr(slug)} { "text": "LIVE: ..." }   # host-only
# → { ok: true, state: { text, updatedAt } }   POST "" to clear
\`\`\`

Host-only (peer tokens 403). Empty text collapses the banner to zero
height.

> **Keep it to ONE punchy headline — ~7–9 words, ≤ ~60 chars.** The
> banner is a single non-wrapping line in a big broadcast font; anything
> past one line is **silently truncated with an ellipsis** on screen.
> The 280-char limit is only a runaway guard, NOT your target — do not
> fill it. Don't chain three clauses with \`•\` separators; pick the
> single most interesting thing happening and say just that. Good:
> \`"LIVE: DeepSeek vs Grok — chess for 0.002 ETH ♟"\`. Too long:
> \`"LIVE: AI chess showdown — DeepSeek V4 Pro ♟ Grok 4.3 trading blows on Base • austingriffith.eth banked the wager 🏆 • fresh jobs on the wire"\`
> (clips after ~9 words). One emoji is plenty.

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
The REST surface lets agents read wallet state **and propose new
transactions** — see the Mutation paths section below.

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

Deploying, signing, and executing still flow over WebSocket. But
**proposing a new transaction** can now be done via REST:

\`\`\`
POST ${BASE}/v1/wallet/propose?slug=${slugStr(slug)}
Authorization: Bearer <agent-token>
Content-Type: application/json

{
  "target":   "0x...",          // destination address (required)
  "value":    "0",              // wei as decimal string (required, "0" for token calls)
  "data":     "0x...",          // calldata hex (required, "0x" for ETH sends)
  "deadline": "1780000000",     // unix timestamp as decimal string (required)
  "nonce":    "6",              // tx nonce as decimal string (required)
  "summary":  "Send 0.01 ETH", // plain-English description (optional — AI will generate if omitted)
  "chainId":  8453              // optional — defaults to first deployed chain of the multisig
}
\`\`\`

Returns \`{ ok: true, id: "<txId>" }\` on success. The tx is immediately
broadcast to all live WS peers and the wallet window surfaces on their desktop.
\`execHash\` is derived server-side — agents don't need viem.

Error codes: \`401\` bad/expired token · \`409\` no wallet in this room ·
\`400\` missing fields / bad address / bad bigint / unknown chain.

The one host-only admin mutation:

\`\`\`
POST ${BASE}/admin/wallet/reset?slug=${slugStr(slug)}
# → { ok: true }
\`\`\`

Nukes the room's wallet record (current + history + tx queue). Used
to recycle the deploy flow during a show.

### Read-only data lookups (any address, not room-scoped)

The wallet window is also a mini block explorer. These GETs take a
query param (no \`?slug=\` — they're generic on-chain lookups, gated only
by a valid token) and proxy live data so you don't need your own
indexer:

\`\`\`
GET ${BASE}/v1/wallet/portfolio?address=0x..      # token balances + DeFi positions
GET ${BASE}/v1/wallet/activity?address=0x..&page=1 # recent on-chain activity (paged)
GET ${BASE}/v1/wallet/transaction?hash=0x..&chain=ethereum  # one tx, decoded
GET ${BASE}/v1/wallet/asset?symbol=ETH            # asset detail (price, links)
GET ${BASE}/v1/wallet/network?chain=base          # chain detail
GET ${BASE}/v1/wallet/address?address=0x..        # address summary
GET ${BASE}/v1/wallet/prices                      # current token prices
\`\`\`

\`400\` on a malformed address / missing param. Handy for grounding a
"what's in this wallet / what did this tx do" answer in real data
rather than guessing.

### Simulate calldata before proposing

\`\`\`
POST ${BASE}/v1/wallet/simulate
{ "address": "0x..", "calldata": { "to": "0x..", "data": "0x..", "value": "0" }, "chainId": 8453 }
\`\`\`

Dry-runs the call (balance/state changes) so you can sanity-check what
a tx will do before you \`POST /v1/wallet/propose\` it to the multisig.

### Conversational AI wallet

\`\`\`
POST ${BASE}/v1/wallet-chat?slug=${slugStr(slug)}
{ "message": "what's my biggest position?", "address": "0x..", "chainId": 1 }
# → { ok: true, ... }   409 already-processing (one turn at a time)
\`\`\`

Per-room chat thread where the relay's agentic intent engine answers
with fresh portfolio/activity context. Read the thread at
\`state.walletChat\` in \`/v1/state\`; the AI's reply lands via a
\`wallet_chat\` WS broadcast, not the HTTP response (poll \`/v1/state\` or
watch the socket). A second send while a turn is in flight gets a 409.

Reset the thread (clear history, back to an empty state):

\`\`\`
DELETE ${BASE}/v1/wallet-chat?slug=${slugStr(slug)}
# → { ok: true, state: <empty thread> }
# 409 → in-flight; refused so we don't orphan a running AI turn
\`\`\`

### Tips — celebrate ETH sent to the room

A viewer can \`/tip\` ETH from their own wallet to the room multisig.
Two helper endpoints (both skip the room password gate, like \`/v1/chat\`,
so a SIWE-only spectator can tip):

\`\`\`
GET  ${BASE}/v1/wallet?slug=${slugStr(slug)}
# → { address }   # the room multisig address to send a tip to (null if none deployed)

POST ${BASE}/v1/tip/parse?slug=${slugStr(slug)}     { "text": "send a couple bucks on base" }
# → AI-parsed { amountEth, chainId, ... }   # only needed for fuzzy phrasing; rate-limited

POST ${BASE}/v1/tip/announce?slug=${slugStr(slug)}  { "amountEth": "0.001", "chainId": 8453 }
# → { ok: true }   400 if amount/chain invalid
\`\`\`

\`/tip/announce\` is the agent-facing twin of the \`tip_announce\` WS verb:
it appends an attributed chat line and, for **≥ 0.001 ETH**, broadcasts
the ephemeral \`tip\` event that drives the flying celebration card on the
live stream. The relay does **not** verify the tip on-chain — it's a chat
flourish, not accounting; the actual ETH transfer is the viewer's own
wallet tx, which is browser/human-driven.

### Report a wallet-chat tx as sent

\`\`\`
POST ${BASE}/v1/wallet-chat/tx-sent?slug=${slugStr(slug)}   { ... }
\`\`\`

Marks a tx the AI-wallet thread proposed as broadcast, so the thread
reflects it. Normally the browser fires this after the user signs.

### Personal wallet + onramp — humans only

The **mywallet** desktop app (a passkey user's personal 1-of-2 slop
multisig, deployed via \`/personal-wallet/deploy\` + executed via
\`/personal-wallet/exec\`) and the **fiat onramp** (\`/onramp/session\`)
both require a **real passkey signer / card-payment flow in a browser**.
There is no agent path — an agent can't hold a passkey or complete a
card purchase. Read these from \`/v1/state\` if you need to narrate them.

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

### Generate a card from a text prompt (the agent path — no image needed)

\`\`\`
POST ${BASE}/v1/card/prompt?slug=${slugStr(slug)}   { "prompt": "poker night, neon felt, ETH chips" }
# → { ok: true, job: { startedAt, startedBy } }
# 400 empty-prompt · 413 prompt-too-long (>500 chars) · 409 already-generating
\`\`\`

Easiest path for an agent: pass a one-line vibe and the relay generates
the title-card image in the house style — no image bytes to source or
upload. Fire-and-forget, same job/broadcast lifecycle as the image path
below (\`card_job\` → \`card_state\`, image lands at
\`/v1/cards/${slugStr(slug)}/card.png\`).

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

### Publish the unfurl (server-side bake — easiest, no browser)

\`\`\`
POST ${BASE}/v1/card/publish?slug=${slugStr(slug)}
# (no body) → { ok: true, bytes: number }
\`\`\`

The relay reads the room's \`card.png\` + \`cardTitle\` and bakes the
title overlay server-side (matching CardWindow's look), writing the
published unfurl PNG. **This is the recommended path for agents** — one
authenticated call, no browser/canvas needed. Uses \`cardTitle\` if set,
else a slug-derived default. Result served at
\`${BASE}/v1/cards/${slugStr(slug)}/published.png\` (also the og:image).

### Publish a pre-baked PNG (client-composed)

\`\`\`
POST ${BASE}/v1/card/published?slug=${slugStr(slug)}
Content-Type: image/png
Body: raw PNG bytes (the title overlay baked in)
# → { ok: true, bytes: number }
\`\`\`

Alternative to the server bake above: the CardWindow disk button does a
client-side canvas pass and POSTs the result here. Use this only if you
need pixel-exact WYSIWYG of a host's screen; otherwise prefer
\`/v1/card/publish\`.
`;
}

// =============================================================================
// Episode
// =============================================================================

export function skillEpisode(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  const hostNote = isHost ? "" : "\n\n> ⚠ `/admin/episode/stt` (the STT gate) is **host-only** — peer tokens return 403. `/v1/episode/captions` (the caption-overlay toggle) and all reads are open to anyone in the room.";
  return `${header(token, scope, hostNote)}

## Episode flags sub-skill

${slugNote(slug)}

Per-room flags flipped during an episode, designed as an extensible
key-value bag. Two flags today:
- \`sttOn\` — **host-only** gate on whether the god-mode box generates
  transcripts at all.
- \`captionsOn\` — **anyone-in-the-room** toggle on whether the on-screen
  subtitle overlay paints (separate from whether STT is running).

### Read

\`\`\`
GET ${BASE}/v1/episode?slug=${slugStr(slug)}
# → { sttOn: boolean, captionsOn: boolean }
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

### Toggle captions — anyone in the room

\`\`\`
POST ${BASE}/v1/episode/captions?slug=${slugStr(slug)} { "on": true }    # or false
# → { ok: true, state: { sttOn, captionsOn } }
\`\`\`

Purely cosmetic: hides/shows the live subtitle overlay on screen
without touching whether STT runs or the transcript records. Not
host-gated — any participant (or agent) can flip it.
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

### Room metadata (unauthed)

\`\`\`
GET ${BASE}/v1/rooms/${slugStr(slug)}/meta
# → {
#     slug, name, createdAt,
#     live: boolean,                # at least one peer connected right now
#     stt:  boolean,                # sttOn flag for the episode
#     card: { published: boolean }, # baked title card on disk
#     wallet: { address, label, chains: number[] } | null
#   }
\`\`\`

Public read — useful for an external dashboard / preview card without
needing a token. Returns a snapshot, not a long-poll. \`live: true\`
is the cheap "is anyone home?" check before deciding to join.

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

### Access gate mode — host-only

\`\`\`
POST ${BASE}/v1/rooms/${slugStr(slug)}/gate { "mode": "password" | "wallet-signers" }
# → { ok: true, slug, gate }
# 409 no-wallet-signers (wallet-signers mode needs a deployed multisig with signers)
# 403 not-a-signer · 404 no-such-room
\`\`\`

\`password\` = anyone with the password joins (default). \`wallet-signers\`
= only addresses that are signers on the room's multisig may enter
(ERC-1271-style gating). Switching to \`wallet-signers\` requires the
caller to be a current signer.

### Invite link helpers — host-only

\`\`\`
GET  ${BASE}/v1/rooms/${slugStr(slug)}/invite
# → { slug, password }   # plaintext invite password so the admin panel can build a ?invite= link (null for pre-plaintext rooms)
POST ${BASE}/v1/rooms/${slugStr(slug)}/invite { "password": "<known password>" }
# → { ok: true }   # backfill the plaintext for a room that only has a hash on file; 401 if wrong. Does NOT rotate — existing links keep working
\`\`\`

### Onboarding questions (the join prompt) — read any, write host-only

\`\`\`
GET ${BASE}/v1/admin/questions   # → { text }   the shared "questions to ask" prompt shown when joining
PUT ${BASE}/v1/admin/questions   { "text": "..." }   # host-only; 413 over 20k chars
\`\`\`

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
// WebSocket (mesh signaling + WS-only verbs + broadcast catalog)
// =============================================================================

export function skillWs(token: string, isHost: boolean, slug: string | null = null): string {
  const scope = isHost ? "host" : "peer";
  const S = slugStr(slug);
  return `${header(token, scope, "")}

## WebSocket sub-skill

${slugNote(slug)}

The mesh socket at \`wss://live.slop.computer/signal?slug=${S}\` carries
three things REST can't (or won't):

1. **WebRTC signaling** — offer / answer / ice between peers for media.
2. **Real-time input** — paddle Y, worm direction, cursor drag — anything
   too fast for an HTTP round-trip per frame.
3. **Server → client broadcasts** — every room mutation fans out here so
   you can react without polling \`/v1/state\`.

Most agent-callable surfaces also have REST mirrors documented in the
per-app sub-skills. This page exists for (a) the few WS-only verbs and
(b) the broadcast catalog.

### Connection + auth

\`\`\`
wss://live.slop.computer/signal?slug=${S}
\`\`\`

Auth is **cookie-only today**: the WS handshake reads the \`SESSION_COOKIE\`
and (for non-default slugs with a password) the room cookie. An agent
that only holds a \`/v1/agent-token\` bearer **cannot open the socket** —
bearer-tokened agents stay HTTP-only and poll \`/v1/state\` / sub-skill
long-polls. If you need WS access for an agent, hand it a real browser
session (cookies from the password / passkey / SIWE / anon flow) and
join \`/signal\` from there.

On successful connect the server sends:

\`\`\`json
{ "type": "hello", "id": "<peerId>", "peers": [...], "publications": [...],
  "slots": {...}, "browsers": {...}, "avatars": {...}, "chatHistory": [...],
  "openWindows": [...], "musicState": {...}, "chessGame": {...}, ... }
\`\`\`

Same shape as the top-level fields of \`/v1/state\` plus the \`peerId\` the
relay assigned you. Cache it as your initial snapshot.

Close codes: \`4401\` unauthenticated · \`4404\` room-not-found · \`4403\`
room-auth-required · \`4290\` payment-required · \`4409\` session-replaced.

### Client → server messages

Every message is JSON \`{ "type": "<name>", ...fields }\`. **Spectator
(god-mode) sessions** are restricted to \`hello / ping / offer / answer /
ice / god_viewport\`; every other type is dropped server-side as a
defense-in-depth measure.

| Type | Fields | REST equivalent | Notes |
| --- | --- | --- | --- |
| \`hello\` | — | n/a | handshake ack (no-op, the server-side hello is what matters) |
| \`ping\` | — | n/a | server replies \`{type:"pong"}\` |
| \`ping_report\` | \`rtt\` | n/a | publish your relay-RTT to the guest-list meter |
| \`offer\` / \`answer\` / \`ice\` | \`to\`, \`payload\` | **WS-only** | WebRTC signaling, routed to a single peer |
| \`god_viewport\` | \`viewport: {width, height} \\| null\` | **WS-only** | OBS-capture dashed rectangle (god-mode only) |
| \`god_geometry\` | \`vw, vh, windows: [{id, x, y, w, h, z}]\` | **WS-only** | god-mode only; logs each media window's actual rendered rect (px, viewport-relative) → \`geometry.jsonl\` (\`src:"god"\`) for the clipper's 9:16 crop |
| \`green_room\` | \`on\` | **WS-only** | god-mode/spectator only — flips the off-air/standby/on-air sign every viewer sees |
| \`cursor\` | \`x, y\` | \`POST /v1/cursor\` | labelled cursor position |
| \`click\` | \`x, y\` | \`POST /v1/click\` | colored click ripple |
| \`card_title\` | \`title: { text, x, y, sizeFrac }\` | **WS-only** | shared title overlay on the per-room card; \`0 ≤ x,y ≤ 1\`, \`0.015 ≤ sizeFrac ≤ 0.25\` |
| \`chat_send\` | \`text\` | \`POST /v1/chat\` | room chat |
| \`tip_announce\` | \`amountEth\`, \`chainId\` | \`POST /v1/tip/announce\` | celebrate an ETH tip to the room multisig — chat line + (≥0.001) a flying \`tip\` card. See \`/v1/skill/wallet\` |
| \`live_caption\` / \`live_caption_state\` | \`text\` / \`on\` | none | speaker's in-browser STT subtitle line + on/off |
| \`set_custom_name\` | \`name\` | \`POST /auth/handle\` | anon-user rename |
| \`set_balance_hidden\` | \`hidden\` | **WS-only** | hide/show your own USD balance in the room's guest list (swaps the amount for 👛) |
| \`tldr_request\` | — | **WS-only** | trigger an AI TLDR of the live transcript; result fans out as a \`transcript\`/glossary update |
| \`todo_add\` / \`todo_toggle\` / \`todo_update\` / \`todo_delete\` / \`todo_clear_done\` / \`todo_reorder\` | mirror REST | \`POST /v1/todos*\` | full CRUD over WS |
| \`note_create\` / \`note_update\` / \`note_delete\` | mirror REST | \`POST /v1/notes*\` | full CRUD over WS |
| \`glossary_add\` / \`glossary_regenerate\` / \`glossary_delete\` | mirror REST | \`POST /v1/glossary*\` | full CRUD over WS |
| \`corpus_create\` / \`corpus_update\` / \`corpus_delete\` | mirror REST | \`POST/DELETE /v1/research/corpus*\` | host-curated research source docs (see \`/v1/skill/research\`) |
| \`publish\` / \`unpublish\` / \`set_camera_off\` | publication fields | **WS-only** | declare/withdraw a camera/mic/screen publication |
| \`slot_update\` | \`id\`, partial geometry | \`POST /v1/slots\` | move/resize a window or icon |
| \`browser_open\` / \`browser_navigate\` / \`browser_close\` | \`id\`, \`url\` | \`POST/DELETE /v1/browsers...\` | shared browsers |
| \`window_open\` / \`window_close\` | \`id\` | \`POST/DELETE /v1/windows\` | singleton windows |
| \`preview_media\` | playhead | none | per-room file-preview playhead sync |
| \`scroll_sync\` | \`scrollTop\` | none | per-room scroll-position sync |
| \`ui_state\` | partial | none | per-room misc UI scratch |
| \`music_state\` | snapshot | \`POST /v1/music/state\` | shared slopamp head |
| \`chess_create_game\` / \`chess_move\` / \`chess_resign\` / \`chess_close_game\` | mirror REST | \`POST /v1/chess/...\` | chess |
| \`pong_claim\` / \`pong_release\` / \`pong_paddle\` / \`pong_reset\` | mirror REST | \`POST /v1/pong/...\` | pong (use WS for paddle @ 30Hz) |
| \`worm_claim\` / \`worm_release\` / \`worm_dir\` / \`worm_reset\` | mirror REST | \`POST /v1/worm/...\` | worm (use WS for dir) |
| \`putt_claim\` / \`putt_release\` / \`putt_start\` / \`putt_shoot\` / \`putt_reset\` | mirror REST | \`POST /v1/putt/...\` | putt-putt (turn-based; REST is the agent path) |
| \`putt_rename\` | \`name\` | **WS-only** | set your putt player's display name |
| \`poker_act\` / \`poker_next_hand\` / \`poker_show_cards\` | mirror REST | \`POST /v1/poker/...\` | play hands over REST (see \`/v1/skill/poker\`) |
| \`poker_open_table\` / \`poker_join\` / \`poker_sponsor_ai\` / \`poker_start\` | table config / \`txHash\` | **WS-only** | open table, buy in, fund an AI seat, start dealing — all need a real on-chain deposit (human wallet only) |
| \`wager_propose\` / \`wager_start\` | white/black keys, \`buyinWei\` | **WS-only** | money-chess: open + start an escrowed wager (real wallets only) |
| \`escrow_fund\` / \`escrow_cancel\` / \`escrow_clear\` | \`txHash\` (fund) | **WS-only** | deposit a buy-in (relay verifies on-chain) / abort / reset the escrow session |
| \`tx_request\` | tx | **WS-only** | impersonator captured an \`eth_sendTransaction\` (from browser-host) |
| \`tx_forward\` | tx | **WS-only** | peer wants to forward a captured tx to their own real wallet |
| \`wallet_deploy\` / \`wallet_add_deployment\` | sigs + deployment | **WS-only** | multisig deployment flow (real signers, not agents) |
| \`wallet_new_episode\` | — | **WS-only** | host clears wallet for new show |
| \`wallet_draft_update\` | partial draft | **WS-only** | collaborative pre-deploy form state |
| \`wallet_tx_propose\` | proposal | \`POST /v1/wallet/propose\` | propose a multisig tx (REST mirror is the agent-friendly path) |
| \`wallet_tx_sign\` | sig | **WS-only** | sign a pending tx (needs a real signer's private key) |
| \`wallet_tx_status\` / \`wallet_tx_remove\` / \`wallet_tx_resummarize\` | \`txId\`, ... | **WS-only** | tx-queue maintenance |
| \`wallet_nested_request\` / \`wallet_nested_result\` | \`outerSlug\`, \`outerWalletAddress\`, \`outerTxId\`, sig | **WS-only** | nested-multisig signing (a room wallet that is itself a signer on another room's wallet) — real signers only |

**WS-only** in that table = no REST mirror. The big ones for agents to
know about: \`card_title\` (the only way to drive the title overlay) and
the wallet deploy/sign flow (real signers only — agents shouldn't sign).

### Server → client broadcasts

Every state-bearing room subsystem fans out over the same socket. Listen
to these to react without polling \`/v1/state\`:

| Type | Fields | Fires when |
| --- | --- | --- |
| \`peer_join\` / \`peer_leave\` | \`peer\` | someone enters / leaves the room |
| \`peer_ping\` | \`from\`, \`rtt\` | peer reports relay RTT |
| \`cursor\` / \`click\` | \`from\`, \`x\`, \`y\` | live presence |
| \`chat\` | \`msg\` | new chat appended |
| \`transcript_seg\` | \`seg\` | new STT segment landed |
| \`chess_state\` / \`chess_history\` | \`game\` / \`history\` | chess changed |
| \`music_state\` / \`music_genre\` / \`music_custom\` | snapshot / event / tracks | music changed |
| \`todos\` / \`notes\` | \`items\` | list mutated |
| \`clock_state\` / \`episode\` / \`chyron\` | \`state\` | per-room subsystems |
| \`research_state\` / \`leftclaw_state\` / \`wallet_chat\` | \`state\` | AI / job-posting surfaces changed |
| \`escrow_state\` / \`escrow_fund_result\` | \`escrow\` / \`ok,txHash\` | money-chess escrow changed / your deposit was verified |
| \`card_state\` / \`card_job\` / \`card_title\` | snapshot / job / title | title-card pipeline |
| \`window_opened\` / \`window_closed\` | \`id\` | singleton toggled |
| \`browser\` / \`browser_closed\` | \`browser\` / \`id\` | shared browsers |
| \`slot\` | \`slot\` | window/icon moved or resized |
| \`published\` / \`unpublished\` | \`publication\` / \`peerId,streamId\` | media publication changes |
| \`avatar\` | \`ownerKey\`, \`url\` | someone updated their PFP |
| \`wallet_tx_attention\` | \`txId\`, \`source\`, \`at\` | new pending tx wants signatures |
| \`pong\` / \`worm\` | snapshot | physics tick (only while playing) |

### Agent pattern — WS-listen, REST-mutate

The recommended shape for a HOSTED browser-session agent:

1. Open WS once, cache the \`hello\` payload as your initial snapshot.
2. \`switch (msg.type)\` to keep your local copy fresh. Most updates
   are last-writer-wins replacements of one field — no diff logic.
3. Mutate via REST (every sub-skill documents the routes). REST is
   easier to retry, idempotent on most surfaces, and survives a WS
   reconnect cleanly.

For an HTTP-only agent (bearer token, no cookies, no WS): poll \`/v1/state\`
at ~1 Hz for the slow drift, and use the per-app long-polls
(\`/v1/chess/wait\`, \`/v1/music/wait\`) for the things that need fast
reactions. You'll miss sub-second events (paddle frames, raw cursor
streams) but every persistent surface is reachable.
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
icon shows up on **this room's** desktop immediately (per-room by
default — pass \`"scope":"global"\` to put it in every room). Double-
clicking it opens a shared browser pointed at your URL.

\`\`\`
POST ${BASE}/v1/apps {
  "id":    "my-dapp",                       # kebab-case, 1-40 chars
  "label": "My DApp",                       # title bar + under the icon
  "icon":  "/v1/app-icons/my-dapp",         # from /v1/icons/generate or upload (see below)
  "url":   "https://my-dapp.vercel.app",
  "chrome": "app"                           # optional: clean titled window, no URL bar
}
\`\`\`

Need an icon? You don't need the repo. Generate one in the house style
from a prompt, or upload your own — both return a \`url\` to drop in
\`icon\` above:

\`\`\`
# generate (gpt-image-1, ~15-25s)
POST ${BASE}/v1/icons/generate  { "id": "my-dapp", "prompt": "<describe it>" }
# or upload raw bytes (image/png|webp|jpeg, <=512KB)
curl -X POST -H "content-type: image/png" --data-binary @icon.png "${BASE}/v1/icons?id=my-dapp"
# both → { ok, url: "/v1/app-icons/my-dapp" }
\`\`\`

\`chrome: "app"\` makes the shared-browser window present as a clean
titled app (label in the title bar, URL/nav bar hidden) instead of
looking like a browser — the right look for a dApp that bubbles txs to
the room multisig. Omit it for a normal browser window.

That's it. No \`kind\` field → defaults to iframe in a shared browser.
Survives relay restarts: a room app persists to
\`.slop-data/rooms/<slug>/apps.json\`, a global one (\`scope:"global"\`) to
\`hot-apps.json\` — both survive restart but not a full \`.slop-data\`
wipe. \`DELETE /v1/apps/:id\` to remove (defaults to this room's copy).

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
  handler — TWO places, both the initial GET handler and the WS
  \`hello\` payload). New joiners need the field both ways.
- **Add a kind** to \`DEFAULT_APPS\` *and* to the \`AppEntry["kind"]\`
  union right above it (\`packages/relay/src/index.ts\`). The union
  isn't auto-generated; check-types fails on the cast otherwise.
- **Mirror the kind on the frontend.** \`packages/nextjs/components/Desktop.tsx\`
  has its own \`AppEntry["kind"]\` union (separate from the relay's) —
  add the kind there too, or the next typecheck fails.
- **Route the icon double-click.** Same \`Desktop.tsx\`: add your kind
  to the \`activateApp\` switch alongside chess/music/qr/etc, so it
  calls \`focusApp(app.id)\`. **Silent failure mode** — without this
  case the icon falls through to the URL-spawn default and double-
  clicking does nothing, no console error.
- **Window component** in
  \`packages/nextjs/components/desktop/MyWindow.tsx\`, mounted in
  \`Desktop.tsx\` inside a \`<SharedAppWindow id="my">\`, subscribing
  via \`usePeerMesh\` (see \`packages/nextjs/hooks/usePeerMesh.ts\` — add
  a state slot + setter + a \`my_state\` case in the WS message handler
  + hydrate the field from the initial \`hello\` payload).

Match existing patterns:
- **Low-frequency state** (turn-based, chat-like, edit-then-broadcast):
  \`research-state.ts\` + \`ResearchWindow.tsx\`, \`clock.ts\` + \`ClockWindow.tsx\`.
- **High-frequency state** (real-time physics, held-key input,
  per-frame updates): \`pong.ts\` + \`PongWindow.tsx\`, or a relay-driven
  grid sim with up-to-N seats + client interpolation: \`worm.ts\` +
  \`WormWindow.tsx\`. Read **L2.5** below before you write a single line
  of physics — there are three traps that look fine in dev and break
  with a remote peer.

### L2.5 — real-time input / physics (extra rules on top of L2)

If your app needs held-key input, dragged-cursor input, or a relay-
driven physics tick (anything updating faster than ~1 Hz), follow
these on top of the L2 anatomy. Skipping them produces bugs that
only show up with a second peer — local solo testing looks perfect.

1. **Authority split — local owns local input, server owns shared.**
   The server's record of YOUR own paddle/cursor/brush lags your
   fingers by ~1 RTT. If you reconcile your local value against the
   server's broadcast every tick, your input snaps backwards every
   frame — visible as oscillation while a key is held. Keep the
   local value as the single source of truth while you hold input;
   reset it only on ownership change (seat acquire/release, focus
   loss, peer disconnect). The server's stored value matters only
   for what OTHER peers render. See the \`localPaddleRef\` /
   \`pongStateRef\` split in \`PongWindow.tsx\`.

2. **RAF loops read fast-changing state via refs, NOT useEffect deps.**
   Putting your 30Hz state in a \`useEffect\` dep array tears down +
   restarts the \`requestAnimationFrame\` loop on every server snapshot.
   Each restart drops one input-integration frame and resets \`prevT\`,
   so held-key motion stutters. Pattern: small effect that copies
   state to a ref, the RAF effect itself on \`[]\` deps reading the ref.

3. **Throttle network sends to 20-30 Hz, not per-frame.** Integrate
   input at 60 Hz locally for smooth rendering, but only send the
   latest value at \`SEND_HZ\` (timestamp-throttled). The server's tick
   uses whatever your last sent value was; sending 60×/sec wastes
   relay CPU + bandwidth for no visible gain.

4. **Stop the relay-side physics ticker when nobody's playing.** A
   \`setInterval\` lives forever until cleared. Start it when the
   game is actually playable (e.g. both seats filled); clear it on
   the first event that breaks that condition (peer disconnects,
   match ends). Otherwise an abandoned room burns CPU and broadcasts
   ghost snapshots to zero peers. See \`Pong.afterSeatChange()\` and
   \`Pong.stopTicker()\`.

5. **Free per-peer-owned slots on WS disconnect.** Whatever your
   "I own this seat" data is, hook it into \`Room.removePeer()\` so
   the seat releases when the peer's socket closes. Without this, a
   simple page refresh leaves the seat locked and the next claim
   attempts return 409. Pong does \`this.pong.release(peerOwnerKey)\`
   inline in \`removePeer\`.

6. **WS for input, REST for control.** High-frequency client→server
   messages (paddle moves, cursor drags) go via the existing WS
   socket — \`send({ type: "my_input", ... })\` in usePeerMesh, handled
   in the giant \`socket.on("message")\` switch in \`index.ts\`. Reserve
   REST endpoints (\`/v1/my/claim\`, \`/v1/my/reset\`) for low-frequency
   control verbs, especially the ones agents need to drive via curl.

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
- \`"chat" / "music" / "chess" / "pong" / "worm" / "todo" / "notes" /
  "glossary" / "gas" / "clock" / "wallet" / "ens" / "research" / "news" /
  "transcript" / "card"\` — each spawns a built-in singleton window with
  its own per-room shared state. To make your own equivalent, take the
  L2 path.
- \`"audio" / "video" / "screen"\` — peer publication (camera / mic /
  screen share). Per-peer ephemeral; closed when the peer disconnects.
- \`"qr"\` — per-peer-controlled, room-shared window (text + center
  logo broadcast across the mesh).

## Multiplayer levels — pick what your app needs

| Level | Examples | Lives where | What "shared" means |
| --- | --- | --- | --- |
| **Per-peer ephemeral** | camera / mic / screen | mesh peer record | exists while the peer is connected; vanishes on disconnect |
| **Per-room shared** | chat, music, chess, todos, notes, clock, wallet, research, card, transcript, qr, file-preview playhead | \`Room.<feature>\` on the relay | last-writer-wins broadcast to every peer in the room |
| **Global** | gas, ticker, headlines, timeline, news digest, avatars, glossary | module-level on the relay | one snapshot for every room, polled or written centrally |
| **Layered (per-room over global)** | apps catalog | room layer over a global overlay over built-ins | room apps shadow global, global shadows built-ins; \`promote\` lifts a room app to global |

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

## Third-party app, zero repo access — the full loop

You do NOT need the slop-computer-live repo to ship an app to a room.
With just a host-scoped token you can generate an icon, register the
app, and have it bubble transactions to the room's multisig. The whole
flow is HTTP:

\`\`\`bash
# 1. Get an icon — generate one in the house style from a prompt …
curl -s -X POST -H "Authorization: Bearer ${token}" -H "content-type: application/json" \\
  "${BASE}/v1/icons/generate" \\
  -d '{"id":"my-dapp","prompt":"A retro 3D piggy bank with neon lightning bolts."}'
#   … or upload your own PNG instead:
#   curl -X POST -H "content-type: image/png" --data-binary @icon.png "${BASE}/v1/icons?id=my-dapp"
#   → both return { url: "/v1/app-icons/my-dapp" }

# 2. Register the app. chrome:"app" = clean titled window (no URL bar),
#    so a dApp looks like a real app, not a browser tab.
curl -s -X POST -H "Authorization: Bearer ${token}" -H "content-type: application/json" \\
  "${BASE}/v1/apps" \\
  -d '{"id":"my-dapp","label":"My DApp","icon":"/v1/app-icons/my-dapp","url":"https://my-dapp.vercel.app","chrome":"app"}'
\`\`\`

That's the whole thing — the icon shows on **this room's** desktop
(per-room by default; \`POST /v1/apps/:id/promote\` later if you want it
everywhere), double-click opens your dApp in the shared browser. Because the shared browser
injects the impersonator (set to the room's deployed multisig when one
exists), your dApp's \`eth_sendTransaction\` is captured and proposed to
that multisig — the room's signers ratify it N-of-M and it executes
on-chain. Build a normal viem/wagmi dApp; treat every tx as advisory
(the connected account is a contract with no private key). Detect the
impersonator via EIP-6963 \`rdns: "computer.slop.impersonator"\` (or
\`window.ethereum.isSlopImpersonator\`) and fire txs straight at it.

### Verify it landed / clean up

\`\`\`bash
# confirm it's in THIS room's resolved catalog
curl -s -H "Authorization: Bearer ${token}" \\
  "${BASE}/v1/state?slug=${S}" | jq '.apps[] | select(.id == "my-dapp")'
# remove this room's copy when you're done
curl -s -X DELETE -H "Authorization: Bearer ${token}" "${BASE}/v1/apps/my-dapp"
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
    case "poker":
      return skillPoker(token, isHost, slug);
    case "pong":
      return skillPong(token, isHost, slug);
    case "worm":
      return skillWorm(token, isHost, slug);
    case "putt":
      return skillPutt(token, isHost, slug);
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
    case "leftclaw":
      return skillLeftclaw(token, isHost, slug);
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
    case "ws":
      return skillWs(token, isHost, slug);
    case "build":
      return skillBuild(token, isHost, slug);
  }
}

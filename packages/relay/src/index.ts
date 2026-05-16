import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { createHmac, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { config } from "./config.js";
import {
  type Publication,
  type SlotKind,
  type SlotPosition,
  applySlotUpdate,
  clearPeerPublications,
  getSlots,
  listPublications,
  publish as publishStream,
  findPublicationOwner,
  unpublish as unpublishStream,
} from "./desktop.js";
import {
  closeBrowser as closeSharedBrowser,
  listBrowsers,
  navigateBrowser as navigateSharedBrowser,
  openBrowser as openSharedBrowser,
} from "./browsers.js";
import { isKnownFanoutId, listFanouts, shutdownAllFanouts, startFanout, stopFanout } from "./fanout.js";
import { finalizeRecording, findLatestRecording, isFinalizeInFlight } from "./recordings.js";
import { addPeer, broadcast, findPeersBySessionToken, kickById, listPeers, removePeer, send, sendTo } from "./peers.js";
import {
  MAX_TEXT_LEN as CHAT_MAX_TEXT,
  type ChatMessage,
  allow as allowChat,
  append as appendChat,
  recent as recentChat,
  subscribe as subscribeChat,
} from "./chat.js";
import {
  MAX_TEXT_LEN as TRANSCRIPT_MAX_TEXT,
  type TranscriptSegment,
  allow as allowTranscript,
  append as appendTranscript,
  recent as recentTranscript,
  subscribe as subscribeTranscript,
} from "./transcript.js";
import {
  SESSION_COOKIE,
  consumeNonce,
  createAgentSession,
  createSession,
  deleteSession,
  getSession,
  issueNonce,
} from "./sessions.js";
import { INVITE_COOKIE, getInvitePassword, isInvited, regenerateInvitePassword } from "./invites.js";
import { bytesToBase64Url, hexToBytes, verifyPasskey } from "./passkey.js";
import { isAdminAddress, verifySiwe } from "./siwe.js";
import { closeWindow as closeSingletonWindow, listOpenWindows, openWindow as openSingletonWindow } from "./windows.js";
import {
  applyMove as chessApplyMove,
  clearGame as chessClearGame,
  createGame as chessCreateGame,
  getCurrentGame as chessGetCurrentGame,
  getHistory as chessGetHistory,
  resign as chessResign,
} from "./chess.js";
import { listAvailableAIPlayers } from "./ai-players.js";
import { maybeMoveAI } from "./ai-mover.js";
import {
  add as todoAdd,
  clearDone as todoClearDone,
  list as todoList,
  remove as todoRemove,
  reorder as todoReorder,
  subscribe as subscribeTodos,
  toggle as todoToggle,
  update as todoUpdate,
} from "./todos.js";
import {
  create as noteCreate,
  list as noteList,
  remove as noteRemove,
  subscribe as subscribeNotes,
  update as noteUpdate,
} from "./notes.js";
import {
  create as glossaryCreate,
  list as glossaryList,
  regenerate as glossaryRegenerate,
  remove as glossaryRemove,
  subscribe as subscribeGlossary,
} from "./glossary.js";
import { type GasState, getState as getGasState, start as startGas, subscribe as subscribeGas } from "./gas.js";
import { resolveEns } from "./ens.js";
import {
  FILES_DIR_PATH,
  FILES_MAX_BYTES,
  add as fileAdd,
  get as fileGet,
  list as fileList,
  remove as fileRemove,
  subscribe as subscribeFiles,
} from "./files.js";
import {
  GENRE_IDS,
  GENRES,
  JAMENDO_DIR,
  type JamendoTrack,
  addToCustom,
  getCurrentGenre,
  getCustomPlaylist,
  isGenre,
  readPlaylist,
  refreshGenre,
  removeFromCustom,
  reorderCustom,
  setCurrentGenre,
  subscribeCustom,
  subscribe as subscribeJamendo,
} from "./jamendo.js";
import {
  type ClockState,
  getState as getClockState,
  setState as setClockState,
  subscribe as subscribeClock,
} from "./clock.js";
import {
  type WalletRecord,
  type WalletTx,
  addSignature as walletAddSignature,
  archiveCurrent as walletArchiveCurrent,
  findTx as walletFindTx,
  listTxs as walletListTxs,
  getCurrent as walletGetCurrent,
  proposeTx as walletProposeTx,
  removeTx as walletRemoveTx,
  setCurrent as walletSetCurrent,
  setTxStatus as walletSetTxStatus,
  setTxSummary as walletSetTxSummary,
  subscribe as subscribeWallet,
  wipeAll as walletWipeAll,
} from "./wallet.js";
import { summarizeTransaction } from "./wallet-ai.js";

// Shared music-player state — singleton across the mesh. When any peer
// presses play/pause/seek/next, they push a snapshot here; we rebroadcast
// it so every other peer can keep their local <audio> in lockstep. Not
// persisted; transient session state, lost on relay restart.
type MusicState = {
  src: string | null;
  index: number;
  playing: boolean;
  /** seconds into the track at `at` */
  position: number;
  /** Date.now() when this snapshot was captured */
  at: number;
  /** 0..1 master volume — shared so peers stay in lockstep */
  volume: number;
};
let musicState: MusicState | null = null;

// Music "state version" — bumped on every set. Lets an agent DJ-loop
// (long-poll → react → set → poll again) wait cheaply for the track
// to end or for another peer to change the snapshot.
let musicStateVersion = 0;
type MusicWaiter = { wake: () => void; cleanup: () => void };
const musicWaiters: MusicWaiter[] = [];

function bumpMusicVersion(): void {
  musicStateVersion++;
  const woke = musicWaiters.splice(0);
  for (const w of woke) {
    try {
      w.cleanup();
    } catch {
      /* ignore */
    }
    try {
      w.wake();
    } catch {
      /* ignore */
    }
  }
}

// Chess "state version" — bumped every time the chess game changes
// (create/move/resign/abort). Lets long-pollers wait cheaply for the
// next change without us needing to keep diffs of the game itself.
let chessStateVersion = 0;
type ChessWaiter = { wake: () => void; cleanup: () => void };
const chessWaiters: ChessWaiter[] = [];

function bumpChessVersion(): void {
  chessStateVersion++;
  // Splice + iterate so wake handlers can't accidentally double-resolve
  // by pushing themselves back into the queue.
  const woke = chessWaiters.splice(0);
  for (const w of woke) {
    try {
      w.cleanup();
    } catch {
      /* ignore */
    }
    try {
      w.wake();
    } catch {
      /* ignore */
    }
  }
}

// Single broadcast helper for chess state changes — also bumps the
// version counter so long-pollers wake up, AND nudges the AI mover
// in case the new turn belongs to a server-side AI player. Use this
// instead of calling broadcast({type:"chess_state"}) directly so we
// never forget either side effect.
//
// AI-vs-AI relies on the recursion at the bottom: when an AI's move
// applies, `notifyAfterMove` calls broadcastChessState again with
// the new state, which itself bumps the version + schedules another
// maybeMoveAI tick. Each recursive call yields via setImmediate so
// the stack never grows. Bounded by inFlight + lastVersionHandled
// inside maybeMoveAI — no infinite loop possible.
function broadcastChessState(game: import("./chess.js").ChessGame | null): void {
  broadcast({ type: "chess_state", game });
  bumpChessVersion();
  setImmediate(() => {
    maybeMoveAI(chessStateVersion, () => {
      // After the AI's move applies, re-enter broadcastChessState so
      // (a) peers see the move and (b) the next side gets nudged. The
      // previous version of this callback only broadcast inline and
      // forgot the nudge — fine for human-vs-AI (the human's next move
      // re-enters via the WS handler) but AI-vs-AI got stuck because
      // nobody scheduled the next side's tick.
      const next = chessGetCurrentGame();
      broadcastChessState(next);
      if (next && next.status !== "active") {
        broadcast({ type: "chess_history", history: chessGetHistory() });
      }
    }).catch(err => console.error("[ai-mover] tick failed:", err));
  });
}

const PRIMARY_HOST_ADDR = config.adminAddresses[0] ?? null;

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 16 * 1024,
});

// Image uploads on /v1/avatars come in as raw image/* bytes — register a
// passthrough parser so Fastify gives us the Buffer instead of trying to
// parse JSON. Per-route bodyLimit overrides the global 16KB cap.
app.addContentTypeParser(/^image\/(jpeg|png|webp)$/, { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});
// Generic binary upload — used by the desktop file system. Clients POST
// raw bytes as application/octet-stream and pass the real mime + name
// in `x-mime` / `?name=`.
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});

await app.register(cors, {
  origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
  credentials: true,
});
await app.register(cookie, { secret: config.sessionSecret });
await app.register(websocket);

app.get("/health", async () => ({
  ok: true,
  service: "slop-relay",
  peers: listPeers().length,
}));

// --- Apps registry ----------------------------------------------------------
// JSON-driven desktop app catalog. Edit /var/lib/slop-relay/apps.json on the
// box and the next page load picks it up — no rebuild, no restart. Schema:
//   { "apps": [{ "id", "label", "icon", "url" }] }
//
// `icon` can be a relative path (served by Next.js, e.g. "/icons/foo.png")
// or an absolute URL. `url` is what the SharedBrowser will load when the
// icon is double-clicked.

import { readFileSync as _readFileSync, readdirSync as _readdirSync } from "node:fs";
import { mkdir as _mkdir, writeFile as _writeFile } from "node:fs/promises";
import { dirname as _dirname, resolve as _resolve } from "node:path";

const APPS_PATH = process.env.APPS_PATH ?? "/var/lib/slop-relay/apps.json";

type AppEntry = {
  id: string;
  label: string;
  icon: string;
  url?: string;
  kind?:
    | "browser"
    | "chat"
    | "audio"
    | "video"
    | "screen"
    | "music"
    | "chess"
    | "qr"
    | "todo"
    | "notes"
    | "gas"
    | "clock"
    | "wallet";
};

const DEFAULT_APPS: AppEntry[] = [
  {
    id: "browser",
    label: "Browser",
    icon: "/icons/browser.png",
    url: "https://clawd-slop-landing-nextjs.vercel.app/",
  },
  {
    id: "chat",
    label: "Chat",
    icon: "/icons/chat.png",
    kind: "chat",
  },
  {
    id: "audio",
    label: "Audio",
    icon: "/icons/mic.png",
    kind: "audio",
  },
  {
    id: "video",
    label: "Video",
    icon: "/icons/video.png",
    kind: "video",
  },
  {
    id: "screen",
    label: "Screen",
    icon: "/icons/screen-sharing.png",
    kind: "screen",
  },
  {
    id: "music",
    label: "Music",
    icon: "/icons/music.png",
    kind: "music",
  },
  {
    id: "chess",
    label: "Chess",
    icon: "/icons/chess.png",
    kind: "chess",
  },
  {
    id: "qr",
    label: "QR",
    icon: "/icons/qr.png",
    kind: "qr",
  },
  {
    id: "todo",
    label: "Todo",
    icon: "/icons/todo.png",
    kind: "todo",
  },
  {
    id: "notes",
    label: "Notes",
    icon: "/icons/notes.png",
    kind: "notes",
  },
  {
    id: "gas",
    label: "Gas",
    icon: "/icons/gas.png",
    kind: "gas",
  },
  {
    id: "clock",
    label: "Clock",
    icon: "/icons/clock.png",
    kind: "clock",
  },
  {
    id: "wallet",
    label: "Wallet",
    icon: "/icons/wallet.png",
    kind: "wallet",
  },
];

function readApps(): AppEntry[] {
  try {
    const raw = _readFileSync(APPS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { apps?: unknown };
    return Array.isArray(parsed.apps) ? (parsed.apps as AppEntry[]) : DEFAULT_APPS;
  } catch {
    return DEFAULT_APPS;
  }
}

async function writeApps(apps: AppEntry[]): Promise<void> {
  await _mkdir(_dirname(APPS_PATH), { recursive: true });
  await _writeFile(APPS_PATH, JSON.stringify({ apps }, null, 2));
}

app.get("/apps", async (_req, reply) => {
  // Re-read on every request so editing the file on the host is instant.
  reply.header("cache-control", "no-store");
  return { apps: readApps() };
});

// =============================================================================
// /v1/* — Agent API
// -----------------------------------------------------------------------------
// Authenticated session cookie OR `Authorization: Bearer <agent-token>`.
// Lets a participant's local LLM (Claude Code, local Llama, anything that
// can curl) read state and mutate the shared desktop the same way the
// real-time WS clients can. Agent tokens are minted via /v1/agent-token,
// scoped to the same identity as the requester's session, valid 7 days.
// =============================================================================

type V1Auth = { session: import("./sessions.js").Session; isHost: boolean; via: "bearer" | "cookie" };

function v1AuthFromReq(req: {
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
}): V1Auth | null {
  // Bearer first, cookie fallback.
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const tok = authHeader.slice(7).trim();
    const s = getSession(tok);
    if (s) return { session: s, isHost: s.role === "host" && !!s.address && isAdminAddress(s.address), via: "bearer" };
  }
  const cookieTok = req.cookies[SESSION_COOKIE];
  const s = getSession(cookieTok);
  if (!s) return null;
  return { session: s, isHost: s.role === "host" && !!s.address && isAdminAddress(s.address), via: "cookie" };
}

const ICONS_DIR = process.env.ICONS_DIR ?? _resolve(process.cwd(), "../nextjs/public/icons");

// --- Auth: mint agent token + skill file ------------------------------------

app.get("/v1/agent-token", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const agent = createAgentSession(a.session);
  return {
    token: agent.token,
    expiresAt: agent.expiresAt,
    scope: a.isHost ? "host" : "peer",
    identity: { address: agent.address, handle: agent.handle, role: agent.role },
  };
});

// --- Read: full state snapshot ----------------------------------------------

app.get("/v1/state", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return {
    you: {
      address: a.session.address,
      handle: a.session.handle,
      role: a.session.role,
      isHost: a.isHost,
      // Stable identity key — same value the chess server compares
      // against `whiteKey` / `blackKey` to enforce side-to-move. Saves
      // agents from having to derive it themselves.
      ownerKey: (a.session.address ?? a.session.handle ?? "").toLowerCase() || null,
    },
    peers: listPeers(),
    publications: listPublications(),
    slots: getSlots(PRIMARY_HOST_ADDR),
    browsers: listBrowsers(PRIMARY_HOST_ADDR),
    apps: readApps(),
    avatars: listAvatarsSync(),
    hiddenAvatars: listHiddenOwnersSync(),
    openWindowIds: listOpenWindows(),
    musicState,
    chessGame: chessGetCurrentGame(),
    chessHistory: chessGetHistory(),
    aiPlayers: listAvailableAIPlayers(),
    todos: todoList(),
    notes: noteList(),
    glossary: glossaryList(),
    gasState: getGasState(),
    files: fileList(),
    musicGenres: GENRE_IDS.map(id => ({ id, label: GENRES[id]!.label })),
    musicGenre: getCurrentGenre(),
    musicCustom: getCustomPlaylist().tracks,
    clockState: getClockState(),
    wallet: walletGetCurrent(),
    walletTxs: walletListTxs(),
  };
});

app.get("/v1/ai-players", async (req, reply) => {
  // No keys exposed — listAvailableAIPlayers strips them.
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return { aiPlayers: listAvailableAIPlayers() };
});

// --- Read: list available icon PNGs -----------------------------------------

app.get("/v1/icons", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  try {
    const entries = _readdirSync(ICONS_DIR, { withFileTypes: true });
    const icons = entries
      .filter(e => e.isFile() && /\.(png|svg|jpg|jpeg|webp)$/i.test(e.name))
      .map(e => ({ name: e.name, url: `/icons/${e.name}` }));
    return { icons };
  } catch (err) {
    return reply.code(500).send({ error: "icons-dir-unreadable", path: ICONS_DIR });
  }
});

// --- Apps: host-only mutators -----------------------------------------------

type AppBody = { id?: unknown; label?: unknown; icon?: unknown; url?: unknown };

app.post<{ Body: AppBody }>("/v1/apps", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!a.isHost) return reply.code(403).send({ error: "host-only" });
  const body = (req.body ?? {}) as AppBody;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const label = typeof body.label === "string" ? body.label : "";
  const icon = typeof body.icon === "string" ? body.icon : "";
  const url = typeof body.url === "string" ? body.url : "";
  if (!id || !label || !icon || !url) {
    return reply.code(400).send({ error: "missing-fields", required: ["id", "label", "icon", "url"] });
  }
  if (!/^[a-z0-9-]{1,40}$/.test(id)) {
    return reply.code(400).send({ error: "bad-id", note: "lowercase letters, digits, dashes, 1-40 chars" });
  }
  const apps = readApps();
  const idx = apps.findIndex(a => a.id === id);
  const next: AppEntry = { id, label, icon, url };
  if (idx >= 0) apps[idx] = next;
  else apps.push(next);
  await writeApps(apps);
  return { ok: true, app: next, total: apps.length };
});

app.delete<{ Params: { id: string } }>("/v1/apps/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!a.isHost) return reply.code(403).send({ error: "host-only" });
  const apps = readApps();
  const next = apps.filter(a => a.id !== req.params.id);
  if (next.length === apps.length) return reply.code(404).send({ error: "no-such-app" });
  await writeApps(next);
  return { ok: true, removed: req.params.id, total: next.length };
});

// --- Slots: any authenticated peer can rearrange the shared layout ----------

type SlotBody = { id?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown; z?: unknown };

app.post<{ Body: SlotBody }>("/v1/slots", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const body = (req.body ?? {}) as SlotBody;
  if (typeof body.id !== "string") return reply.code(400).send({ error: "missing-id" });
  const patch: Partial<SlotPosition> & { id: string } = { id: body.id };
  for (const key of ["x", "y", "width", "height", "z"] as const) {
    if (typeof body[key] === "number") (patch as Record<string, unknown>)[key] = body[key];
  }
  const merged = applySlotUpdate(PRIMARY_HOST_ADDR, patch);
  if (!merged) return reply.code(500).send({ error: "no-host-configured" });
  // Broadcast to live WS peers so they see the move in real time, same
  // as the existing slot_update WS handler.
  broadcast({ type: "slot", slot: merged });
  return { ok: true, slot: merged };
});

// --- Browsers: open / navigate / close --------------------------------------

type OpenBrowserBody = { id?: unknown; url?: unknown };

app.post<{ Body: OpenBrowserBody }>("/v1/browsers", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const body = (req.body ?? {}) as OpenBrowserBody;
  const url = typeof body.url === "string" ? body.url : "";
  if (!url) return reply.code(400).send({ error: "missing-url" });
  const id =
    typeof body.id === "string" && body.id.trim() ? body.id.trim() : `browser-${Math.random().toString(36).slice(2, 8)}`;
  const browser = openSharedBrowser(PRIMARY_HOST_ADDR, id, url, "agent");
  broadcast({ type: "browser", browser });
  return { ok: true, browser };
});

type NavBody = { url?: unknown };

app.post<{ Params: { id: string }; Body: NavBody }>("/v1/browsers/:id/navigate", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  if (!url) return reply.code(400).send({ error: "missing-url" });
  const browser = navigateSharedBrowser(PRIMARY_HOST_ADDR, req.params.id, url);
  if (!browser) return reply.code(404).send({ error: "no-such-browser" });
  broadcast({ type: "browser", browser });
  return { ok: true, browser };
});

app.delete<{ Params: { id: string } }>("/v1/browsers/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const ok = closeSharedBrowser(PRIMARY_HOST_ADDR, req.params.id);
  if (!ok) return reply.code(404).send({ error: "no-such-browser" });
  broadcast({ type: "browser_closed", id: req.params.id });
  return { ok: true };
});

// --- Cursor + click: agent presence -----------------------------------------
// Lets an agent show up on the desktop the way a human does. Cursor moves
// emit `cursor` messages keyed by a stable agent peer id; clicks emit a
// `click` (which produces a colored ripple). Both include the session's
// address/handle inline so the frontend can label + color them with the
// user's blockie palette without needing a synthetic peer entry.

function agentPeerId(token: string): string {
  // Stable per-agent-token id — different LLMs the same human uses get
  // distinct cursors/ripples. 12 chars is enough to avoid collisions.
  return `agent-${token.slice(0, 12)}`;
}

type XYBody = { x?: unknown; y?: unknown };

app.post<{ Body: XYBody }>("/v1/cursor", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return reply.code(400).send({ error: "missing-coords" });
  broadcast({
    type: "cursor",
    from: agentPeerId(a.session.token),
    address: a.session.address,
    handle: a.session.handle,
    x,
    y,
  });
  return { ok: true };
});

app.post<{ Body: XYBody }>("/v1/click", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return reply.code(400).send({ error: "missing-coords" });
  broadcast({
    type: "click",
    from: agentPeerId(a.session.token),
    address: a.session.address,
    handle: a.session.handle,
    x,
    y,
  });
  return { ok: true };
});

// --- Chat -------------------------------------------------------------------
// Three readers: live WS peers (broadcast inside the existing mesh socket),
// SSE subscribers (slop.computer spectators), and the REST GET /v1/chat poll.
// Single writer surface: append() in ./chat.js, called from POST /v1/chat
// (cookie/bearer) and from the WS chat_send handler. Persistence is handled
// inside chat.js (JSONL on disk, ring in memory).

// Mirror every chat append onto the live peer mesh — the existing usePeerMesh
// WS already opens a /signal connection for slot/avatar/presence, chat just
// rides along on the same socket. Spectators (no WS) get the same payload via
// SSE below.
subscribeChat(msg => {
  broadcast({ type: "chat", msg });
});

// Todo + notes: full-list broadcast on every mutation. The list is small
// (capped at 200 items each), the change semantics include mutate+delete,
// and full-state broadcast keeps reducer logic out of every client. If
// the lists grow much larger we can switch to incremental events.
subscribeTodos(items => {
  broadcast({ type: "todos", items });
});
subscribeNotes(items => {
  broadcast({ type: "notes", items });
});
// Glossary: term added or its TLDR resolved → full-list rebroadcast.
// Same small-list trade-off as notes/todos.
subscribeGlossary(items => {
  broadcast({ type: "glossary", items });
});

// Gas tracker poll loop. Server-side polling keeps the Alchemy API key
// off the client and shares one RPC budget across all connected peers.
subscribeGas(state => {
  broadcast({ type: "gas", state });
});
startGas();

// Desktop file system: broadcast every add/remove so all peers see new
// file icons appear / disappear in real time. Bulk-list events aren't
// emitted (none of the producers fire those) but the channel exists if
// we later add e.g. a "delete all my files" admin endpoint.
subscribeFiles(event => {
  if (event.type === "added") broadcast({ type: "file_added", item: event.item });
  else if (event.type === "removed") broadcast({ type: "file_removed", id: event.id });
  else broadcast({ type: "files", items: event.items });
});

// Jamendo genre selection — shared across the mesh. When any peer
// picks a genre, all peers' music players switch playlists.
subscribeJamendo(event => {
  broadcast({ type: "music_genre", genre: event.genre });
});

// Custom playlist — shared across the mesh. Broadcast the full
// track list on every add/remove/reorder so every peer's [+]/[-]
// state stays in sync.
subscribeCustom(tracks => {
  broadcast({ type: "music_custom", tracks });
});

// Clock app state — shared across the mesh. Tab pick, timezone,
// stopwatch + countdown all synchronized. Wall-clock-anchored fields
// (`startedAt`, `endAt`) mean every peer's UI computes the same
// remaining/elapsed at any moment without us syncing per-tick.
subscribeClock(state => {
  broadcast({ type: "clock_state", state });
});

// Session wallet — broadcast current/history + pending tx queue on
// every mutation. Same full-state-replace pattern as todos/notes.
subscribeWallet(state => {
  broadcast({ type: "wallet", current: state.current, history: state.history });
  broadcast({ type: "wallet_txs", txs: state.txs });
});

type ChatBody = { text?: unknown };

app.post<{ Body: ChatBody }>("/v1/chat", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const raw = typeof req.body?.text === "string" ? req.body.text : "";
  if (!raw.trim()) return reply.code(400).send({ error: "empty" });
  if (raw.length > CHAT_MAX_TEXT * 2) return reply.code(413).send({ error: "too-long" });
  // Rate-limit by session token (covers both browser cookie and agent
  // bearer — each is one chatty actor).
  if (!allowChat(a.session.token)) return reply.code(429).send({ error: "rate-limited" });
  // Source classification: bearer = agent (skill flow), cookie = browser.
  // Browser cookies that own a current WS peer are "live" desktop users;
  // those without an active WS are "spectator" (slop.computer SIWE).
  const inMesh = findPeersBySessionToken(a.session.token).length > 0;
  const source: ChatMessage["source"] = a.via === "bearer" ? "agent" : inMesh ? "live" : "spectator";
  const msg = appendChat({
    address: a.session.address,
    handle: a.session.handle,
    text: raw,
    source,
  });
  if (!msg) return reply.code(400).send({ error: "empty" });
  return { ok: true, msg };
});

app.get("/v1/chat", async (_req, reply) => {
  reply.header("cache-control", "no-store");
  return { messages: recentChat() };
});

// SSE stream for slop.computer spectators (and anyone who'd rather not open
// a WS). First write is the recent history as a single `init` event so the
// client can paint scrollback before the live feed catches up.
app.get("/v1/chat/stream", async (req, reply) => {
  // We're hijacking the raw response to stream events, which bypasses the
  // @fastify/cors plugin's outbound headers. Re-emit them by hand so
  // EventSource (cross-origin from slop.computer) doesn't get blocked.
  const origin = (req.headers.origin as string | undefined) ?? "";
  const corsOrigins = config.corsOrigins;
  const allowOrigin =
    corsOrigins.includes("*") || corsOrigins.includes(origin) ? origin || "*" : "";
  const sseHeaders: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Required when the SSE response goes out through a reverse proxy that
    // would otherwise buffer chunks (Caddy is fine but be explicit).
    "x-accel-buffering": "no",
  };
  if (allowOrigin) {
    sseHeaders["access-control-allow-origin"] = allowOrigin;
    sseHeaders["access-control-allow-credentials"] = "true";
    sseHeaders["vary"] = "Origin";
  }
  reply.raw.writeHead(200, sseHeaders);
  const write = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  write("init", { messages: recentChat() });
  const unsub = subscribeChat(msg => write("chat", msg));
  // Heartbeat — some proxies drop idle connections after ~60s.
  const heartbeat = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000);
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    unsub();
    try {
      reply.raw.end();
    } catch {
      /* already closed */
    }
  });
});

// --- Live transcript ---------------------------------------------------------
// Browsers run Web Speech locally and POST final-result segments here. Server
// stamps `ts` + identity (so a peer can't forge another peer's words) and
// persists via ./transcript.js. Same auth path as chat.
type TranscriptBody = { text?: unknown };

app.post<{ Body: TranscriptBody }>("/v1/transcript", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const raw = typeof req.body?.text === "string" ? req.body.text : "";
  if (!raw.trim()) return reply.code(400).send({ error: "empty" });
  if (raw.length > TRANSCRIPT_MAX_TEXT * 2) return reply.code(413).send({ error: "too-long" });
  if (!allowTranscript(a.session.token)) return reply.code(429).send({ error: "rate-limited" });
  const inMesh = findPeersBySessionToken(a.session.token).length > 0;
  const source: TranscriptSegment["source"] =
    a.via === "bearer" ? "agent" : inMesh ? "live" : "spectator";
  const seg = appendTranscript({
    address: a.session.address,
    handle: a.session.handle,
    text: raw,
    source,
  });
  if (!seg) return reply.code(400).send({ error: "empty" });
  return { ok: true, seg };
});

// --- Admin transcript viewer -------------------------------------------------
// Host-only. JSON for one-shot inspection, SSE for live tailing — open either
// in a browser to verify per-peer STT is flowing and correctly attributed.
app.get("/admin/transcript", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  reply.header("cache-control", "no-store");
  return { segments: recentTranscript() };
});

app.get("/admin/transcript/stream", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) {
    reply.code(401);
    return { error: auth.error };
  }
  // Host-authed (cookie or bearer), same-origin from the admin UI — no
  // cross-origin CORS gymnastics needed, just plain SSE.
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const write = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  write("init", { segments: recentTranscript() });
  const unsub = subscribeTranscript(seg => write("transcript", seg));
  const heartbeat = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000);
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    unsub();
    try {
      reply.raw.end();
    } catch {
      /* already closed */
    }
  });
});

// --- Skill files: a markdown the user can drop into a local AI --------------
//
// Split into a top-level INDEX + per-app SUB-SKILLS so an agent doesn't
// have to carry every app's docs in context if it's only doing one thing.
// All generators live in `./skill.ts`; this file only wires the routes.

import { SKILL_TOPICS, isSkillTopic, skillForTopic, skillIndex } from "./skill.js";

/** Both routes share the same auth path — accept `?token=` or
 *  cookie/bearer header. If the token came from the query string AND
 *  it's a valid session, we use it verbatim in the embedded curl
 *  examples; otherwise we mint a fresh agent session inheriting the
 *  caller's identity. */
function resolveSkillAuth(req: import("fastify").FastifyRequest, queryToken: string) {
  let auth: V1Auth | null = null;
  if (queryToken) {
    const s = getSession(queryToken);
    if (s) {
      auth = { session: s, isHost: s.role === "host" && !!s.address && isAdminAddress(s.address), via: "bearer" };
    }
  }
  if (!auth) auth = v1AuthFromReq(req);
  if (!auth) return null;
  const token = queryToken && auth.session.token === queryToken ? queryToken : createAgentSession(auth.session).token;
  return { auth, token };
}

app.get<{ Querystring: { token?: string } }>("/v1/skill", async (req, reply) => {
  const queryToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
  const got = resolveSkillAuth(req, queryToken);
  if (!got) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("content-type", "text/markdown; charset=utf-8");
  reply.header("cache-control", "no-store");
  return skillIndex(got.token, got.auth.isHost);
});

app.get<{ Params: { topic: string }; Querystring: { token?: string } }>(
  "/v1/skill/:topic",
  async (req, reply) => {
    const topic = req.params.topic;
    if (!isSkillTopic(topic)) {
      return reply.code(404).send({ error: "no-such-skill", topics: SKILL_TOPICS });
    }
    const queryToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
    const got = resolveSkillAuth(req, queryToken);
    if (!got) return reply.code(401).send({ error: "unauthenticated" });
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("cache-control", "no-store");
    return skillForTopic(topic, got.token, got.auth.isHost);
  },
);

// =============================================================================
// Avatars
// -----------------------------------------------------------------------------
// Per-user avatar images. Stored on disk keyed by lowercased address (SIWE
// users) or slugified handle (password users). Re-upload overwrites — no
// way for one user to fill the disk. Caps at 600KB on the wire (the
// frontend downscales to ~300KB before uploading).
//
// On every successful upload we broadcast `{type:"avatar", ownerKey, url}`
// so all peers update their UI immediately. The hello message also
// includes the current set so a fresh tab gets everyone's avatars at once.
// =============================================================================

const AVATARS_DIR = process.env.AVATARS_DIR ?? "/var/lib/slop-relay/avatars";
const AVATAR_PUBLIC_BASE = process.env.AVATAR_PUBLIC_BASE ?? "https://relay.slop.computer/avatars";
const AVATAR_MAX_BYTES = 600 * 1024;
const AVATAR_EXTS = ["jpg", "jpeg", "png", "webp"] as const;

type AvatarOwnerKey = string;

function ownerKeyFromSession(s: { address: string | null; handle: string | null }): AvatarOwnerKey | null {
  if (s.address) return s.address.toLowerCase();
  if (s.handle) {
    const slug = s.handle.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 32);
    return slug ? `h_${slug}` : null;
  }
  return null;
}

function avatarPublicUrl(filename: string, version: number): string {
  return `${AVATAR_PUBLIC_BASE}/${filename}?v=${version}`;
}

import { statSync as _statSync, readdirSync as _readdirSyncRaw, unlinkSync as _unlinkSync } from "node:fs";

function listAvatarsSync(): Record<AvatarOwnerKey, string> {
  const out: Record<string, string> = {};
  let files: string[];
  try {
    files = _readdirSyncRaw(AVATARS_DIR);
  } catch {
    return out;
  }
  for (const f of files) {
    const m = f.match(/^(.+)\.(jpg|jpeg|png|webp)$/i);
    if (!m) continue;
    const key = m[1]!;
    let mtime = 0;
    try {
      mtime = _statSync(`${AVATARS_DIR}/${f}`).mtimeMs | 0;
    } catch {
      /* ignore */
    }
    out[key] = avatarPublicUrl(f, mtime);
  }
  return out;
}

// Owners that have explicitly opted out of any avatar (including the
// ENS fallback). Marker is a sibling `${key}.hidden` file in the same
// directory. listAvatars / listHidden are independent reads — the
// upload + hide flows keep them mutually exclusive.
function listHiddenOwnersSync(): string[] {
  let files: string[];
  try {
    files = _readdirSyncRaw(AVATARS_DIR);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const f of files) {
    const m = f.match(/^(.+)\.hidden$/i);
    if (m) out.push(m[1]!);
  }
  return out;
}

app.post(
  "/v1/avatars",
  { bodyLimit: AVATAR_MAX_BYTES },
  async (req, reply) => {
    const a = v1AuthFromReq(req);
    if (!a) return reply.code(401).send({ error: "unauthenticated" });
    const key = ownerKeyFromSession(a.session);
    if (!key) return reply.code(400).send({ error: "no-identity-on-session" });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "empty-body", note: "send raw image bytes with image/jpeg, image/png, or image/webp" });
    }
    if (body.length > AVATAR_MAX_BYTES) return reply.code(413).send({ error: "too-large" });

    const ct = String(req.headers["content-type"] ?? "");
    const ext: (typeof AVATAR_EXTS)[number] =
      ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";

    await _mkdir(AVATARS_DIR, { recursive: true });
    // Wipe any previous avatar for this key (different extension is OK)
    // AND any `.hidden` marker — uploading implicitly un-hides.
    try {
      const existing = _readdirSyncRaw(AVATARS_DIR);
      for (const f of existing) {
        if (f.startsWith(`${key}.`)) _unlinkSync(`${AVATARS_DIR}/${f}`);
      }
    } catch {
      /* ignore */
    }

    const filename = `${key}.${ext}`;
    await _writeFile(`${AVATARS_DIR}/${filename}`, body);

    const url = avatarPublicUrl(filename, Date.now());
    broadcast({ type: "avatar", ownerKey: key, url });
    return { ok: true, url, key };
  },
);

// Opt-out endpoint: drop any uploaded image AND write a `.hidden` marker
// so peers know the user has explicitly chosen "no avatar at all". This
// suppresses the client-side ENS fallback. Re-enabled by uploading a
// new image (auto-clears the marker) or DELETE'ing the avatar entry
// (clean slate — ENS fallback resumes if available).
app.post("/v1/avatars/hide", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const key = ownerKeyFromSession(a.session);
  if (!key) return reply.code(400).send({ error: "no-identity-on-session" });

  await _mkdir(AVATARS_DIR, { recursive: true });
  // Drop any image extensions belonging to this key — only the marker remains.
  try {
    const existing = _readdirSyncRaw(AVATARS_DIR);
    for (const f of existing) {
      if (f.startsWith(`${key}.`) && !f.endsWith(".hidden")) {
        _unlinkSync(`${AVATARS_DIR}/${f}`);
      }
    }
  } catch {
    /* ignore */
  }
  await _writeFile(`${AVATARS_DIR}/${key}.hidden`, "");

  broadcast({ type: "avatar_hidden", ownerKey: key });
  return { ok: true, hidden: true, key };
});

app.delete("/v1/avatars", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const key = ownerKeyFromSession(a.session);
  if (!key) return reply.code(400).send({ error: "no-identity-on-session" });
  // Clean slate: remove any image AND any `.hidden` marker so the user
  // returns to the default "no upload, ENS fallback if any" state.
  let removed = false;
  try {
    const existing = _readdirSyncRaw(AVATARS_DIR);
    for (const f of existing) {
      if (f.startsWith(`${key}.`)) {
        _unlinkSync(`${AVATARS_DIR}/${f}`);
        removed = true;
      }
    }
  } catch {
    /* dir doesn't exist yet → nothing to remove */
  }
  if (removed) broadcast({ type: "avatar_removed", ownerKey: key });
  return { ok: true, removed, key };
});

// --- Music files (static) --------------------------------------------------
// MP3s + playlist.json live in MUSIC_DIR (default `/var/lib/slop-relay/music`
// in prod, `./.slop-data/music` in dev). Manual range-request support so
// HTML5 <audio> can seek mid-track for the mesh sync.
const MUSIC_DIR = process.env.MUSIC_DIR ?? "./.slop-data/music";

function musicContentType(ext: string): string {
  switch (ext.toLowerCase()) {
    case "mp3":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

app.get<{ Params: { filename: string } }>("/music/:filename", async (req, reply) => {
  const filename = req.params.filename;
  // Strict filename — no path traversal, no slashes.
  if (!/^[a-z0-9._-]+$/i.test(filename) || filename.includes("..")) {
    return reply.code(400).send({ error: "bad-name" });
  }
  const fs = await import("node:fs/promises");
  const fsSync = await import("node:fs");
  const filepath = `${MUSIC_DIR}/${filename}`;
  let stat;
  try {
    stat = await fs.stat(filepath);
  } catch {
    return reply.code(404).send({ error: "not-found" });
  }
  const ext = filename.split(".").pop() ?? "";
  const ct = musicContentType(ext);

  // playlist.json is small + frequently fetched → read into a buffer
  // and skip range support.
  if (filename === "playlist.json") {
    const buf = await fs.readFile(filepath);
    reply.header("content-type", ct);
    reply.header("cache-control", "no-store");
    return reply.send(buf);
  }

  // Range requests: HTML5 <audio> issues these when seeking. Without
  // 206 support the browser re-fetches the whole file every seek,
  // which makes mid-track sync between peers feel terrible.
  const rangeHeader = req.headers.range;
  reply.header("accept-ranges", "bytes");
  reply.header("content-type", ct);
  reply.header("cache-control", "public, max-age=3600");
  if (rangeHeader && /^bytes=/.test(rangeHeader)) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (m && m[1] !== undefined) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isFinite(start) && start <= end && end < stat.size) {
        reply.code(206);
        reply.header("content-range", `bytes ${start}-${end}/${stat.size}`);
        reply.header("content-length", end - start + 1);
        return reply.send(fsSync.createReadStream(filepath, { start, end }));
      }
    }
  }
  reply.header("content-length", stat.size);
  return reply.send(fsSync.createReadStream(filepath));
});

app.get<{ Params: { filename: string } }>("/avatars/:filename", async (req, reply) => {
  const filename = req.params.filename;
  // Defense-in-depth: only serve files matching the strict shape we write.
  if (!/^[a-z0-9_.-]+\.(jpg|jpeg|png|webp)$/i.test(filename) || filename.includes("..")) {
    return reply.code(400).send({ error: "bad-name" });
  }
  let buf: Buffer;
  try {
    const fs = await import("node:fs/promises");
    buf = await fs.readFile(`${AVATARS_DIR}/${filename}`);
  } catch {
    return reply.code(404).send({ error: "not-found" });
  }
  const ext = filename.split(".").pop()!.toLowerCase();
  const ct = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  reply.header("content-type", ct);
  reply.header("cache-control", "public, max-age=300");
  return reply.send(buf);
});

// =============================================================================
// /v1/chess — agent surface for the chess game
// -----------------------------------------------------------------------------
// Mirrors the WS handlers, with the same server-authoritative validation.
// Lets a BYO-AI flow play moves on a player's behalf: sign in as the human,
// mint an agent token, then have the model POST /v1/chess/move using the
// human's identity. Server enforces side-to-move so the agent can ONLY
// move for the player it represents.
// =============================================================================

/** Build the response payload for /v1/chess and /v1/chess/wait. Includes
 *  derived fields the agent loop needs (toMove, yourTurn) so callers
 *  don't have to parse FEN to figure out whose turn it is. */
function buildChessPayload(callerKey: string | null) {
  const game = chessGetCurrentGame();
  let toMove: "white" | "black" | null = null;
  let yourTurn = false;
  if (game && game.status === "active") {
    // FEN's second whitespace-separated field is "w" or "b".
    const fenTurn = game.fen.split(" ")[1];
    toMove = fenTurn === "w" ? "white" : "black";
    const sideKey = toMove === "white" ? game.whiteKey : game.blackKey;
    yourTurn = !!callerKey && callerKey === sideKey;
  }
  return {
    version: chessStateVersion,
    game,
    toMove,
    yourTurn,
    history: chessGetHistory(),
  };
}

app.get("/v1/chess", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  const callerKey = (a.session.address ?? a.session.handle ?? "").toLowerCase() || null;
  return buildChessPayload(callerKey);
});

/** Long-poll the chess game. Pass `?since=<version>` (the `version`
 *  field from a previous /v1/chess response). If `chessStateVersion`
 *  is already greater, returns immediately. Otherwise blocks up to
 *  `?timeout=<sec>` seconds (default 25, max 60) waiting for the next
 *  change, then returns the current snapshot regardless.
 *
 *  Lets an agent's autonomous-play loop wait cheaply for the opponent
 *  to move without polling on a fixed cadence. Wakes on every state
 *  change: create / move / resign / abort / close. */
app.get<{ Querystring: { since?: string; timeout?: string } }>("/v1/chess/wait", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  const callerKey = (a.session.address ?? a.session.handle ?? "").toLowerCase() || null;
  const since = Number(req.query?.since ?? 0);
  const timeoutSec = Math.min(60, Math.max(1, Number(req.query?.timeout ?? 25)));

  if (!Number.isFinite(since) || chessStateVersion > since) {
    return buildChessPayload(callerKey);
  }

  return await new Promise<unknown>(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(buildChessPayload(callerKey));
    };
    const timer = setTimeout(finish, timeoutSec * 1000);
    const cleanup = () => {
      clearTimeout(timer);
      const idx = chessWaiters.findIndex(x => x === entry);
      if (idx >= 0) chessWaiters.splice(idx, 1);
      try {
        reply.raw.off("close", finish);
      } catch {
        /* ignore */
      }
    };
    const entry: ChessWaiter = { wake: finish, cleanup };
    chessWaiters.push(entry);
    // Client closed the request mid-wait → drop them so we don't
    // try to resolve a dead reply.
    reply.raw.on("close", finish);
  });
});

type ChessCreateBody = { whiteKey?: unknown; blackKey?: unknown; whiteLabel?: unknown; blackLabel?: unknown };
app.post<{ Body: ChessCreateBody }>("/v1/chess/create", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const b = (req.body ?? {}) as ChessCreateBody;
  if (typeof b.whiteKey !== "string" || typeof b.blackKey !== "string") {
    return reply.code(400).send({ error: "missing-player" });
  }
  const result = chessCreateGame({
    whiteKey: b.whiteKey,
    blackKey: b.blackKey,
    whiteLabel: typeof b.whiteLabel === "string" ? b.whiteLabel : b.whiteKey,
    blackLabel: typeof b.blackLabel === "string" ? b.blackLabel : b.blackKey,
  });
  if (!result.ok) return reply.code(409).send({ error: result.error });
  broadcastChessState(result.game);
  return { ok: true, game: result.game };
});

type ChessMoveBody = { from?: unknown; to?: unknown; promotion?: unknown };
app.post<{ Body: ChessMoveBody }>("/v1/chess/move", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const b = (req.body ?? {}) as ChessMoveBody;
  if (typeof b.from !== "string" || typeof b.to !== "string") {
    return reply.code(400).send({ error: "missing-from-or-to" });
  }
  // Use the SAME ownerKey scheme the chess client + WS handler use:
  // raw lowercased address ?? raw lowercased handle. Don't reuse the
  // avatar helper here (it slugifies handles with a `h_` prefix) or
  // moves submitted via REST will fail "not_your_turn" against keys
  // stored from the WS / client side.
  const callerKey = (a.session.address ?? a.session.handle ?? "").toLowerCase();
  if (!callerKey) return reply.code(400).send({ error: "no-identity-on-session" });
  const result = chessApplyMove(callerKey, {
    from: b.from,
    to: b.to,
    promotion: typeof b.promotion === "string" ? b.promotion : undefined,
  });
  if (!result.ok) {
    const code = result.error === "not_your_turn" || result.error === "illegal_move" ? 403 : 409;
    return reply.code(code).send({ error: result.error });
  }
  broadcastChessState(result.game);
  if (result.ended) broadcast({ type: "chess_history", history: chessGetHistory() });
  return { ok: true, game: result.game, ended: result.ended };
});

app.post("/v1/chess/resign", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const callerKey = (a.session.address ?? a.session.handle ?? "").toLowerCase();
  if (!callerKey) return reply.code(400).send({ error: "no-identity-on-session" });
  const result = chessResign(callerKey);
  if (!result.ok) return reply.code(409).send({ error: result.error });
  broadcastChessState(result.game);
  broadcast({ type: "chess_history", history: chessGetHistory() });
  return { ok: true, game: result.game };
});

app.post("/v1/chess/close", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const result = chessClearGame();
  broadcastChessState(null);
  return { ok: true, aborted: result.aborted };
});

// =============================================================================
// /v1/music — agent surface for the slopamp player
// -----------------------------------------------------------------------------
// Volume + playback are a single shared snapshot. POSTing here is the
// same as the music_state WS message: replace the snapshot, fan out.
// Volume omitted = preserve the existing value.
// =============================================================================

app.get("/v1/music", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return { state: musicState, version: musicStateVersion };
});

// Long-poll the music state. Pass `?since=<version>` from a previous
// /v1/music response; this returns immediately if `musicStateVersion`
// has already advanced, otherwise blocks up to `?timeout=<sec>` (default
// 25, max 60) waiting for the next change.
//
// Drives the "agent DJ" loop: long-poll → check if the current track
// just ended (position + elapsed-since-`at` >= duration) → set the
// next track. Wakes on every state change broadcast — play/pause,
// volume, src/index swap.
app.get<{ Querystring: { since?: string; timeout?: string } }>("/v1/music/wait", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  const since = Number(req.query?.since ?? 0);
  const timeoutSec = Math.min(60, Math.max(1, Number(req.query?.timeout ?? 25)));

  if (!Number.isFinite(since) || musicStateVersion > since) {
    return { state: musicState, version: musicStateVersion };
  }

  return await new Promise<unknown>(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ state: musicState, version: musicStateVersion });
    };
    const timer = setTimeout(finish, timeoutSec * 1000);
    const cleanup = () => {
      clearTimeout(timer);
      const idx = musicWaiters.findIndex(x => x === entry);
      if (idx >= 0) musicWaiters.splice(idx, 1);
      try {
        reply.raw.off("close", finish);
      } catch {
        /* ignore */
      }
    };
    const entry: MusicWaiter = { wake: finish, cleanup };
    musicWaiters.push(entry);
    reply.raw.on("close", finish);
  });
});

// Playlist — read from MUSIC_DIR/playlist.json on every request (the
// file is small and rarely changes; cache headers on the static
// /music/playlist.json route handle the heavy traffic). Auth-gated so
// it sits behind the same bearer as the rest of /v1/.
app.get("/v1/music/playlist", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  try {
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(`${MUSIC_DIR}/playlist.json`, "utf8");
    return JSON.parse(buf);
  } catch (err) {
    console.warn("[music] playlist read failed", err);
    return reply.code(502).send({ error: "read-failed" });
  }
});

type MusicStateBody = {
  src?: unknown;
  index?: unknown;
  playing?: unknown;
  position?: unknown;
  at?: unknown;
  volume?: unknown;
};
app.post<{ Body: MusicStateBody }>("/v1/music/state", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const b = (req.body ?? {}) as MusicStateBody;
  if (typeof b.index !== "number" || typeof b.position !== "number") {
    return reply.code(400).send({ error: "bad-state" });
  }
  const incomingVolume = typeof b.volume === "number" ? Math.max(0, Math.min(1, b.volume)) : null;
  musicState = {
    src: typeof b.src === "string" ? b.src : null,
    index: b.index,
    playing: !!b.playing,
    position: b.position,
    at: typeof b.at === "number" ? b.at : Date.now(),
    volume: incomingVolume ?? musicState?.volume ?? 0.7,
  };
  broadcast({ type: "music_state", state: musicState });
  bumpMusicVersion();
  return { ok: true, state: musicState, version: musicStateVersion };
});

// =============================================================================
// /v1/windows — open / close shared singleton app windows
// -----------------------------------------------------------------------------
// Same model as the music window or chess window: anyone can open or
// close any singleton id. Visibility broadcasts to every peer.
// =============================================================================

type OpenWindowBody = { id?: unknown };
app.post<{ Body: OpenWindowBody }>("/v1/windows", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  if (!id) return reply.code(400).send({ error: "missing-id" });
  if (openSingletonWindow(id)) broadcast({ type: "window_opened", id });
  return { ok: true, id };
});

app.delete<{ Params: { id: string } }>("/v1/windows/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const id = req.params.id;
  if (closeSingletonWindow(id)) broadcast({ type: "window_closed", id });
  return { ok: true, id };
});

// --- Todo REST surface ------------------------------------------------------
// Mirrors the WS handlers below; mutations broadcast to live peers via the
// shared subscribeTodos broadcaster, so REST writers and WS writers feel the
// same to spectators.

type TodoTextBody = { text?: unknown };
type TodoReorderBody = { ids?: unknown };

app.get("/v1/todos", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return { items: todoList() };
});

app.post<{ Body: TodoTextBody }>("/v1/todos", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) return reply.code(400).send({ error: "empty" });
  const item = todoAdd({ address: a.session.address, handle: a.session.handle, text });
  if (!item) return reply.code(400).send({ error: "empty" });
  return { ok: true, item };
});

app.post<{ Params: { id: string } }>("/v1/todos/:id/toggle", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!todoToggle(req.params.id)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: TodoTextBody }>("/v1/todos/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) return reply.code(400).send({ error: "empty" });
  if (!todoUpdate(req.params.id, text)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

app.delete<{ Params: { id: string } }>("/v1/todos/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!todoRemove(req.params.id)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

app.post("/v1/todos/clear-done", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  todoClearDone();
  return { ok: true };
});

app.post<{ Body: TodoReorderBody }>("/v1/todos/reorder", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!Array.isArray(req.body?.ids)) return reply.code(400).send({ error: "ids-required" });
  const ids = req.body.ids.filter((s: unknown): s is string => typeof s === "string");
  todoReorder(ids);
  return { ok: true };
});

// --- Notes REST surface -----------------------------------------------------

type NoteTextBody = { text?: unknown };

app.get("/v1/notes", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return { items: noteList() };
});

app.post<{ Body: NoteTextBody }>("/v1/notes", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const note = noteCreate({ address: a.session.address, handle: a.session.handle, text });
  if (!note) return reply.code(400).send({ error: "create-failed" });
  return { ok: true, note };
});

app.post<{ Params: { id: string }; Body: NoteTextBody }>("/v1/notes/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!noteUpdate(req.params.id, text)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

app.delete<{ Params: { id: string } }>("/v1/notes/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!noteRemove(req.params.id)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

// --- Glossary REST surface --------------------------------------------------
// Term creation kicks off an async AI TLDR generation; the broadcast loop
// surfaces the resolved tldr to peers a moment later.

type GlossaryTermBody = { term?: unknown };

app.get("/v1/glossary", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return { items: glossaryList() };
});

app.post<{ Body: GlossaryTermBody }>("/v1/glossary", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const term = typeof req.body?.term === "string" ? req.body.term : "";
  const entry = glossaryCreate({ term, address: a.session.address, handle: a.session.handle });
  if (!entry) return reply.code(400).send({ error: "empty-term" });
  return { ok: true, item: entry };
});

app.post<{ Params: { id: string } }>("/v1/glossary/:id/regenerate", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!glossaryRegenerate(req.params.id)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

app.delete<{ Params: { id: string } }>("/v1/glossary/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!glossaryRemove(req.params.id)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

// --- Jamendo genre playlists -----------------------------------------------
// Shared genre selection that drives the music player. The current
// genre is broadcast over the mesh; selecting a genre also triggers an
// hourly-ish refresh of the trending tracks for that genre (downloads
// new MP3s, dedupes against on-disk track ids).

type SetGenreBody = { genre?: unknown };

app.get("/v1/music/genres", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return {
    genres: GENRE_IDS.map(id => ({ id, label: GENRES[id]!.label })),
    current: getCurrentGenre(),
  };
});

app.post<{ Body: SetGenreBody }>("/v1/music/genre", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const incoming = req.body?.genre;
  if (incoming !== null && typeof incoming !== "string") return reply.code(400).send({ error: "bad-genre" });
  if (incoming !== null && !isGenre(incoming)) return reply.code(400).send({ error: "unknown-genre" });
  try {
    const out = await setCurrentGenre(incoming as string | null);
    // Intentionally do NOT reset musicState here. If someone is in the
    // middle of a song from genre A and a peer switches to genre B,
    // the currently-playing song should keep playing — only an
    // explicit click on a new track in genre B should change what's
    // playing. The audio src lives in musicState.src and the client
    // looks up "what's playing" by src match, so the genre flip is
    // purely a playlist-view change.
    return { ok: true, genre: out.genre };
  } catch (err) {
    return reply.code(502).send({ error: "set-failed", detail: (err as Error).message });
  }
});

app.get<{ Params: { genre: string } }>("/v1/music/genre/:genre/playlist", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!isGenre(req.params.genre)) return reply.code(404).send({ error: "unknown-genre" });
  reply.header("cache-control", "no-store");
  // Lazily refresh if the cache is stale. Hot path (popular genre, cached
  // and fresh) returns immediately; cold path may take ~30s while we
  // download missing tracks.
  try {
    const pl = await refreshGenre(req.params.genre);
    return pl;
  } catch (err) {
    // Stale-on-error: prefer the previously-fetched playlist if any
    // (e.g. Jamendo briefly down) over a 502.
    const fallback = readPlaylist(req.params.genre);
    if (fallback) return fallback;
    return reply.code(502).send({ error: "refresh-failed", detail: (err as Error).message });
  }
});

// --- Custom playlist mutations --------------------------------------------
// The Custom genre is user-curated. Each [+] click on a track in some
// other genre posts that track's metadata here; the track's MP3 stays
// on disk in its original genre's dir, and Custom just references the
// same `src` path. Reorder + remove follow the same pattern.

type AddCustomBody = { track?: unknown };

app.post<{ Body: AddCustomBody }>("/v1/music/custom/add", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const t = req.body?.track as Partial<JamendoTrack> | undefined;
  if (
    !t ||
    typeof t.title !== "string" ||
    typeof t.artist !== "string" ||
    typeof t.src !== "string" ||
    typeof t.jamendoId !== "string"
  ) {
    return reply.code(400).send({ error: "bad-track" });
  }
  // Normalize: only persist the fields we know about. Defends against
  // a misbehaving client storing extra junk in the saved blob.
  const tracks = addToCustom({
    title: t.title,
    artist: t.artist,
    src: t.src,
    duration: typeof t.duration === "number" ? t.duration : 0,
    jamendoId: t.jamendoId,
    license: typeof t.license === "string" ? t.license : "",
    source: typeof t.source === "string" ? t.source : "",
  });
  return { ok: true, tracks };
});

app.delete<{ Params: { jamendoId: string } }>("/v1/music/custom/:jamendoId", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const tracks = removeFromCustom(req.params.jamendoId);
  return { ok: true, tracks };
});

type ReorderCustomBody = { ids?: unknown };

app.post<{ Body: ReorderCustomBody }>("/v1/music/custom/reorder", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!Array.isArray(req.body?.ids)) return reply.code(400).send({ error: "ids-required" });
  const ids = req.body.ids.filter((x: unknown): x is string => typeof x === "string");
  const tracks = reorderCustom(ids);
  return { ok: true, tracks };
});

// Static serve for the per-genre MP3s. Same range-supporting pattern as
// /music/<filename>, but two path segments deep so genre playlists stay
// neatly partitioned on disk.
app.get<{ Params: { genre: string; filename: string } }>(
  "/jamendo-music/:genre/:filename",
  async (req, reply) => {
    const { genre, filename } = req.params;
    if (!isGenre(genre)) return reply.code(404).send({ error: "unknown-genre" });
    if (!/^[a-z0-9._-]+$/i.test(filename) || filename.includes("..")) {
      return reply.code(400).send({ error: "bad-name" });
    }
    const fs = await import("node:fs/promises");
    const fsSync = await import("node:fs");
    const filepath = `${JAMENDO_DIR}/${genre}/${filename}`;
    let stat;
    try {
      stat = await fs.stat(filepath);
    } catch {
      return reply.code(404).send({ error: "not-found" });
    }
    const ext = filename.split(".").pop() ?? "";
    const ct = ext === "json" ? "application/json; charset=utf-8" : "audio/mpeg";
    if (filename.endsWith(".json")) {
      const buf = await fs.readFile(filepath);
      reply.header("content-type", ct);
      reply.header("cache-control", "no-store");
      return reply.send(buf);
    }
    const rangeHeader = req.headers.range;
    reply.header("accept-ranges", "bytes");
    reply.header("content-type", ct);
    reply.header("cache-control", "public, max-age=3600");
    if (rangeHeader && /^bytes=/.test(rangeHeader)) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (m && m[1] !== undefined) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (Number.isFinite(start) && start <= end && end < stat.size) {
          reply.code(206);
          reply.header("content-range", `bytes ${start}-${end}/${stat.size}`);
          reply.header("content-length", end - start + 1);
          return reply.send(fsSync.createReadStream(filepath, { start, end }));
        }
      }
    }
    reply.header("content-length", stat.size);
    return reply.send(fsSync.createReadStream(filepath));
  },
);

// --- Clock REST surface -----------------------------------------------------
// Shared clock state — tab pick, timezone, stopwatch, countdown. Anyone
// can mutate; the server validates the shape and broadcasts the new
// state to every peer.

type ClockBody = Partial<ClockState>;

app.get("/v1/clock", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return { state: getClockState() };
});

app.post<{ Body: ClockBody }>("/v1/clock", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!req.body || typeof req.body !== "object") return reply.code(400).send({ error: "bad-body" });
  const next = setClockState(req.body);
  return { ok: true, state: next };
});

// --- Gas REST surface (read-only) -------------------------------------------

app.get("/v1/gas", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return { state: getGasState() };
});

// --- Files REST surface -----------------------------------------------------
// Drag-and-drop on the desktop posts raw bytes here; everyone sees the
// resulting icon. List + download endpoints are agent-facing too.

app.get("/v1/files", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return { items: fileList() };
});

// Upload — raw body. Filename comes from `?name=<original>` (URL-encoded)
// or the `x-filename` header. Content-type is the request's. We cap the
// body at FILES_MAX_BYTES via Fastify's bodyLimit per-route.
type FileUploadQuery = { name?: string };
app.post<{ Querystring: FileUploadQuery }>(
  "/v1/files",
  { bodyLimit: FILES_MAX_BYTES },
  async (req, reply) => {
    const a = v1AuthFromReq(req);
    if (!a) return reply.code(401).send({ error: "unauthenticated" });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply
        .code(400)
        .send({ error: "empty-body", note: "POST raw bytes with `?name=<filename>` and the file's content-type" });
    }
    const headerName = typeof req.headers["x-filename"] === "string" ? (req.headers["x-filename"] as string) : "";
    const queryName = typeof req.query?.name === "string" ? req.query.name : "";
    const name = queryName || headerName || "untitled";
    // Real mime travels in `x-mime` because the body itself is always
    // shipped as application/octet-stream (browser drag-and-drop into a
    // fetch() doesn't carry the file's MIME). Fall back to whatever the
    // request content-type actually was.
    const headerMime = typeof req.headers["x-mime"] === "string" ? (req.headers["x-mime"] as string) : "";
    const mime = headerMime || String(req.headers["content-type"] ?? "application/octet-stream");
    const ownerKey = (a.session.address ?? a.session.handle ?? "").toLowerCase() || "anon";
    const uploaderLabel = a.session.handle ?? a.session.address ?? "anon";
    const result = fileAdd({ name, mime, buffer: body, ownerKey, uploaderLabel });
    if ("error" in result) return reply.code(400).send(result);
    return { ok: true, item: result };
  },
);

app.delete<{ Params: { id: string } }>("/v1/files/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const ownerKey = (a.session.address ?? a.session.handle ?? "").toLowerCase() || "";
  const result = fileRemove(req.params.id, ownerKey, a.isHost);
  if (result === "not-found") return reply.code(404).send({ error: "not-found" });
  if (result === "forbidden") return reply.code(403).send({ error: "forbidden" });
  return { ok: true };
});

// Public download. No auth — file URLs are shared across the mesh and
// embeddable in <img>/<a> tags. The id is unguessable (random 16-hex)
// so listing is the only enumeration path, which IS auth-gated.
app.get<{ Params: { id: string } }>("/files/:id", async (req, reply) => {
  const id = req.params.id;
  if (!/^[a-z0-9]+$/i.test(id)) return reply.code(400).send({ error: "bad-id" });
  const item = fileGet(id);
  if (!item) return reply.code(404).send({ error: "not-found" });
  const fsSync = await import("node:fs");
  const filepath = `${FILES_DIR_PATH}/${item.storedAs}`;
  if (!fsSync.existsSync(filepath)) return reply.code(404).send({ error: "missing-on-disk" });
  reply.header("content-type", item.mime);
  reply.header("content-length", item.size);
  // RFC 5987-style encoded filename so non-ASCII names survive intact.
  const encodedName = encodeURIComponent(item.name);
  reply.header("content-disposition", `attachment; filename*=UTF-8''${encodedName}`);
  reply.header("cache-control", "public, max-age=3600");
  return reply.send(fsSync.createReadStream(filepath));
});

// --- ENS resolution (read-only, no auth gate) -------------------------------
// Read-only public lookup — anyone hitting the slop-computer browser can use
// it without holding a v1 bearer token. Cached for 10min on the relay so a
// retyped name doesn't re-hammer Alchemy.

app.get<{ Querystring: { name?: string } }>("/v1/ens/resolve", async (req, reply) => {
  reply.header("cache-control", "no-store");
  const name = typeof req.query.name === "string" ? req.query.name : "";
  if (!name) return reply.code(400).send({ ok: false, error: "missing-name" });
  return await resolveEns(name);
});

// --- Invite gate ------------------------------------------------------------
//
// A single global invite password that gates the sign-in screen. Visitors
// hit POST /auth/invite with the password (typically pre-filled from a
// `?invite=` query the host shared); on match we set a long-lived
// `slop_invite` cookie carrying the password verbatim, and the SIWE +
// passkey login endpoints check that cookie before issuing a session.
//
// Admins (addresses in ADMIN_ADDRESSES) bypass the invite check on SIWE
// so the operator can sign in on a fresh deploy without having to know
// the bootstrap password — once signed in they can read / regenerate
// the password from the admin panel and share the invite link.

const INVITE_COOKIE_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

type InviteBody = { password?: unknown };

app.post<{ Body: InviteBody }>("/auth/invite", async (req, reply) => {
  const body = (req.body ?? {}) as InviteBody;
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) return reply.code(400).send({ error: "missing-password" });
  if (password !== getInvitePassword()) return reply.code(401).send({ error: "bad-password" });
  reply.setCookie(INVITE_COOKIE, password, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: INVITE_COOKIE_TTL_SECONDS,
  });
  return { ok: true };
});

// --- SIWE auth --------------------------------------------------------------

app.get("/auth/siwe/nonce", async () => ({ nonce: issueNonce() }));

type SiweBody = { message?: unknown; signature?: unknown; nonce?: unknown };

app.post<{ Body: SiweBody }>("/auth/siwe", async (req, reply) => {
  const body = (req.body ?? {}) as SiweBody;
  const message = typeof body.message === "string" ? body.message : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  if (!message || !/^0x[0-9a-fA-F]+$/.test(signature) || !nonce) {
    return reply.code(400).send({ error: "Missing message, signature, or nonce" });
  }
  if (!consumeNonce(nonce)) return reply.code(401).send({ error: "Bad or expired nonce" });
  const check = await verifySiwe({ message, signature: signature as `0x${string}`, expectedNonce: nonce });
  if (!check.ok) return reply.code(401).send({ error: check.error });
  // Admins bypass the invite gate so the operator can sign in on a fresh
  // deploy and then share / regenerate the invite from the admin panel.
  // Everyone else needs the slop_invite cookie set first.
  if (!check.isAdmin && !isInvited(req.cookies[INVITE_COOKIE])) {
    return reply.code(403).send({ error: "invite-required" });
  }
  const session = createSession({
    role: check.isAdmin ? "host" : "guest",
    address: check.address,
    handle: null,
  });
  reply.setCookie(SESSION_COOKIE, session.token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: config.sessionTTLSeconds,
  });
  return { ok: true, role: session.role, address: session.address, isAdmin: check.isAdmin };
});

// --- Passkey auth -----------------------------------------------------------
//
// Browser hands us the WebAuthn assertion plus the recovered public key
// (qx, qy). We:
//   1. Consume the nonce from /auth/siwe/nonce (reused — same one-shot).
//   2. Re-derive the message that the authenticator signed and verify
//      the P-256 signature against the supplied pubkey.
//   3. Use `keccak256(qx ‖ qy)[-20:]` as the user's address — same
//      derivation slopwallet uses, so the identity is stable per
//      passkey across devices.
// Issues a normal slop_session cookie like SIWE / password do.

type PasskeyBody = {
  qx?: unknown;
  qy?: unknown;
  r?: unknown;
  s?: unknown;
  authenticatorData?: unknown;
  clientDataJSON?: unknown;
  nonce?: unknown;
};

app.post<{ Body: PasskeyBody }>("/auth/passkey", async (req, reply) => {
  if (!isInvited(req.cookies[INVITE_COOKIE])) {
    return reply.code(403).send({ error: "invite-required" });
  }
  const b = (req.body ?? {}) as PasskeyBody;
  const sNonce = typeof b.nonce === "string" ? b.nonce : "";
  if (!sNonce || !consumeNonce(sNonce)) return reply.code(401).send({ error: "bad-or-expired-nonce" });

  let qx: Uint8Array, qy: Uint8Array, r: Uint8Array, s: Uint8Array;
  let authData: Uint8Array, clientDataJSON: Uint8Array;
  try {
    qx = hexToBytes(String(b.qx ?? ""));
    qy = hexToBytes(String(b.qy ?? ""));
    r = hexToBytes(String(b.r ?? ""));
    s = hexToBytes(String(b.s ?? ""));
    authData = hexToBytes(String(b.authenticatorData ?? ""));
    clientDataJSON = hexToBytes(String(b.clientDataJSON ?? ""));
  } catch {
    return reply.code(400).send({ error: "bad-hex" });
  }

  const expectedChallengeB64 = bytesToBase64Url(hexToBytes(sNonce));
  const result = verifyPasskey({
    qx,
    qy,
    r,
    s,
    authenticatorData: authData,
    clientDataJSON,
    expectedChallengeBase64Url: expectedChallengeB64,
  });
  if (!result.ok) return reply.code(401).send({ error: result.error });

  const session = createSession({ role: "guest", address: result.address, handle: null });
  reply.setCookie(SESSION_COOKIE, session.token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: config.sessionTTLSeconds,
  });
  return { ok: true, role: "guest", address: result.address, isAdmin: false };
});

// --- Password auth (guest) --------------------------------------------------

type PasswordBody = { password?: unknown; handle?: unknown };

app.post<{ Body: PasswordBody }>("/auth/password", async (req, reply) => {
  const body = (req.body ?? {}) as PasswordBody;
  const password = typeof body.password === "string" ? body.password : "";
  const handle = typeof body.handle === "string" ? body.handle.trim().slice(0, 32) : "";
  if (!config.guestPassword) {
    return reply.code(503).send({ error: "Guest password not configured on relay" });
  }
  if (password !== config.guestPassword) {
    return reply.code(401).send({ error: "Bad password" });
  }
  if (!handle) return reply.code(400).send({ error: "Handle required" });
  const session = createSession({ role: "guest", address: null, handle });
  reply.setCookie(SESSION_COOKIE, session.token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: config.sessionTTLSeconds,
  });
  return { ok: true, role: "guest", handle };
});

app.post("/auth/logout", async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) deleteSession(token);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});

app.get("/auth/me", async req => {
  const token = req.cookies[SESSION_COOKIE];
  const session = getSession(token);
  const invited = isInvited(req.cookies[INVITE_COOKIE]);
  if (!session) return { authenticated: false, invited };
  return {
    authenticated: true,
    invited,
    role: session.role,
    address: session.address,
    handle: session.handle,
    isAdmin: session.role === "host" && !!session.address && isAdminAddress(session.address),
  };
});

// --- TURN credentials (HMAC, RFC 5766 ephemeral) ----------------------------
// Issues a short-lived {username, credential, urls} pair for the WebRTC ICE
// agent. Username is "<expiry-unix-seconds>:<random>", credential is
// base64(HMAC-SHA1(turnSecret, username)). The TURN server validates the same
// way using its `static-auth-secret`.
app.get("/turn/credentials", async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  const session = getSession(token);
  if (!session) return reply.code(401).send({ error: "Unauthenticated" });
  if (!config.turnSecret || !config.turnHost) {
    return reply.code(503).send({ error: "TURN not configured" });
  }
  const expiry = Math.floor(Date.now() / 1000) + config.turnTtlSeconds;
  const id = randomBytes(4).toString("hex");
  const username = `${expiry}:${id}`;
  const credential = createHmac("sha1", config.turnSecret).update(username).digest("base64");
  return {
    username,
    credential,
    ttl: config.turnTtlSeconds,
    urls: [
      `stun:${config.turnHost}:3478`,
      `turn:${config.turnHost}:3478?transport=udp`,
      `turn:${config.turnHost}:3478?transport=tcp`,
    ],
  };
});

app.get("/peers", async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  const session = getSession(token);
  if (!session) return reply.code(401).send({ error: "Unauthenticated" });
  return { peers: listPeers() };
});

// --- Admin host-only --------------------------------------------------------

function requireHost(req: { cookies: Record<string, string | undefined> }):
  | { ok: true; address: string }
  | { ok: false; error: string } {
  const token = req.cookies[SESSION_COOKIE];
  const session = getSession(token);
  if (!session) return { ok: false, error: "Unauthenticated" };
  if (session.role !== "host" || !session.address || !isAdminAddress(session.address)) {
    return { ok: false, error: "Not authorized as host" };
  }
  return { ok: true, address: session.address };
}

app.get("/admin/invite-password", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  return { password: getInvitePassword() };
});

app.post("/admin/invite-password", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  // Regeneration invalidates every outstanding `slop_invite` cookie
  // because the cookie value is checked verbatim against the current
  // password — peers who'd already typed the old one stay logged in
  // (their slop_session cookie is intact) but new joins need the
  // updated link.
  const password = regenerateInvitePassword();
  return { password };
});

app.post("/admin/start", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  // OBS only takes two fields — Server URL and Stream Key. We collapse the
  // MediaMTX publish credentials into the stream key as a query string so
  // the secret is in ONE place, not split across visible fields. Final URL
  // OBS publishes to: rtmp://host:port/live?user=...&pass=...
  const u = config.mediamtxPublishUser;
  const p = config.mediamtxPublishPass;
  const streamKey = `live?user=${encodeURIComponent(u)}&pass=${encodeURIComponent(p)}`;
  return {
    ok: true,
    rtmpUrl: config.mediamtxRtmpIngress,
    streamKey,
    hlsUrl: config.hlsUrl,
  };
});

app.post("/admin/stop", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  return { ok: true };
});

// Peek at the latest recording on disk without uploading. Used by the host
// UI to show "ready to finalize: <name>, <size>" before they hit the button.
app.get("/admin/recording", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const latest = await findLatestRecording(config.recordingsDir, "live");
  return { latest, pinning: isFinalizeInFlight() };
});

// Pin the latest MediaMTX recording to the local kubo daemon and stream
// progress back as application/x-ndjson — one JSON object per line. The
// host UI parses each line to drive its progress bar; the final line
// carries `{phase:"done", cid, ...}`. Single-flight: concurrent callers
// would see kubo errors anyway, but the guard in recordings.ts makes a
// second request piggy-back on the first.
//
// IMPORTANT: hand Fastify a Readable via `reply.send(stream)` rather than
// writing to `reply.raw` directly. The latter bypasses @fastify/cors,
// which leaves the browser seeing a cross-origin response with no
// Access-Control-Allow-Origin header → "Failed to fetch". The Readable
// path lets the CORS plugin attach its headers before Node flushes them.
app.post("/admin/finalize", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });

  const stream = new Readable({ read() {} });

  // Disable Caddy/reverse-proxy buffering so each progress line lands
  // at the browser as soon as the relay emits it.
  reply.header("Content-Type", "application/x-ndjson");
  reply.header("Cache-Control", "no-store");
  reply.header("X-Accel-Buffering", "no");

  const writeEvent = (obj: unknown) => {
    stream.push(JSON.stringify(obj) + "\n");
  };

  // Kick the finalize off in the background — Fastify pipes `stream`
  // to the wire and returns to the event loop while we push events.
  void (async () => {
    try {
      await finalizeRecording({
        recordingsDir: config.recordingsDir,
        pathName: "live",
        ipfsApiUrl: config.ipfsApiUrl,
        onEvent: writeEvent,
      });
    } catch (err) {
      // `finalizeRecording` already emits a `phase: "error"` event, but
      // belt-and-suspenders if the throw came from somewhere else.
      app.log.error({ err }, "finalize failed");
      writeEvent({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      stream.push(null); // EOF
    }
  })();

  return reply.send(stream);
});

app.get("/admin/peers", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  return { peers: listPeers() };
});

// Host-only "nuke the session wallet" — wipes current + history + tx queue.
// Same effect as `rm .slop-data/wallet.json` but doesn't require shell access.
// Used by the admin page's "Reset session wallet" button so the host can
// recycle the deploy flow during a show.
app.post("/admin/wallet/reset", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  walletWipeAll();
  return { ok: true };
});

type KickBody = { id?: unknown };

// --- Fanout (server-side restream to YouTube/Twitch/X/Kick) -----------------
app.get("/admin/fanouts", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  return { fanouts: listFanouts() };
});

app.post<{ Params: { id: string } }>("/admin/fanouts/:id/start", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const id = req.params.id;
  if (!isKnownFanoutId(id)) return reply.code(400).send({ error: "Unknown destination" });
  const result = startFanout(id, line => app.log.info(line));
  if (!result.ok) return reply.code(400).send({ error: result.error });
  return { ok: true, fanouts: listFanouts() };
});

app.post<{ Params: { id: string } }>("/admin/fanouts/:id/stop", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const id = req.params.id;
  if (!isKnownFanoutId(id)) return reply.code(400).send({ error: "Unknown destination" });
  const result = stopFanout(id);
  if (!result.ok) return reply.code(400).send({ error: result.error });
  return { ok: true, fanouts: listFanouts() };
});

// --- Browser-host tx ingress -----------------------------------------------
// The browser-host POSTs captured wallet calls here so all WS-connected peers
// see them in their tx panels. Authenticated by a shared bearer secret —
// keeps random clients from injecting fake tx_request messages.
type BrowserTxBody = { browserId?: unknown; payload?: unknown };
app.post<{ Body: BrowserTxBody }>("/internal/browser-tx", async (req, reply) => {
  const expected = process.env.BROWSER_HOST_INGRESS_SECRET;
  if (!expected) return reply.code(503).send({ error: "ingress not configured" });
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${expected}`) return reply.code(401).send({ error: "bad token" });
  const body = (req.body ?? {}) as BrowserTxBody;
  if (typeof body.browserId !== "string") return reply.code(400).send({ error: "missing browserId" });
  const payload = (body.payload ?? {}) as { method?: unknown; params?: unknown };
  const method = typeof payload.method === "string" ? payload.method : "";
  const params = Array.isArray(payload.params) ? payload.params : [];
  // Pull `to`, `value`, calldata out of the first eth_sendTransaction param,
  // best-effort — other write methods (personal_sign / signTypedData) just
  // get the raw payload back as calldata.
  let to: string | null = null;
  let value: string | null = null;
  let calldata = "";
  if (method === "eth_sendTransaction" && params[0] && typeof params[0] === "object") {
    const tx = params[0] as { to?: unknown; value?: unknown; data?: unknown };
    to = typeof tx.to === "string" ? tx.to : null;
    value = typeof tx.value === "string" ? tx.value : null;
    calldata = typeof tx.data === "string" ? tx.data : JSON.stringify(tx);
  } else {
    calldata = JSON.stringify({ method, params });
  }
  broadcast({
    type: "tx_request",
    from: "browser-host",
    browserId: body.browserId,
    calldata,
    to,
    value,
    chainId: null,
  });
  return { ok: true };
});

app.post<{ Body: KickBody }>("/admin/kick", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const body = (req.body ?? {}) as KickBody;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return reply.code(400).send({ error: "Missing id" });
  const ok = kickById(id);
  if (!ok) return reply.code(404).send({ error: "Peer not found" });
  return { ok: true };
});

// --- WS /signal -------------------------------------------------------------
// Client → server:
//   { type: "offer"|"answer"|"ice", to: <peerId>, payload }
//   { type: "cursor", x, y }                                  // broadcast
//   { type: "click", x, y }                                    // ripple broadcast (incl. sender)
//   { type: "publish", streamId, kind, label }                // I'm publishing this stream
//   { type: "unpublish", streamId }                            // I stopped publishing
//   { type: "slot_update", id, x, y, width, height, z }        // any auth'd peer; last write wins
//   { type: "browser_open", id, url }                          // any peer; spawns a shared browser
//   { type: "browser_navigate", id, url }                      // any peer; sets URL of an existing browser
//   { type: "browser_close", id }                              // any peer; closes a shared browser
//   { type: "tx_request", browserId, calldata, to, value, chainId }  // captured impersonator tx
//   { type: "ping" }
// Server → client:
//   { type: "hello", id, peers, publications, slots, browsers }
//   { type: "peer_join" | "peer_leave", peer }
//   { type: "signal", from, kind, payload }
//   { type: "cursor", from, x, y }
//   { type: "published", publication }
//   { type: "unpublished", peerId, streamId }
//   { type: "slot", slot }                                     // host moved a slot
//   { type: "browser", browser }                               // browser opened or navigated
//   { type: "browser_closed", id }
//   { type: "tx_request", from, browserId, calldata, to, value, chainId }
//   { type: "pong" }
//   { type: "error", error }

const isHostInfo = (info: { role: string; address: string | null }) =>
  info.role === "host" && !!info.address && isAdminAddress(info.address);

app.register(async function signalRoutes(fastify) {
  fastify.get("/signal", { websocket: true }, (socket, req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const session = getSession(token);
    if (!session) {
      send(socket, { type: "error", error: "unauthenticated" });
      socket.close(4401, "unauthenticated");
      return;
    }

    const peerId = randomBytes(8).toString("hex");
    const info = {
      id: peerId,
      role: session.role,
      address: session.address,
      handle: session.handle,
      connectedAt: Date.now(),
    };

    // Garbage-collect peers from this session whose socket is already
    // dead (network drop, refresh in progress, etc.). We do NOT kick
    // healthy peers — two live tabs of the same user (or two devices
    // sharing a session cookie) must be able to coexist. The old code
    // unconditionally kicked the existing peer, which produced an
    // infinite reconnect loop: each new tab kicked the previous one,
    // the kicked tab auto-reconnected and kicked back, ad nauseam.
    // Symptom in the UI: icons flicker, peer cursors blink in and out.
    for (const stale of findPeersBySessionToken(session.token)) {
      // ws is the `ws` library's WebSocket on the server side; readyState
      // values: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. Treat both
      // CONNECTING and OPEN as "alive" — a peer that's still in the WS
      // upgrade handshake on a slow link shouldn't get GC'd by a
      // sibling tab whose own handshake just completed.
      const rs = (stale.ws as { readyState?: number }).readyState;
      const stillAlive = rs === 0 || rs === 1;
      if (stillAlive) continue;
      const ended = clearPeerPublications(stale.id);
      removePeer(stale.id);
      for (const p of ended) {
        broadcast({ type: "unpublished", peerId: stale.id, streamId: p.streamId });
      }
      broadcast({
        type: "peer_leave",
        peer: { id: stale.id, role: stale.role, address: stale.address, handle: stale.handle, connectedAt: stale.connectedAt },
      });
      try {
        stale.ws.close(4409, "session-replaced");
      } catch {
        /* ignore */
      }
    }

    addPeer({ ...info, ws: socket, sessionToken: session.token });
    send(socket, {
      type: "hello",
      id: peerId,
      peers: listPeers().filter(p => p.id !== peerId),
      publications: listPublications(),
      slots: getSlots(PRIMARY_HOST_ADDR),
      browsers: listBrowsers(PRIMARY_HOST_ADDR),
      avatars: listAvatarsSync(),
      hiddenAvatars: listHiddenOwnersSync(),
      chatHistory: recentChat(),
      openWindows: listOpenWindows(),
      musicState,
      chessGame: chessGetCurrentGame(),
      chessHistory: chessGetHistory(),
      aiPlayers: listAvailableAIPlayers(),
      todos: todoList(),
      notes: noteList(),
      glossary: glossaryList(),
      gasState: getGasState(),
      files: fileList(),
      musicGenres: GENRE_IDS.map(id => ({ id, label: GENRES[id]!.label })),
      musicGenre: getCurrentGenre(),
      musicCustom: getCustomPlaylist().tracks,
      clockState: getClockState(),
      wallet: walletGetCurrent(),
      walletTxs: walletListTxs(),
    });
    broadcast({ type: "peer_join", peer: info }, peerId);

    socket.on("message", (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(socket, { type: "error", error: "invalid_json" });
      }
      switch (msg?.type) {
        case "hello":
          return;
        case "ping":
          send(socket, { type: "pong" });
          return;
        case "offer":
        case "answer":
        case "ice": {
          if (typeof msg.to !== "string") {
            return send(socket, { type: "error", error: "missing_to" });
          }
          const ok = sendTo(msg.to, {
            type: "signal",
            kind: msg.type,
            from: peerId,
            payload: msg.payload,
          });
          if (!ok) send(socket, { type: "error", error: "peer_not_found", to: msg.to });
          return;
        }
        case "cursor": {
          if (typeof msg.x !== "number" || typeof msg.y !== "number") return;
          broadcast({ type: "cursor", from: peerId, x: msg.x, y: msg.y }, peerId);
          return;
        }
        case "click": {
          if (typeof msg.x !== "number" || typeof msg.y !== "number") return;
          // Include the sender — the click ripple should appear on the
          // clicker's own screen at the same time it appears for everyone
          // else, otherwise click+ripple feel desynced.
          broadcast({ type: "click", from: peerId, x: msg.x, y: msg.y });
          return;
        }
        case "chat_send": {
          if (typeof msg.text !== "string" || !msg.text.trim()) return;
          if (!allowChat(session.token)) {
            return send(socket, { type: "error", error: "rate-limited" });
          }
          // Cookie-authed WS peer → "live". The chat subscriber relays
          // this back to everyone (including the sender) via broadcast,
          // so the local UI doesn't need an optimistic insert.
          appendChat({
            address: info.address,
            handle: info.handle,
            text: msg.text,
            source: "live",
          });
          return;
        }
        case "todo_add": {
          if (typeof msg.text !== "string" || !msg.text.trim()) return;
          todoAdd({
            address: info.address,
            handle: info.handle,
            text: msg.text,
          });
          return;
        }
        case "todo_toggle": {
          if (typeof msg.id !== "string") return;
          todoToggle(msg.id);
          return;
        }
        case "todo_update": {
          if (typeof msg.id !== "string" || typeof msg.text !== "string") return;
          todoUpdate(msg.id, msg.text);
          return;
        }
        case "todo_delete": {
          if (typeof msg.id !== "string") return;
          todoRemove(msg.id);
          return;
        }
        case "todo_clear_done": {
          todoClearDone();
          return;
        }
        case "todo_reorder": {
          if (!Array.isArray(msg.ids)) return;
          const ids = msg.ids.filter((s: unknown): s is string => typeof s === "string");
          todoReorder(ids);
          return;
        }
        case "note_create": {
          if (typeof msg.text !== "string") return;
          noteCreate({
            address: info.address,
            handle: info.handle,
            text: msg.text,
          });
          return;
        }
        case "note_update": {
          if (typeof msg.id !== "string" || typeof msg.text !== "string") return;
          noteUpdate(msg.id, msg.text);
          return;
        }
        case "note_delete": {
          if (typeof msg.id !== "string") return;
          noteRemove(msg.id);
          return;
        }
        case "glossary_add": {
          if (typeof msg.term !== "string") return;
          glossaryCreate({
            term: msg.term,
            address: info.address,
            handle: info.handle,
          });
          return;
        }
        case "glossary_regenerate": {
          if (typeof msg.id !== "string") return;
          glossaryRegenerate(msg.id);
          return;
        }
        case "glossary_delete": {
          if (typeof msg.id !== "string") return;
          glossaryRemove(msg.id);
          return;
        }
        case "publish": {
          if (
            typeof msg.streamId !== "string" ||
            (msg.kind !== "camera" && msg.kind !== "screen" && msg.kind !== "audio") ||
            typeof msg.label !== "string"
          ) {
            return send(socket, { type: "error", error: "bad_publish" });
          }
          const ownerKey = (info.address ?? info.handle ?? peerId).toLowerCase();
          const pub: Publication = {
            streamId: msg.streamId,
            peerId,
            ownerKey,
            kind: msg.kind as SlotKind,
            label: msg.label,
          };
          publishStream(pub);
          broadcast({ type: "published", publication: pub });
          return;
        }
        case "unpublish": {
          // Any authenticated peer can close any publication — same
          // collaborative model as slot moves and shared windows. We
          // look up the actual owner by streamId so the broadcast
          // carries the right peerId (which is what every client uses
          // to remove the publication from its own state).
          if (typeof msg.streamId !== "string") {
            return send(socket, { type: "error", error: "missing_streamId" });
          }
          const ownerId = findPublicationOwner(msg.streamId) ?? peerId;
          const ok = unpublishStream(ownerId, msg.streamId);
          if (ok) broadcast({ type: "unpublished", peerId: ownerId, streamId: msg.streamId });
          return;
        }
        case "slot_update": {
          // Any authenticated peer may rearrange the shared layout — same
          // model as a collaborative whiteboard. Last write wins.
          if (typeof msg.id !== "string") {
            return send(socket, { type: "error", error: "missing_id" });
          }
          const patch: Partial<SlotPosition> & { id: string } = { id: msg.id };
          for (const key of ["x", "y", "width", "height", "z"] as const) {
            if (typeof msg[key] === "number") (patch as any)[key] = msg[key];
          }
          const merged = applySlotUpdate(PRIMARY_HOST_ADDR, patch);
          if (!merged) return;
          broadcast({ type: "slot", slot: merged });
          return;
        }
        case "browser_open": {
          if (typeof msg.id !== "string" || typeof msg.url !== "string") {
            return send(socket, { type: "error", error: "bad_browser_open" });
          }
          const browser = openSharedBrowser(PRIMARY_HOST_ADDR, msg.id, msg.url, peerId);
          broadcast({ type: "browser", browser });
          return;
        }
        case "browser_navigate": {
          if (typeof msg.id !== "string" || typeof msg.url !== "string") {
            return send(socket, { type: "error", error: "bad_browser_navigate" });
          }
          const browser = navigateSharedBrowser(PRIMARY_HOST_ADDR, msg.id, msg.url);
          if (!browser) return;
          broadcast({ type: "browser", browser });
          return;
        }
        case "browser_close": {
          if (typeof msg.id !== "string") {
            return send(socket, { type: "error", error: "missing_id" });
          }
          const ok = closeSharedBrowser(PRIMARY_HOST_ADDR, msg.id);
          if (ok) broadcast({ type: "browser_closed", id: msg.id });
          return;
        }
        case "window_open": {
          // Singleton shared windows (music, future calculator/weather/etc).
          // Toggling state is broadcast to every peer so the window appears
          // for everyone, not just the opener. Distinct from browsers in
          // that there's no per-instance data — just an "is open" bit.
          if (typeof msg.id !== "string") {
            return send(socket, { type: "error", error: "missing_id" });
          }
          if (openSingletonWindow(msg.id)) {
            broadcast({ type: "window_opened", id: msg.id });
          }
          return;
        }
        case "window_close": {
          if (typeof msg.id !== "string") {
            return send(socket, { type: "error", error: "missing_id" });
          }
          if (closeSingletonWindow(msg.id)) {
            broadcast({ type: "window_closed", id: msg.id });
          }
          return;
        }
        case "music_state": {
          // Replace the shared music snapshot and fan it out. We trust
          // the sender's clock for `at` — peers compute drift locally
          // (Date.now() - at). Drift on the order of seconds is fine
          // for a podcast-bumper player; we're not building a metronome.
          if (typeof msg.index !== "number" || typeof msg.position !== "number" || typeof msg.at !== "number") {
            return send(socket, { type: "error", error: "bad_music_state" });
          }
          // Volume is optional in the wire format (older clients won't
          // send it). Fall back to the existing snapshot's value or a
          // sensible default — never leave it undefined, peers expect a
          // number.
          const incomingVolume = typeof msg.volume === "number" ? Math.max(0, Math.min(1, msg.volume)) : null;
          musicState = {
            src: typeof msg.src === "string" ? msg.src : null,
            index: msg.index,
            playing: !!msg.playing,
            position: msg.position,
            at: msg.at,
            volume: incomingVolume ?? musicState?.volume ?? 0.7,
          };
          broadcast({ type: "music_state", state: musicState });
          bumpMusicVersion();
          return;
        }
        case "chess_create_game": {
          // Anyone in the room can spin up a game between any two
          // players (including self vs self for testing). The keys
          // are stable ownerKeys — usually a lowercased wallet
          // address, fall back to handle, fall back to peerId.
          if (typeof msg.whiteKey !== "string" || typeof msg.blackKey !== "string") {
            return send(socket, { type: "error", error: "bad_chess_create" });
          }
          const result = chessCreateGame({
            whiteKey: msg.whiteKey,
            blackKey: msg.blackKey,
            whiteLabel: typeof msg.whiteLabel === "string" ? msg.whiteLabel : msg.whiteKey,
            blackLabel: typeof msg.blackLabel === "string" ? msg.blackLabel : msg.blackKey,
          });
          if (!result.ok) return send(socket, { type: "error", error: result.error });
          broadcastChessState(result.game);
          return;
        }
        case "chess_move": {
          // The caller's ownerKey decides which side they're allowed
          // to move for. Server validates against chess.js — clients
          // can't fake a legal move.
          if (typeof msg.from !== "string" || typeof msg.to !== "string") {
            return send(socket, { type: "error", error: "bad_chess_move" });
          }
          const callerKey = (info.address ?? info.handle ?? info.id).toLowerCase();
          const result = chessApplyMove(callerKey, {
            from: msg.from,
            to: msg.to,
            promotion: typeof msg.promotion === "string" ? msg.promotion : undefined,
          });
          if (!result.ok) return send(socket, { type: "error", error: result.error });
          broadcastChessState(result.game);
          if (result.ended) {
            broadcast({ type: "chess_history", history: chessGetHistory() });
          }
          return;
        }
        case "chess_resign": {
          const callerKey = (info.address ?? info.handle ?? info.id).toLowerCase();
          const result = chessResign(callerKey);
          if (!result.ok) return send(socket, { type: "error", error: result.error });
          broadcastChessState(result.game);
          broadcast({ type: "chess_history", history: chessGetHistory() });
          return;
        }
        case "chess_close_game": {
          // Any peer can clear the chess slot — finished or active.
          // Clearing an active game is an "abort" (no winner recorded,
          // nothing appended to history). Same any-peer-can-close model
          // as the rest of the singleton windows.
          chessClearGame();
          broadcastChessState(null);
          return;
        }
        case "tx_request": {
          // Forward the captured impersonator tx to every peer so they all see
          // the same calldata. We don't validate or store — this is just a
          // shared notification surface.
          if (typeof msg.browserId !== "string" || typeof msg.calldata !== "string") {
            return send(socket, { type: "error", error: "bad_tx_request" });
          }
          broadcast({
            type: "tx_request",
            from: peerId,
            browserId: msg.browserId,
            calldata: msg.calldata,
            to: typeof msg.to === "string" ? msg.to : null,
            value: typeof msg.value === "string" ? msg.value : null,
            chainId: typeof msg.chainId === "number" ? msg.chainId : null,
          });
          return;
        }
        case "wallet_deploy": {
          // Client has just confirmed a `MultisigFactory.createMultisig` tx
          // and tells us the resulting record. We don't recompute — we trust
          // the broadcast (the client already verified the tx receipt).
          const rec = msg.wallet as Partial<WalletRecord> | undefined;
          if (
            !rec ||
            typeof rec.address !== "string" ||
            typeof rec.chainId !== "number" ||
            typeof rec.deployer !== "string" ||
            typeof rec.salt !== "string" ||
            typeof rec.threshold !== "number" ||
            !Array.isArray(rec.signers)
          ) {
            return send(socket, { type: "error", error: "bad_wallet_deploy" });
          }
          const signers = rec.signers
            .filter(
              (s): s is { address: string; label: string; signerType: "eoa" | "passkey" } =>
                !!s && typeof s.address === "string" && typeof s.label === "string" && (s.signerType === "eoa" || s.signerType === "passkey"),
            )
            .map(s => ({ address: s.address.toLowerCase(), label: s.label, signerType: s.signerType }));
          if (signers.length === 0) return send(socket, { type: "error", error: "no_signers" });
          walletSetCurrent({
            id: typeof rec.id === "string" ? rec.id : Math.random().toString(36).slice(2),
            address: rec.address.toLowerCase(),
            chainId: rec.chainId,
            deployer: rec.deployer.toLowerCase(),
            salt: rec.salt,
            signers,
            threshold: rec.threshold,
            txHash: typeof rec.txHash === "string" ? rec.txHash : null,
            createdAt: typeof rec.createdAt === "number" ? rec.createdAt : Date.now(),
            label: typeof rec.label === "string" ? rec.label : `Episode ${new Date().toISOString().slice(0, 10)}`,
          });
          return;
        }
        case "wallet_new_episode": {
          // Archive `current` and let the deploy flow surface again.
          walletArchiveCurrent();
          return;
        }
        case "wallet_tx_propose": {
          const cur = walletGetCurrent();
          if (!cur) return send(socket, { type: "error", error: "no_wallet" });
          if (
            typeof msg.target !== "string" ||
            typeof msg.value !== "string" ||
            typeof msg.data !== "string" ||
            typeof msg.deadline !== "string" ||
            typeof msg.nonce !== "string" ||
            typeof msg.execHash !== "string"
          ) {
            return send(socket, { type: "error", error: "bad_propose" });
          }
          const tx = walletProposeTx({
            multisigAddress: cur.address,
            chainId: cur.chainId,
            from: info.address,
            fromLabel: info.handle ?? info.address ?? null,
            source: msg.source === "browser" ? "browser" : "manual",
            browserId: typeof msg.browserId === "string" ? msg.browserId : null,
            target: msg.target,
            value: msg.value,
            data: msg.data,
            deadline: msg.deadline,
            nonce: msg.nonce,
            execHash: msg.execHash,
          });
          // Fire-and-forget AI summary — broadcasts when it lands.
          void summarizeTransaction({
            chainId: cur.chainId,
            multisigAddress: cur.address,
            target: tx.target,
            value: tx.value,
            data: tx.data,
          }).then(summary => walletSetTxSummary(tx.id, summary));
          return;
        }
        case "wallet_tx_sign": {
          if (
            typeof msg.id !== "string" ||
            typeof msg.signer !== "string" ||
            typeof msg.data !== "string" ||
            (msg.sigType !== 0 && msg.sigType !== 1)
          ) {
            return send(socket, { type: "error", error: "bad_sign" });
          }
          walletAddSignature(msg.id, {
            signer: msg.signer,
            sigType: msg.sigType,
            data: msg.data,
            receivedAt: Date.now(),
          });
          return;
        }
        case "wallet_tx_status": {
          if (typeof msg.id !== "string" || typeof msg.status !== "string") {
            return send(socket, { type: "error", error: "bad_status" });
          }
          const allowed: WalletTx["status"][] = ["pending", "executing", "executed", "failed", "expired", "cancelled"];
          if (!allowed.includes(msg.status as WalletTx["status"])) return;
          walletSetTxStatus(msg.id, msg.status as WalletTx["status"], typeof msg.txHash === "string" ? msg.txHash : null);
          return;
        }
        case "wallet_tx_remove": {
          if (typeof msg.id !== "string") return;
          walletRemoveTx(msg.id);
          return;
        }
        case "wallet_tx_resummarize": {
          if (typeof msg.id !== "string") return;
          const tx = walletFindTx(msg.id);
          const cur = walletGetCurrent();
          if (!tx || !cur) return;
          void summarizeTransaction({
            chainId: cur.chainId,
            multisigAddress: cur.address,
            target: tx.target,
            value: tx.value,
            data: tx.data,
          }).then(summary => walletSetTxSummary(tx.id, summary));
          return;
        }
        default:
          send(socket, { type: "error", error: "unknown_type" });
      }
    });

    socket.on("close", () => {
      const ended = clearPeerPublications(peerId);
      removePeer(peerId);
      for (const p of ended) {
        broadcast({ type: "unpublished", peerId, streamId: p.streamId });
      }
      broadcast({ type: "peer_leave", peer: info });
    });
  });
});

// --- Boot -------------------------------------------------------------------

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    app.log.info(
      `slop-relay listening on http://${config.host}:${config.port} — admins=${config.adminAddresses.length} guestPwd=${config.guestPassword ? "set" : "unset"}`,
    );
    // If a game was persisted with AI-to-move and the relay restarted
    // mid-think (rare, but happened during the AI-vs-AI debug), kick
    // off a fresh tick. Without this, the game would sit forever
    // because nothing else triggers a broadcastChessState until a
    // human interacts.
    const resumed = chessGetCurrentGame();
    if (resumed && resumed.status === "active") {
      // Triggering broadcastChessState handles broadcast + version
      // bump + maybeMoveAI scheduling. Safe to call on an unchanged
      // state — peers just re-receive the snapshot they already have.
      broadcastChessState(resumed);
    }
  })
  .catch(err => {
    app.log.error(err);
    process.exit(1);
  });

// Clean up restream children on shutdown so destinations see a clean
// "stream ended" rather than a network drop.
const cleanShutdown = (signal: NodeJS.Signals) => {
  app.log.info(`received ${signal} — stopping fanouts`);
  shutdownAllFanouts();
  app.close().finally(() => process.exit(0));
};
process.on("SIGTERM", cleanShutdown);
process.on("SIGINT", cleanShutdown);

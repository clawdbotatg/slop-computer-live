import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { createHmac, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { config } from "./config.js";
import type { Publication, SlotKind, SlotPosition } from "./desktop.js";
import { isKnownFanoutId, listFanouts, shutdownAllFanouts, startFanout, stopFanout } from "./fanout.js";
import { broadcastAction, getBroadcastStatus, getBroadcastUrl, setBroadcastUrl } from "./broadcast.js";
import { finalizeRecording, findLatestRecording, isFinalizeInFlight } from "./recordings.js";
import {
  closeAllPeers,
  findPeersBySessionToken,
  kickById,
  listPeers,
  send,
  sendTo,
} from "./peers.js";
import {
  DEFAULT_SLUG,
  findPeerRoom,
  getOrCreateRoom,
  hibernateRoom,
  isValidSlug,
  listRooms,
  parseSlug,
  type Room,
} from "./room.js";
import { hasAnyValidRoomCookie, roomCookieName, signRoomCookie, verifyRoomCookie } from "./room-auth.js";
import { generateCard } from "./card.js";
import { MAX_TEXT_LEN as CHAT_MAX_TEXT, type ChatMessage } from "./chat.js";
import {
  MAX_TEXT_LEN as TRANSCRIPT_MAX_TEXT,
  type TranscriptSegment,
} from "./transcript.js";
import { isSttConfigured, transcribeAudio } from "./stt.js";
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
import type { ChessGame } from "./chess.js";
import { listAvailableAIPlayers } from "./ai-players.js";
import {
  create as glossaryCreate,
  list as glossaryList,
  regenerate as glossaryRegenerate,
  remove as glossaryRemove,
  subscribe as subscribeGlossary,
} from "./glossary.js";
import { type GasState, getState as getGasState, start as startGas, subscribe as subscribeGas } from "./gas.js";
import {
  type TickerState,
  getState as getTickerState,
  start as startTicker,
  subscribe as subscribeTicker,
} from "./ticker.js";
import {
  type HeadlinesState,
  getState as getHeadlinesState,
  refreshNow as refreshHeadlinesNow,
  start as startHeadlines,
  subscribe as subscribeHeadlines,
} from "./headlines.js";
import {
  type TimelineState,
  getState as getTimelineState,
  refreshNow as refreshTimelineNow,
  setResearchFocus as setTimelineResearchFocus,
  start as startTimeline,
  subscribe as subscribeTimeline,
} from "./timeline.js";
import {
  type NewsDigestState,
  getState as getNewsDigestState,
  start as startNewsDigest,
  subscribe as subscribeNewsDigest,
} from "./news-digest.js";
import { start as startPolymarket } from "./polymarket.js";
import { resolveEns, reverseLookup as reverseLookupEns } from "./ens.js";
import { type EpisodeState } from "./episode.js";
import { peerNames } from "./peer-names.js";
import { FILES_MAX_BYTES } from "./files.js";
import {
  GENRE_IDS,
  GENRES,
  JAMENDO_DIR,
  type JamendoTrack,
  isGenre,
  readPlaylist,
  refreshGenre,
} from "./jamendo.js";
import { type ClockState } from "./clock.js";
import type { WalletRecord, WalletTx } from "./wallet.js";
import { summarizeTransaction } from "./wallet-ai.js";
import { type ResearchQuery, lookupGuest, researchGuest } from "./guest-research.js";

// Room used by HTTP routes that aren't slug-scoped (admin-global things
// that operate on the default room only). Kept as a thin alias so the
// intent is grep-able — "this endpoint really does only act on debug".
const httpRoom = () => getOrCreateRoom(DEFAULT_SLUG);

// Per-room HTTP routes resolve their room from `?slug=<slug>` on the
// query string. Frontend hooks read it from RoomSlugContext and append
// it to every fetch. Missing slug falls back to DEFAULT_SLUG so the
// admin UI (still served from "/") keeps working without changes.
// Invalid slugs are silently coerced to DEFAULT_SLUG — the caller can
// also use `roomFromReqStrict` if it wants a 400.
const roomFromReq = (req: { query?: unknown }) => {
  const q = (req.query ?? {}) as { slug?: unknown };
  const raw = typeof q.slug === "string" ? q.slug : "";
  if (raw && isValidSlug(raw)) return getOrCreateRoom(raw);
  return getOrCreateRoom(DEFAULT_SLUG);
};

// Global feeds (ticker, gas, headlines, news-digest, timeline,
// polymarket, glossary) poll external sources once and fan the snapshot
// out to every hot room. Iterates the room registry on every push;
// rooms instantiated after a feed's last tick still receive the next
// one (and read the current cached state at room-connect time via the
// hello payload).
function broadcastToAllRooms(msg: unknown): void {
  for (const r of listRooms()) r.broadcast(msg);
}

// --- Hot/cold lifecycle ---------------------------------------------------
// Rooms with no peers and no recent mutations get hibernated after
// IDLE_HIBERNATE_MS. Hibernation drops the in-memory slice from `rooms`
// and asks the browser-host to close that room's BrowserContext too;
// on-disk state survives, so the next `/signal?slug=X` call lazily
// reconstructs the room from disk.
//
// Free vs paid: rooms with no password set (unclaimed) and rooms
// matching the configured HOST_WHITELIST are always free. Otherwise the
// `verifyPaid()` stub gates revival. Phase 8 wires this to the Base
// contract; for now it consults env (PAYMENTS_DISABLED / HOST_WHITELIST).
const IDLE_HIBERNATE_MS = Number(process.env.IDLE_HIBERNATE_MS ?? 3 * 24 * 60 * 60 * 1000); // 3 days default
const LIFECYCLE_TICK_MS = 5 * 60 * 1000;

const HOST_WHITELIST = (process.env.HOST_WHITELIST ?? DEFAULT_SLUG)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const PAYMENTS_DISABLED = process.env.PAYMENTS_DISABLED === "1";

/** Whether `slug` can be hot without a current payment receipt.
 *  - PAYMENTS_DISABLED=1 → everything is free (dev mode)
 *  - HOST_WHITELIST contains the slug → free (always-on rooms)
 *  - Room has no password yet (unclaimed) → free (the slug hasn't
 *    been picked up by anyone, the act of claiming sets a paidUntil)
 * Otherwise, paidUntil must be > now to be hot. */
function isRoomFreeOrPaid(room: Room): boolean {
  if (PAYMENTS_DISABLED) return true;
  if (HOST_WHITELIST.includes(room.id)) return true;
  if (!room.auth.hasPassword()) return true;
  return room.meta.isPaid();
}

/** Phase 7 stub. Phase 8 replaces this with an Alchemy-Base RPC call
 *  that reads the SlopComputer payment contract for `slug` and returns
 *  the unix-seconds the room is paid through. Today it just trusts an
 *  optional admin-signed body OR a global PAYMENTS_DISABLED flag. */
async function verifyPaid(_slug: string, _proof: unknown): Promise<{ paidUntil: number } | null> {
  if (PAYMENTS_DISABLED) {
    return { paidUntil: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 };
  }
  // No real verification path yet — explicit revive needs the real
  // on-chain check that lands in Phase 8.
  return null;
}

async function notifyBrowserHostHibernate(slug: string): Promise<void> {
  const base = process.env.BROWSER_HOST_INGRESS_URL;
  if (!base) return;
  try {
    await fetch(`${base.replace(/\/$/, "")}/admin/rooms/${encodeURIComponent(slug)}/close`, {
      method: "POST",
      headers: process.env.BROWSER_HOST_INGRESS_SECRET
        ? { authorization: `Bearer ${process.env.BROWSER_HOST_INGRESS_SECRET}` }
        : {},
    });
  } catch (err) {
    app.log.warn({ slug, err: (err as Error).message }, "browser-host close-context call failed");
  }
}

// Tell browser-host to destroy a specific tab when a peer closes the
// browser window in the UI. Without this we rely on every subscriber WS
// closing within TAB_LINGER_MS — but a single zombie WS (lingering peer,
// keepalive timing) leaves the tab alive and eats a slot in the room's
// 5-tab cap forever.
async function notifyBrowserHostCloseTab(slug: string, id: string): Promise<void> {
  const base = process.env.BROWSER_HOST_INGRESS_URL;
  if (!base) return;
  try {
    await fetch(
      `${base.replace(/\/$/, "")}/admin/rooms/${encodeURIComponent(slug)}/tabs/${encodeURIComponent(id)}/close`,
      {
        method: "POST",
        headers: process.env.BROWSER_HOST_INGRESS_SECRET
          ? { authorization: `Bearer ${process.env.BROWSER_HOST_INGRESS_SECRET}` }
          : {},
      },
    );
  } catch (err) {
    app.log.warn({ slug, id, err: (err as Error).message }, "browser-host close-tab call failed");
  }
}

setInterval(() => {
  const now = Date.now();
  for (const room of listRooms()) {
    if (room.peerCount() > 0) continue;
    if (HOST_WHITELIST.includes(room.id)) continue;
    if (room.meta.isPaid()) continue;
    if (now - room.meta.getLastSeenAt() < IDLE_HIBERNATE_MS) continue;
    if (hibernateRoom(room.id)) {
      app.log.info({ slug: room.id, idleMs: now - room.meta.getLastSeenAt() }, "hibernated");
      void notifyBrowserHostHibernate(room.id);
    }
  }
}, LIFECYCLE_TICK_MS).unref();

// Music player state is now per-room — see room.music (MusicState class).

// Single broadcast helper for chess state changes — also bumps the
// room's chess version (so /v1/chess/wait long-pollers wake up) AND
// nudges that room's AI mover in case the new turn belongs to a
// server-side AI player. Use this instead of calling broadcast
// directly so we never forget either side effect.
//
// AI-vs-AI relies on the recursion at the bottom: when an AI's move
// applies, `notifyAfterMove` calls broadcastChessState again with
// the new state, which itself bumps the version + schedules another
// AIMover.tick. Each recursive call yields via setImmediate so the
// stack never grows. Bounded by inFlight + lastVersionHandled inside
// AIMover — no infinite loop possible.
function broadcastChessState(room: Room, game: ChessGame | null): void {
  room.broadcast({ type: "chess_state", game });
  room.chess.bumpVersion();
  setImmediate(() => {
    room.aiMover.tick(room.chess.getVersion(), () => {
      const next = room.chess.getCurrentGame();
      broadcastChessState(room, next);
      if (next && next.status !== "active") {
        room.broadcast({ type: "chess_history", history: room.chess.getHistory() });
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
// god-mode STT — the streaming box ships short MediaRecorder blobs
// (audio/webm;codecs=opus by default) to /v1/transcript/relay. Same
// passthrough shape as the image parser above so we get a Buffer.
app.addContentTypeParser(/^audio\/(webm|ogg|mp4|mpeg|wav)/, { parseAs: "buffer" }, (_req, body, done) => {
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
// Two layers, single resolved list:
//   1. DEFAULT_APPS (this file)  — the authoritative built-in catalog. Ships
//      with every deploy. Add a permanent app here, commit, deploy.
//   2. hot-apps.json on the box  — optional, appended at read time. Schema:
//      { "apps": [{ "id", "label", "icon", "url", "kind?" }] }. Same `id` as
//      a built-in = the hot entry overrides at request time (lets you patch
//      a broken built-in without redeploy). Missing file = empty list.
//
// Why two layers? DEFAULT_APPS is the single source of truth for what ships;
// hot-apps is the small escape hatch for runtime additions (one-off episode
// apps) or hot-patches (override a built-in's URL/icon without a build).
//
// Read on every `GET /apps` — no restart needed after editing hot-apps.json.
//
// `icon` is a relative path (served by Next.js, e.g. "/icons/foo.png") or
// an absolute URL. `url` is what the SharedBrowser loads on double-click.
//
// Adding a new app? Generate its icon FIRST so the style stays consistent:
//   yarn icon:add <id> "<prompt>"
// Lands at packages/nextjs/public/icons/<id>.png (= "/icons/<id>.png").
// See packages/icon-gen/README.md and CLAUDE.md for details.

import { readFileSync as _readFileSync, readdirSync as _readdirSync } from "node:fs";
import { mkdir as _mkdir, writeFile as _writeFile } from "node:fs/promises";
import { dirname as _dirname, resolve as _resolve } from "node:path";

const HOT_APPS_PATH = process.env.HOT_APPS_PATH ?? "/var/lib/slop-relay/hot-apps.json";

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
    | "glossary"
    | "gas"
    | "clock"
    | "wallet"
    | "research"
    | "news"
    | "transcript"
    | "card";
};

const DEFAULT_APPS: AppEntry[] = [
  // ⚠️ Adding a new app here? Generate its icon FIRST:
  //     yarn icon:add <id> "<prompt>"
  // Don't ship an entry whose `icon:` path doesn't exist in public/icons.
  //
  // Order matters: this is the cascade order for icons that have never
  // been dragged (defaultIconPosition in nextjs/app/page.tsx). Reordering
  // here only takes visual effect on prod after slots.json's icon-*
  // entries are cleared (or the host triggers Auto Arrange).
  {
    id: "chat",
    label: "Chat",
    icon: "/icons/chat.png",
    kind: "chat",
  },
  {
    id: "video",
    label: "Video",
    icon: "/icons/video.png",
    kind: "video",
  },
  {
    id: "audio",
    label: "Audio",
    icon: "/icons/mic.png",
    kind: "audio",
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
    id: "browser",
    label: "Browser",
    icon: "/icons/browser.png",
    url: "https://clawd-slop-landing-nextjs.vercel.app/",
  },
  {
    id: "abi-ninja",
    label: "ABINinja",
    icon: "/icons/ninja.png",
    url: "https://abi.ninja",
  },
  {
    id: "nifty-ink",
    label: "NiftyINK",
    icon: "/icons/paint.png",
    url: "https://nifty.ink/",
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
    id: "glossary",
    label: "Glossary",
    icon: "/icons/glossary.png",
    kind: "glossary",
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
  {
    id: "research",
    label: "Research",
    icon: "/icons/research.png",
    kind: "research",
  },
  {
    id: "news",
    label: "News",
    icon: "/icons/news.png",
    kind: "news",
  },
  {
    id: "transcript",
    label: "Transcript",
    icon: "/icons/transcript.png",
    kind: "transcript",
  },
  {
    id: "card",
    label: "Card",
    icon: "/icons/card.png",
    kind: "card",
  },
];

// Load the hot-apps overlay. Missing/bad file = empty list, never throws.
function readHotApps(): AppEntry[] {
  try {
    const raw = _readFileSync(HOT_APPS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { apps?: unknown };
    return Array.isArray(parsed.apps) ? (parsed.apps as AppEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeHotApps(apps: AppEntry[]): Promise<void> {
  await _mkdir(_dirname(HOT_APPS_PATH), { recursive: true });
  await _writeFile(HOT_APPS_PATH, JSON.stringify({ apps }, null, 2));
}

// Resolved catalog: DEFAULT_APPS as the base, then for each hot entry
// either override the built-in with the same id, or append. Preserves
// DEFAULT_APPS order so the icon grid layout is stable across deploys.
function readApps(): AppEntry[] {
  const hot = readHotApps();
  if (hot.length === 0) return DEFAULT_APPS.slice();
  const hotById = new Map(hot.map(a => [a.id, a]));
  const out: AppEntry[] = DEFAULT_APPS.map(a => hotById.get(a.id) ?? a);
  const builtInIds = new Set(DEFAULT_APPS.map(a => a.id));
  for (const a of hot) if (!builtInIds.has(a.id)) out.push(a);
  return out;
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
  query?: unknown;
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
  // Per-room gate: if the caller passed ?slug=<x>, they must also hold a
  // valid slop_room_<x> cookie. Mirrors the /signal WS gate exactly —
  // rooms with no password (debug, plus any unclaimed slug) skip the
  // cookie check because no one was ever issued one. Without this skip,
  // SIWE/passkey users on debug 401 on every /v1 endpoint (the session
  // cookie alone isn't enough, and the legacy slop_invite cookie is no
  // longer minted post per-room migration). Bearer tokens above skip
  // this because the agent was vetted at mint time. Endpoints without
  // a ?slug= (eg /v1/agent-token) aren't slug-scoped.
  const q = (req.query ?? {}) as { slug?: unknown };
  const rawSlug = typeof q.slug === "string" ? q.slug : "";
  if (rawSlug && isValidSlug(rawSlug)) {
    const room = getOrCreateRoom(rawSlug);
    if (room.auth.hasPassword() && !hasValidRoomCookie(req, rawSlug)) return null;
  }
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
    publications: roomFromReq(req).desktop.listPublications(),
    slots: roomFromReq(req).desktop.getSlots(),
    browsers: roomFromReq(req).browsers.list(),
    apps: readApps(),
    avatars: listAvatarsSync(),
    hiddenAvatars: listHiddenOwnersSync(),
    openWindowIds: roomFromReq(req).windows.list(),
    musicState: roomFromReq(req).music.current().state,
    chessGame: roomFromReq(req).chess.getCurrentGame(),
    chessHistory: roomFromReq(req).chess.getHistory(),
    aiPlayers: listAvailableAIPlayers(),
    todos: roomFromReq(req).todos.list(),
    notes: roomFromReq(req).notes.list(),
    glossary: glossaryList(),
    gasState: getGasState(),
    tickerState: getTickerState(),
    headlinesState: getHeadlinesState(),
    timelineState: getTimelineState(),
    newsDigestState: getNewsDigestState(),
    files: roomFromReq(req).files.list(),
    musicGenres: GENRE_IDS.map(id => ({ id, label: GENRES[id]!.label })),
    musicGenre: roomFromReq(req).jamendo.getCurrentGenre(),
    musicCustom: roomFromReq(req).jamendo.getCustomPlaylist().tracks,
    clockState: roomFromReq(req).clock.getState(),
    wallet: roomFromReq(req).wallet.getCurrent(),
    walletDraft: roomFromReq(req).wallet.getDraft(),
    walletTxs: roomFromReq(req).wallet.listTxs(),
    cardState: readCardSnapshot(roomFromReq(req).id),
    cardJob: readCardJob(roomFromReq(req).id),
    cardTitle: readCardTitle(roomFromReq(req).id),
    researchState: roomFromReq(req).research.current().state,
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
  // Only mutate hot-apps. Built-ins are code; submitting one here creates
  // an override (same id) that wins at read time.
  const hot = readHotApps();
  const idx = hot.findIndex(a => a.id === id);
  const next: AppEntry = { id, label, icon, url };
  if (idx >= 0) hot[idx] = next;
  else hot.push(next);
  await writeHotApps(hot);
  const total = readApps().length;
  return { ok: true, app: next, total };
});

app.delete<{ Params: { id: string } }>("/v1/apps/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!a.isHost) return reply.code(403).send({ error: "host-only" });
  const id = req.params.id;
  // We can only remove from hot-apps. If id is purely a built-in (no hot
  // override), there's nothing to delete — say so explicitly.
  const hot = readHotApps();
  const filtered = hot.filter(a => a.id !== id);
  if (filtered.length === hot.length) {
    const isBuiltIn = DEFAULT_APPS.some(a => a.id === id);
    return reply
      .code(isBuiltIn ? 409 : 404)
      .send({ error: isBuiltIn ? "built-in-app-not-removable" : "no-such-app", id });
  }
  await writeHotApps(filtered);
  return { ok: true, removed: id, total: readApps().length };
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
  const room = roomFromReq(req);
  const merged = room.desktop.applySlotUpdate(patch);
  if (!merged) return reply.code(500).send({ error: "no-host-configured" });
  // Broadcast to live WS peers so they see the move in real time, same
  // as the existing slot_update WS handler.
  room.broadcast({ type: "slot", slot: merged });
  return { ok: true, slot: merged };
});

// --- Browsers: open / navigate / close --------------------------------------

type OpenBrowserBody = { id?: unknown; url?: unknown; appId?: unknown };

app.post<{ Body: OpenBrowserBody }>("/v1/browsers", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const body = (req.body ?? {}) as OpenBrowserBody;
  const url = typeof body.url === "string" ? body.url : "";
  if (!url) return reply.code(400).send({ error: "missing-url" });
  const id =
    typeof body.id === "string" && body.id.trim() ? body.id.trim() : `browser-${Math.random().toString(36).slice(2, 8)}`;
  const appId = typeof body.appId === "string" && body.appId.trim() ? body.appId.trim() : undefined;
  const room = roomFromReq(req);
  const browser = room.browsers.open(id, url, "agent", appId);
  room.broadcast({ type: "browser", browser });
  return { ok: true, browser };
});

type NavBody = { url?: unknown };

app.post<{ Params: { id: string }; Body: NavBody }>("/v1/browsers/:id/navigate", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  if (!url) return reply.code(400).send({ error: "missing-url" });
  const room = roomFromReq(req);
  const browser = room.browsers.navigate(req.params.id, url);
  if (!browser) return reply.code(404).send({ error: "no-such-browser" });
  room.broadcast({ type: "browser", browser });
  return { ok: true, browser };
});

app.delete<{ Params: { id: string } }>("/v1/browsers/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const room = roomFromReq(req);
  const ok = room.browsers.close(req.params.id);
  if (!ok) return reply.code(404).send({ error: "no-such-browser" });
  room.broadcast({ type: "browser_closed", id: req.params.id });
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
  roomFromReq(req).broadcast({
    type: "cursor",
    from: agentPeerId(a.session.token),
    address: a.session.address,
    handle: a.session.handle,
    anonId: a.session.anonId ?? null,
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
  roomFromReq(req).broadcast({
    type: "click",
    from: agentPeerId(a.session.token),
    address: a.session.address,
    handle: a.session.handle,
    anonId: a.session.anonId ?? null,
    x,
    y,
  });
  return { ok: true };
});

// --- Timeline: host-only manual refresh -------------------------------------
// Auto-poll runs once every 24h (Twitter reads are metered). The host
// triggers this right before going live by clicking the TIMELINE badge
// on the bottom marquee. Debounced inside timeline.ts to 1/min.
app.post("/v1/timeline/refresh", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!a.isHost) return reply.code(403).send({ error: "host-only" });
  const result = await refreshTimelineNow();
  if (!result.ok) {
    if (result.reason === "rate-limited") {
      return reply.code(429).send({ error: "rate-limited", retryAfterMs: result.retryAfterMs });
    }
    return reply.code(503).send({ error: result.reason });
  }
  return { ok: true, state: result.state };
});

// --- Headlines: host-only manual refresh ------------------------------------
// Auto-poll runs hourly. Host clicks the HEADLINES badge to force a
// fresh pull right before going live. APIs are free, debounce just
// prevents spammed clicks from stacking concurrent fetches.
app.post("/v1/headlines/refresh", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!a.isHost) return reply.code(403).send({ error: "host-only" });
  const result = await refreshHeadlinesNow();
  if (!result.ok) {
    return reply.code(429).send({ error: "rate-limited", retryAfterMs: result.retryAfterMs });
  }
  return { ok: true, state: result.state };
});

// --- Chat -------------------------------------------------------------------
// Three readers: live WS peers (broadcast inside the existing mesh socket),
// SSE subscribers (slop.computer spectators), and the REST GET /v1/chat poll.
// Single writer surface: append() in ./chat.js, called from POST /v1/chat
// (cookie/bearer) and from the WS chat_send handler. Persistence is handled
// inside chat.js (JSONL on disk, ring in memory).

// Chat append → live peer mesh broadcast is wired in Room's constructor.
// Spectators (no WS) get the same payload via SSE below.

// Todos + notes use the same per-room broadcast pattern, wired into
// each Room's constructor (see room.ts).
//
// Glossary: term added or its TLDR resolved → full-list rebroadcast.
// Same small-list trade-off as notes/todos.
subscribeGlossary(items => {
  broadcastToAllRooms({ type: "glossary", items });
});

// Gas tracker poll loop. Server-side polling keeps the Alchemy API key
// off the client and shares one RPC budget across all connected peers.
subscribeGas(state => {
  broadcastToAllRooms({ type: "gas", state });
});
startGas();

// Slop ticker (crypto + AI stocks + private valuations + $CLAWD).
// Same pattern as gas — relay polls upstream feeds once a minute and
// fans the snapshot out to every connected peer.
subscribeTicker(state => {
  broadcastToAllRooms({ type: "ticker", state });
});
startTicker();

// Headlines feed (crypto + AI). Same broadcast pattern; cadence is
// slow (5 min) because headline lists don't churn fast.
subscribeHeadlines(state => {
  broadcastToAllRooms({ type: "headlines", state });
});
startHeadlines();

// Twitter timeline (host's home feed, ranked by engagement). Auto-poll
// runs once every 24h to keep Twitter API spend down; the host triggers
// a fresh crawl on-demand via POST /v1/timeline/refresh (clicking the
// TIMELINE badge in the bottom marquee) right before going live.
subscribeTimeline(state => {
  broadcastToAllRooms({ type: "timeline", state });
});
startTimeline();

// Polymarket — top events by 24h volume, tag-filtered to crypto / AI /
// macro / geopolitics. Feeds the news digest as a 4th source.
startPolymarket();

// News digest — interleaved crypto + AI + tweets + polymarket, with an
// AI-ranked "featured" top tier picked by Claude. Rebuilds whenever
// any upstream source updates (debounce inside the module).
subscribeNewsDigest(state => {
  broadcastToAllRooms({ type: "news_digest", state });
});
startNewsDigest();

// Custom peer display names — global across rooms, keyed by lowercased
// address. When a user sets/clears their name, fan out a single
// `peer_name` event to every room so video/audio tile badges and guest
// list labels update everywhere they're visible.
peerNames.subscribe((address, name) => {
  broadcastToAllRooms({ type: "peer_name", address, name });
});

// Desktop file system — per-room. Each room's FileIndex broadcasts
// add/remove events into that room's mesh (wired in Room's constructor)
// so file icons appear / disappear in real time for the right audience.

// Jamendo genre selection + custom playlist are per-room — each room's
// JamendoRoomState fires `music_genre` and `music_custom` into that
// room's broadcast. Wired in Room's constructor.

// Clock app state — per-room shared. Wall-clock-anchored fields
// (`startedAt`, `endAt`) mean every peer's UI computes the same
// remaining/elapsed at any moment without us syncing per-tick. The
// per-room broadcast subscriber is wired in Room's constructor.

// Session wallet — per-room. Each room's WalletState fires
// `wallet` + `wallet_txs` into that room's broadcast on every mutation;
// wired in Room's constructor.

type ChatBody = { text?: unknown };

app.post<{ Body: ChatBody }>("/v1/chat", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const raw = typeof req.body?.text === "string" ? req.body.text : "";
  if (!raw.trim()) return reply.code(400).send({ error: "empty" });
  if (raw.length > CHAT_MAX_TEXT * 2) return reply.code(413).send({ error: "too-long" });
  // Rate-limit by session token (covers both browser cookie and agent
  // bearer — each is one chatty actor).
  const chat = roomFromReq(req).chat;
  if (!chat.allow(a.session.token)) return reply.code(429).send({ error: "rate-limited" });
  // Source classification: bearer = agent (skill flow), cookie = browser.
  // Browser cookies that own a current WS peer are "live" desktop users;
  // those without an active WS are "spectator" (slop.computer SIWE).
  const inMesh = findPeersBySessionToken(a.session.token).length > 0;
  const source: ChatMessage["source"] = a.via === "bearer" ? "agent" : inMesh ? "live" : "spectator";
  const msg = chat.append({
    address: a.session.address,
    handle: a.session.handle,
    anonId: a.session.anonId ?? null,
    text: raw,
    source,
  });
  if (!msg) return reply.code(400).send({ error: "empty" });
  return { ok: true, msg };
});

app.get("/v1/chat", async (req, reply) => {
  reply.header("cache-control", "no-store");
  return { messages: roomFromReq(req).chat.recent() };
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
  const chat = roomFromReq(req).chat;
  write("init", { messages: chat.recent() });
  const unsub = chat.subscribe(msg => write("chat", msg));
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
  const transcript = roomFromReq(req).transcript;
  if (!transcript.allow(a.session.token)) return reply.code(429).send({ error: "rate-limited" });
  const inMesh = findPeersBySessionToken(a.session.token).length > 0;
  const source: TranscriptSegment["source"] =
    a.via === "bearer" ? "agent" : inMesh ? "live" : "spectator";
  const seg = transcript.append({
    address: a.session.address,
    handle: a.session.handle,
    anonId: a.session.anonId ?? null,
    text: raw,
    source,
  });
  if (!seg) return reply.code(400).send({ error: "empty" });
  return { ok: true, seg };
});

// Public read — mirrors GET /v1/chat. Anyone can pull the recent transcript
// (the live show is already streaming the speakers' words to every peer +
// the spectator chat firehose, so there's nothing to gate). The Transcript
// desktop app polls this every few seconds.
app.get("/v1/transcript", async (req, reply) => {
  reply.header("cache-control", "no-store");
  return { segments: roomFromReq(req).transcript.recent() };
});

// --- God-mode STT relay (on-behalf-of transcript) ---------------------------
// The headed-Chrome streaming box receives every other peer's audio over
// the full-mesh WebRTC connection it already maintains. For each peer it
// runs client-side VAD, captures short Opus chunks via MediaRecorder, and
// POSTs them here tagged with that speaker's address. We transcribe via
// OpenAI and stamp the resulting segment with the speaker's identity —
// not the god-mode caller's — so the transcript reads identically to
// the old per-browser Web Speech path, just without the Firefox blind
// spot. Only sessions minted via /auth/godmode are allowed in.
//
// `address` / `handle` come from query params (URL-encoded) so the
// request body can stay a raw audio Buffer.
const STT_AUDIO_MAX_BYTES = 4 * 1024 * 1024; // ~30s of opus at 96kbps, with headroom
type SttRelayQuery = { slug?: string; address?: string; handle?: string; anonId?: string; lang?: string };
app.post<{ Querystring: SttRelayQuery }>(
  "/v1/transcript/relay",
  { bodyLimit: STT_AUDIO_MAX_BYTES },
  async (req, reply) => {
    const a = v1AuthFromReq(req);
    if (!a) return reply.code(401).send({ error: "unauthenticated" });
    if (!a.session.spectator) return reply.code(403).send({ error: "godmode-only" });
    if (!isSttConfigured()) return reply.code(503).send({ error: "stt-not-configured" });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply
        .code(400)
        .send({ error: "empty-body", note: "POST raw audio bytes (audio/webm or audio/ogg)" });
    }

    // Speaker identity from the query string. `address` is optional —
    // the god-mode client looks it up from the room state, but a peer
    // who hasn't authed yet would have null. handle is purely cosmetic.
    const rawAddr = typeof req.query?.address === "string" ? req.query.address.toLowerCase() : "";
    const address = /^0x[a-f0-9]{40}$/.test(rawAddr) ? rawAddr : null;
    const handle = typeof req.query?.handle === "string" && req.query.handle.length <= 64
      ? req.query.handle
      : null;
    const anonId = typeof req.query?.anonId === "string" && req.query.anonId.length <= 64
      ? req.query.anonId
      : null;
    const lang = typeof req.query?.lang === "string" && req.query.lang.length <= 16
      ? req.query.lang
      : undefined;

    // Rate limit keyed on the SPEAKER, not the caller. Otherwise a
    // single god-mode token would share one bucket across all speakers
    // and a fast conversation would 429 mid-utterance. Bucket key
    // falls back to the god-mode session token when address is null
    // so we still cap unattributed spam.
    const room = roomFromReq(req);
    const bucketKey = address ?? anonId ?? `gm:${a.session.token}`;
    if (!room.transcript.allow(bucketKey)) {
      return reply.code(429).send({ error: "rate-limited" });
    }

    let text: string;
    try {
      const mime = String(req.headers["content-type"] ?? "audio/webm");
      text = await transcribeAudio(body, mime, lang);
    } catch (err) {
      req.log.error({ err }, "stt failed");
      const msg = err instanceof Error ? err.message : "unknown";
      return reply.code(502).send({ error: "stt-failed", detail: msg });
    }

    const trimmed = text.trim();
    if (!trimmed) return { ok: true, seg: null };

    const seg = room.transcript.append({
      address,
      handle,
      anonId,
      text: trimmed,
      // Same "live" source the per-browser STT path used — keeps the
      // archive coherent for downstream consumers (no special "from
      // god-mode" branch needed in the finalize / spectator UIs).
      source: "live",
    });
    if (!seg) return reply.code(400).send({ error: "empty" });
    return { ok: true, seg };
  },
);

// --- Admin transcript viewer -------------------------------------------------
// Host-only. JSON for one-shot inspection, SSE for live tailing — open either
// in a browser to verify per-peer STT is flowing and correctly attributed.
app.get("/admin/transcript", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  reply.header("cache-control", "no-store");
  return { segments: roomFromReq(req).transcript.recent() };
});

// Manual wipe — for blowing away pre-show test segments. Finalize also
// clears automatically once the manifest pins, so this is mainly for the
// "I dinked around and want a clean slate before going live" case.
app.delete("/admin/transcript", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  return roomFromReq(req).transcript.clear();
});

// --- Episode flags (STT toggle, etc.) ---------------------------------------
// Tiny key-value store the host flips to gate things like live transcript
// posting. Peers read /v1/episode (or subscribe to /v1/episode/stream) so
// their browser knows when STT is allowed.

app.get("/v1/episode", async (req, reply) => {
  reply.header("cache-control", "no-store");
  return roomFromReq(req).episode.getState();
});

app.get("/v1/episode/stream", async (req, reply) => {
  // Same cross-origin handling as /v1/chat/stream — slop.computer reads
  // this too if it ever wants to react to STT-on state visually.
  const origin = (req.headers.origin as string | undefined) ?? "";
  const corsOrigins = config.corsOrigins;
  const allowOrigin =
    corsOrigins.includes("*") || corsOrigins.includes(origin) ? origin || "*" : "";
  const sseHeaders: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
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
  const episode = roomFromReq(req).episode;
  write("init", episode.getState());
  const unsub = episode.subscribe((s: EpisodeState) => write("episode", s));
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

type EpisodeSttBody = { on?: unknown };

app.post<{ Body: EpisodeSttBody }>("/admin/episode/stt", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const on = req.body?.on === true;
  return roomFromReq(req).episode.setSttOn(on);
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
  const transcript = roomFromReq(req).transcript;
  write("init", { segments: transcript.recent() });
  const unsub = transcript.subscribe(seg => write("transcript", seg));
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

/** Pull `?slug=<slug>` off the request, validate it, and return the
 *  concrete slug or null. Null means the skill renders with `<slug>`
 *  placeholders; a concrete slug pre-fills every example. */
function skillSlugFromReq(req: { query?: unknown }): string | null {
  const q = (req.query ?? {}) as { slug?: unknown };
  const raw = typeof q.slug === "string" ? q.slug.trim() : "";
  if (!raw) return null;
  return isValidSlug(raw) ? raw : null;
}

app.get<{ Querystring: { token?: string; slug?: string } }>("/v1/skill", async (req, reply) => {
  const queryToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
  const got = resolveSkillAuth(req, queryToken);
  if (!got) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("content-type", "text/markdown; charset=utf-8");
  reply.header("cache-control", "no-store");
  return skillIndex(got.token, got.auth.isHost, skillSlugFromReq(req));
});

app.get<{ Params: { topic: string }; Querystring: { token?: string; slug?: string } }>(
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
    return skillForTopic(topic, got.token, got.auth.isHost, skillSlugFromReq(req));
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
    // Avatars are keyed by wallet address — the same image belongs to
    // the same user no matter which room they're in. Fan out to every
    // room so a user changing their avatar in ep0 immediately reflects
    // for spectators sitting in ep1.
    broadcastToAllRooms({ type: "avatar", ownerKey: key, url });
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

  broadcastToAllRooms({ type: "avatar_hidden", ownerKey: key });
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
  if (removed) broadcastToAllRooms({ type: "avatar_removed", ownerKey: key });
  return { ok: true, removed, key };
});

// --- Title card generator --------------------------------------------------
// Multiplayer title card per room. Generation runs as a background job
// owned by the relay — POST /v1/card kicks it off and returns
// immediately (202), the relay broadcasts `card_job` so every peer in
// the room sees a shared progress bar regardless of who started it,
// and on completion the result PNG lands at
// ./.slop-data/rooms/<slug>/card.png with a `card_state` broadcast.
// Closing the CardWindow doesn't cancel anything — the server runs the
// job to completion and the closer sees the result whenever they
// reopen. Endpoints live under /v1/ so the prod Caddyfile's /v1/* proxy
// rule catches them without needing a config change.
const CARD_PFP_MAX_BYTES = 10 * 1024 * 1024;

function cardFilePath(slug: string): string {
  return `./.slop-data/rooms/${slug}/card.png`;
}

// Host-baked unfurl PNG. The bare card.png is the raw AI image; this is
// what the host explicitly saved via the disk button in CardWindow,
// title overlay baked in. Used as the og:image for live.slop.computer/<slug>.
function cardPublishedFilePath(slug: string): string {
  return `./.slop-data/rooms/${slug}/card-published.png`;
}

function readCardSnapshot(slug: string): { version: number } | null {
  try {
    const st = _statSync(cardFilePath(slug));
    return { version: st.mtimeMs | 0 };
  } catch {
    return null;
  }
}

// In-memory job registry. Resets on relay restart by design — an
// in-flight OpenAI call would be orphaned anyway, and the client clears
// stale loading state on WS reconnect via hello.cardJob.
type CardJob = { startedAt: number; startedBy: string | null };
const cardJobs = new Map<string, CardJob>();

function readCardJob(slug: string): CardJob | null {
  return cardJobs.get(slug) ?? null;
}

// Shared title overlay (text + fractional position + size) sitting on
// top of the card image. Persisted alongside card.png so a host who
// staged a guest name doesn't lose it when the relay restarts mid-show.
// Coordinates are fractions of the IMAGE content rect, matching the
// client's `getImageRect` math — `sizeFrac` is font-size as a fraction
// of image width.
type CardTitle = { text: string; x: number; y: number; sizeFrac: number };
const cardTitles = new Map<string, CardTitle>();

function cardTitleFilePath(slug: string): string {
  return `./.slop-data/rooms/${slug}/card-title.json`;
}

function readCardTitle(slug: string): CardTitle | null {
  const cached = cardTitles.get(slug);
  if (cached) return cached;
  try {
    const raw = _readFileSync(cardTitleFilePath(slug), "utf8");
    const j = JSON.parse(raw);
    if (
      j && typeof j === "object" &&
      typeof j.text === "string" &&
      typeof j.x === "number" &&
      typeof j.y === "number" &&
      typeof j.sizeFrac === "number"
    ) {
      const title: CardTitle = { text: j.text, x: j.x, y: j.y, sizeFrac: j.sizeFrac };
      cardTitles.set(slug, title);
      return title;
    }
  } catch {
    /* not yet persisted */
  }
  return null;
}

function writeCardTitle(slug: string, title: CardTitle): void {
  cardTitles.set(slug, title);
  void (async () => {
    try {
      await _mkdir(`./.slop-data/rooms/${slug}`, { recursive: true });
      await _writeFile(cardTitleFilePath(slug), JSON.stringify(title));
    } catch (err) {
      app.log.warn({ err, slug }, "card title persist failed");
    }
  })();
}

function sanitizeCardTitle(input: unknown): CardTitle | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.text !== "string") return null;
  if (typeof raw.x !== "number" || !Number.isFinite(raw.x)) return null;
  if (typeof raw.y !== "number" || !Number.isFinite(raw.y)) return null;
  if (typeof raw.sizeFrac !== "number" || !Number.isFinite(raw.sizeFrac)) return null;
  return {
    text: raw.text.slice(0, 200),
    x: Math.max(0, Math.min(1, raw.x)),
    y: Math.max(0, Math.min(1, raw.y)),
    sizeFrac: Math.max(0.015, Math.min(0.25, raw.sizeFrac)),
  };
}

app.post(
  "/v1/card",
  { bodyLimit: CARD_PFP_MAX_BYTES },
  async (req, reply) => {
    const a = v1AuthFromReq(req);
    if (!a) return reply.code(401).send({ error: "unauthenticated" });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "empty-body", note: "POST raw image bytes with image/jpeg, image/png, or image/webp" });
    }
    if (body.length > CARD_PFP_MAX_BYTES) return reply.code(413).send({ error: "too-large" });

    const room = roomFromReq(req);
    const slug = room.id;

    // One job at a time per room. If someone else's drop is already
    // generating, tell the caller and let them watch the shared
    // progress bar.
    const existing = cardJobs.get(slug);
    if (existing) {
      return reply.code(409).send({ error: "already-generating", job: existing });
    }

    const startedBy = (a.session.address ?? a.session.handle ?? null) || null;
    const job: CardJob = { startedAt: Date.now(), startedBy };
    cardJobs.set(slug, job);
    room.broadcast({ type: "card_job", job });

    // Fire-and-forget: the HTTP req returns now, the actual generation
    // runs server-side independent of the connection. Peers learn about
    // the result through `card_state` + `card_job: null` on the mesh,
    // not through this response body.
    const ct = String(req.headers["content-type"] ?? "");
    void (async () => {
      try {
        const { png } = await generateCard(body, ct);
        await _mkdir(`./.slop-data/rooms/${slug}`, { recursive: true });
        await _writeFile(cardFilePath(slug), png);
        const snap = readCardSnapshot(slug);
        room.broadcast({ type: "card_state", state: snap });
      } catch (err) {
        req.log.error({ err }, "card generation failed");
      } finally {
        cardJobs.delete(slug);
        room.broadcast({ type: "card_job", job: null });
      }
    })();

    return reply.code(202).send({ ok: true, job });
  },
);

// Clear the current card — anyone in the room may reset, mirroring the
// per-peer reset button in CardWindow. After delete the room falls back
// to the template until someone drops a new PFP. Does NOT cancel an
// in-flight job; that would leave peers' progress bars stuck.
app.delete("/v1/card", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const room = roomFromReq(req);
  try {
    _unlinkSync(cardFilePath(room.id));
  } catch {
    /* already gone */
  }
  room.broadcast({ type: "card_state", state: null });
  return { ok: true };
});

// Publish the room's title card as a baked PNG (title overlay drawn
// into the image). Anyone in the room can publish — mirrors the same
// permissive model as reset. The body is the raw PNG bytes produced
// client-side by CardWindow's canvas bake. This file is what gets
// served as the og:image for live.slop.computer/<slug>.
app.post(
  "/v1/card/published",
  { bodyLimit: CARD_PFP_MAX_BYTES },
  async (req, reply) => {
    const a = v1AuthFromReq(req);
    if (!a) return reply.code(401).send({ error: "unauthenticated" });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "empty-body", note: "POST raw PNG bytes with content-type: image/png" });
    }
    if (body.length > CARD_PFP_MAX_BYTES) return reply.code(413).send({ error: "too-large" });
    const ct = String(req.headers["content-type"] ?? "");
    if (!ct.startsWith("image/png")) return reply.code(415).send({ error: "png-only" });
    const room = roomFromReq(req);
    const slug = room.id;
    try {
      await _mkdir(`./.slop-data/rooms/${slug}`, { recursive: true });
      await _writeFile(cardPublishedFilePath(slug), body);
    } catch (err) {
      req.log.error({ err }, "card publish failed");
      return reply.code(500).send({ error: "write-failed" });
    }
    return { ok: true, bytes: body.length };
  },
);

// Serve the per-room card PNG. Slug validated against the same regex
// the relay uses everywhere; filename is locked to a small allowlist so
// this can never be turned into an arbitrary-file-read primitive. Lives
// under /v1/ so prod Caddy proxies it without a config change.
//
// `card.png` = raw AI-generated card (5min cache, written by the
// generation job). `published.png` = host-baked unfurl PNG with title
// overlay rendered in (1h cache since hosts publish deliberately and
// re-publishes are rare).
app.get<{ Params: { slug: string; filename: string } }>(
  "/v1/cards/:slug/:filename",
  async (req, reply) => {
    const { slug, filename } = req.params;
    if (!isValidSlug(slug) || (filename !== "card.png" && filename !== "published.png")) {
      return reply.code(400).send({ error: "bad-name" });
    }
    const path = filename === "published.png" ? cardPublishedFilePath(slug) : cardFilePath(slug);
    let buf: Buffer;
    try {
      const fs = await import("node:fs/promises");
      buf = await fs.readFile(path);
    } catch {
      return reply.code(404).send({ error: "not-found" });
    }
    reply.header("content-type", "image/png");
    reply.header("cache-control", filename === "published.png" ? "public, max-age=3600" : "public, max-age=300");
    return reply.send(buf);
  },
);

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
function buildChessPayload(room: Room, callerKey: string | null) {
  const game = room.chess.getCurrentGame();
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
    version: room.chess.getVersion(),
    game,
    toMove,
    yourTurn,
    history: room.chess.getHistory(),
  };
}

app.get("/v1/chess", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  const callerKey = (a.session.address ?? a.session.handle ?? "").toLowerCase() || null;
  return buildChessPayload(roomFromReq(req), callerKey);
});

/** Long-poll the chess game. Pass `?since=<version>` (the `version`
 *  field from a previous /v1/chess response). If the room's chess
 *  version is already greater, returns immediately. Otherwise blocks
 *  up to `?timeout=<sec>` seconds (default 25, max 60) waiting for the
 *  next change, then returns the current snapshot regardless.
 *
 *  Lets an agent's autonomous-play loop wait cheaply for the opponent
 *  to move without polling on a fixed cadence. Wakes on every state
 *  change: create / move / resign / abort / close. */
app.get<{ Querystring: { since?: string; timeout?: string } }>("/v1/chess/wait", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  const room = roomFromReq(req);
  const callerKey = (a.session.address ?? a.session.handle ?? "").toLowerCase() || null;
  const since = Number(req.query?.since ?? 0);
  const timeoutSec = Math.min(60, Math.max(1, Number(req.query?.timeout ?? 25)));

  if (!Number.isFinite(since) || room.chess.getVersion() > since) {
    return buildChessPayload(room, callerKey);
  }

  return await new Promise<unknown>(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(buildChessPayload(room, callerKey));
    };
    const timer = setTimeout(finish, timeoutSec * 1000);
    const cleanup = () => {
      clearTimeout(timer);
      room.chess.removeWaiter(entry);
      try {
        reply.raw.off("close", finish);
      } catch {
        /* ignore */
      }
    };
    const entry = { wake: finish, cleanup };
    room.chess.pushWaiter(entry);
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
  const room = roomFromReq(req);
  const result = room.chess.createGame({
    whiteKey: b.whiteKey,
    blackKey: b.blackKey,
    whiteLabel: typeof b.whiteLabel === "string" ? b.whiteLabel : b.whiteKey,
    blackLabel: typeof b.blackLabel === "string" ? b.blackLabel : b.blackKey,
  });
  if (!result.ok) return reply.code(409).send({ error: result.error });
  broadcastChessState(room, result.game);
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
  const room = roomFromReq(req);
  const result = room.chess.applyMove(callerKey, {
    from: b.from,
    to: b.to,
    promotion: typeof b.promotion === "string" ? b.promotion : undefined,
  });
  if (!result.ok) {
    const code = result.error === "not_your_turn" || result.error === "illegal_move" ? 403 : 409;
    return reply.code(code).send({ error: result.error });
  }
  broadcastChessState(room, result.game);
  if (result.ended) room.broadcast({ type: "chess_history", history: room.chess.getHistory() });
  return { ok: true, game: result.game, ended: result.ended };
});

app.post("/v1/chess/resign", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const callerKey = (a.session.address ?? a.session.handle ?? "").toLowerCase();
  if (!callerKey) return reply.code(400).send({ error: "no-identity-on-session" });
  const room = roomFromReq(req);
  const result = room.chess.resign(callerKey);
  if (!result.ok) return reply.code(409).send({ error: result.error });
  broadcastChessState(room, result.game);
  room.broadcast({ type: "chess_history", history: room.chess.getHistory() });
  return { ok: true, game: result.game };
});

app.post("/v1/chess/close", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const room = roomFromReq(req);
  const result = room.chess.clearGame();
  broadcastChessState(room, null);
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
  return roomFromReq(req).music.current();
});

// Long-poll the music state. Pass `?since=<version>` from a previous
// /v1/music response; this returns immediately if the version has
// already advanced, otherwise blocks up to `?timeout=<sec>` (default 25,
// max 60) waiting for the next change.
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

  const music = roomFromReq(req).music;
  const cur = music.current();
  if (!Number.isFinite(since) || cur.version > since) {
    return cur;
  }

  return await new Promise<unknown>(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(music.current());
    };
    const timer = setTimeout(finish, timeoutSec * 1000);
    const cleanup = () => {
      clearTimeout(timer);
      music.removeWaiter(entry);
      try {
        reply.raw.off("close", finish);
      } catch {
        /* ignore */
      }
    };
    const entry = { wake: finish, cleanup };
    music.pushWaiter(entry);
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
  const room = roomFromReq(req);
  const incomingVolume = typeof b.volume === "number" ? Math.max(0, Math.min(1, b.volume)) : null;
  const next = room.music.set({
    src: typeof b.src === "string" ? b.src : null,
    index: b.index,
    playing: !!b.playing,
    position: b.position,
    at: typeof b.at === "number" ? b.at : Date.now(),
    volume: incomingVolume ?? room.music.cachedVolume() ?? 0.7,
  });
  room.broadcast({ type: "music_state", state: next });
  return { ok: true, ...room.music.current() };
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
  const room = roomFromReq(req);
  if (room.windows.open(id)) room.broadcast({ type: "window_opened", id });
  return { ok: true, id };
});

app.delete<{ Params: { id: string } }>("/v1/windows/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const id = req.params.id;
  const room = roomFromReq(req);
  if (room.windows.close(id)) room.broadcast({ type: "window_closed", id });
  return { ok: true, id };
});

// --- Todo REST surface ------------------------------------------------------
// Mirrors the WS handlers below; mutations broadcast to live peers via the
// Room's wired-in TodoList subscriber, so REST writers and WS writers feel
// the same to spectators.

type TodoTextBody = { text?: unknown };
type TodoReorderBody = { ids?: unknown };

app.get("/v1/todos", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return { items: roomFromReq(req).todos.list() };
});

app.post<{ Body: TodoTextBody }>("/v1/todos", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) return reply.code(400).send({ error: "empty" });
  const item = roomFromReq(req).todos.add({
    address: a.session.address,
    handle: a.session.handle,
    anonId: a.session.anonId ?? null,
    text,
  });
  if (!item) return reply.code(400).send({ error: "empty" });
  return { ok: true, item };
});

app.post<{ Params: { id: string } }>("/v1/todos/:id/toggle", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!roomFromReq(req).todos.toggle(req.params.id)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: TodoTextBody }>("/v1/todos/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) return reply.code(400).send({ error: "empty" });
  if (!roomFromReq(req).todos.update(req.params.id, text)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

app.delete<{ Params: { id: string } }>("/v1/todos/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!roomFromReq(req).todos.remove(req.params.id)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

app.post("/v1/todos/clear-done", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  roomFromReq(req).todos.clearDone();
  return { ok: true };
});

app.post<{ Body: TodoReorderBody }>("/v1/todos/reorder", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!Array.isArray(req.body?.ids)) return reply.code(400).send({ error: "ids-required" });
  const ids = req.body.ids.filter((s: unknown): s is string => typeof s === "string");
  roomFromReq(req).todos.reorder(ids);
  return { ok: true };
});

// --- Notes REST surface -----------------------------------------------------

type NoteTextBody = { text?: unknown };

app.get("/v1/notes", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  reply.header("cache-control", "no-store");
  return { items: roomFromReq(req).notes.list() };
});

app.post<{ Body: NoteTextBody }>("/v1/notes", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const note = roomFromReq(req).notes.create({
    address: a.session.address,
    handle: a.session.handle,
    anonId: a.session.anonId ?? null,
    text,
  });
  if (!note) return reply.code(400).send({ error: "create-failed" });
  return { ok: true, note };
});

app.post<{ Params: { id: string }; Body: NoteTextBody }>("/v1/notes/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!roomFromReq(req).notes.update(req.params.id, text)) return reply.code(404).send({ error: "not-found" });
  return { ok: true };
});

app.delete<{ Params: { id: string } }>("/v1/notes/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!roomFromReq(req).notes.remove(req.params.id)) return reply.code(404).send({ error: "not-found" });
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
  const entry = glossaryCreate({
    term,
    address: a.session.address,
    handle: a.session.handle,
    anonId: a.session.anonId ?? null,
  });
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

// --- Guest research --------------------------------------------------------
// AI dossier for an upcoming interview / live guest. The state machine
// (lookup-pending → form → research-pending → done) lives on
// room.research; every transition broadcasts a `research_state` message
// so every peer sees the same loading bar and the same final dossier.
// All three POST routes return 202 + the new snapshot — clients learn
// about results through the broadcast, not the HTTP response. Mirrors
// the long-running card-generation flow at /v1/card.

type GuestLookupBody = { query?: unknown };

type GuestResearchBody = {
  name?: unknown;
  socials?: unknown;
  notes?: unknown;
};

function readSocials(raw: unknown): ResearchQuery["socials"] {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const pick = (k: string): string | undefined => {
    const v = r[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  return {
    twitter: pick("twitter"),
    github: pick("github"),
    linkedin: pick("linkedin"),
    website: pick("website"),
    other: pick("other"),
  };
}

// "alice.eth" if we have it, else 0xabcd…1234, else null. Stamped on
// the job so spectators could read "Alice is researching @vitalik" if
// we ever want to render that.
function startedByLabel(a: ReturnType<typeof v1AuthFromReq>): string | null {
  if (!a) return null;
  return (a.session.handle || a.session.address || null) || null;
}

app.post<{ Body: GuestLookupBody }>("/v1/guest-lookup", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) return reply.code(400).send({ error: "missing-query" });

  const room = roomFromReq(req);
  // Refuse overlapping jobs — same idea as the card endpoint. The
  // existing job's broadcast is enough for the second caller; they
  // already see the shared loading bar.
  const current = room.research.current().state;
  if (current.job) return reply.code(409).send({ error: "already-in-flight", state: current });

  const job = { kind: "lookup" as const, startedAt: Date.now(), startedBy: startedByLabel(a) };
  // Transition into lookup-pending. Reset prior result/form so peers
  // don't see stale dossier underneath the loading bar.
  const next = room.research.setPatch({
    phase: "lookup-pending",
    lookupQuery: query,
    name: "",
    socials: {},
    notes: "",
    result: null,
    error: null,
    job,
  });

  // Fire and forget. The HTTP response returns immediately; result
  // delivery happens through the `research_state` broadcast.
  void (async () => {
    try {
      const result = await lookupGuest(query);
      if (result.error) {
        room.research.setPatch({
          phase: "idle",
          job: null,
          error: result.error,
        });
        return;
      }
      room.research.setPatch({
        phase: "form",
        name: result.name || query,
        socials: result.socials,
        notes: result.notes ?? "",
        job: null,
        error: null,
      });
    } catch (err) {
      room.research.setPatch({
        phase: "idle",
        job: null,
        error: `lookup failed: ${String(err).slice(0, 300)}`,
      });
    }
  })();

  reply.header("cache-control", "no-store");
  return reply.code(202).send({ ok: true, state: next });
});

app.post<{ Body: GuestResearchBody }>("/v1/guest-research", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return reply.code(400).send({ error: "missing-name" });
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;
  const socials = readSocials(req.body?.socials);

  const room = roomFromReq(req);
  const current = room.research.current().state;
  if (current.job) return reply.code(409).send({ error: "already-in-flight", state: current });

  // If the host included a Twitter handle in the research query,
  // tell the Timeline module to over-index on that account's recent
  // tweets for the next 4h. Done before the (slow) Anthropic call so
  // the focus is set even if the AI dossier fails.
  if (socials.twitter) setTimelineResearchFocus(socials.twitter);

  const job = { kind: "research" as const, startedAt: Date.now(), startedBy: startedByLabel(a) };
  const next = room.research.setPatch({
    phase: "research-pending",
    name,
    socials,
    notes: notes ?? "",
    result: null,
    error: null,
    job,
  });

  void (async () => {
    try {
      const result = await researchGuest({ name, socials, notes });
      room.research.setPatch({
        phase: "done",
        result,
        job: null,
        error: null,
      });
    } catch (err) {
      room.research.setPatch({
        phase: "form",
        job: null,
        error: `research failed: ${String(err).slice(0, 300)}`,
      });
    }
  })();

  reply.header("cache-control", "no-store");
  return reply.code(202).send({ ok: true, state: next });
});

// Clear the shared research state back to the lookup screen. Anyone in
// the room can hit this — same "anyone resets" model as /v1/card.
// Refuses while a job is in flight so a "Start over" click can't
// orphan a running AI call (the result would land on a stale snapshot
// and confuse everyone).
app.delete("/v1/research", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const room = roomFromReq(req);
  const current = room.research.current().state;
  if (current.job) return reply.code(409).send({ error: "in-flight", state: current });
  const next = room.research.reset();
  return { ok: true, state: next };
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
    current: roomFromReq(req).jamendo.getCurrentGenre(),
  };
});

app.post<{ Body: SetGenreBody }>("/v1/music/genre", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const incoming = req.body?.genre;
  if (incoming !== null && typeof incoming !== "string") return reply.code(400).send({ error: "bad-genre" });
  if (incoming !== null && !isGenre(incoming)) return reply.code(400).send({ error: "unknown-genre" });
  try {
    const out = await roomFromReq(req).jamendo.setCurrentGenre(incoming as string | null);
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
  // The "custom" playlist is per-room — served from the JamendoRoomState
  // rather than the global MP3 cache.
  if (req.params.genre === "custom") return roomFromReq(req).jamendo.getCustomPlaylist();
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
  const tracks = roomFromReq(req).jamendo.addToCustom({
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
  const tracks = roomFromReq(req).jamendo.removeFromCustom(req.params.jamendoId);
  return { ok: true, tracks };
});

type ReorderCustomBody = { ids?: unknown };

app.post<{ Body: ReorderCustomBody }>("/v1/music/custom/reorder", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!Array.isArray(req.body?.ids)) return reply.code(400).send({ error: "ids-required" });
  const ids = req.body.ids.filter((x: unknown): x is string => typeof x === "string");
  const tracks = roomFromReq(req).jamendo.reorderCustom(ids);
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
  return { state: roomFromReq(req).clock.getState() };
});

app.post<{ Body: ClockBody }>("/v1/clock", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  if (!req.body || typeof req.body !== "object") return reply.code(400).send({ error: "bad-body" });
  const next = roomFromReq(req).clock.setState(req.body);
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
  return { items: roomFromReq(req).files.list() };
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
    const result = roomFromReq(req).files.add({ name, mime, buffer: body, ownerKey, uploaderLabel });
    if ("error" in result) return reply.code(400).send(result);
    return { ok: true, item: result };
  },
);

app.delete<{ Params: { id: string } }>("/v1/files/:id", async (req, reply) => {
  const a = v1AuthFromReq(req);
  if (!a) return reply.code(401).send({ error: "unauthenticated" });
  const ownerKey = (a.session.address ?? a.session.handle ?? "").toLowerCase() || "";
  // godMode (spectator) sessions act as ops — they can delete anyone's
  // file, same as the room host. Treat them as elevated for this call.
  const elevated = a.isHost || a.session.spectator === true;
  const result = roomFromReq(req).files.remove(req.params.id, ownerKey, elevated);
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
  const filesIndex = roomFromReq(req).files;
  const item = filesIndex.get(id);
  if (!item) return reply.code(404).send({ error: "not-found" });
  // Prefer the BGIPFS gateway when the background pin landed — keeps
  // the prod box's outbound bandwidth off the hot path, and the gateway
  // already has aggressive caching. Falls back to serving local bytes
  // for legacy entries (pre-IPFS) and pin-pending entries.
  const gateway = config.ipfsPublicGateway;
  if (item.cid && gateway) {
    const encodedName = encodeURIComponent(item.name);
    return reply.redirect(`${gateway.replace(/\/$/, "")}/${item.cid}?filename=${encodedName}`, 302);
  }
  const fsSync = await import("node:fs");
  const filepath = filesIndex.resolveReadPath(item);
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
// Legacy single-global-invite endpoint, kept so existing slop_invite
// cookies issued before per-room passwords keep working for the main
// room. New rooms use /v1/rooms/:slug/auth (below).
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

// --- Per-room password gate ------------------------------------------------
//
// Each room has its own scrypt-hashed password (stored in
// .slop-data/rooms/<slug>/auth.json). The host creates the room with a
// password via POST /v1/rooms; anyone with the password posts to
// /v1/rooms/:slug/auth and gets back an HMAC-signed cookie scoped to
// that slug.
//
// Two layers of auth:
//   - Room cookie (this endpoint)  → "you were invited to this room"
//   - Session cookie (SIWE/passkey) → "this is who you are"
// Both required for write actions; either alone is not enough.

const ROOM_COOKIE_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

function hasValidRoomCookie(req: { cookies?: Record<string, string | undefined> }, slug: string): boolean {
  if (slug === DEFAULT_SLUG && isInvited(req.cookies?.[INVITE_COOKIE])) {
    // Backwards-compat: pre-Phase-5 users with a slop_invite cookie keep
    // their access to the main room without re-entering a password.
    return true;
  }
  const cookie = req.cookies?.[roomCookieName(slug)];
  return verifyRoomCookie(cookie, slug, config.sessionSecret);
}

type RoomCreateBody = { slug?: unknown; password?: unknown; name?: unknown };

// Host-only: claim a slug + set its password. Returns 409 if the slug
// already has a password (use POST /v1/rooms/:slug/password to rotate).
app.post<{ Body: RoomCreateBody }>("/v1/rooms", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const body = (req.body ?? {}) as RoomCreateBody;
  const slug = typeof body.slug === "string" ? body.slug : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!isValidSlug(slug)) return reply.code(400).send({ error: "bad-slug" });
  if (!password) return reply.code(400).send({ error: "missing-password" });
  const room = getOrCreateRoom(slug);
  if (room.auth.hasPassword()) return reply.code(409).send({ error: "room-already-exists" });
  room.auth.setPassword(password);
  return { ok: true, slug };
});

// Host-only: rotate an existing room's password. Doesn't invalidate
// outstanding room cookies (those are time-bound only — Phase 7 could
// add a revocation list if needed).
type RoomPasswordBody = { password?: unknown };
app.post<{ Params: { slug: string }; Body: RoomPasswordBody }>("/v1/rooms/:slug/password", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  if (!isValidSlug(req.params.slug)) return reply.code(400).send({ error: "bad-slug" });
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) return reply.code(400).send({ error: "missing-password" });
  const room = getOrCreateRoom(req.params.slug);
  room.auth.setPassword(password);
  return { ok: true };
});

type RoomAuthBody = { password?: unknown };

// Public: verify a room's password and get back a slug-scoped cookie.
// Rejects with 404 if the room hasn't been claimed yet (no password set)
// — without this rooms would silently accept any password as wrong.
app.post<{ Params: { slug: string }; Body: RoomAuthBody }>("/v1/rooms/:slug/auth", async (req, reply) => {
  if (!isValidSlug(req.params.slug)) return reply.code(400).send({ error: "bad-slug" });
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) return reply.code(400).send({ error: "missing-password" });
  const room = getOrCreateRoom(req.params.slug);
  if (!room.auth.hasPassword()) return reply.code(404).send({ error: "no-such-room" });
  if (!room.auth.verify(password)) return reply.code(401).send({ error: "bad-password" });
  reply.setCookie(roomCookieName(req.params.slug), signRoomCookie(req.params.slug, config.sessionSecret), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ROOM_COOKIE_TTL_SECONDS,
  });
  return { ok: true, slug: req.params.slug };
});

// GET status: does this room exist + does the caller already have a
// valid cookie? Frontends call this on page load to decide whether to
// show the password prompt.
app.get<{ Params: { slug: string } }>("/v1/rooms/:slug/auth", async (req, reply) => {
  reply.header("cache-control", "no-store");
  if (!isValidSlug(req.params.slug)) return reply.code(400).send({ error: "bad-slug" });
  const room = getOrCreateRoom(req.params.slug);
  return {
    slug: req.params.slug,
    exists: room.auth.hasPassword(),
    authed: hasValidRoomCookie(req, req.params.slug),
  };
});

// Hot/cold revive: the frontend POSTs payment proof here when a WS
// connect fails with `payment-required`. Phase 7 stub trusts the
// PAYMENTS_DISABLED env var; Phase 8 swaps in the real on-chain check
// against the Base contract via Alchemy.
type ReviveBody = { proof?: unknown };
app.post<{ Params: { slug: string }; Body: ReviveBody }>("/v1/rooms/:slug/revive", async (req, reply) => {
  if (!isValidSlug(req.params.slug)) return reply.code(400).send({ error: "bad-slug" });
  const result = await verifyPaid(req.params.slug, (req.body ?? {}).proof);
  if (!result) return reply.code(402).send({ error: "payment-required" });
  const room = getOrCreateRoom(req.params.slug);
  room.meta.setPaidUntil(result.paidUntil);
  return { ok: true, slug: req.params.slug, paidUntil: result.paidUntil };
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
  // Everyone else has to have cleared either the legacy global gate
  // (slop_invite) OR a per-room password gate (any signed slop_room_*).
  if (
    !check.isAdmin &&
    !isInvited(req.cookies[INVITE_COOKIE]) &&
    !hasAnyValidRoomCookie(req.cookies, config.sessionSecret)
  ) {
    return reply.code(403).send({ error: "invite-required" });
  }
  // Resolve the primary ENS name once at login so chat / transcript /
  // cursor labels all carry a real handle instead of null. Cached for an
  // hour, so the per-session cost is one Alchemy call per cold user.
  const handle = check.address ? await reverseLookupEns(check.address) : null;
  const session = createSession({
    role: check.isAdmin ? "host" : "guest",
    address: check.address,
    handle,
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
  // Same gate as SIWE — legacy global invite OR any per-room cookie.
  if (
    !isInvited(req.cookies[INVITE_COOKIE]) &&
    !hasAnyValidRoomCookie(req.cookies, config.sessionSecret)
  ) {
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

  const handle = result.address ? await reverseLookupEns(result.address) : null;
  const session = createSession({ role: "guest", address: result.address, handle });
  reply.setCookie(SESSION_COOKIE, session.token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: config.sessionTTLSeconds,
  });
  return { ok: true, role: "guest", address: result.address, isAdmin: false };
});

// --- Anonymous auth ---------------------------------------------------------
//
// No wallet, no passkey, no password — just mint a guest session with a
// random `AnonXXXX` handle. The handle seeds `bandsFromIdentity` on the
// client, so each anon ends up with their own deterministic 3-color flag.
// Same invite gate as SIWE/passkey: the global slop_invite cookie OR any
// per-room password cookie has to be present, otherwise this is a free
// bypass of the gates we already ship.

app.post("/auth/anon", async (req, reply) => {
  if (
    !isInvited(req.cookies[INVITE_COOKIE]) &&
    !hasAnyValidRoomCookie(req.cookies, config.sessionSecret)
  ) {
    return reply.code(403).send({ error: "invite-required" });
  }
  const handle = `Anon${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
  // Stable per-session public identifier. Drives the flag colors and
  // peerNames lookups so renaming doesn't change visual identity.
  // Random 16-byte hex, not derived from the handle, so a rename can
  // never collide with another anon's initial AnonXXXX.
  const anonId = `anon-${randomBytes(8).toString("hex")}`;
  const session = createSession({ role: "guest", address: null, handle, anonId });
  reply.setCookie(SESSION_COOKIE, session.token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: config.sessionTTLSeconds,
  });
  return { ok: true, role: "guest", handle };
});

// --- Anon handle rename -----------------------------------------------------
//
// Sets the anon user's display name. We DO NOT mutate session.handle —
// that stays as the initial `AnonXXXX` forever, because chat/transcript/
// peer records baked it in at write time and we'd never see consistent
// identity if it changed. Instead we go through `peerNames` (the same
// system SIWE users' set_custom_name WS path uses), keyed by the
// session's stable `anonId`. The PeerNames subscriber fans a `peer_name`
// broadcast to every room, and the client SlopAddress component looks
// up customNames[anonId] — so the new name lights up everywhere
// (chat history, transcript, peer list) without per-record migration.

type HandleBody = { handle?: unknown };

app.post<{ Body: HandleBody }>("/auth/handle", async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  const session = getSession(token);
  if (!session || !token) return reply.code(401).send({ error: "unauthenticated" });
  if (session.address !== null) return reply.code(403).send({ error: "not-anon" });
  if (!session.anonId) return reply.code(409).send({ error: "no-anon-id" });

  const body = (req.body ?? {}) as HandleBody;
  const handle = typeof body.handle === "string" ? body.handle : "";
  // peerNames.set normalizes (trim, strip controls, max 30). Returns
  // null if the result is empty — which we reject as a bad rename.
  const next = peerNames.set(session.anonId, handle);
  if (next == null) return reply.code(400).send({ error: "empty-handle" });

  return { ok: true, handle: next };
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

// --- God-mode auth (spectator) ----------------------------------------------
//
// Issues a session cookie for a passive streaming/observer session. The
// caller must:
//   - Hold a valid per-room cookie (i.e. already cleared the PasswordGate
//     for some room).
//   - Provide the GOD_MODE_PASSWORD configured on the relay env.
// God-mode sessions are invisible in the UI: their peer record carries
// `spectator: true`, every client filters them out of the guest list,
// and the WS handler rejects state-changing message types (cursor,
// click, publish, chat, slot moves, browser ops, etc.). Used for the
// live stream capture box.

type GodModeBody = { password?: unknown };

app.post<{ Body: GodModeBody }>("/auth/godmode", async (req, reply) => {
  if (!config.godPassword) {
    return reply.code(503).send({ error: "godmode-not-configured" });
  }
  if (!hasAnyValidRoomCookie(req.cookies, config.sessionSecret)) {
    return reply.code(403).send({ error: "room-auth-required" });
  }
  const body = (req.body ?? {}) as GodModeBody;
  const password = typeof body.password === "string" ? body.password : "";
  if (!password || password !== config.godPassword) {
    return reply.code(401).send({ error: "bad-password" });
  }
  const session = createSession({
    role: "guest",
    address: null,
    handle: null,
    spectator: true,
  });
  reply.setCookie(SESSION_COOKIE, session.token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: config.sessionTTLSeconds,
  });
  return { ok: true, role: "guest", spectator: true };
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
    anonId: session.anonId ?? null,
    isAdmin: session.role === "host" && !!session.address && isAdminAddress(session.address),
    spectator: session.spectator === true,
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

function requireHost(req: { cookies: Record<string, string | undefined>; headers?: Record<string, unknown> }):
  | { ok: true; address: string }
  | { ok: false; error: string } {
  // Cookie session first (browser admin panel), then fall back to
  // bearer (host-scoped agent tokens minted via /v1/agent-token). Both
  // paths require role=host AND an admin address — bearer is not a
  // privilege escalation, it just lets a host's agent reach the same
  // surfaces the host can reach in their browser.
  const cookieToken = req.cookies[SESSION_COOKIE];
  let session = getSession(cookieToken);
  if (!session && req.headers) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      session = getSession(authHeader.slice("Bearer ".length).trim());
    }
  }
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

// Returns the configured GOD_MODE_PASSWORD as plaintext so the admin UI can
// build a one-click shareable god-mode link. Read-only; the password lives
// in env and isn't rotatable through the API. Returns null when unset so
// the UI can hide the [god] affordance instead of generating a broken link.
app.get("/admin/god-password", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  return { password: config.godPassword || null };
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

// Server-side broadcaster control. The slop-broadcast.service unit runs
// next to mediamtx on this box, capturing a Chromium --app window of
// the live room and pushing it to mediamtx over loopback RTMP. These
// endpoints control that unit so a host can start/stop the broadcast
// from the admin panel without ssh.
app.get("/admin/broadcast/status", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const [status, url] = await Promise.all([getBroadcastStatus(), getBroadcastUrl()]);
  return { ...status, url };
});

app.post<{ Body: { url?: string } }>("/admin/broadcast/url", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const url = req.body?.url ?? "";
  const result = await setBroadcastUrl(url);
  if (!result.ok) return reply.code(400).send(result);
  return result;
});

app.post("/admin/broadcast/start", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const result = await broadcastAction("start");
  if (!result.ok) return reply.code(500).send(result);
  return result;
});

app.post("/admin/broadcast/stop", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const result = await broadcastAction("stop");
  if (!result.ok) return reply.code(500).send(result);
  return result;
});

app.post("/admin/broadcast/restart", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const result = await broadcastAction("restart");
  if (!result.ok) return reply.code(500).send(result);
  return result;
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
      const room = roomFromReq(req);
      await finalizeRecording({
        recordingsDir: config.recordingsDir,
        pathName: "live",
        ipfsApiUrl: config.ipfsApiUrl,
        chatArchive: room.chat.readArchive(),
        transcriptArchive: room.transcript.readArchive(),
        clearTranscript: () => room.transcript.clear(),
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

// Lists every claimed room (anything with an `auth.json` on disk).
// Scans the filesystem rather than the in-memory `rooms` Map so cold /
// hibernated rooms still show up. Returns slug + claim/hot metadata
// only — never the password (that lives on disk as a scrypt hash).
app.get("/admin/rooms", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  const fs = await import("node:fs");
  const dir = "./.slop-data/rooms";
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { rooms: [] };
  }
  const hotSlugs = new Set(listRooms().map(r => r.id));
  // Debug is special-cased: it's the always-on sandbox room and has no
  // password (so no auth.json), but the admin still needs to control its
  // STT toggle, view its transcript, etc. from the same row UI as every
  // other room. We synthesize an entry for it if the directory exists at
  // all — the room may be cold but its state on disk is real.
  const claimedSlugs = entries
    .filter(name => /^[a-z0-9-]{1,64}$/.test(name))
    .filter(slug => fs.existsSync(`${dir}/${slug}/auth.json`));
  const slugSet = new Set<string>(claimedSlugs);
  if (fs.existsSync(`${dir}/${DEFAULT_SLUG}`) || hotSlugs.has(DEFAULT_SLUG)) {
    slugSet.add(DEFAULT_SLUG);
  }
  const rooms = Array.from(slugSet)
    .map(slug => {
      let createdAt: number | null = null;
      try {
        const raw = fs.readFileSync(`${dir}/${slug}/auth.json`, "utf8");
        const parsed = JSON.parse(raw) as { createdAt?: number };
        if (typeof parsed.createdAt === "number") createdAt = parsed.createdAt;
      } catch {
        /* unreadable auth.json — slug still claimed, just no createdAt */
      }
      let paidUntil: number | null = null;
      try {
        const raw = fs.readFileSync(`${dir}/${slug}/meta.json`, "utf8");
        const parsed = JSON.parse(raw) as { paidUntil?: number };
        if (typeof parsed.paidUntil === "number") paidUntil = parsed.paidUntil;
      } catch {
        /* no meta.json yet — room exists but never accessed since hibernate */
      }
      // Cold rooms keep their last STT toggle on disk so a relay restart
      // doesn't quietly turn STT back off mid-show. Read it directly
      // rather than instantiating the Room (which would also flip cold→hot
      // just to read a boolean). Defaults match EpisodeFlags' fresh-room
      // default (true) so the admin row shows the toggle in its real state
      // for rooms that haven't been touched.
      let sttOn = true;
      try {
        const raw = fs.readFileSync(`${dir}/${slug}/episode.json`, "utf8");
        const parsed = JSON.parse(raw) as { sttOn?: boolean };
        if (typeof parsed.sttOn === "boolean") sttOn = parsed.sttOn;
      } catch {
        /* no episode.json — sttOn defaults to true, same as a fresh room */
      }
      return { slug, createdAt, paidUntil, hot: hotSlugs.has(slug), sttOn };
    })
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { rooms };
});

// Host-only "nuke the session wallet" — wipes current + history + tx queue.
// Same effect as `rm .slop-data/wallet.json` but doesn't require shell access.
// Used by the admin page's "Reset session wallet" button so the host can
// recycle the deploy flow during a show.
app.post("/admin/wallet/reset", async (req, reply) => {
  const auth = requireHost(req);
  if (!auth.ok) return reply.code(401).send({ error: auth.error });
  roomFromReq(req).wallet.wipeAll();
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
// The browser-host POSTs captured wallet calls here so peers in the
// originating room see them in their tx panels. Authenticated by a shared
// bearer secret — keeps random clients from injecting fake tx_requests.
//
// `slug` lets us narrow the broadcast to that specific room (Phase 2).
// Old browser-host builds that don't include `slug` fall back to the
// main room — the relay can still serve them during a rolling deploy.
type BrowserTxBody = { slug?: unknown; browserId?: unknown; payload?: unknown };
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
  const slug = typeof body.slug === "string" ? parseSlug(body.slug) : DEFAULT_SLUG;
  getOrCreateRoom(slug).broadcast({
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
//   { type: "tx_forward", to: peerId, browserId, method, params, chainId }    // directed: send captured tx
//                                                                    //   to a specific peer (whose
//                                                                    //   wallet is being impersonated)
//                                                                    //   so they can sign+broadcast
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
//   { type: "tx_forward", from, fromAddress, fromHandle, id, browserId, method, params, chainId }
//                                                                    // directed: only the targeted
//                                                                    // peer sees this
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

    // Parse the room slug from the connect URL (?slug=ep0). Falls back
    // to DEFAULT_SLUG ("debug") so pre-Phase-3 frontends — which don't
    // yet send a slug — keep landing in the sandbox room.
    const urlForSlug = new URL(req.url ?? "/", "http://x");
    const slug = parseSlug(urlForSlug.searchParams.get("slug"));
    const room = getOrCreateRoom(slug);

    // Pre-claim model: arbitrary slugs (e.g. /testslug123) shouldn't
    // silently spin up a sandbox room. Non-DEFAULT slugs must have
    // been claimed via POST /v1/rooms (which writes auth.json) before
    // any peer can connect. The debug slug is special — always-on, no
    // password, used by ops + the AI for poking at the relay.
    if (slug !== DEFAULT_SLUG && !room.auth.hasPassword()) {
      send(socket, { type: "error", error: "room-not-found", slug });
      socket.close(4404, "room-not-found");
      return;
    }
    // Password gate. Everyone — including admins — needs the room
    // cookie for any slug that has a password set. The previous
    // adminBypass shortcut here meant admins could enter their own
    // claimed rooms without proving they remembered the password,
    // which silently broke the "unique-per-room password" invariant.
    // Admins who lock themselves out should rotate via
    // POST /v1/rooms/:slug/password instead.
    if (room.auth.hasPassword() && !hasValidRoomCookie(req, slug)) {
      send(socket, { type: "error", error: "room-auth-required", slug });
      socket.close(4403, "room-auth-required");
      return;
    }

    // Phase 7: paid-room gate. Admins DO bypass this one — payment is
    // a billing concern (Phase 8 wires it to the Base contract), not
    // an access-control concern, and locking the operator out of
    // their own room because of a missed payment is the wrong
    // failure mode. Free / unclaimed / paid rooms pass through.
    const isPaymentAdminBypass = session.address ? isAdminAddress(session.address) : false;
    if (!isPaymentAdminBypass && !isRoomFreeOrPaid(room)) {
      send(socket, { type: "error", error: "payment-required", slug });
      socket.close(4290, "payment-required");
      return;
    }
    room.touch();

    const peerId = randomBytes(8).toString("hex");
    const isSpectator = session.spectator === true;
    const info = {
      id: peerId,
      role: session.role,
      address: session.address,
      handle: session.handle,
      anonId: session.anonId ?? null,
      connectedAt: Date.now(),
      ...(isSpectator ? { spectator: true as const } : {}),
    };

    // Garbage-collect peers from this session whose socket is already
    // dead (network drop, refresh in progress, etc.). We do NOT kick
    // healthy peers — two live tabs of the same user (or two devices
    // sharing a session cookie) must be able to coexist. The old code
    // unconditionally kicked the existing peer, which produced an
    // infinite reconnect loop: each new tab kicked the previous one,
    // the kicked tab auto-reconnected and kicked back, ad nauseam.
    // Symptom in the UI: icons flicker, peer cursors blink in and out.
    //
    // Cross-room: a stale peer may live in a different room than the
    // one we're now joining (same session, different slug). Use
    // findPeerRoom so each peer_leave broadcast lands in the room
    // where that peer was actually visible.
    for (const stale of findPeersBySessionToken(session.token)) {
      // ws is the `ws` library's WebSocket on the server side; readyState
      // values: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. Treat both
      // CONNECTING and OPEN as "alive" — a peer that's still in the WS
      // upgrade handshake on a slow link shouldn't get GC'd by a
      // sibling tab whose own handshake just completed.
      const rs = (stale.ws as { readyState?: number }).readyState;
      const stillAlive = rs === 0 || rs === 1;
      if (stillAlive) continue;
      const staleRoom = findPeerRoom(stale.id);
      if (!staleRoom) continue;
      const ended = staleRoom.desktop.clearPeerPublications(stale.id);
      staleRoom.removePeer(stale.id);
      for (const p of ended) {
        staleRoom.broadcast({ type: "unpublished", peerId: stale.id, streamId: p.streamId });
      }
      staleRoom.broadcast({
        type: "peer_leave",
        peer: { id: stale.id, role: stale.role, address: stale.address, handle: stale.handle, connectedAt: stale.connectedAt },
      });
      try {
        stale.ws.close(4409, "session-replaced");
      } catch {
        /* ignore */
      }
    }

    room.addPeer({ ...info, ws: socket, sessionToken: session.token });
    send(socket, {
      type: "hello",
      id: peerId,
      peers: room.listPeers().filter(p => p.id !== peerId),
      publications: room.desktop.listPublications(),
      slots: room.desktop.getSlots(),
      browsers: room.browsers.list(),
      avatars: listAvatarsSync(),
      hiddenAvatars: listHiddenOwnersSync(),
      chatHistory: room.chat.recent(),
      openWindows: room.windows.list(),
      musicState: room.music.current().state,
      chessGame: room.chess.getCurrentGame(),
      chessHistory: room.chess.getHistory(),
      aiPlayers: listAvailableAIPlayers(),
      todos: room.todos.list(),
      notes: room.notes.list(),
      glossary: glossaryList(),
      gasState: getGasState(),
      tickerState: getTickerState(),
      headlinesState: getHeadlinesState(),
      timelineState: getTimelineState(),
    newsDigestState: getNewsDigestState(),
      files: room.files.list(),
      musicGenres: GENRE_IDS.map(id => ({ id, label: GENRES[id]!.label })),
      musicGenre: room.jamendo.getCurrentGenre(),
      musicCustom: room.jamendo.getCustomPlaylist().tracks,
      clockState: room.clock.getState(),
      wallet: room.wallet.getCurrent(),
      walletDraft: room.wallet.getDraft(),
      walletTxs: room.wallet.listTxs(),
      customNames: peerNames.all(),
      cardState: readCardSnapshot(room.id),
      cardJob: readCardJob(room.id),
      cardTitle: readCardTitle(room.id),
      researchState: room.research.current().state,
    });
    room.broadcast({ type: "peer_join", peer: info }, peerId);

    socket.on("message", (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(socket, { type: "error", error: "invalid_json" });
      }
      // God-mode (spectator) sessions are passive: they receive every
      // broadcast and do RTC signaling so the streaming box gets audio/
      // video, but every state-changing message is dropped. This is
      // defense in depth — the client already hides write UI — so even
      // a hand-crafted WS frame can't smuggle presence into the room.
      if (isSpectator) {
        const t = msg?.type;
        const allowed = t === "hello" || t === "ping" || t === "offer" || t === "answer" || t === "ice";
        if (!allowed) return;
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
          const ok = room.sendTo(msg.to, {
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
          room.broadcast({ type: "cursor", from: peerId, x: msg.x, y: msg.y }, peerId);
          return;
        }
        case "click": {
          if (typeof msg.x !== "number" || typeof msg.y !== "number") return;
          // Include the sender — the click ripple should appear on the
          // clicker's own screen at the same time it appears for everyone
          // else, otherwise click+ripple feel desynced.
          room.broadcast({ type: "click", from: peerId, x: msg.x, y: msg.y });
          return;
        }
        case "card_title": {
          // Shared title overlay sitting on top of the card image. Any
          // peer can drag (x/y), wheel-resize (sizeFrac), or rename
          // (text on blur) — server persists last-write-wins and fans
          // the change out to everyone EXCEPT the sender, who has
          // already updated optimistically. Drags fire at pointer-move
          // cadence (~60Hz) so the same pattern as `cursor` applies.
          const sanitized = sanitizeCardTitle(msg.title);
          if (!sanitized) return;
          writeCardTitle(room.id, sanitized);
          room.broadcast({ type: "card_title", title: sanitized }, peerId);
          return;
        }
        case "chat_send": {
          if (typeof msg.text !== "string" || !msg.text.trim()) return;
          if (!room.chat.allow(session.token)) {
            return send(socket, { type: "error", error: "rate-limited" });
          }
          // Cookie-authed WS peer → "live". The chat subscriber relays
          // this back to everyone (including the sender) via broadcast,
          // so the local UI doesn't need an optimistic insert.
          room.chat.append({
            address: info.address,
            handle: info.handle,
            anonId: info.anonId,
            text: msg.text,
            source: "live",
          });
          return;
        }
        case "set_custom_name": {
          // User picks a display name that overrides ENS / address-short
          // everywhere their identity is shown. Keyed by the user's
          // stable id — `address` for SIWE/passkey, `anonId` for anon.
          // The PeerNames subscriber above fans this out to every room
          // so chat, transcript, peer list, tile badges, etc. all flip
          // through their customNames[stableId] lookup in lockstep.
          const stableId = info.address ?? info.anonId ?? null;
          if (!stableId) {
            return send(socket, { type: "error", error: "no_stable_id" });
          }
          const next = peerNames.set(stableId, typeof msg.name === "string" ? msg.name : null);
          send(socket, { type: "custom_name_ack", name: next });
          return;
        }
        case "todo_add": {
          if (typeof msg.text !== "string" || !msg.text.trim()) return;
          room.todos.add({
            address: info.address,
            handle: info.handle,
            anonId: info.anonId,
            text: msg.text,
          });
          return;
        }
        case "todo_toggle": {
          if (typeof msg.id !== "string") return;
          room.todos.toggle(msg.id);
          return;
        }
        case "todo_update": {
          if (typeof msg.id !== "string" || typeof msg.text !== "string") return;
          room.todos.update(msg.id, msg.text);
          return;
        }
        case "todo_delete": {
          if (typeof msg.id !== "string") return;
          room.todos.remove(msg.id);
          return;
        }
        case "todo_clear_done": {
          room.todos.clearDone();
          return;
        }
        case "todo_reorder": {
          if (!Array.isArray(msg.ids)) return;
          const ids = msg.ids.filter((s: unknown): s is string => typeof s === "string");
          room.todos.reorder(ids);
          return;
        }
        case "note_create": {
          if (typeof msg.text !== "string") return;
          room.notes.create({
            address: info.address,
            handle: info.handle,
            anonId: info.anonId,
            text: msg.text,
          });
          return;
        }
        case "note_update": {
          if (typeof msg.id !== "string" || typeof msg.text !== "string") return;
          room.notes.update(msg.id, msg.text);
          return;
        }
        case "note_delete": {
          if (typeof msg.id !== "string") return;
          room.notes.remove(msg.id);
          return;
        }
        case "glossary_add": {
          if (typeof msg.term !== "string") return;
          glossaryCreate({
            term: msg.term,
            address: info.address,
            handle: info.handle,
            anonId: info.anonId,
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
          room.desktop.publish(pub);
          room.broadcast({ type: "published", publication: pub });
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
          const ownerId = room.desktop.findPublicationOwner(msg.streamId) ?? peerId;
          const ok = room.desktop.unpublish(ownerId, msg.streamId);
          if (ok) room.broadcast({ type: "unpublished", peerId: ownerId, streamId: msg.streamId });
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
          const merged = room.desktop.applySlotUpdate(patch);
          if (!merged) return;
          room.broadcast({ type: "slot", slot: merged });
          return;
        }
        case "browser_open": {
          if (typeof msg.id !== "string" || typeof msg.url !== "string") {
            return send(socket, { type: "error", error: "bad_browser_open" });
          }
          const appId = typeof msg.appId === "string" && msg.appId.trim() ? msg.appId.trim() : undefined;
          const browser = room.browsers.open(msg.id, msg.url, peerId, appId);
          room.broadcast({ type: "browser", browser });
          return;
        }
        case "browser_navigate": {
          if (typeof msg.id !== "string" || typeof msg.url !== "string") {
            return send(socket, { type: "error", error: "bad_browser_navigate" });
          }
          const browser = room.browsers.navigate(msg.id, msg.url);
          if (!browser) return;
          room.broadcast({ type: "browser", browser });
          return;
        }
        case "browser_close": {
          if (typeof msg.id !== "string") {
            return send(socket, { type: "error", error: "missing_id" });
          }
          const ok = room.browsers.close(msg.id);
          if (ok) {
            room.broadcast({ type: "browser_closed", id: msg.id });
            void notifyBrowserHostCloseTab(slug, msg.id);
          }
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
          if (room.windows.open(msg.id)) {
            room.broadcast({ type: "window_opened", id: msg.id });
          }
          return;
        }
        case "window_close": {
          if (typeof msg.id !== "string") {
            return send(socket, { type: "error", error: "missing_id" });
          }
          if (room.windows.close(msg.id)) {
            room.broadcast({ type: "window_closed", id: msg.id });
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
          const next = room.music.set({
            src: typeof msg.src === "string" ? msg.src : null,
            index: msg.index,
            playing: !!msg.playing,
            position: msg.position,
            at: msg.at,
            volume: incomingVolume ?? room.music.cachedVolume() ?? 0.7,
          });
          room.broadcast({ type: "music_state", state: next });
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
          const result = room.chess.createGame({
            whiteKey: msg.whiteKey,
            blackKey: msg.blackKey,
            whiteLabel: typeof msg.whiteLabel === "string" ? msg.whiteLabel : msg.whiteKey,
            blackLabel: typeof msg.blackLabel === "string" ? msg.blackLabel : msg.blackKey,
          });
          if (!result.ok) return send(socket, { type: "error", error: result.error });
          broadcastChessState(room, result.game);
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
          const result = room.chess.applyMove(callerKey, {
            from: msg.from,
            to: msg.to,
            promotion: typeof msg.promotion === "string" ? msg.promotion : undefined,
          });
          if (!result.ok) return send(socket, { type: "error", error: result.error });
          broadcastChessState(room, result.game);
          if (result.ended) {
            room.broadcast({ type: "chess_history", history: room.chess.getHistory() });
          }
          return;
        }
        case "chess_resign": {
          const callerKey = (info.address ?? info.handle ?? info.id).toLowerCase();
          const result = room.chess.resign(callerKey);
          if (!result.ok) return send(socket, { type: "error", error: result.error });
          broadcastChessState(room, result.game);
          room.broadcast({ type: "chess_history", history: room.chess.getHistory() });
          return;
        }
        case "chess_close_game": {
          // Any peer can clear the chess slot — finished or active.
          // Clearing an active game is an "abort" (no winner recorded,
          // nothing appended to history). Same any-peer-can-close model
          // as the rest of the singleton windows.
          room.chess.clearGame();
          broadcastChessState(room, null);
          return;
        }
        case "tx_request": {
          // Forward the captured impersonator tx to every peer so they all see
          // the same calldata. We don't validate or store — this is just a
          // shared notification surface.
          if (typeof msg.browserId !== "string" || typeof msg.calldata !== "string") {
            return send(socket, { type: "error", error: "bad_tx_request" });
          }
          room.broadcast({
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
        case "tx_forward": {
          // Directed delivery: SharedBrowser captured a tx and the impersonated
          // address belongs to a specific connected peer's wallet. Forward to
          // that peer so they can sign+broadcast with their own wagmi wallet.
          // We don't validate the payload — receiver decides whether to act.
          if (typeof msg.to !== "string" || typeof msg.browserId !== "string" || typeof msg.method !== "string") {
            return send(socket, { type: "error", error: "bad_tx_forward" });
          }
          const ok = sendTo(msg.to, {
            type: "tx_forward",
            from: peerId,
            fromAddress: info.address ?? null,
            fromHandle: info.handle ?? null,
            id: typeof msg.id === "string" ? msg.id : `${peerId}-${Date.now()}`,
            browserId: msg.browserId,
            method: msg.method,
            params: Array.isArray(msg.params) ? msg.params : [],
            chainId: typeof msg.chainId === "number" ? msg.chainId : null,
          });
          if (!ok) send(socket, { type: "error", error: "peer_not_found", to: msg.to });
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
            typeof rec.deployer !== "string" ||
            typeof rec.salt !== "string" ||
            typeof rec.threshold !== "number" ||
            !Array.isArray(rec.signers) ||
            !rec.deployments ||
            typeof rec.deployments !== "object"
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
          const deployments: Record<number, { txHash: string | null; deployedAt: number }> = {};
          for (const [k, v] of Object.entries(rec.deployments)) {
            const chainId = Number(k);
            if (!Number.isFinite(chainId)) continue;
            if (!v || typeof v !== "object") continue;
            const dep = v as { txHash?: unknown; deployedAt?: unknown };
            deployments[chainId] = {
              txHash: typeof dep.txHash === "string" ? dep.txHash : null,
              deployedAt: typeof dep.deployedAt === "number" ? dep.deployedAt : Date.now(),
            };
          }
          if (Object.keys(deployments).length === 0) {
            return send(socket, { type: "error", error: "no_deployments" });
          }
          room.wallet.setCurrent({
            id: typeof rec.id === "string" ? rec.id : Math.random().toString(36).slice(2),
            address: rec.address.toLowerCase(),
            deployer: rec.deployer.toLowerCase(),
            salt: rec.salt,
            signers,
            threshold: rec.threshold,
            deployments,
            createdAt: typeof rec.createdAt === "number" ? rec.createdAt : Date.now(),
            label: typeof rec.label === "string" ? rec.label : `Episode ${new Date().toISOString().slice(0, 10)}`,
          });
          return;
        }
        case "wallet_add_deployment": {
          // Record a deployment of the current wallet on an additional
          // chain. The client computed the deploy tx + chain themselves
          // and confirmed the receipt; we just persist the entry so
          // every peer sees the same set of chains.
          const chainId = typeof msg.chainId === "number" ? msg.chainId : null;
          const txHash = typeof msg.txHash === "string" ? msg.txHash : null;
          if (chainId === null || !Number.isFinite(chainId)) {
            return send(socket, { type: "error", error: "bad_chain_id" });
          }
          const updated = room.wallet.addDeployment(chainId, txHash);
          if (!updated) return send(socket, { type: "error", error: "no_wallet" });
          return;
        }
        case "wallet_new_episode": {
          // Archive `current` and let the deploy flow surface again.
          room.wallet.archiveCurrent();
          return;
        }
        case "wallet_draft_update": {
          // Collaborative pre-deploy form state. Anyone in the room may
          // edit; the host is the only one who can ultimately submit the
          // deploy (enforced client-side and implicitly by which wallet
          // signs createMultisig). Sending null clears the draft.
          const d = msg.draft;
          if (d === null || d === undefined) {
            room.wallet.setDraft(null);
            return;
          }
          if (typeof d !== "object") return send(socket, { type: "error", error: "bad_draft" });
          const draft = d as Partial<import("./wallet.js").WalletDraft>;
          if (
            typeof draft.selected !== "object" ||
            draft.selected === null ||
            typeof draft.threshold !== "number" ||
            typeof draft.label !== "string" ||
            !Array.isArray(draft.customSigners)
          ) {
            return send(socket, { type: "error", error: "bad_draft" });
          }
          // Normalize: lowercased addresses, bounded sizes.
          const selected: Record<string, boolean> = {};
          for (const [k, v] of Object.entries(draft.selected)) {
            if (typeof k === "string" && /^0x[a-f0-9]{40}$/i.test(k)) {
              selected[k.toLowerCase()] = !!v;
            }
          }
          const customSigners = draft.customSigners
            .filter((c): c is { address: string; label: string } =>
              !!c && typeof c.address === "string" && /^0x[a-f0-9]{40}$/i.test(c.address) && typeof c.label === "string",
            )
            .map(c => ({ address: c.address.toLowerCase(), label: c.label.slice(0, 60) }))
            .slice(0, 50);
          room.wallet.setDraft({
            selected,
            threshold: Math.max(1, Math.min(50, Math.floor(draft.threshold))),
            label: draft.label.slice(0, 100),
            customSigners,
          });
          return;
        }
        case "wallet_tx_propose": {
          const cur = room.wallet.getCurrent();
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
          // chainId is now per-tx, not per-wallet — the client tells us
          // which chain it's executing on. Fall back to a deployment we
          // know exists when older clients send no chainId field.
          const incomingChainId = typeof msg.chainId === "number" ? msg.chainId : null;
          const fallbackChain = Number(Object.keys(cur.deployments)[0] ?? "0");
          const chainId = incomingChainId ?? fallbackChain;
          if (!Number.isFinite(chainId) || chainId === 0) {
            return send(socket, { type: "error", error: "no_chain" });
          }
          const tx = room.wallet.proposeTx({
            multisigAddress: cur.address,
            chainId,
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
            chainId,
            multisigAddress: cur.address,
            target: tx.target,
            value: tx.value,
            data: tx.data,
          }).then(summary => room.wallet.setTxSummary(tx.id, summary));
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
          room.wallet.addSignature(msg.id, {
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
          room.wallet.setTxStatus(msg.id, msg.status as WalletTx["status"], typeof msg.txHash === "string" ? msg.txHash : null);
          return;
        }
        case "wallet_tx_remove": {
          if (typeof msg.id !== "string") return;
          room.wallet.removeTx(msg.id);
          return;
        }
        case "wallet_tx_resummarize": {
          if (typeof msg.id !== "string") return;
          const tx = room.wallet.findTx(msg.id);
          const cur = room.wallet.getCurrent();
          if (!tx || !cur) return;
          void summarizeTransaction({
            chainId: tx.chainId,
            multisigAddress: cur.address,
            target: tx.target,
            value: tx.value,
            data: tx.data,
          }).then(summary => room.wallet.setTxSummary(tx.id, summary));
          return;
        }
        default:
          send(socket, { type: "error", error: "unknown_type" });
      }
    });

    socket.on("close", () => {
      const ended = room.desktop.clearPeerPublications(peerId);
      room.removePeer(peerId);
      for (const p of ended) {
        room.broadcast({ type: "unpublished", peerId, streamId: p.streamId });
      }
      room.broadcast({ type: "peer_leave", peer: info });
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
    // human interacts. Only resumes the main room on boot — other rooms
    // are loaded lazily on first WS connect, and resume their own
    // chess state at that time via the Room constructor + ChessState
    // load. If we ever need to resume every persistent room on boot
    // we'd glob the .slop-data/rooms dir here.
    const mainRoom = getOrCreateRoom(DEFAULT_SLUG);
    const resumed = mainRoom.chess.getCurrentGame();
    if (resumed && resumed.status === "active") {
      broadcastChessState(mainRoom, resumed);
    }
  })
  .catch(err => {
    app.log.error(err);
    process.exit(1);
  });

// Clean shutdown on systemd's SIGTERM. The key insight: Fastify's
// `app.close()` waits for HTTP requests to drain, but it does NOT
// proactively close upgraded WebSocket connections. With ~tens of
// long-lived peer + fanout WS connections, app.close() would never
// resolve and systemd's 90s TimeoutStopSec would fire — three full
// minutes of "icons gone" during a deploy as systemd waited, then
// SIGKILLed, then started the new process. Explicit terminate of
// every WS first, then app.close(), then a force-exit safety net.
const cleanShutdown = (signal: NodeJS.Signals) => {
  app.log.info(`received ${signal} — stopping fanouts + terminating peers`);
  shutdownAllFanouts();
  closeAllPeers();
  // Safety net: if app.close() still hangs (some other long-lived
  // resource we don't know about), force-exit after 3s. `.unref()`
  // means this timeout itself doesn't keep the event loop alive —
  // so on a clean shutdown the process exits naturally below and
  // the timeout never fires.
  setTimeout(() => {
    app.log.warn("graceful shutdown exceeded 3s — force-exiting");
    process.exit(0);
  }, 3000).unref();
  app.close().finally(() => process.exit(0));
};
process.on("SIGTERM", cleanShutdown);
process.on("SIGINT", cleanShutdown);

// Per-room state for live.slop.computer/<slug>. Each room is an
// isolated environment — its own peers, chess game, wallet, files, etc.
// A handful of feeds (ticker, news, glossary) remain process-global and
// fan out to every hot room.
//
// Phase 1b: Room owns its peers Map and a per-room broadcast() method.
// peers.ts is now a compatibility shim that delegates to the DEFAULT_SLUG
// room (and iterates all rooms for cross-room ops like kick/find/close).
// See ops/PLAN-rooms.md.

import type { Peer, PeerInfo } from "./peers.js";
import { AIMover } from "./ai-mover.js";
import { BrowserRegistry } from "./browsers.js";
import { ChatHistory } from "./chat.js";
import { ChessState } from "./chess.js";
import { Clock } from "./clock.js";
import { config } from "./config.js";
import { DesktopState } from "./desktop.js";
import { EpisodeFlags } from "./episode.js";
import { FileIndex } from "./files.js";
import { JAMENDO_DIR, JamendoRoomState } from "./jamendo.js";
import { MusicState } from "./music-state.js";
import { NoteList } from "./notes.js";
import { RoomAuth } from "./room-auth.js";
import { RoomMeta } from "./room-meta.js";
import { TodoList } from "./todos.js";
import { Transcript } from "./transcript.js";
import { WalletState } from "./wallet.js";
import { WindowSet } from "./windows.js";
import { send } from "./ws-send.js";

// Mirrors the on-chain SlopComputer contract's slug rule
// (`^[a-z0-9-]{1,64}$`). The relay never reads the contract — the
// frontend hands us validated slugs — but we enforce the regex locally
// for consistency and to reject filesystem-path tricks once slugs land
// in `.slop-data/rooms/<slug>/...` (Phase 4).
const SLUG_REGEX = /^[a-z0-9-]{1,64}$/;

// Sandbox room used for debugging + the pre-Phase-3 fallback. Always-on
// (via HOST_WHITELIST), no password required, and inherits the pre-
// per-room-refactor legacy data files. Real episodes live at claimed
// slugs like /ep0; visitors who hit an unknown slug bounce to
// slop.computer rather than landing here.
export const DEFAULT_SLUG = "debug";

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}

export function parseSlug(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_SLUG;
  return isValidSlug(raw) ? raw : DEFAULT_SLUG;
}

/** Per-room subsystem paths. Each subsystem class takes its own canonical
 *  per-room file path plus an optional legacy global path that only the
 *  `"main"` room is allowed to inherit from. This lets the 1d/4 refactor
 *  ship without orphaning the pre-room-aware production data sitting at
 *  the legacy paths.
 *
 *  Legacy paths must match the file constants that were defined in each
 *  subsystem module before this refactor — keep them in sync if you
 *  rename or relocate the canonical files. */
type SubsystemPath = { path: string; legacy: string | null };

function roomPaths(id: string): {
  todos: SubsystemPath;
  notes: SubsystemPath;
  windows: SubsystemPath;
  episode: SubsystemPath;
  clock: SubsystemPath;
  chat: SubsystemPath;
  transcript: SubsystemPath;
  jamendo: { path: string; legacyState: string | null; legacyCustom: string | null };
  files: {
    blobsDir: string;
    metadataFile: string;
    legacyBlobsDir: string | null;
    legacyMetadataFile: string | null;
  };
  browsers: { path: string; legacyPath: string | null; legacyHostKey: string | null };
  desktop: { slotsFile: string; legacySlotsFile: string | null; legacyHostKey: string | null };
  chess: SubsystemPath;
  wallet: SubsystemPath;
  auth: { path: string };
  meta: { path: string };
} {
  const dir = `./.slop-data/rooms/${id}`;
  const legacy = id === DEFAULT_SLUG;
  return {
    todos: {
      path: `${dir}/todos.json`,
      legacy: legacy ? (process.env.TODOS_FILE ?? "./.slop-data/todos.json") : null,
    },
    notes: {
      path: `${dir}/notes.json`,
      legacy: legacy ? (process.env.NOTES_FILE ?? "./.slop-data/notes.json") : null,
    },
    windows: {
      path: `${dir}/windows.json`,
      legacy: legacy ? (process.env.WINDOWS_PATH ?? "/var/lib/slop-relay/windows.json") : null,
    },
    episode: {
      path: `${dir}/episode.json`,
      legacy: legacy ? (process.env.EPISODE_STATE_FILE ?? "./.slop-data/episode.json") : null,
    },
    clock: {
      path: `${dir}/clock.json`,
      legacy: legacy ? (process.env.CLOCK_STATE_FILE ?? "./.slop-data/clock-state.json") : null,
    },
    chat: {
      path: `${dir}/chat.jsonl`,
      legacy: legacy ? (process.env.CHAT_LOG_FILE ?? "./.slop-data/chat.jsonl") : null,
    },
    transcript: {
      path: `${dir}/transcript.jsonl`,
      legacy: legacy ? (process.env.TRANSCRIPT_LOG_FILE ?? "./.slop-data/transcript.jsonl") : null,
    },
    jamendo: {
      path: `${dir}/jamendo.json`,
      legacyState: legacy ? `${JAMENDO_DIR}/state.json` : null,
      legacyCustom: legacy ? `${JAMENDO_DIR}/custom-playlist.json` : null,
    },
    files: {
      blobsDir: `${dir}/files`,
      metadataFile: `${dir}/files.json`,
      legacyBlobsDir: legacy ? (process.env.FILES_DIR ?? "./.slop-data/files") : null,
      legacyMetadataFile: legacy ? `${process.env.FILES_DIR ?? "./.slop-data/files"}/files.json` : null,
    },
    browsers: {
      path: `${dir}/browsers.json`,
      legacyPath: legacy ? (process.env.BROWSERS_PATH ?? "/var/lib/slop-relay/browsers.json") : null,
      // Pre-Phase-1d browsers were bucketed by lowercased host address.
      legacyHostKey: legacy ? (config.adminAddresses[0]?.toLowerCase() ?? null) : null,
    },
    desktop: {
      slotsFile: `${dir}/slots.json`,
      legacySlotsFile: legacy ? (process.env.SLOT_PATH ?? "/var/lib/slop-relay/slots.json") : null,
      legacyHostKey: legacy ? (config.adminAddresses[0]?.toLowerCase() ?? null) : null,
    },
    chess: {
      path: `${dir}/chess.json`,
      legacy: legacy ? (process.env.CHESS_PATH ?? "/var/lib/slop-relay/chess.json") : null,
    },
    wallet: {
      path: `${dir}/wallet.json`,
      legacy: legacy ? (process.env.WALLET_FILE ?? "./.slop-data/wallet.json") : null,
    },
    auth: {
      path: `${dir}/auth.json`,
    },
    meta: {
      path: `${dir}/meta.json`,
    },
  };
}

export class Room {
  readonly id: string;

  /** Persisted room metadata: paidUntil, lastSeenAt, createdAt, name.
   *  Field access goes through room.meta.* — the bare `paidUntil` and
   *  `lastSeenAt` properties on Room are gone in Phase 7 to avoid
   *  drift between in-memory and on-disk state. */
  readonly meta: RoomMeta;

  private peers = new Map<string, Peer>();

  readonly todos: TodoList;
  readonly notes: NoteList;
  readonly windows: WindowSet;
  readonly episode: EpisodeFlags;
  readonly clock: Clock;
  readonly chat: ChatHistory;
  readonly transcript: Transcript;
  readonly jamendo: JamendoRoomState;
  readonly files: FileIndex;
  readonly browsers: BrowserRegistry;
  readonly desktop: DesktopState;
  readonly music = new MusicState();
  readonly chess: ChessState;
  readonly aiMover: AIMover;
  readonly wallet: WalletState;
  readonly auth: RoomAuth;

  constructor(id: string) {
    if (!isValidSlug(id)) {
      throw new Error(`Invalid slug: ${JSON.stringify(id)}`);
    }
    this.id = id;

    const paths = roomPaths(id);
    this.meta = new RoomMeta(paths.meta.path, id);
    this.todos = new TodoList(paths.todos.path, paths.todos.legacy);
    this.notes = new NoteList(paths.notes.path, paths.notes.legacy);
    this.windows = new WindowSet(paths.windows.path, paths.windows.legacy);
    this.episode = new EpisodeFlags(paths.episode.path, paths.episode.legacy);
    this.clock = new Clock(paths.clock.path, paths.clock.legacy);
    this.chat = new ChatHistory(paths.chat.path, paths.chat.legacy);
    this.transcript = new Transcript(paths.transcript.path, paths.transcript.legacy);
    this.jamendo = new JamendoRoomState(paths.jamendo.path, paths.jamendo.legacyState, paths.jamendo.legacyCustom);
    this.files = new FileIndex(
      paths.files.blobsDir,
      paths.files.metadataFile,
      paths.files.legacyBlobsDir,
      paths.files.legacyMetadataFile,
      config.ipfsApiUrl || null,
    );
    this.browsers = new BrowserRegistry(
      paths.browsers.path,
      paths.browsers.legacyPath,
      paths.browsers.legacyHostKey,
    );
    this.desktop = new DesktopState(
      paths.desktop.slotsFile,
      paths.desktop.legacySlotsFile,
      paths.desktop.legacyHostKey,
    );
    this.chess = new ChessState(paths.chess.path, paths.chess.legacy);
    this.aiMover = new AIMover(this.chess);
    this.wallet = new WalletState(paths.wallet.path, paths.wallet.legacy);
    this.auth = new RoomAuth(paths.auth.path);

    // Wire subsystem mutation events into this room's broadcast.
    // Windows has no subscriber — its callers broadcast inline because
    // they need to send distinct `window_opened` vs `window_closed`
    // events, not a full-list refresh.
    this.todos.subscribe(items => this.broadcast({ type: "todos", items }));
    this.notes.subscribe(items => this.broadcast({ type: "notes", items }));
    this.episode.subscribe(state => this.broadcast({ type: "episode", state }));
    this.clock.subscribe(state => this.broadcast({ type: "clock_state", state }));
    this.chat.subscribe(msg => this.broadcast({ type: "chat", msg }));
    this.jamendo.subscribe(event => this.broadcast({ type: "music_genre", genre: event.genre }));
    this.jamendo.subscribeCustom(tracks => this.broadcast({ type: "music_custom", tracks }));
    this.files.subscribe(event => {
      if (event.type === "added") this.broadcast({ type: "file_added", item: event.item });
      else if (event.type === "removed") this.broadcast({ type: "file_removed", id: event.id });
      else this.broadcast({ type: "files", items: event.items });
    });
    this.wallet.subscribe(state => {
      this.broadcast({
        type: "wallet",
        current: state.current,
        history: state.history,
        draft: state.draft,
      });
      this.broadcast({ type: "wallet_txs", txs: state.txs });
    });
  }

  touch(): void {
    this.meta.touchLastSeen();
  }

  addPeer(peer: Peer): void {
    this.peers.set(peer.id, peer);
    this.touch();
  }

  removePeer(id: string): void {
    this.peers.delete(id);
  }

  getPeer(id: string): Peer | undefined {
    return this.peers.get(id);
  }

  listPeers(): PeerInfo[] {
    return [...this.peers.values()].map(({ ws: _ws, sessionToken: _t, ...info }) => info);
  }

  allPeers(): Iterable<Peer> {
    return this.peers.values();
  }

  clearPeers(): void {
    this.peers.clear();
  }

  peerCount(): number {
    return this.peers.size;
  }

  broadcast(msg: unknown, exceptId?: string): void {
    for (const [id, peer] of this.peers) {
      if (exceptId && id === exceptId) continue;
      send(peer.ws, msg);
    }
  }

  /** Direct in-room send to a specific peer. Returns false if the peer
   *  isn't in this room (caller can fall back to a cross-room lookup
   *  for things like tx_forward where targets may be in other rooms). */
  sendTo(targetId: string, msg: unknown): boolean {
    const peer = this.peers.get(targetId);
    if (!peer) return false;
    send(peer.ws, msg);
    return true;
  }
}

const rooms = new Map<string, Room>();

export function getOrCreateRoom(slug: string): Room {
  let room = rooms.get(slug);
  if (!room) {
    room = new Room(slug);
    rooms.set(slug, room);
  }
  return room;
}

export function getRoom(slug: string): Room | undefined {
  return rooms.get(slug);
}

export function listRooms(): Room[] {
  return [...rooms.values()];
}

/** Linear scan to find which Room (if any) holds a peer. Used by
 *  cross-room cleanup paths — e.g. when a new connection finds a stale
 *  peer with the same session token in some other room and needs to
 *  emit the peer_leave broadcast to *that* room, not the new one. */
export function findPeerRoom(peerId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.getPeer(peerId)) return room;
  }
  return undefined;
}

/**
 * Drop a room's in-memory slice. Persistent state (todos.json,
 * wallet.json, etc.) stays on disk and lazy-loads on the next
 * `getOrCreateRoom(slug)`. Use this for the hibernation path (Phase 7);
 * the room directory itself is never deleted.
 *
 * Caller is responsible for any external-side cleanup (e.g. POSTing
 * to browser-host's /admin/rooms/:slug/close so the BrowserContext
 * gets torn down too). We don't reach out from here because room.ts
 * has no business knowing about HTTP clients.
 */
export function hibernateRoom(slug: string): boolean {
  const room = rooms.get(slug);
  if (!room) return false;
  if (room.peerCount() > 0) return false; // refuse to hibernate a room with live peers
  room.meta.flush();
  rooms.delete(slug);
  return true;
}

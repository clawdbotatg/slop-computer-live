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
import { RoomApps } from "./apps.js";
import { BrowserRegistry } from "./browsers.js";
import { ChatHistory } from "./chat.js";
import { ChessState } from "./chess.js";
import { Clock } from "./clock.js";
import { config } from "./config.js";
import { DesktopState } from "./desktop.js";
import { EpisodeFlags } from "./episode.js";
import { FileIndex } from "./files.js";
import { Chyron } from "./chyron.js";
import { JAMENDO_DIR, JamendoRoomState } from "./jamendo.js";
import { MusicState } from "./music-state.js";
import { NoteList } from "./notes.js";
import { Participants } from "./participants.js";
import { Pong } from "./pong.js";
import { PreviewMedia } from "./preview-media.js";
import { ScrollSync } from "./scroll-sync.js";
import { UIState } from "./ui-state.js";
import { QrState } from "./qr-state.js";
import { ResearchState } from "./research-state.js";
import { RoomAuth } from "./room-auth.js";
import { WalletChatState } from "./wallet-chat.js";
import { RoomMeta } from "./room-meta.js";
import { TodoList } from "./todos.js";
import { Transcript } from "./transcript.js";
import { formatBytes, ownerKeyActor } from "./transcript-actions.js";
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

/** Stable id used to key per-speaker arbitration: lowercased address
 *  for signed-in users, anonId for anon peers, null if neither is
 *  available (in which case we can't track the speaker — they bypass
 *  arbitration and always get the god-mode lane). */
export function liveCaptionKey(peer: { address?: string | null; anonId?: string | null } | undefined): string | null {
  if (!peer) return null;
  if (peer.address) return peer.address.toLowerCase();
  if (peer.anonId) return peer.anonId;
  return null;
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
  participants: { path: string };
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
  research: { path: string };
  walletChat: { path: string };
  auth: { path: string };
  meta: { path: string };
  chyron: { path: string };
  apps: { path: string };
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
    participants: {
      path: `${dir}/participants.jsonl`,
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
    research: {
      // No legacy path — guest-research never persisted before, so the
      // DEFAULT_SLUG room has nothing to inherit. Cold start = empty.
      path: `${dir}/research.json`,
    },
    walletChat: {
      // No legacy path — the AI wallet chat was per-iframe localStorage
      // before this port, never relay-persisted. Cold start = empty.
      path: `${dir}/wallet-chat.json`,
    },
    auth: {
      path: `${dir}/auth.json`,
    },
    meta: {
      path: `${dir}/meta.json`,
    },
    chyron: {
      // No legacy path — the on-screen chyron shipped post-room-refactor,
      // there's nothing global to inherit. Cold start = empty string.
      path: `${dir}/chyron.json`,
    },
    apps: {
      // No legacy path — per-room apps are a new concept; the global
      // catalog (DEFAULT_APPS + hot-apps.json) is unaffected and stays
      // global. Cold start = no room-scoped apps.
      path: `${dir}/apps.json`,
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

  /** Ephemeral: the inner size of the active god-mode streaming session's
   *  browser window. Spectators broadcast `god_viewport` on resize and we
   *  fan it out so every client can draw a dashed rectangle showing where
   *  the live-capture frame ends. Last-write-wins if multiple spectators
   *  are connected; cleared when the last spectator leaves. */
  private godViewport: { width: number; height: number } | null = null;

  /** Per-speaker live-caption arbitration. Speakers running browser STT
   *  (useLiveTranscript) emit `live_caption_state {alive}` on connect
   *  and on recognizer error/recovery. When alive=true we suppress the
   *  god-mode `transcript_seg` broadcast for that speaker — their
   *  in-browser captions are 3-5s faster than Whisper, so showing both
   *  would double-display. The god-mode segment still gets archived as
   *  the canonical transcript; only the live overlay is swapped.
   *
   *  Keyed by stable speaker id (address.toLowerCase() ?? anonId).
   *  ABSENT entry = "dead/unknown, broadcast god-mode" — that's the
   *  Firefox / no-Web-Speech default. Cleared on peer disconnect so
   *  rejoin re-evaluates. */
  private liveCaptionAlive = new Map<string, boolean>();

  // Cursors for chess→transcript narration (driven from broadcastChessState
  // in index.ts, the one chokepoint all chess state changes pass through —
  // human moves, AI moves, resigns, aborts). `narratedMoves` is how many of
  // the game's SAN moves we've already considered; `narratedEnd` guards the
  // single game-over line against the recursive AI broadcast cycle.
  chessNarratedMoves = 0;
  chessNarratedEnd = false;
  // Tx ids already narrated, so a double-click (proposeTx collapses onto the
  // same execHash and returns the existing tx) doesn't log twice.
  readonly narratedTxIds = new Set<string>();

  readonly todos: TodoList;
  readonly notes: NoteList;
  readonly windows: WindowSet;
  readonly episode: EpisodeFlags;
  readonly clock: Clock;
  readonly chat: ChatHistory;
  readonly transcript: Transcript;
  readonly participants: Participants;
  readonly jamendo: JamendoRoomState;
  readonly files: FileIndex;
  readonly browsers: BrowserRegistry;
  readonly desktop: DesktopState;
  readonly music = new MusicState();
  readonly pong = new Pong();
  readonly research: ResearchState;
  readonly qr = new QrState();
  readonly previewMedia = new PreviewMedia();
  readonly scrollSync = new ScrollSync();
  readonly uiState = new UIState();
  readonly chess: ChessState;
  readonly aiMover: AIMover;
  readonly wallet: WalletState;
  readonly walletChat: WalletChatState;
  readonly auth: RoomAuth;
  readonly chyron: Chyron;
  readonly apps: RoomApps;

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
    this.participants = new Participants(paths.participants.path);
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
    this.walletChat = new WalletChatState(paths.walletChat.path);
    this.research = new ResearchState(paths.research.path);
    this.auth = new RoomAuth(paths.auth.path);
    this.chyron = new Chyron(paths.chyron.path);
    this.apps = new RoomApps(paths.apps.path);

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
    this.research.subscribe(state => this.broadcast({ type: "research_state", state }));
    this.walletChat.subscribe(state => this.broadcast({ type: "wallet_chat", state }));
    this.chyron.subscribe(state => this.broadcast({ type: "chyron", state }));
    // Live transcript fan-out to mesh peers. Previously the desktop's
    // TranscriptWindow polled /v1/transcript every 1.5s — fine for the
    // archive view but too slow to drive on-screen subtitle captions.
    // Pushing every new segment on the WS lets the SubtitleCaption
    // surface a line within ~50ms of Whisper returning.
    //
    // BUT: skip the broadcast when the speaker is currently driving
    // their own captions via browser STT (`live_caption` frames). The
    // god-mode segment still lands in the archive (above the subscribe
    // call) — we just don't paint it as a live caption when the faster
    // in-browser version already did. `transcript_seg` consumers like
    // TranscriptWindow re-read the archive via /v1/transcript, so no
    // viewer feature breaks from the suppression.
    this.transcript.subscribe(seg => {
      // Action rows (music/file/wallet/chess/pong) live in the archive and
      // the polled TranscriptWindow only — never flash them as an on-screen
      // subtitle caption; that overlay stays reserved for actual speech.
      if (seg.kind && seg.kind !== "speech") return;
      const speakerKey = seg.address ?? seg.anonId ?? null;
      if (speakerKey && this.liveCaptionAlive.get(speakerKey) === true) return;
      this.broadcast({ type: "transcript_seg", seg });
    });
    this.qr.subscribe(state => this.broadcast({ type: "qr_state", state }));
    // Narrate a pong win once, on the null→winner edge. `lastPongWinner`
    // resets when the snapshot goes back to no-winner (reset / new match) so
    // the next decisive game logs again. The 30Hz physics ticks re-broadcast
    // the same `winner` until reset — the edge check keeps it to one line.
    let lastPongWinner: "left" | "right" | null = null;
    this.pong.subscribe(state => {
      this.broadcast({ type: "pong_state", state });
      if (state.winner && state.winner !== lastPongWinner) {
        lastPongWinner = state.winner;
        const seat = state.seats[state.winner];
        const winScore = state.winner === "left" ? state.score.left : state.score.right;
        const loseScore = state.winner === "left" ? state.score.right : state.score.left;
        if (seat) {
          this.transcript.appendAction({
            kind: "pong",
            ...ownerKeyActor(seat.ownerKey, seat.handle),
            text: `🏓 ${seat.handle} won pong ${winScore}–${loseScore}`,
            meta: { winner: seat.handle, scoreLeft: state.score.left, scoreRight: state.score.right },
          });
        }
      } else if (!state.winner) {
        lastPongWinner = null;
      }
    });
    this.previewMedia.subscribe(event =>
      this.broadcast({ type: "preview_media", fileId: event.fileId, state: event.state }),
    );
    this.scrollSync.subscribe(event =>
      this.broadcast({ type: "scroll_sync", key: event.key, state: event.state }),
    );
    this.uiState.subscribe(event =>
      this.broadcast({ type: "ui_state", key: event.key, state: event.state }),
    );
    this.files.subscribe(event => {
      if (event.type === "added") {
        this.broadcast({ type: "file_added", item: event.item });
        // `added` fires twice per upload: once on add, again when the
        // background IPFS pin stamps `cid`. Narrate only the first.
        if (!event.item.cid) {
          const it = event.item;
          this.transcript.appendAction({
            kind: "file",
            ...ownerKeyActor(it.ownerKey, it.uploaderLabel),
            text: `📎 ${it.uploaderLabel} uploaded ${it.name} (${formatBytes(it.size)})`,
            meta: { name: it.name, mime: it.mime, size: it.size },
          });
        }
      } else if (event.type === "removed") this.broadcast({ type: "file_removed", id: event.id });
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
    // Spectators are god-mode streaming sessions, not actual participants —
    // they're filtered out of the visible guest list elsewhere and shouldn't
    // appear in the manifest either. Anon peers are recorded by anonId so the
    // custom name they set lights up on the post-show participant list.
    if (!peer.spectator && (peer.role === "host" || peer.role === "guest")) {
      this.participants.record({
        address: peer.address,
        anonId: peer.anonId,
        handle: peer.handle,
        role: peer.role,
      });
    }
  }

  removePeer(id: string): void {
    const peer = this.peers.get(id);
    const wasSpectator = peer?.spectator === true;
    // Clear live-caption arbitration for this speaker so a rejoin
    // re-evaluates from scratch — matches the "sticky until rejoin"
    // rule we agreed on. If another peer in the room shares the same
    // stable id (same address signed in on two devices), the second
    // peer's next live_caption_state will repopulate the entry.
    const speakerKey = liveCaptionKey(peer);
    if (speakerKey) this.liveCaptionAlive.delete(speakerKey);
    // Free any pong seat held by the disconnecting peer so the lobby
    // reopens instead of locking out the next joiner. Same key scheme
    // the chess + cursors handlers use: address > handle > peerId.
    if (peer) {
      const peerOwnerKey = (peer.address ?? peer.handle ?? peer.id).toLowerCase();
      this.pong.release(peerOwnerKey);
    }
    this.peers.delete(id);
    // No spectators left → drop the god-mode viewport hint and tell
    // everyone, so the dashed rectangle disappears for surviving peers.
    if (wasSpectator && this.godViewport !== null) {
      const stillHasSpectator = [...this.peers.values()].some(p => p.spectator);
      if (!stillHasSpectator) {
        this.godViewport = null;
        this.broadcast({ type: "god_viewport", viewport: null });
      }
    }
  }

  setLiveCaptionAlive(speakerKey: string, alive: boolean): void {
    if (alive) this.liveCaptionAlive.set(speakerKey, true);
    else this.liveCaptionAlive.set(speakerKey, false);
  }

  getGodViewport(): { width: number; height: number } | null {
    return this.godViewport;
  }

  setGodViewport(v: { width: number; height: number } | null): void {
    const prev = this.godViewport;
    if (
      (prev === null && v === null) ||
      (prev !== null && v !== null && prev.width === v.width && prev.height === v.height)
    ) {
      return;
    }
    this.godViewport = v;
    this.broadcast({ type: "god_viewport", viewport: v });
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

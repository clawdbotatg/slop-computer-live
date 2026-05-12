"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const RELAY_WS_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? "ws://slop.computer/signal";
const RELAY_HTTP_URL = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// Fallback when our relay's TURN server isn't reachable yet — STUN-only.
// This works for same-NAT testing but fails on symmetric NATs.
const FALLBACK_ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

type TurnCreds = {
  username: string;
  credential: string;
  ttl: number;
  urls: string[];
};

let cachedTurn: { config: RTCConfiguration; expiresAt: number } | null = null;

async function fetchIceConfig(): Promise<RTCConfiguration> {
  // Reuse if still valid (refresh 60s before expiry).
  if (cachedTurn && cachedTurn.expiresAt > Date.now() + 60_000) {
    return cachedTurn.config;
  }
  try {
    const res = await fetch(`${RELAY_HTTP_URL}/turn/credentials`, { credentials: "include" });
    if (!res.ok) return FALLBACK_ICE;
    const data = (await res.json()) as TurnCreds;
    const config: RTCConfiguration = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: data.urls,
          username: data.username,
          credential: data.credential,
        },
      ],
    };
    cachedTurn = { config, expiresAt: Date.now() + data.ttl * 1000 };
    return config;
  } catch {
    return FALLBACK_ICE;
  }
}

const PING_INTERVAL_MS = 25_000;
const CURSOR_THROTTLE_MS = 33; // ~30hz
const RECONNECT_DELAY_MS = 2000;

export type Peer = {
  id: string;
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
  connectedAt?: number;
};

export type SlotKind = "camera" | "screen" | "audio";

export type Publication = {
  streamId: string;
  peerId: string; // ephemeral
  ownerKey: string; // stable across reconnects (wallet address or handle)
  kind: SlotKind;
  label: string;
};

export type SlotPosition = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
};

type CursorData = {
  x: number;
  y: number;
  /** Optional inline identity — present when the source is an HTTP agent
   *  that isn't a registered WS peer. Used to render label + blockie
   *  colors without a peers-list lookup. */
  address?: string | null;
  handle?: string | null;
};

export type ClickEvent = {
  /** Monotonic id used as React key + for cleanup. Local-only. */
  id: number;
  peerId: string;
  x: number;
  y: number;
  /** Same inline-identity shape as CursorData. */
  address?: string | null;
  handle?: string | null;
  receivedAt: number;
};

export type Browser = {
  id: string;
  url: string;
  openedBy: string;
  openedAt: number;
};

export type TxRequest = {
  from: string;
  browserId: string;
  calldata: string;
  to: string | null;
  value: string | null;
  chainId: number | null;
  receivedAt: number;
};

export type ChatMessage = {
  id: string;
  ts: number;
  address: string | null;
  handle: string | null;
  text: string;
  source: "live" | "spectator" | "agent";
};

/** Shared todo list item — server-authoritative, mirrors
 *  `packages/relay/src/todos.ts`. */
export type TodoItem = {
  id: string;
  ts: number;
  address: string | null;
  handle: string | null;
  text: string;
  done: boolean;
};

/** Shared note — server-authoritative, mirrors
 *  `packages/relay/src/notes.ts`. */
export type Note = {
  id: string;
  createdTs: number;
  updatedTs: number;
  address: string | null;
  handle: string | null;
  text: string;
};

export type MusicState = {
  src: string | null;
  index: number;
  playing: boolean;
  /** seconds into the track at the moment captured by `at` */
  position: number;
  /** Date.now() of the snapshot. Live position = position + (now - at)/1000 when playing. */
  at: number;
  /** 0..1 master volume — shared across the mesh so all listeners are at the same loudness. */
  volume: number;
};

// Server-authoritative chess state. Mirrors `packages/relay/src/chess.ts`.
export type ChessGameStatus =
  | "active"
  | "white_won"
  | "black_won"
  | "draw_stalemate"
  | "draw_threefold"
  | "draw_insufficient"
  | "draw_other"
  | "white_resigned"
  | "black_resigned";

export type ChessGame = {
  whiteKey: string;
  blackKey: string;
  whiteLabel: string;
  blackLabel: string;
  fen: string;
  moves: string[];
  status: ChessGameStatus;
  startedAt: number;
  endedAt?: number;
  /** Date.now() when the current side started thinking. Drives the
   *  live "this turn" counter under each player's name. */
  turnStartedAt: number;
  /** Wall-clock ms each completed move took, parallel to `moves`. */
  moveTimings: number[];
};

export type ChessResult = {
  whiteKey: string;
  blackKey: string;
  whiteLabel: string;
  blackLabel: string;
  status: Exclude<ChessGameStatus, "active">;
  startedAt: number;
  endedAt: number;
  moveCount: number;
};

/** Server-side AI player available as a chess opponent. The lobby
 *  shows these alongside the live human peers in the player picker.
 *  The relay is responsible for actually playing their moves. */
export type AIPlayer = {
  id: string;
  label: string;
  ownerKey: string; // "ai:<id>"
  model: string;
};

const CHAT_HISTORY_CAP = 200;

type SelfHint = {
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
};

export type PeerMeshState = {
  myId: string | null;
  peers: Peer[];
  connected: boolean;
  // True once the first `hello` payload has been processed — i.e. we know
  // the authoritative slots, browsers, and publications. Use this to gate
  // any UI that would otherwise flash from a fallback to the persisted
  // value (icon positions, browser windows, etc.).
  bootstrapped: boolean;
  // Streams keyed by stream.id (NOT peerId). Multiple streams per peer work.
  remoteStreams: Map<string, MediaStream>;
  // Currently-active publications across all peers (own + others).
  publications: Publication[];
  // Persistent layout positions (host-authoritative).
  slots: Record<string, SlotPosition>;
  cursors: Record<string, CursorData>;
  /** Recent click ripples — auto-prune after the animation completes. */
  clicks: ClickEvent[];
  sendClick: (x: number, y: number) => void;
  // Shared browser windows.
  browsers: Record<string, Browser>;
  // Per-user avatar URLs keyed by ownerKey (lowercased address or
  // slugified handle). Same key Publication.ownerKey uses.
  avatars: Record<string, string>;
  // Owners that have explicitly opted out of any avatar (no upload,
  // no ENS fallback). Render layer treats these as "show nothing".
  hiddenAvatars: Set<string>;
  // Recent tx_request broadcasts (newest first, capped client-side).
  txRequests: TxRequest[];
  // Chat history (oldest first), bootstrapped from the WS hello payload
  // and appended to as `chat` events stream in.
  chatMessages: ChatMessage[];
  sendChat: (text: string) => void;
  publish: (stream: MediaStream, kind: SlotKind, label: string) => void;
  unpublish: (streamId: string) => void;
  /** Hot-swap a single track on an already-published stream. Calls
   *  RTCRtpSender.replaceTrack on every peer connection so the remote
   *  side never loses the publication — the streamId (the map key)
   *  stays stable. Returns the FRESH local MediaStream so the caller
   *  can re-render consumers (analysers / <video> elements) bound to
   *  the old stream — MediaStream mutations don't fire add/removetrack
   *  for developer-initiated calls, so we hand back a new object. */
  replaceTrack: (streamId: string, kind: "audio" | "video", newTrack: MediaStreamTrack) => Promise<MediaStream | null>;
  updateSlot: (patch: Partial<SlotPosition> & { id: string }) => void;
  openBrowser: (id: string, url: string) => void;
  navigateBrowser: (id: string, url: string) => void;
  closeBrowser: (id: string) => void;
  /** Singleton apps whose visibility is shared across the mesh — opened
   *  by anyone, visible to everyone, closed by anyone. */
  openWindowIds: Set<string>;
  openWindow: (id: string) => void;
  closeWindow: (id: string) => void;
  /** Shared music-player state. Last writer wins. Position drift is
   *  computed locally from `at` (Date.now() at capture). */
  musicState: MusicState | null;
  setMusicState: (state: MusicState) => void;
  /** Server-authoritative chess game (singleton) + recent results. */
  chessGame: ChessGame | null;
  chessHistory: ChessResult[];
  /** Server-side AI players available as opponents. Empty if no
   *  provider keys are configured on the relay. */
  aiPlayers: AIPlayer[];
  chessCreate: (args: { whiteKey: string; blackKey: string; whiteLabel: string; blackLabel: string }) => void;
  chessMove: (from: string, to: string, promotion?: string) => void;
  chessResign: () => void;
  chessCloseGame: () => void;
  /** Shared todo list. Full-state replace from server on every change. */
  todos: TodoItem[];
  todoAdd: (text: string) => void;
  todoToggle: (id: string) => void;
  todoUpdate: (id: string, text: string) => void;
  todoDelete: (id: string) => void;
  todoClearDone: () => void;
  /** Apply a new ordering to the todo list. Unknown ids are ignored;
   *  ids missing from `ids` are appended at the end. */
  todoReorder: (ids: string[]) => void;
  /** Shared notes. Full-state replace from server on every change. */
  notes: Note[];
  noteCreate: (text: string) => void;
  noteUpdate: (id: string, text: string) => void;
  noteDelete: (id: string) => void;
  broadcastTxRequest: (req: Omit<TxRequest, "from" | "receivedAt">) => void;
};

export function usePeerMesh(enabled: boolean, self: SelfHint | null): PeerMeshState {
  const [myId, setMyId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [publications, setPublications] = useState<Publication[]>([]);
  const [slots, setSlots] = useState<Record<string, SlotPosition>>({});
  const [cursors, setCursors] = useState<Record<string, CursorData>>({});
  const [clicks, setClicks] = useState<ClickEvent[]>([]);
  const clickIdRef = useRef(0);
  const [browsers, setBrowsers] = useState<Record<string, Browser>>({});
  const [txRequests, setTxRequests] = useState<TxRequest[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [hiddenAvatars, setHiddenAvatars] = useState<Set<string>>(new Set());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [openWindowIds, setOpenWindowIds] = useState<Set<string>>(new Set());
  const [musicState, setMusicStateLocal] = useState<MusicState | null>(null);
  const [chessGame, setChessGame] = useState<ChessGame | null>(null);
  const [chessHistory, setChessHistory] = useState<ChessResult[]>([]);
  const [aiPlayers, setAiPlayers] = useState<AIPlayer[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const myIdRef = useRef<string | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Local streams we are publishing, mapped streamId -> MediaStream.
  const localStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const selfRef = useRef<SelfHint | null>(self);
  selfRef.current = self;
  // ICE config (STUN+TURN) — refreshed once per session/credential expiry.
  const iceConfigRef = useRef<RTCConfiguration>(FALLBACK_ICE);

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const closePeerConnection = useCallback((peerId: string) => {
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.onnegotiationneeded = null;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    peerConnectionsRef.current.delete(peerId);
    setCursors(prev => {
      if (!(peerId in prev)) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  const initiateOffer = useCallback(
    async (peerId: string) => {
      const pc = peerConnectionsRef.current.get(peerId);
      if (!pc) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: "offer", to: peerId, payload: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn("[mesh] initiateOffer failed", err);
      }
    },
    [send],
  );

  const createPeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection(iceConfigRef.current);

      // Attach existing local streams so newly-formed pcs get our outgoing media.
      for (const stream of localStreamsRef.current.values()) {
        for (const track of stream.getTracks()) {
          try {
            pc.addTrack(track, stream);
          } catch {
            /* track already added */
          }
        }
      }

      pc.ontrack = event => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        setRemoteStreams(prev => {
          if (prev.get(stream.id) === stream) return prev;
          const next = new Map(prev);
          next.set(stream.id, stream);
          return next;
        });
        // Track end → drop from map
        event.track.addEventListener("ended", () => {
          if (stream.getTracks().every(t => t.readyState === "ended")) {
            setRemoteStreams(prev => {
              if (!prev.has(stream.id)) return prev;
              const next = new Map(prev);
              next.delete(stream.id);
              return next;
            });
          }
        });
      };

      pc.onicecandidate = event => {
        if (event.candidate) {
          send({ type: "ice", to: peerId, payload: event.candidate.toJSON() });
        }
      };

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected" ||
          pc.connectionState === "closed"
        ) {
          closePeerConnection(peerId);
        }
      };

      pc.onnegotiationneeded = () => {
        if (pc.signalingState === "stable") void initiateOffer(peerId);
      };

      peerConnectionsRef.current.set(peerId, pc);
      return pc;
    },
    [send, closePeerConnection, initiateOffer],
  );

  const handleOffer = useCallback(
    async (from: string, payload: RTCSessionDescriptionInit) => {
      let pc = peerConnectionsRef.current.get(from);
      if (!pc) pc = createPeerConnection(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: "answer", to: from, payload: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn("[mesh] handleOffer failed", err);
      }
    },
    [createPeerConnection, send],
  );

  const handleAnswer = useCallback(async (from: string, payload: RTCSessionDescriptionInit) => {
    const pc = peerConnectionsRef.current.get(from);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
    } catch (err) {
      console.warn("[mesh] handleAnswer failed", err);
    }
  }, []);

  const handleIce = useCallback(async (from: string, payload: RTCIceCandidateInit) => {
    const pc = peerConnectionsRef.current.get(from);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(payload));
    } catch {
      /* stale candidate */
    }
  }, []);

  // ---- public API: publish / unpublish / updateSlot ----------------------

  const publish = useCallback(
    (stream: MediaStream, kind: SlotKind, label: string) => {
      if (localStreamsRef.current.has(stream.id)) return;
      localStreamsRef.current.set(stream.id, stream);
      // Add tracks to all existing PCs; onnegotiationneeded handles the rest.
      for (const pc of peerConnectionsRef.current.values()) {
        for (const track of stream.getTracks()) {
          try {
            pc.addTrack(track, stream);
          } catch {
            /* duplicate */
          }
        }
      }
      send({ type: "publish", streamId: stream.id, kind, label });
    },
    [send],
  );

  const replaceTrack = useCallback(
    async (streamId: string, kind: "audio" | "video", newTrack: MediaStreamTrack): Promise<MediaStream | null> => {
      const stream = localStreamsRef.current.get(streamId);
      if (!stream) return null;
      // Swap the sender on every PC. Sender lookup is by track.kind on
      // the *current* track — works because we only have one of each
      // kind per pub (audio pubs are audio-only, video pubs are video-only).
      for (const pc of peerConnectionsRef.current.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === kind);
        if (!sender) continue;
        try {
          await sender.replaceTrack(newTrack);
        } catch (err) {
          console.warn("[mesh] replaceTrack failed", err);
        }
      }
      // Construct a brand-new MediaStream so React-side consumers re-bind:
      // MediaStreamAudioSourceNode and HTMLMediaElement.srcObject latch onto
      // a track at hookup time, and add/removetrack do NOT fire for
      // dev-initiated mutations — handing back a new object is the only
      // reliable signal.
      const oldTracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
      const keepTracks = kind === "audio" ? stream.getVideoTracks() : stream.getAudioTracks();
      const fresh = new MediaStream([...keepTracks, newTrack]);
      for (const t of oldTracks) t.stop();
      // Map key is the ORIGINAL publication streamId, not fresh.id — peers
      // and the unpublish path both look up by the published id.
      localStreamsRef.current.set(streamId, fresh);
      return fresh;
    },
    [],
  );

  const unpublish = useCallback(
    (streamId: string) => {
      // Local tracks + peer-connection senders only need teardown when
      // WE own the stream. For a force-close on someone else's pub we
      // fall through to just the WS message — the relay will broadcast
      // `unpublished`, the publisher's reconcile effect will stop their
      // hardware, every peer (including us) drops the pub from state.
      const stream = localStreamsRef.current.get(streamId);
      if (stream) {
        localStreamsRef.current.delete(streamId);
        const tracks = new Set(stream.getTracks());
        for (const pc of peerConnectionsRef.current.values()) {
          for (const sender of pc.getSenders()) {
            if (sender.track && tracks.has(sender.track)) {
              try {
                pc.removeTrack(sender);
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
      send({ type: "unpublish", streamId });
    },
    [send],
  );

  const openBrowser = useCallback(
    (id: string, url: string) => {
      // Optimistic local insert so the window pops in instantly.
      setBrowsers(prev => ({ ...prev, [id]: { id, url, openedBy: myIdRef.current ?? "", openedAt: Date.now() } }));
      send({ type: "browser_open", id, url });
    },
    [send],
  );

  const navigateBrowser = useCallback(
    (id: string, url: string) => {
      setBrowsers(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], url } } : prev));
      send({ type: "browser_navigate", id, url });
    },
    [send],
  );

  const closeBrowser = useCallback(
    (id: string) => {
      setBrowsers(prev => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      send({ type: "browser_close", id });
    },
    [send],
  );

  // Optimistic local toggle so the window pops in/out instantly; server
  // rebroadcast confirms (and carries the change to other peers).
  const openWindow = useCallback(
    (id: string) => {
      setOpenWindowIds(prev => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      send({ type: "window_open", id });
    },
    [send],
  );
  const closeWindow = useCallback(
    (id: string) => {
      setOpenWindowIds(prev => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      send({ type: "window_close", id });
    },
    [send],
  );

  const setMusicState = useCallback(
    (state: MusicState) => {
      // Optimistic local apply so the local UI doesn't wait a round-trip
      // for its own click — the server echo will (harmlessly) re-apply.
      setMusicStateLocal(state);
      send({ type: "music_state", ...state });
    },
    [send],
  );

  // ---- Chess action helpers --------------------------------------
  // No optimistic state update here — the relay owns the truth, and
  // a rejected move (illegal, not-your-turn) should NOT briefly show
  // a fake board state. We wait for the server's chess_state echo.
  const chessCreate = useCallback(
    (args: { whiteKey: string; blackKey: string; whiteLabel: string; blackLabel: string }) => {
      send({ type: "chess_create_game", ...args });
    },
    [send],
  );
  const chessMove = useCallback(
    (from: string, to: string, promotion?: string) => {
      send({ type: "chess_move", from, to, promotion });
    },
    [send],
  );
  const chessResign = useCallback(() => {
    send({ type: "chess_resign" });
  }, [send]);
  const chessCloseGame = useCallback(() => {
    send({ type: "chess_close_game" });
  }, [send]);

  const sendClick = useCallback(
    (x: number, y: number) => {
      send({ type: "click", x, y });
    },
    [send],
  );

  const sendChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      send({ type: "chat_send", text: trimmed.slice(0, 500) });
    },
    [send],
  );

  const todoAdd = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      send({ type: "todo_add", text: trimmed.slice(0, 500) });
    },
    [send],
  );
  const todoToggle = useCallback(
    (id: string) => {
      send({ type: "todo_toggle", id });
    },
    [send],
  );
  const todoUpdate = useCallback(
    (id: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      send({ type: "todo_update", id, text: trimmed.slice(0, 500) });
    },
    [send],
  );
  const todoDelete = useCallback(
    (id: string) => {
      send({ type: "todo_delete", id });
    },
    [send],
  );
  const todoClearDone = useCallback(() => {
    send({ type: "todo_clear_done" });
  }, [send]);
  const todoReorder = useCallback(
    (ids: string[]) => {
      send({ type: "todo_reorder", ids });
    },
    [send],
  );

  const noteCreate = useCallback(
    (text: string) => {
      send({ type: "note_create", text: text.slice(0, 10_000) });
    },
    [send],
  );
  const noteUpdate = useCallback(
    (id: string, text: string) => {
      send({ type: "note_update", id, text: text.slice(0, 10_000) });
    },
    [send],
  );
  const noteDelete = useCallback(
    (id: string) => {
      send({ type: "note_delete", id });
    },
    [send],
  );

  const broadcastTxRequest = useCallback(
    (req: Omit<TxRequest, "from" | "receivedAt">) => {
      send({
        type: "tx_request",
        browserId: req.browserId,
        calldata: req.calldata,
        to: req.to,
        value: req.value,
        chainId: req.chainId,
      });
    },
    [send],
  );

  const updateSlot = useCallback(
    (patch: Partial<SlotPosition> & { id: string }) => {
      // Optimistic local update so a controlled <Rnd> doesn't snap back
      // while waiting for the server echo. Relay broadcast then confirms.
      setSlots(prev => {
        const cur = prev[patch.id];
        const merged: SlotPosition = {
          id: patch.id,
          x: patch.x ?? cur?.x ?? 80,
          y: patch.y ?? cur?.y ?? 280,
          width: patch.width ?? cur?.width ?? 360,
          height: patch.height ?? cur?.height ?? 260,
          z: patch.z ?? cur?.z ?? 5,
        };
        return { ...prev, [patch.id]: merged };
      });
      send({ type: "slot_update", ...patch });
    },
    [send],
  );

  // ---- WS lifecycle ------------------------------------------------------

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const teardownConnections = () => {
      peerConnectionsRef.current.forEach(pc => {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      });
      peerConnectionsRef.current = new Map();
      setRemoteStreams(new Map());
    };

    const connect = async () => {
      if (cancelled) return;
      iceConfigRef.current = await fetchIceConfig();
      if (cancelled) return;
      const ws = new WebSocket(RELAY_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        ws.send(JSON.stringify({ type: "hello" }));
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, PING_INTERVAL_MS);
        // Re-announce any locally-published streams (e.g. after reconnect).
        for (const [streamId, stream] of localStreamsRef.current) {
          const kind: SlotKind = stream
            .getVideoTracks()
            .some(t => (t as MediaStreamTrack).label.toLowerCase().includes("screen"))
            ? "screen"
            : "camera";
          const hint = selfRef.current;
          ws.send(
            JSON.stringify({
              type: "publish",
              streamId,
              kind,
              label: hint?.handle ?? hint?.address ?? "anon",
            }),
          );
        }
      };

      ws.onmessage = ev => {
        if (cancelled) return;
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }

        if (msg.type === "hello" && typeof msg.id === "string" && Array.isArray(msg.peers)) {
          const meId = msg.id;
          const others = msg.peers as Peer[];
          myIdRef.current = meId;
          setMyId(meId);
          const hint = selfRef.current;
          const me: Peer = {
            id: meId,
            role: hint?.role ?? "guest",
            address: hint?.address ?? null,
            handle: hint?.handle ?? null,
          };
          setPeers([...others, me]);

          if (Array.isArray(msg.publications)) setPublications(msg.publications as Publication[]);
          if (Array.isArray(msg.slots)) {
            const next: Record<string, SlotPosition> = {};
            for (const s of msg.slots as SlotPosition[]) next[s.id] = s;
            setSlots(next);
          }
          if (Array.isArray(msg.browsers)) {
            const next: Record<string, Browser> = {};
            for (const b of msg.browsers as Browser[]) next[b.id] = b;
            setBrowsers(next);
          }
          if (msg.avatars && typeof msg.avatars === "object" && !Array.isArray(msg.avatars)) {
            setAvatars({ ...(msg.avatars as Record<string, string>) });
          }
          if (Array.isArray(msg.hiddenAvatars)) {
            setHiddenAvatars(new Set(msg.hiddenAvatars as string[]));
          }
          if (Array.isArray(msg.chatHistory)) {
            setChatMessages((msg.chatHistory as ChatMessage[]).slice(-CHAT_HISTORY_CAP));
          }
          if (Array.isArray(msg.openWindows)) {
            setOpenWindowIds(new Set((msg.openWindows as unknown[]).filter((s): s is string => typeof s === "string")));
          }
          if (msg.musicState && typeof msg.musicState === "object") {
            setMusicStateLocal(msg.musicState as MusicState);
          }
          if (msg.chessGame === null || (msg.chessGame && typeof msg.chessGame === "object")) {
            setChessGame((msg.chessGame ?? null) as ChessGame | null);
          }
          if (Array.isArray(msg.chessHistory)) {
            setChessHistory(msg.chessHistory as ChessResult[]);
          }
          if (Array.isArray(msg.aiPlayers)) {
            setAiPlayers(msg.aiPlayers as AIPlayer[]);
          }
          if (Array.isArray(msg.todos)) {
            setTodos(msg.todos as TodoItem[]);
          }
          if (Array.isArray(msg.notes)) {
            setNotes(msg.notes as Note[]);
          }
          // Flip last so consumers can `if (bootstrapped) render` without
          // worrying about whether slots/browsers have been applied yet.
          setBootstrapped(true);

          teardownConnections();
          for (const peer of others) {
            if (peer.id < meId) {
              createPeerConnection(peer.id);
              void initiateOffer(peer.id);
            }
          }
          return;
        }

        if (msg.type === "peer_join" && msg.peer) {
          const peer = msg.peer as Peer;
          setPeers(prev => (prev.some(p => p.id === peer.id) ? prev : [...prev, peer]));
          const meIdNow = myIdRef.current;
          if (meIdNow && peer.id < meIdNow) {
            createPeerConnection(peer.id);
            void initiateOffer(peer.id);
          }
          return;
        }

        if (msg.type === "peer_leave" && msg.peer) {
          const peer = msg.peer as Peer;
          setPeers(prev => prev.filter(p => p.id !== peer.id));
          closePeerConnection(peer.id);
          return;
        }

        if (msg.type === "signal") {
          const kind = msg.kind as string;
          const from = msg.from as string;
          const payload = msg.payload as RTCSessionDescriptionInit | RTCIceCandidateInit;
          if (kind === "offer") void handleOffer(from, payload as RTCSessionDescriptionInit);
          else if (kind === "answer") void handleAnswer(from, payload as RTCSessionDescriptionInit);
          else if (kind === "ice") void handleIce(from, payload as RTCIceCandidateInit);
          return;
        }

        if (msg.type === "cursor") {
          const from = msg.from as string;
          const x = msg.x as number;
          const y = msg.y as number;
          if (typeof from !== "string" || typeof x !== "number" || typeof y !== "number") return;
          const address = typeof msg.address === "string" ? (msg.address as string) : null;
          const handle = typeof msg.handle === "string" ? (msg.handle as string) : null;
          setCursors(prev => ({ ...prev, [from]: { x, y, address, handle } }));
          return;
        }

        if (msg.type === "click") {
          const from = msg.from as string;
          const x = msg.x as number;
          const y = msg.y as number;
          if (typeof from !== "string" || typeof x !== "number" || typeof y !== "number") return;
          const address = typeof msg.address === "string" ? (msg.address as string) : null;
          const handle = typeof msg.handle === "string" ? (msg.handle as string) : null;
          clickIdRef.current += 1;
          const evt: ClickEvent = {
            id: clickIdRef.current,
            peerId: from,
            x,
            y,
            address,
            handle,
            receivedAt: Date.now(),
          };
          // Cap to 30 in flight so a click-spammer doesn't blow up the
          // render tree. The animation finishes in ~900ms and self-prunes.
          setClicks(prev => (prev.length >= 30 ? [...prev.slice(-29), evt] : [...prev, evt]));
          setTimeout(() => {
            setClicks(prev => prev.filter(c => c.id !== evt.id));
          }, 1000);
          return;
        }

        if (msg.type === "published" && msg.publication) {
          const pub = msg.publication as Publication;
          setPublications(prev => {
            const next = prev.filter(p => !(p.peerId === pub.peerId && p.streamId === pub.streamId));
            next.push(pub);
            return next;
          });
          return;
        }

        if (msg.type === "unpublished" && typeof msg.peerId === "string" && typeof msg.streamId === "string") {
          const pid = msg.peerId as string;
          const sid = msg.streamId as string;
          setPublications(prev => prev.filter(p => !(p.peerId === pid && p.streamId === sid)));
          setRemoteStreams(prev => {
            if (!prev.has(sid)) return prev;
            const next = new Map(prev);
            next.delete(sid);
            return next;
          });
          return;
        }

        if (msg.type === "slot" && msg.slot) {
          const s = msg.slot as SlotPosition;
          setSlots(prev => ({ ...prev, [s.id]: s }));
          return;
        }

        if (msg.type === "browser" && msg.browser) {
          const b = msg.browser as Browser;
          setBrowsers(prev => ({ ...prev, [b.id]: b }));
          return;
        }

        if (msg.type === "browser_closed" && typeof msg.id === "string") {
          const id = msg.id as string;
          setBrowsers(prev => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
          return;
        }

        if (msg.type === "window_opened" && typeof msg.id === "string") {
          const id = msg.id as string;
          setOpenWindowIds(prev => {
            if (prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
          });
          return;
        }

        if (msg.type === "window_closed" && typeof msg.id === "string") {
          const id = msg.id as string;
          setOpenWindowIds(prev => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          return;
        }

        if (msg.type === "music_state" && msg.state && typeof msg.state === "object") {
          setMusicStateLocal(msg.state as MusicState);
          return;
        }

        if (msg.type === "chess_state") {
          // game may be null (lobby reopened) or an object
          setChessGame((msg.game ?? null) as ChessGame | null);
          return;
        }

        if (msg.type === "chess_history" && Array.isArray(msg.history)) {
          setChessHistory(msg.history as ChessResult[]);
          return;
        }

        if (msg.type === "avatar" && typeof msg.ownerKey === "string" && typeof msg.url === "string") {
          const k = msg.ownerKey as string;
          const u = msg.url as string;
          setAvatars(prev => ({ ...prev, [k]: u }));
          // Uploading implicitly clears the hidden marker.
          setHiddenAvatars(prev => {
            if (!prev.has(k)) return prev;
            const next = new Set(prev);
            next.delete(k);
            return next;
          });
          return;
        }

        if (msg.type === "avatar_removed" && typeof msg.ownerKey === "string") {
          const k = msg.ownerKey as string;
          setAvatars(prev => {
            if (!(k in prev)) return prev;
            const next = { ...prev };
            delete next[k];
            return next;
          });
          // Clean slate also clears the hidden marker.
          setHiddenAvatars(prev => {
            if (!prev.has(k)) return prev;
            const next = new Set(prev);
            next.delete(k);
            return next;
          });
          return;
        }

        if (msg.type === "avatar_hidden" && typeof msg.ownerKey === "string") {
          const k = msg.ownerKey as string;
          setAvatars(prev => {
            if (!(k in prev)) return prev;
            const next = { ...prev };
            delete next[k];
            return next;
          });
          setHiddenAvatars(prev => {
            if (prev.has(k)) return prev;
            const next = new Set(prev);
            next.add(k);
            return next;
          });
          return;
        }

        if (msg.type === "chat" && msg.msg && typeof (msg.msg as ChatMessage).id === "string") {
          const cm = msg.msg as ChatMessage;
          setChatMessages(prev => {
            // Dedupe on id — a fast double-broadcast would otherwise
            // double-render in the window.
            if (prev.some(m => m.id === cm.id)) return prev;
            const next = [...prev, cm];
            return next.length > CHAT_HISTORY_CAP ? next.slice(-CHAT_HISTORY_CAP) : next;
          });
          return;
        }

        if (msg.type === "todos" && Array.isArray(msg.items)) {
          setTodos(msg.items as TodoItem[]);
          return;
        }

        if (msg.type === "notes" && Array.isArray(msg.items)) {
          setNotes(msg.items as Note[]);
          return;
        }

        if (msg.type === "tx_request" && typeof msg.browserId === "string" && typeof msg.calldata === "string") {
          const req: TxRequest = {
            from: typeof msg.from === "string" ? msg.from : "",
            browserId: msg.browserId,
            calldata: msg.calldata,
            to: typeof msg.to === "string" ? msg.to : null,
            value: typeof msg.value === "string" ? msg.value : null,
            chainId: typeof msg.chainId === "number" ? msg.chainId : null,
            receivedAt: Date.now(),
          };
          // Cap history at 50 to stop unbounded growth on long sessions.
          setTxRequests(prev => [req, ...prev].slice(0, 50));
          return;
        }
      };

      ws.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        setConnected(false);
        setBootstrapped(false);
        setMyId(null);
        myIdRef.current = null;
        teardownConnections();
        setPeers([]);
        setPublications([]);
        if (cancelled) return;
        reconnectTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };

    void connect();

    return () => {
      cancelled = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
      teardownConnections();
    };
  }, [enabled, createPeerConnection, closePeerConnection, handleOffer, handleAnswer, handleIce, initiateOffer]);

  // Cursor broadcast at ~30 Hz.
  useEffect(() => {
    if (!connected) return;
    let lastSent = 0;
    const handler = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastSent < CURSOR_THROTTLE_MS) return;
      lastSent = now;
      send({ type: "cursor", x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, [connected, send]);

  return {
    myId,
    peers,
    connected,
    bootstrapped,
    remoteStreams,
    publications,
    slots,
    cursors,
    clicks,
    sendClick,
    browsers,
    avatars,
    hiddenAvatars,
    txRequests,
    chatMessages,
    sendChat,
    publish,
    unpublish,
    replaceTrack,
    updateSlot,
    openBrowser,
    navigateBrowser,
    closeBrowser,
    openWindowIds,
    openWindow,
    closeWindow,
    musicState,
    setMusicState,
    chessGame,
    chessHistory,
    aiPlayers,
    chessCreate,
    chessMove,
    chessResign,
    chessCloseGame,
    todos,
    todoAdd,
    todoToggle,
    todoUpdate,
    todoDelete,
    todoClearDone,
    todoReorder,
    notes,
    noteCreate,
    noteUpdate,
    noteDelete,
    broadcastTxRequest,
  };
}

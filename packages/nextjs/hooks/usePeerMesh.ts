"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const RELAY_WS_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? "ws://slop.computer/signal";

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

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

type CursorData = { x: number; y: number };

type SelfHint = {
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
};

export type WindowState = {
  id: string;
  kind: "camera" | "screen" | "remote" | "panel";
  ownerPeerId: string | null;
  ownerLabel: string | null;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  open: boolean;
};

export type WindowPatch = Partial<WindowState> & { id: string };

export type PeerMeshState = {
  myId: string | null;
  peers: Peer[];
  connected: boolean;
  remoteStreams: Map<string, MediaStream>;
  peerConnections: Map<string, RTCPeerConnection>;
  cursors: Record<string, CursorData>;
  windows: Record<string, WindowState>;
  addLocalStream: (stream: MediaStream) => void;
  removeLocalStream: (stream: MediaStream) => void;
  updateWindow: (patch: WindowPatch) => void;
  removeWindow: (id: string) => void;
};

export function usePeerMesh(enabled: boolean, self: SelfHint | null): PeerMeshState {
  const [myId, setMyId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [connected, setConnected] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [peerConnections, setPeerConnections] = useState<Map<string, RTCPeerConnection>>(new Map());
  const [cursors, setCursors] = useState<Record<string, CursorData>>({});
  const [windows, setWindows] = useState<Record<string, WindowState>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const myIdRef = useRef<string | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamsRef = useRef<MediaStream[]>([]);
  const selfRef = useRef<SelfHint | null>(self);
  selfRef.current = self;

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const closePeerConnection = useCallback((peerId: string) => {
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    peerConnectionsRef.current.delete(peerId);
    setPeerConnections(new Map(peerConnectionsRef.current));
    setRemoteStreams(prev => {
      if (!prev.has(peerId)) return prev;
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
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
      const pc = new RTCPeerConnection(ICE_CONFIG);

      // Attach existing local streams so newly-formed pcs get our outgoing media.
      for (const stream of localStreamsRef.current) {
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
          const next = new Map(prev);
          next.set(peerId, stream);
          return next;
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
        // Only the side that adds tracks first should initiate; if both sides
        // do simultaneously you hit glare. Our addLocalStream already nudges
        // initiateOffer when state is stable, so this is just a safety net.
        if (pc.signalingState === "stable") void initiateOffer(peerId);
      };

      peerConnectionsRef.current.set(peerId, pc);
      setPeerConnections(new Map(peerConnectionsRef.current));
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

  const addLocalStream = useCallback(
    (stream: MediaStream) => {
      if (localStreamsRef.current.includes(stream)) return;
      localStreamsRef.current = [...localStreamsRef.current, stream];
      for (const [peerId, pc] of peerConnectionsRef.current) {
        for (const track of stream.getTracks()) {
          try {
            pc.addTrack(track, stream);
          } catch {
            /* duplicate */
          }
        }
        if (pc.signalingState === "stable") {
          void initiateOffer(peerId);
        }
      }
    },
    [initiateOffer],
  );

  const removeLocalStream = useCallback(
    (stream: MediaStream) => {
      const tracks = new Set(stream.getTracks());
      localStreamsRef.current = localStreamsRef.current.filter(s => s !== stream);
      for (const [peerId, pc] of peerConnectionsRef.current) {
        for (const sender of pc.getSenders()) {
          if (sender.track && tracks.has(sender.track)) {
            try {
              pc.removeTrack(sender);
            } catch {
              /* ignore */
            }
          }
        }
        if (pc.signalingState === "stable") {
          void initiateOffer(peerId);
        }
      }
    },
    [initiateOffer],
  );

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
      setPeerConnections(new Map());
      setRemoteStreams(new Map());
    };

    const connect = () => {
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

          // Initial window snapshot from server (host-authoritative layout).
          if (Array.isArray(msg.windows)) {
            const next: Record<string, WindowState> = {};
            for (const w of msg.windows as WindowState[]) {
              if (w && typeof w.id === "string") next[w.id] = w;
            }
            setWindows(next);
          }

          // Reset existing pcs (reconnect) and re-initiate to lower-id peers.
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
          setCursors(prev => ({ ...prev, [from]: { x, y } }));
          return;
        }

        if (msg.type === "window" && msg.window && typeof (msg.window as WindowState).id === "string") {
          const w = msg.window as WindowState;
          setWindows(prev => ({ ...prev, [w.id]: w }));
          return;
        }

        if (msg.type === "window_removed" && typeof msg.id === "string") {
          const id = msg.id as string;
          setWindows(prev => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
          return;
        }
      };

      ws.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        setConnected(false);
        setMyId(null);
        myIdRef.current = null;
        teardownConnections();
        setPeers([]);
        setWindows({});
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };

    connect();

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

  // Broadcast own cursor.
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

  const updateWindow = useCallback(
    (patch: WindowPatch) => {
      send({ type: "window_update", ...patch });
    },
    [send],
  );

  const removeWindow = useCallback(
    (id: string) => {
      send({ type: "window_remove", id });
    },
    [send],
  );

  return {
    myId,
    peers,
    connected,
    remoteStreams,
    peerConnections,
    cursors,
    windows,
    addLocalStream,
    removeLocalStream,
    updateWindow,
    removeWindow,
  };
}

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

type CursorData = { x: number; y: number };

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
  // Shared browser windows.
  browsers: Record<string, Browser>;
  // Recent tx_request broadcasts (newest first, capped client-side).
  txRequests: TxRequest[];
  publish: (stream: MediaStream, kind: SlotKind, label: string) => void;
  unpublish: (streamId: string) => void;
  updateSlot: (patch: Partial<SlotPosition> & { id: string }) => void;
  openBrowser: (id: string, url: string) => void;
  navigateBrowser: (id: string, url: string) => void;
  closeBrowser: (id: string) => void;
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
  const [browsers, setBrowsers] = useState<Record<string, Browser>>({});
  const [txRequests, setTxRequests] = useState<TxRequest[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);

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

  const unpublish = useCallback(
    (streamId: string) => {
      const stream = localStreamsRef.current.get(streamId);
      if (!stream) return;
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
          setCursors(prev => ({ ...prev, [from]: { x, y } }));
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
    browsers,
    txRequests,
    publish,
    unpublish,
    updateSlot,
    openBrowser,
    navigateBrowser,
    closeBrowser,
    broadcastTxRequest,
  };
}

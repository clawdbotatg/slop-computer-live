"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const RELAY_WS_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? "ws://slop.computer/signal";
const _RELAY_HTTP_URL = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "https://slop.computer"; void _RELAY_HTTP_URL;

type CursorData = {
  x: number;
  y: number;
};

export type PeerMeshState = {
  remoteStreams: Map<string, MediaStream>;
  peerConnections: Map<string, RTCPeerConnection>;
  cursors: Record<string, CursorData>;
  connected: boolean;
};

type PeerInfo = {
  id: string;
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
};

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export function usePeerMesh(
  enabled: boolean,
  _selfHint: { role: "host" | "guest"; address: string | null; handle: string | null } | null,
): PeerMeshState {
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [peerConnections, setPeerConnections] = useState<Map<string, RTCPeerConnection>>(new Map());
  const [cursors, setCursors] = useState<Record<string, CursorData>>({});
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const myIdRef = useRef<string | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const cursorsRef = useRef<Record<string, CursorData>>({});

  // Keep refs in sync with state
  const [, _forceUpdate] = useState(0);
  void _selfHint;
  void _forceUpdate;
  const syncRefs = useCallback((pcs: Map<string, RTCPeerConnection>, cs: Record<string, CursorData>) => {
    peerConnectionsRef.current = pcs;
    cursorsRef.current = cs;
  }, []);

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const closePeerConnection = useCallback(
    (peerId: string) => {
      setPeerConnections(prev => {
        const pc = prev.get(peerId);
        if (pc) {
          pc.ontrack = null;
          pc.onicecandidate = null;
          pc.onconnectionstatechange = null;
          pc.close();
        }
        peerConnectionsRef.current.delete(peerId);
        const next = new Map(prev);
        next.delete(peerId);
        const newCursors = { ...cursorsRef.current };
        delete newCursors[peerId];
        setCursors(newCursors);
        syncRefs(next, newCursors);
        return next;
      });
      setRemoteStreams(prev => {
        const next = new Map(prev);
        next.delete(peerId);
        return next;
      });
    },
    [syncRefs],
  );

  const createPeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection(ICE_CONFIG);

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

      return pc;
    },
    [send, closePeerConnection],
  );

  const handleOffer = useCallback(
    async (from: string, payload: RTCSessionDescriptionInit) => {
      const myId = myIdRef.current;
      if (!myId) return;

      const pc = createPeerConnection(from);
      setPeerConnections(prev => {
        const next = new Map(prev);
        next.set(from, pc);
        peerConnectionsRef.current = next;
        syncRefs(next, cursorsRef.current);
        return next;
      });

      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "answer", to: from, payload: pc.localDescription!.toJSON() });
    },
    [createPeerConnection, send, syncRefs],
  );

  const handleAnswer = useCallback(async (from: string, payload: RTCSessionDescriptionInit) => {
    const pc = peerConnectionsRef.current.get(from);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
    }
  }, []);

  const handleIce = useCallback(async (from: string, payload: RTCIceCandidateInit) => {
    const pc = peerConnectionsRef.current.get(from);
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload));
      } catch {
        /* ignore stale candidates */
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(RELAY_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        ws.send(JSON.stringify({ type: "hello" }));
      };

      ws.onmessage = ev => {
        if (cancelled) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }

        if (msg.type === "hello") {
          const meId = msg.id as string;
          const peers = msg.peers as PeerInfo[];
          myIdRef.current = meId;

          // Close all existing peer connections on reconnect
          peerConnectionsRef.current.forEach(pc => pc.close());
          peerConnectionsRef.current = new Map();
          setPeerConnections(new Map());
          setRemoteStreams(new Map());
          syncRefs(new Map(), cursorsRef.current);

          // Initiate connections: if peerId < myId, we create offer
          for (const peer of peers) {
            if (peer.id < meId) {
              const pc = createPeerConnection(peer.id);
              peerConnectionsRef.current.set(peer.id, pc);
              setPeerConnections(prev => {
                const next = new Map(prev);
                next.set(peer.id, pc);
                return next;
              });
              pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                  send({ type: "offer", to: peer.id, payload: pc.localDescription!.toJSON() });
                });
            }
          }
          return;
        }

        if (msg.type === "peer_leave") {
          const peer = msg.peer as PeerInfo;
          closePeerConnection(peer.id);
          return;
        }

        if (msg.type === "peer_join") {
          const peer = msg.peer as PeerInfo;
          const myId = myIdRef.current;
          // New peer joins with smaller ID → we are initiator
          if (myId && peer.id < myId) {
            const pc = createPeerConnection(peer.id);
            peerConnectionsRef.current.set(peer.id, pc);
            setPeerConnections(prev => {
              const next = new Map(prev);
              next.set(peer.id, pc);
              return next;
            });
            pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
              send({ type: "offer", to: peer.id, payload: pc.localDescription!.toJSON() });
            });
          }
          return;
        }

        // Relay-wrapped signaling messages
        if (msg.type === "signal") {
          const kind = msg.kind as string;
          const from = msg.from as string;
          const payload = msg.payload as RTCSessionDescriptionInit | RTCIceCandidateInit;
          if (kind === "offer") {
            handleOffer(from, payload as RTCSessionDescriptionInit);
          } else if (kind === "answer") {
            handleAnswer(from, payload as RTCSessionDescriptionInit);
          } else if (kind === "ice") {
            handleIce(from, payload as RTCIceCandidateInit);
          }
          return;
        }

        // Cursor broadcast from relay
        if (msg.type === "cursor") {
          const from = msg.from as string;
          const x = msg.x as number;
          const y = msg.y as number;
          setCursors(prev => {
            const next = { ...prev, [from]: { x, y } };
            cursorsRef.current = next;
            syncRefs(peerConnectionsRef.current, next);
            return next;
          });
          return;
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        myIdRef.current = null;
        peerConnectionsRef.current.forEach(pc => pc.close());
        peerConnectionsRef.current = new Map();
        setPeerConnections(new Map());
        setRemoteStreams(new Map());
        syncRefs(new Map(), cursorsRef.current);

        if (!cancelled) {
          setTimeout(connect, 2000);
        }
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
      wsRef.current?.close();
      wsRef.current = null;
      peerConnectionsRef.current.forEach(pc => pc.close());
      peerConnectionsRef.current = new Map();
    };
  }, [enabled, createPeerConnection, closePeerConnection, handleOffer, handleAnswer, handleIce, send, syncRefs]);

  // Broadcast our own cursor position
  useEffect(() => {
    if (!connected) return;
    const handler = (e: MouseEvent) => {
      send({ type: "cursor", x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, [connected, send]);

  return { remoteStreams, peerConnections, cursors, connected };
}

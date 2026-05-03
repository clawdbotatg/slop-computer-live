"use client";

import { useEffect, useRef, useState } from "react";

const RELAY_WS_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? "ws://localhost:8080/signal";

export type Peer = {
  id: string;
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
  connectedAt?: number;
};

type State = {
  myId: string | null;
  peers: Peer[];
  connected: boolean;
};

type SelfHint = {
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
};

const PING_INTERVAL_MS = 25_000;

export function useSignalSocket(enabled: boolean, self: SelfHint | null): State {
  const [state, setState] = useState<State>({ myId: null, peers: [], connected: false });
  const wsRef = useRef<WebSocket | null>(null);
  const selfRef = useRef(self);
  selfRef.current = self;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(RELAY_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setState(s => ({ ...s, connected: true }));
        ws.send(JSON.stringify({ type: "hello" }));
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = ev => {
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }
        if (msg.type === "hello" && typeof msg.id === "string" && Array.isArray(msg.peers)) {
          const meId = msg.id;
          const others = msg.peers as Peer[];
          const hint = selfRef.current;
          const me: Peer = {
            id: meId,
            role: hint?.role ?? "guest",
            address: hint?.address ?? null,
            handle: hint?.handle ?? null,
          };
          setState({ myId: meId, peers: [...others, me], connected: true });
          return;
        }
        if (msg.type === "peer_join" && msg.peer) {
          const peer = msg.peer as Peer;
          setState(s => ({ ...s, peers: s.peers.some(p => p.id === peer.id) ? s.peers : [...s.peers, peer] }));
          return;
        }
        if (msg.type === "peer_leave" && msg.peer) {
          const peer = msg.peer as Peer;
          setState(s => ({ ...s, peers: s.peers.filter(p => p.id !== peer.id) }));
          return;
        }
      };

      ws.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        setState({ myId: null, peers: [], connected: false });
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, 2000);
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
    };
  }, [enabled]);

  return state;
}

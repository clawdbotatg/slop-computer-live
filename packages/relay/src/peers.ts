import type { WebSocket } from "ws";

export type PeerInfo = {
  id: string;
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
  connectedAt: number;
};

type Peer = PeerInfo & { ws: WebSocket; sessionToken: string };

const peers = new Map<string, Peer>();

export function addPeer(peer: Peer): void {
  peers.set(peer.id, peer);
}

export function removePeer(id: string): void {
  peers.delete(id);
}

export function getPeer(id: string): Peer | undefined {
  return peers.get(id);
}

export function listPeers(): PeerInfo[] {
  return [...peers.values()].map(({ ws: _ws, sessionToken: _t, ...info }) => info);
}

export function findPeersBySessionToken(token: string): Peer[] {
  return [...peers.values()].filter(p => p.sessionToken === token);
}

export function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function broadcast(msg: unknown, exceptId?: string): void {
  for (const [id, peer] of peers) {
    if (exceptId && id === exceptId) continue;
    send(peer.ws, msg);
  }
}

export function sendTo(targetId: string, msg: unknown): boolean {
  const peer = peers.get(targetId);
  if (!peer) return false;
  send(peer.ws, msg);
  return true;
}

export function kickById(id: string): boolean {
  const peer = peers.get(id);
  if (!peer) return false;
  try {
    send(peer.ws, { type: "kicked" });
    peer.ws.close(4403, "kicked");
  } catch {
    /* ignore */
  }
  peers.delete(id);
  return true;
}

/**
 * Terminate every connected WebSocket so the process can exit on
 * SIGTERM. Fastify's `app.close()` waits for HTTP requests to drain
 * but won't proactively close upgraded WS connections — left alone,
 * those keep the event loop alive until systemd's 90s stop timeout
 * fires and SIGKILLs the process. Send a courtesy "shutting_down"
 * frame so clients know to reconnect, then force-terminate the
 * socket (ws.terminate() unlike ws.close() doesn't wait for a
 * close handshake).
 */
export function closeAllPeers(): void {
  for (const peer of peers.values()) {
    try {
      send(peer.ws, { type: "shutting_down" });
    } catch {
      /* ignore */
    }
    try {
      peer.ws.terminate();
    } catch {
      /* ignore */
    }
  }
  peers.clear();
}

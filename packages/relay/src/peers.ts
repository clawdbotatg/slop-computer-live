import type { WebSocket } from "ws";

export type PeerInfo = {
  id: string;
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
};

type Peer = PeerInfo & { ws: WebSocket };

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
  return [...peers.values()].map(({ ws: _ws, ...info }) => info);
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

import type { WebSocket } from "ws";
import { DEFAULT_SLUG, getOrCreateRoom, listRooms } from "./room.js";
import { send } from "./ws-send.js";

// Backwards-compat shim. The peers Map now lives on a Room instance
// (see room.ts). During Phase 1 the rest of the codebase keeps calling
// the free functions below; each one delegates to the DEFAULT_SLUG
// room. Cross-room operations (kick, find-by-token, close-all,
// targeted sendTo) iterate every room so a stale handle in any room
// stays reachable.
//
// Phase 1d migrates subsystem-by-subsystem to taking an explicit Room
// parameter, at which point this shim shrinks to just the cross-room
// helpers + the `send` re-export.

export type PeerInfo = {
  id: string;
  role: "host" | "guest";
  address: string | null;
  handle: string | null;
  // Stable per-session public id for anon peers (no wallet/passkey →
  // no address). Used as the customNames lookup key + flag-color seed
  // so a rename doesn't break their visual identity. Null for SIWE/
  // passkey peers — their `address` plays the same role.
  anonId: string | null;
  connectedAt: number;
  // True for god-mode streaming sessions: still in the relay's peer
  // map so RTC signaling flows (the streaming box receives audio/
  // video), but filtered out of the visible guest list on every
  // client.
  spectator?: boolean;
  // Mirrored from the session for passkey peers. Lets other peers in
  // the same room register this user as a passkey signer on a multisig
  // (the deploy form auto-routes signers with a `passkey` field into
  // the passkey arrays of `createMultisig`). Undefined for SIWE/anon
  // peers. The pubkey is public-by-design; nothing sensitive here.
  passkey?: { qx: string; qy: string; credentialIdHash: string };
};

export type Peer = PeerInfo & { ws: WebSocket; sessionToken: string };

// Re-export so existing `import { send } from "./peers.js"` callsites
// keep working.
export { send };

const mainRoom = () => getOrCreateRoom(DEFAULT_SLUG);

export function addPeer(peer: Peer): void {
  mainRoom().addPeer(peer);
}

export function removePeer(id: string): void {
  for (const room of listRooms()) {
    if (room.getPeer(id)) {
      room.removePeer(id);
      return;
    }
  }
}

export function getPeer(id: string): Peer | undefined {
  for (const room of listRooms()) {
    const peer = room.getPeer(id);
    if (peer) return peer;
  }
  return undefined;
}

export function listPeers(): PeerInfo[] {
  return mainRoom().listPeers();
}

export function findPeersBySessionToken(token: string): Peer[] {
  const out: Peer[] = [];
  for (const room of listRooms()) {
    for (const peer of room.allPeers()) {
      if (peer.sessionToken === token) out.push(peer);
    }
  }
  return out;
}

export function broadcast(msg: unknown, exceptId?: string): void {
  mainRoom().broadcast(msg, exceptId);
}

export function sendTo(targetId: string, msg: unknown): boolean {
  for (const room of listRooms()) {
    const peer = room.getPeer(targetId);
    if (!peer) continue;
    send(peer.ws, msg);
    return true;
  }
  return false;
}

export function kickById(id: string): boolean {
  for (const room of listRooms()) {
    const peer = room.getPeer(id);
    if (!peer) continue;
    try {
      send(peer.ws, { type: "kicked" });
      peer.ws.close(4403, "kicked");
    } catch {
      /* ignore */
    }
    room.removePeer(id);
    return true;
  }
  return false;
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
  for (const room of listRooms()) {
    for (const peer of room.allPeers()) {
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
    room.clearPeers();
  }
}

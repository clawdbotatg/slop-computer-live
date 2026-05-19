import type { WebSocket } from "ws";

// Low-level socket write helper. Extracted from peers.ts so both Room
// (which holds the per-room peers Map) and the peers.ts compatibility
// shim can import it without forming a runtime cycle.
export function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

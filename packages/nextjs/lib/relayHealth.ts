"use client";

// Tiny module-level pub/sub for "is the relay WS reachable right now?".
//
// Bridges Desktop (deep in the tree, owns usePeerMesh and therefore the
// authoritative WS state) with UpgradeModal (mounted up in the
// providers shell so it can render over any page). Doing this through
// React context would require hoisting usePeerMesh up to the providers
// — out of scope — so we use a plain module-level singleton.
//
// Authenticated users get instant detection here (WS close fires within
// milliseconds of the relay restart on systemctl); UpgradeModal still
// runs a parallel /health poll as a fallback for surfaces that never
// open the mesh WS (front page, spectators, unauthed gates).

type Listener = (connected: boolean) => void;

const listeners = new Set<Listener>();
let current = false;
let everConnected = false;

export function reportRelayWsConnected(connected: boolean): void {
  if (connected === current) return;
  current = connected;
  if (connected) everConnected = true;
  for (const fn of listeners) fn(connected);
}

export function getRelayHealthSnapshot(): { connected: boolean; everConnected: boolean } {
  return { connected: current, everConnected };
}

export function subscribeRelayHealth(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

"use client";

// Tiny module-level pub/sub for relay connection state.
//
// Bridges Desktop (deep in the tree, owns usePeerMesh and therefore the
// authoritative WS state) with UpgradeModal (mounted up in the
// providers shell so it can render over any page). Doing this through
// React context would require hoisting usePeerMesh up to the providers
// — out of scope — so we use a plain module-level singleton.
//
// Two signals are tracked:
//
//  - `connected`     — WS handshake is open. Proves the relay has its
//                      port bound. Used as the "deploy started" trigger
//                      (going true→false means the relay restarted).
//
//  - `bootstrapped`  — WS hello completed and the relay returned the
//                      full room snapshot (peers, slots, browsers, UI
//                      state, password validation). Proves the relay
//                      has finished loading state from disk and is
//                      able to serve real clients — much stronger
//                      readiness signal than /health, which lies about
//                      readiness for several seconds after restart.
//                      Used as the "deploy finished" reload trigger.

type Snapshot = {
  connected: boolean;
  bootstrapped: boolean;
  everConnected: boolean;
  everBootstrapped: boolean;
};

type Listener = (snap: Snapshot) => void;

const listeners = new Set<Listener>();
let snap: Snapshot = {
  connected: false,
  bootstrapped: false,
  everConnected: false,
  everBootstrapped: false,
};

function emit(): void {
  for (const fn of listeners) fn(snap);
}

export function reportRelayWsConnected(connected: boolean): void {
  if (snap.connected === connected) return;
  snap = {
    ...snap,
    connected,
    everConnected: snap.everConnected || connected,
  };
  emit();
}

export function reportMeshBootstrapped(bootstrapped: boolean): void {
  if (snap.bootstrapped === bootstrapped) return;
  snap = {
    ...snap,
    bootstrapped,
    everBootstrapped: snap.everBootstrapped || bootstrapped,
  };
  emit();
}

export function getRelayHealthSnapshot(): Snapshot {
  return snap;
}

export function subscribeRelayHealth(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

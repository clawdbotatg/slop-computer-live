"use client";

import { useSyncExternalStore } from "react";

// ETH→USD spot price, shared across the whole app via one /api/eth-price poll
// (not one per consumer). Returns USD-per-ETH, or null until the first fetch
// lands / if the price endpoint is unavailable. Pair with utils/usd.ts to show
// a USD value next to any ETH amount.

const POLL_MS = 60_000;

let price: number | null = null;
let started = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

async function refresh() {
  try {
    const res = await fetch("/api/eth-price");
    if (!res.ok) return;
    const j = (await res.json()) as { usd?: number };
    if (typeof j.usd === "number" && isFinite(j.usd) && j.usd > 0 && j.usd !== price) {
      price = j.usd;
      emit();
    }
  } catch {
    // Leave the last good price in place; a transient failure just stalls updates.
  }
}

function ensureStarted() {
  if (started) return;
  started = true;
  void refresh();
  setInterval(() => void refresh(), POLL_MS);
}

function subscribe(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** USD per 1 ETH, or null until known. */
export function useEthPrice(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => price,
    () => null,
  );
}

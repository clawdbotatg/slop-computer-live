"use client";

import { useCallback } from "react";
import type { PeerMeshState } from "./usePeerMesh";

// Shared discrete UI selection for any surface on the desktop — the
// last-writer-wins sibling to useSyncedScroll. One peer picks a tab, a
// chain, a filter; every peer's matching surface follows.
//
// Backed by the relay's `ui_state` channel (see usePeerMesh's
// `setUIState` / `uiState`): the setter updates locally for zero-lag
// feedback and broadcasts; the server echo is authoritative, and a
// late joiner gets the current value in the `hello` payload. Because
// the value is discrete and written only on an explicit action (not a
// continuous gesture), there's no detach grace and no oscillation —
// unlike scroll, two peers can't fight over a half-finished drag.
//
// Drop-in for useState: returns `[value, setValue]`. `fallback` is
// shown until any peer writes the key, so derive it from other synced
// room state (e.g. the wallet's default tab from its tx queue) and
// every peer agrees on what to show before the first pick.
export function useSyncedUIState<T>(mesh: PeerMeshState, key: string, fallback: T): [T, (value: T) => void] {
  const { uiState, setUIState } = mesh;
  const raw = uiState[key];
  const value = raw === undefined ? fallback : (raw as T);
  // setUIState is stable for the mesh's lifetime, so this setter is too
  // — safe to list in an effect's dep array without churning it.
  const setValue = useCallback((next: T) => setUIState(key, next), [setUIState, key]);
  return [value, setValue];
}

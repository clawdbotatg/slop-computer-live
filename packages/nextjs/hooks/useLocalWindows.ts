"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SlotPosition } from "~~/hooks/usePeerMesh";

// Local (single-player) window state — the private-window twin of the mesh's
// slot system in usePeerMesh.
//
// The mesh tracks geometry + open/close for windows EVERYONE sees, broadcasts
// them, and the relay persists them to slots.json. This hook is the exact same
// surface (slots map, open set, updateSlot/openWindow/closeWindow/focusWindow)
// but for windows only the LOCAL viewer sees: nothing here ever touches the
// relay. State persists to localStorage, scoped to the room slug, so a private
// window remembers its position/size/open-state across reloads — for this
// browser only.
//
// `<LocalWindow>` / `<PrivateAppWindow>` consume this exactly the way
// `<SlotWindow>` / `<SharedAppWindow>` consume `mesh`. Create one instance per
// Desktop and pass it down.

const KEY_BASE = "slop-private-windows-v1";
const localWindowsKey = (slug: string) => `${KEY_BASE}:${slug}`;

type Persisted = {
  slots: Record<string, SlotPosition>;
  open: string[];
};

const EMPTY: Persisted = { slots: {}, open: [] };

const read = (slug: string): Persisted => {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(localWindowsKey(slug));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      slots: parsed.slots ?? {},
      open: Array.isArray(parsed.open) ? parsed.open : [],
    };
  } catch {
    return EMPTY;
  }
};

const write = (slug: string, state: Persisted) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(localWindowsKey(slug), JSON.stringify(state));
  } catch {
    // best-effort; a full/blocked localStorage just loses persistence
  }
};

export type LocalWindowsState = {
  /** Geometry per slot id (`app-<id>`), mirroring `mesh.slots`. */
  slots: Record<string, SlotPosition>;
  /** Set of open app ids, mirroring `mesh.openWindowIds`. */
  openWindowIds: Set<string>;
  openWindow: (id: string) => void;
  closeWindow: (id: string) => void;
  /** Toggle helper for menubar/desktop-icon activation. */
  toggleWindow: (id: string) => void;
  updateSlot: (patch: Partial<SlotPosition> & { id: string }) => void;
};

export function useLocalWindows(slug: string): LocalWindowsState {
  const [state, setState] = useState<Persisted>(EMPTY);

  // Hydrate from localStorage once the slug is known (and re-hydrate if the
  // room changes — private windows are per-room, like resume flags).
  useEffect(() => {
    setState(read(slug));
  }, [slug]);

  // Persist on every change. Keep a ref of the slug so the persist effect
  // doesn't re-fire purely on slug churn before hydration lands.
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const hydratedRef = useRef(false);
  useEffect(() => {
    // Skip the very first commit (the EMPTY initial state) so we never clobber
    // stored data with empties before hydration runs.
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    write(slugRef.current, state);
  }, [state]);

  const openWindow = useCallback((id: string) => {
    setState(prev => (prev.open.includes(id) ? prev : { ...prev, open: [...prev.open, id] }));
  }, []);

  const closeWindow = useCallback((id: string) => {
    setState(prev => ({ ...prev, open: prev.open.filter(x => x !== id) }));
  }, []);

  const toggleWindow = useCallback((id: string) => {
    setState(prev =>
      prev.open.includes(id)
        ? { ...prev, open: prev.open.filter(x => x !== id) }
        : { ...prev, open: [...prev.open, id] },
    );
  }, []);

  const updateSlot = useCallback((patch: Partial<SlotPosition> & { id: string }) => {
    setState(prev => {
      const cur = prev.slots[patch.id];
      // Same defensive merge as usePeerMesh.updateSlot: a partial patch (e.g.
      // just a z bump on focus) must not wipe geometry, and a brand-new slot
      // needs sane fallbacks so it doesn't snap to a tiny default mid-drag.
      const merged: SlotPosition = cur
        ? { ...cur, ...patch }
        : {
            id: patch.id,
            x: patch.x ?? 80,
            y: patch.y ?? 80,
            width: patch.width ?? 360,
            height: patch.height ?? 260,
            z: patch.z ?? 50,
          };
      return { ...prev, slots: { ...prev.slots, [patch.id]: merged } };
    });
  }, []);

  const openWindowIds = useMemo(() => new Set(state.open), [state.open]);

  return useMemo(
    () => ({ slots: state.slots, openWindowIds, openWindow, closeWindow, toggleWindow, updateSlot }),
    [state.slots, openWindowIds, openWindow, closeWindow, toggleWindow, updateSlot],
  );
}

export default useLocalWindows;

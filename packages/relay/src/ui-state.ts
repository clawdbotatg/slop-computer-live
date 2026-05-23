// Per-key shared UI state for the room — the "which tab am I on, which
// item is selected" layer that scroll-sync doesn't cover. Last-writer-
// wins. Unlike scroll-sync, no detach grace: when a peer clicks a
// different tab, every peer flips immediately, because that's the
// whole point ("look at this one"). Detach grace only makes sense for
// continuous gestures.
//
// Why a separate subsystem from ScrollSync:
//  • Different value type (arbitrary JSON, not a 0..1 frac) — keeping
//    them split means the wire format for each can evolve without
//    touching the other.
//  • Different conflict model (last-writer-wins vs detach-on-local).
//  • Different cadence (scroll fires every frame at full bore;
//    selection changes are sparse clicks).
//
// Persisted? No — like scroll-sync, this is transient UI hint state.
// If the relay restarts, peers fall back to whatever local default
// their hook was initialized with until the next click broadcasts.
// Persistence could be added later if we find ourselves wanting tab
// state to survive a deploy.
//
// Value size is capped server-side (4KB serialized) so a misbehaving
// client can't blow up the map. Surface ids ("wallet:tab",
// "notes:selectedId", …) are short by convention.

const MAX_VALUE_BYTES = 4096;

export type UIStateSnapshot = {
  /** Arbitrary JSON value the caller wants to share. Typed as unknown
   *  on the relay; the consumer hook re-types locally via generics. */
  value: unknown;
  /** Date.now() of the writer; used for tie-break / debug. */
  at: number;
};

export type UIStateEvent = {
  key: string;
  state: UIStateSnapshot;
};

type Listener = (event: UIStateEvent) => void;

export class UIState {
  private states = new Map<string, UIStateSnapshot>();
  private listeners: Listener[] = [];

  get(key: string): UIStateSnapshot | null {
    return this.states.get(key) ?? null;
  }

  /** Set returns the stored snapshot, or null if the value was too big
   *  to serialize within the per-entry cap (caller can decide whether
   *  to error or silently drop — index.ts surfaces it as `bad_ui_state`). */
  set(key: string, state: UIStateSnapshot): UIStateSnapshot | null {
    try {
      if (JSON.stringify(state.value).length > MAX_VALUE_BYTES) return null;
    } catch {
      // Non-serializable (cycles, BigInt, …) → reject.
      return null;
    }
    this.states.set(key, state);
    this.notify({ key, state });
    return state;
  }

  /** Snapshot of every active key. Used by hello + /v1/state to
   *  hydrate a fresh client. Returned as an array so it serializes
   *  cleanly over JSON / WS without losing map keys. */
  all(): Array<{ key: string; state: UIStateSnapshot }> {
    return Array.from(this.states.entries()).map(([key, state]) => ({ key, state }));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private notify(event: UIStateEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* ignore */
      }
    }
  }
}

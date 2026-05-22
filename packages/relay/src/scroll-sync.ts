// Per-surface scroll position shared across the room. Any scrollable
// dialog/panel (transcript, chat, notes, research, news, todo, wallet
// tabs, etc.) reports its scroll position as a 0..1 fraction keyed by
// a stable surface id. Peers in the same room follow along.
//
// Why a separate subsystem from PreviewMedia:
//  • PreviewMedia is keyed by fileId and conflates playback state with
//    text scroll. ScrollSync is keyed by an arbitrary surface id and
//    only carries scroll. Different lifecycle (surfaces are static,
//    files come and go), different semantics, different consumers.
//  • Keeping them separate means the Hello payload + WS routing for
//    one can change without entangling the other.
//
// Not persisted; the map resets on relay restart by design (scroll
// position is transient UI state). On reconnect, hello carries the
// current snapshot so a late joiner whose UI opens the same surface
// immediately picks up the room's read position.

export type ScrollSnapshot = {
  /** 0..1 scroll position (scrollTop / (scrollHeight - clientHeight)) */
  frac: number;
  /** Date.now() of the snapshot, used for tie-break / debugging */
  at: number;
};

export type ScrollSyncEvent = {
  key: string;
  state: ScrollSnapshot;
};

type Listener = (event: ScrollSyncEvent) => void;

export class ScrollSync {
  private states = new Map<string, ScrollSnapshot>();
  private listeners: Listener[] = [];

  get(key: string): ScrollSnapshot | null {
    return this.states.get(key) ?? null;
  }

  set(key: string, state: ScrollSnapshot): ScrollSnapshot {
    this.states.set(key, state);
    this.notify({ key, state });
    return state;
  }

  /** Snapshot of every active scroll position. Used by hello + /v1/state
   *  to hydrate a fresh client. Returned as an array so it serializes
   *  cleanly over JSON / WS without losing map keys. */
  all(): Array<{ key: string; state: ScrollSnapshot }> {
    return Array.from(this.states.entries()).map(([key, state]) => ({ key, state }));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private notify(event: ScrollSyncEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* ignore */
      }
    }
  }
}

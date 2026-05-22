// Per-file audio/video playback state shared across the room's file
// previews. A FilePreviewWindow's <audio> or <video> element keeps
// its `currentTime` and play/pause flag in lockstep with whatever
// this Map says — so when the host hits play on an uploaded video,
// every peer's preview window plays from the same frame at the same
// moment, and seeking pulls the whole room along.
//
// Why per-file: multiple preview windows can be open simultaneously
// (host opens a slide PDF, a song, and a clip; spectators each pick
// which to focus on). Each file's playhead lives independently. Text
// / image / PDF previews don't broadcast anything — they're rendered
// statelessly, and PDF page navigation is left local for now.
//
// Not persisted; the map resets on relay restart by design (audio /
// video state is transient by nature). On reconnect, hello carries
// the current snapshot so a late joiner who opens the same file
// immediately picks up the in-progress playback.
//
// State entries don't get auto-evicted on file delete — the
// preview window unmounts when the file row disappears, so its sync
// effect detaches naturally. The stale map entry is harmless; it
// just costs ~80 bytes per dead file id until relay restart.

export type MediaSnapshot = {
  /** seconds into the file at moment `at` */
  position: number;
  playing: boolean;
  /** Date.now() of the snapshot, used to extrapolate live position */
  at: number;
};

export type PreviewMediaEvent = {
  fileId: string;
  state: MediaSnapshot;
};

type Listener = (event: PreviewMediaEvent) => void;

export class PreviewMedia {
  private states = new Map<string, MediaSnapshot>();
  private listeners: Listener[] = [];

  get(fileId: string): MediaSnapshot | null {
    return this.states.get(fileId) ?? null;
  }

  set(fileId: string, state: MediaSnapshot): MediaSnapshot {
    this.states.set(fileId, state);
    this.notify({ fileId, state });
    return state;
  }

  /** Snapshot of every active playhead. Used by hello + /v1/state to
   *  hydrate a fresh client. Returned as an array so it serializes
   *  cleanly over JSON / WS without losing map keys. */
  all(): Array<{ fileId: string; state: MediaSnapshot }> {
    return Array.from(this.states.entries()).map(([fileId, state]) => ({ fileId, state }));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private notify(event: PreviewMediaEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* ignore */
      }
    }
  }
}

// Per-file preview UI state shared across the room's file previews.
// Two kinds of state ride this one map, keyed by fileId:
//
//  • audio / video — a FilePreviewWindow's <audio>/<video> element
//    keeps its `currentTime` + play/pause flag in lockstep with the
//    snapshot, so a host pressing play / seeking pulls the room along.
//
//  • text — a text preview's <pre> broadcasts its scroll position as
//    a 0..1 fraction (`scrollFrac`), so the room can read-along with
//    whoever's driving. `position` / `playing` are unused for text
//    (sent as 0 / false); `scrollFrac` is unused for media.
//
// A single file is exactly one kind, so the two never collide on the
// same fileId — that's why they share the map rather than each
// getting their own subsystem.
//
// Why per-file: multiple preview windows can be open simultaneously
// (host opens a slide PDF, a song, and a clip; spectators each pick
// which to focus on). Each file's state lives independently. Image
// and PDF previews still broadcast nothing — images are static and
// the PDF iframe is a native viewer we can't drive.
//
// Not persisted; the map resets on relay restart by design (preview
// UI state is transient by nature). On reconnect, hello carries the
// current snapshot so a late joiner who opens the same file
// immediately picks up the in-progress playback / scroll position.
//
// State entries don't get auto-evicted on file delete — the
// preview window unmounts when the file row disappears, so its sync
// effect detaches naturally. The stale map entry is harmless; it
// just costs ~80 bytes per dead file id until relay restart.

export type MediaSnapshot = {
  /** seconds into the file at moment `at` (audio/video only) */
  position: number;
  playing: boolean;
  /** Date.now() of the snapshot, used to extrapolate live position */
  at: number;
  /** 0..1 scroll position (text previews only); absent for media */
  scrollFrac?: number;
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

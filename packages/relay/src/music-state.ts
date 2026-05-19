// Per-room music-player state — shared across the mesh within a room.
// When any peer presses play/pause/seek/next, they push a snapshot here;
// we rebroadcast it so every other peer can keep their local <audio> in
// lockstep. Not persisted; transient session state, lost on relay
// restart. (Persisting would let an agent DJ resume mid-track, but
// that's a Phase 4 concern — for now music state is in-memory only.)

export type MusicSnapshot = {
  src: string | null;
  index: number;
  playing: boolean;
  /** seconds into the track at `at` */
  position: number;
  /** Date.now() when this snapshot was captured */
  at: number;
  /** 0..1 master volume — shared so peers stay in lockstep */
  volume: number;
};

type Waiter = { wake: () => void; cleanup: () => void };

export class MusicState {
  private snapshot: MusicSnapshot | null = null;
  // Bumped on every set. Lets an agent DJ-loop (long-poll → react →
  // set → poll again) wait cheaply for the track to end or for
  // another peer to change the snapshot.
  private version = 0;
  private waiters: Waiter[] = [];

  current(): { state: MusicSnapshot | null; version: number } {
    return { state: this.snapshot, version: this.version };
  }

  /** Replace the snapshot. Caller is responsible for any side effects
   *  (broadcast to room peers, etc.). */
  set(next: MusicSnapshot): MusicSnapshot {
    this.snapshot = next;
    this.bumpVersion();
    return next;
  }

  /** Look at the cached volume so callers can default to it when a
   *  client omits volume from their snapshot. */
  cachedVolume(): number | null {
    return this.snapshot?.volume ?? null;
  }

  /** Register a long-poll waiter. Returns its index — caller is expected
   *  to call `removeWaiter` if the request closes before bumpVersion
   *  fires the cleanup. */
  pushWaiter(entry: Waiter): void {
    this.waiters.push(entry);
  }

  removeWaiter(entry: Waiter): void {
    const idx = this.waiters.findIndex(x => x === entry);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }

  private bumpVersion(): void {
    this.version++;
    const woke = this.waiters.splice(0);
    for (const w of woke) {
      try {
        w.cleanup();
      } catch {
        /* ignore */
      }
      try {
        w.wake();
      } catch {
        /* ignore */
      }
    }
  }
}

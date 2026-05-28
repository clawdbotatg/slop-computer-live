// Per-room music-player state — shared across the mesh within a room.
// When any peer presses play/pause/seek/next, they push a snapshot here;
// we rebroadcast it so every other peer can keep their local <audio> in
// lockstep.
//
// Persisted to disk so the music survives a relay restart (e.g. a
// production deploy). Without this, every `./ops/deploy.sh` would
// silently stop music mid-track: clients' WS reconnects to the new
// relay, ask for the snapshot, the relay says "no music", and listeners
// sit in confused silence.
//
// On load we freeze `at = Date.now()` and keep the saved `position`
// verbatim. The alternative — letting livePosition() advance through
// the outage — would make the track skip forward by the deploy
// duration on the listener side. Freezing means the music resumes
// from exactly where it was, with only the actual silence gap of the
// deploy. The few seconds of dead-air during the restart is the same
// either way; this just avoids the artificial "jump."

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

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
  private loaded = false;
  private saveQueued = false;

  constructor(private readonly filePath: string | null = null) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      // Validate the shape — old/corrupted files shouldn't crash the
      // relay on startup. Anything off and we start fresh.
      const p = parsed as Record<string, unknown>;
      if (typeof p.index !== "number") return;
      if (typeof p.playing !== "boolean") return;
      if (typeof p.position !== "number") return;
      if (typeof p.volume !== "number") return;
      if (p.src !== null && typeof p.src !== "string") return;
      // Freeze `at` to now() so livePosition() resumes at the saved
      // `position` rather than advancing through the deploy gap.
      this.snapshot = {
        src: p.src,
        index: p.index,
        playing: p.playing,
        position: p.position,
        at: Date.now(),
        volume: p.volume,
      };
    } catch {
      /* missing or unparseable — start fresh */
    }
  }

  private scheduleSave(): void {
    if (!this.filePath || this.saveQueued) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      if (!this.filePath || !this.snapshot) return;
      try {
        writeFileAtomic(this.filePath, JSON.stringify(this.snapshot));
      } catch (err) {
        console.error("[music] failed to persist:", err);
      }
    });
  }

  current(): { state: MusicSnapshot | null; version: number } {
    this.load();
    return { state: this.snapshot, version: this.version };
  }

  /** Replace the snapshot. Caller is responsible for any side effects
   *  (broadcast to room peers, etc.). */
  set(next: MusicSnapshot): MusicSnapshot {
    this.load();
    this.snapshot = next;
    this.bumpVersion();
    this.scheduleSave();
    return next;
  }

  /** Look at the cached volume so callers can default to it when a
   *  client omits volume from their snapshot. */
  cachedVolume(): number | null {
    this.load();
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

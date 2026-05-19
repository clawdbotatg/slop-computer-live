import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room metadata that doesn't belong with any one subsystem:
//   - `name` is the human label (defaults to the slug)
//   - `paidUntil` is the unix-seconds timestamp through which the room is
//     kept hot; the hibernation tick won't drop a room while this is in
//     the future, and a cold room can be revived by extending it
//   - `lastSeenAt` is the unix-ms of the last peer connect or mutation;
//     drives the idle-hibernate decision once `paidUntil` has lapsed
//
// Persisted to `meta.json`. Separate from `auth.json` (RoomAuth) so the
// scrypt-hashed password stays in its own file — Phase 4's IPFS-or-NFT
// future likely wants meta.json content-addressable independent of the
// password.

type RoomMetaState = {
  name: string;
  paidUntil: number; // unix seconds; 0 = unpaid
  lastSeenAt: number; // unix ms
  createdAt: number; // unix ms
};

export class RoomMeta {
  private state: RoomMetaState;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly slug: string,
  ) {
    this.state = { name: slug, paidUntil: 0, lastSeenAt: Date.now(), createdAt: Date.now() };
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RoomMetaState>;
      this.state = {
        name: typeof parsed.name === "string" ? parsed.name : this.slug,
        paidUntil: typeof parsed.paidUntil === "number" ? parsed.paidUntil : 0,
        lastSeenAt: typeof parsed.lastSeenAt === "number" ? parsed.lastSeenAt : Date.now(),
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      };
    } catch {
      /* fresh — keep constructor defaults */
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify(this.state));
    } catch {
      /* disk write failed — in-memory state still valid until next restart */
    }
  }

  /** True if this room's meta file exists on disk. Used by the
   *  hibernation revive path to distinguish "cold room (state on disk,
   *  needs revive)" from "never-existed room (no state, just open it)". */
  static existsOnDisk(filePath: string): boolean {
    return existsSync(filePath);
  }

  getName(): string {
    this.load();
    return this.state.name;
  }

  setName(name: string): void {
    this.load();
    if (this.state.name === name) return;
    this.state.name = name;
    this.persist();
  }

  /** Returns the unix-seconds the room is paid through. 0 means unpaid. */
  getPaidUntil(): number {
    this.load();
    return this.state.paidUntil;
  }

  /** Extend payment to `unixSeconds`. Lower-than-current values are no-ops
   *  — payment can only ratchet forward, never get clawed back. */
  setPaidUntil(unixSeconds: number): void {
    this.load();
    if (unixSeconds <= this.state.paidUntil) return;
    this.state.paidUntil = unixSeconds;
    this.persist();
  }

  isPaid(now: number = Math.floor(Date.now() / 1000)): boolean {
    this.load();
    return this.state.paidUntil > now;
  }

  getLastSeenAt(): number {
    this.load();
    return this.state.lastSeenAt;
  }

  /** Stamp `lastSeenAt = now`. Coalesces persistence — caller may invoke
   *  on every peer mutation without flooding disk; we write at most once
   *  per LAST_SEEN_FLUSH_MS, otherwise just update the in-memory value. */
  touchLastSeen(): void {
    this.load();
    const now = Date.now();
    const elapsedSinceFlush = now - this.lastSeenFlushedAt;
    this.state.lastSeenAt = now;
    if (elapsedSinceFlush >= LAST_SEEN_FLUSH_MS) {
      this.lastSeenFlushedAt = now;
      this.persist();
    }
  }

  /** Flush whatever's pending. Called before hibernation so the on-disk
   *  state matches in-memory at the moment we drop the slice. */
  flush(): void {
    this.load();
    this.lastSeenFlushedAt = Date.now();
    this.persist();
  }

  getCreatedAt(): number {
    this.load();
    return this.state.createdAt;
  }

  private lastSeenFlushedAt = 0;
}

// Don't write to disk more often than once a minute under the touchLastSeen
// firehose. Idle threshold for hibernation is on the order of days; a
// minute of slop on the lastSeenAt timestamp is fine.
const LAST_SEEN_FLUSH_MS = 60_000;

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Long-running, dedup-by-address record of everyone who joined this room's
// desktop mesh during the episode (i.e. everyone `Room.addPeer` was called
// for). Persists to JSONL alongside chat/transcript and is snapshotted into
// `manifest.participants` at finalize.
//
// "Participants" not "guests" because the host shows up here too — the role
// field distinguishes. Spectators (SIWE'd chat-only viewers) don't reach
// addPeer, so they're not included; anon desktop peers (no address) are also
// skipped — the manifest only carries identified participants.
//
// First-seen wins: if the same wallet joins, leaves, and rejoins (or comes
// back as a different role), only the first observation lands in the list.

export type ParticipantEntry = {
  /** Lowercased 0x... — the dedup key. Never null in the persisted list. */
  address: string;
  handle: string | null;
  role: "host" | "guest";
  /** ms epoch when this address was first recorded. */
  firstSeenAt: number;
};

type Subscriber = (entry: ParticipantEntry) => void;

export class Participants {
  private byAddress = new Map<string, ParticipantEntry>();
  private loaded = false;
  private subscribers = new Set<Subscriber>();

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          const entry = JSON.parse(s) as ParticipantEntry;
          if (entry.address && !this.byAddress.has(entry.address)) {
            this.byAddress.set(entry.address, entry);
          }
        } catch {
          /* skip corrupt line */
        }
      }
    } catch {
      /* file doesn't exist yet — fine */
    }
  }

  private persist(entry: ParticipantEntry): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[participants] persist failed", err);
    }
  }

  /** Record a peer's first join. No-op for anon peers (no address) and for
   *  already-recorded addresses. Returns the newly-recorded entry or null. */
  record(peer: { address: string | null; handle: string | null; role: "host" | "guest" }): ParticipantEntry | null {
    this.load();
    const address = peer.address?.toLowerCase();
    if (!address) return null;
    if (this.byAddress.has(address)) return null;
    const entry: ParticipantEntry = {
      address,
      handle: peer.handle,
      role: peer.role,
      firstSeenAt: Date.now(),
    };
    this.byAddress.set(address, entry);
    this.persist(entry);
    for (const sub of this.subscribers) {
      try {
        sub(entry);
      } catch {
        /* one bad sub shouldn't kill the rest */
      }
    }
    return entry;
  }

  /** All recorded participants in insertion order. */
  list(): ParticipantEntry[] {
    this.load();
    return [...this.byAddress.values()];
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** Wipe both in-memory and on-disk. Only triggered manually — never
   *  auto-cleared on finalize (re-finalize must produce the same list). */
  clear(): { clearedCount: number } {
    this.load();
    const clearedCount = this.byAddress.size;
    this.byAddress.clear();
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, "", "utf8");
    } catch {
      /* ignore */
    }
    return { clearedCount };
  }
}

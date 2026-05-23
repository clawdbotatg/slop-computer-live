import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Long-running, dedup record of everyone who joined this room's desktop mesh
// during the episode (i.e. everyone `Room.addPeer` was called for). Persists
// to JSONL alongside chat/transcript and is snapshotted into
// `manifest.participants` at finalize.
//
// "Participants" not "guests" because the host shows up here too — the role
// field distinguishes. Spectators (SIWE'd chat-only viewers) don't reach
// addPeer, so they're not included. Anon peers (no address) ARE included,
// keyed by their stable session `anonId`; the manifest renders them by the
// custom name they chose via /auth/handle (falling back to their initial
// AnonXXXX handle).
//
// First-seen wins: if the same wallet/anonId joins, leaves, and rejoins (or
// comes back as a different role), only the first observation lands in the
// list.

export type ParticipantEntry = {
  /** Lowercased 0x... for SIWE/passkey peers; null for anon peers. */
  address: string | null;
  /** Stable per-session anon id for anon peers; null for SIWE/passkey peers.
   *  Exactly one of {address, anonId} is non-null. */
  anonId: string | null;
  handle: string | null;
  role: "host" | "guest";
  /** ms epoch when this peer was first recorded. */
  firstSeenAt: number;
};

type Subscriber = (entry: ParticipantEntry) => void;

export class Participants {
  // Keyed by lowercased address for SIWE/passkey peers, or by anonId for anon
  // peers. The two keyspaces don't collide (addresses start with `0x`, anonIds
  // start with `anon-`), so a single map is safe.
  private byKey = new Map<string, ParticipantEntry>();
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
          const parsed = JSON.parse(s) as Partial<ParticipantEntry>;
          // Backfill anonId on legacy JSONL lines that pre-date the field.
          const entry: ParticipantEntry = {
            address: parsed.address ?? null,
            anonId: parsed.anonId ?? null,
            handle: parsed.handle ?? null,
            role: parsed.role === "host" ? "host" : "guest",
            firstSeenAt: typeof parsed.firstSeenAt === "number" ? parsed.firstSeenAt : Date.now(),
          };
          const key = entry.address ?? entry.anonId;
          if (key && !this.byKey.has(key)) {
            this.byKey.set(key, entry);
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

  /** Record a peer's first join. Skips peers with neither an address nor an
   *  anonId (shouldn't happen in practice) and dedupes by whichever key the
   *  peer carries. Returns the newly-recorded entry or null. */
  record(peer: {
    address: string | null;
    anonId: string | null;
    handle: string | null;
    role: "host" | "guest";
  }): ParticipantEntry | null {
    this.load();
    const address = peer.address?.toLowerCase() ?? null;
    const anonId = peer.anonId ?? null;
    const key = address ?? anonId;
    if (!key) return null;
    if (this.byKey.has(key)) return null;
    const entry: ParticipantEntry = {
      address,
      anonId,
      handle: peer.handle,
      role: peer.role,
      firstSeenAt: Date.now(),
    };
    this.byKey.set(key, entry);
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
    return [...this.byKey.values()];
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** Wipe both in-memory and on-disk. Only triggered manually — never
   *  auto-cleared on finalize (re-finalize must produce the same list). */
  clear(): { clearedCount: number } {
    this.load();
    const clearedCount = this.byKey.size;
    this.byKey.clear();
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, "", "utf8");
    } catch {
      /* ignore */
    }
    return { clearedCount };
  }
}

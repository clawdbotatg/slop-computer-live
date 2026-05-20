import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// User-chosen display names, keyed by lowercased Ethereum address.
// Global across rooms — set it once, follows you everywhere.
//
// Custom name wins over ENS in the display fallback chain; we trust the
// user's stated preference over reverse-lookup. Persistence is a single
// JSON file at .slop-data/peer-names.json (process cwd), atomically
// rewritten on each change so a crash mid-write can't leave a half-flushed
// file.

const NAMES_FILE = process.env.PEER_NAMES_FILE ?? "./.slop-data/peer-names.json";

export const MAX_NAME_LEN = 30;

/** Display-name validation. Trims surrounding whitespace, strips ASCII
 *  control characters (NUL..US + DEL), and truncates to MAX_NAME_LEN.
 *  Returns `null` if the result is empty — caller treats `null` as
 *  "clear the name". */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 32 || code === 127) continue;
    out += raw[i];
  }
  const trimmed = out.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_NAME_LEN ? trimmed.slice(0, MAX_NAME_LEN) : trimmed;
}

type Subscriber = (address: string, name: string | null) => void;

class PeerNames {
  private names = new Map<string, string>();
  private loaded = false;
  private subscribers = new Set<Subscriber>();

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(NAMES_FILE, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [addr, name] of Object.entries(parsed)) {
        if (typeof name === "string") this.names.set(addr.toLowerCase(), name);
      }
    } catch {
      /* missing or unparseable — start empty */
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(NAMES_FILE, JSON.stringify(Object.fromEntries(this.names)));
    } catch {
      /* disk write failed — name stays in memory until next attempt */
    }
  }

  /** Look up the chosen name for an address, or null if none set. */
  get(address: string | null | undefined): string | null {
    if (!address) return null;
    this.load();
    return this.names.get(address.toLowerCase()) ?? null;
  }

  /** Returns the full address → name map (for hello payloads). */
  all(): Record<string, string> {
    this.load();
    return Object.fromEntries(this.names);
  }

  /** Set or clear a name. Passing `null` (or a string that normalizes to
   *  empty) removes the entry. Returns the normalized name actually
   *  stored, or `null` if cleared. */
  set(address: string, raw: string | null): string | null {
    this.load();
    const key = address.toLowerCase();
    const next = raw == null ? null : normalizeName(raw);
    const prev = this.names.get(key) ?? null;
    if (prev === next) return next;
    if (next == null) this.names.delete(key);
    else this.names.set(key, next);
    this.persist();
    for (const fn of this.subscribers) {
      try {
        fn(key, next);
      } catch {
        /* one bad sub shouldn't kill the rest */
      }
    }
    return next;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

export const peerNames = new PeerNames();

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-guest "hide my USD balance from the room" flag, keyed by the
// guest's stable id (lowercased Ethereum address for SIWE/passkey,
// anonId for anon). Global across rooms — set it once and your balance
// stays hidden everywhere you appear, exactly like the custom-name
// preference in peer-names.ts (the closest sibling pattern).
//
// Only `true` (hidden) entries are stored; absence means visible. This
// keeps the persisted file and the hello payload to the small set of
// guests who actually opted out. Persistence is a single JSON file at
// .slop-data/balance-hidden.json (process cwd), atomically rewritten on
// each change so a crash mid-write can't leave a half-flushed file.

const HIDDEN_FILE = process.env.BALANCE_HIDDEN_FILE ?? "./.slop-data/balance-hidden.json";

type Subscriber = (id: string, hidden: boolean) => void;

class BalanceVisibility {
  private hidden = new Set<string>();
  private loaded = false;
  private subscribers = new Set<Subscriber>();

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(HIDDEN_FILE, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const id of parsed) if (typeof id === "string") this.hidden.add(id.toLowerCase());
      }
    } catch {
      /* missing or unparseable — start empty */
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(HIDDEN_FILE, JSON.stringify([...this.hidden]));
    } catch {
      /* disk write failed — flag stays in memory until next attempt */
    }
  }

  /** True if this guest has hidden their balance. */
  get(id: string | null | undefined): boolean {
    if (!id) return false;
    this.load();
    return this.hidden.has(id.toLowerCase());
  }

  /** All ids whose balance is currently hidden (for hello payloads). */
  all(): string[] {
    this.load();
    return [...this.hidden];
  }

  /** Set or clear the hidden flag. Returns the value actually stored.
   *  No-ops (and skips the broadcast) when the value is unchanged. */
  set(id: string, hidden: boolean): boolean {
    this.load();
    const key = id.toLowerCase();
    const prev = this.hidden.has(key);
    if (prev === hidden) return hidden;
    if (hidden) this.hidden.add(key);
    else this.hidden.delete(key);
    this.persist();
    for (const fn of this.subscribers) {
      try {
        fn(key, hidden);
      } catch {
        /* one bad sub shouldn't kill the rest */
      }
    }
    return hidden;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

export const balanceVisibility = new BalanceVisibility();

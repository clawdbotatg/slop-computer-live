import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Per-room chat log. In-memory ring of the last MAX messages, mirrored
// to an append-only JSONL file so a relay restart replays the recent
// scrollback. No DB — the relay's other state (sessions, slots, avatars)
// follows the same simple pattern.

const MAX_HISTORY = 200;

export type ChatMessage = {
  id: string;
  // Server-stamped — ms epoch.
  ts: number;
  // Wallet address (lowercased) when the sender authed via SIWE/passkey,
  // null for the rare case of an admin-pinged system message.
  address: string | null;
  // ENS / handle if available; falls back to short address client-side.
  handle: string | null;
  // Message text. Already trimmed + length-capped at acceptance time.
  text: string;
  // "live" = signed-in user inside the desktop session, "spectator" = SIWE
  // sign-in from slop.computer, "agent" = bearer-token AI. Lets the UI
  // tag/style messages distinctly.
  source: "live" | "spectator" | "agent";
};

export const MAX_TEXT_LEN = 500;

type Subscriber = (msg: ChatMessage) => void;

const BURST = 5;
const REFILL_PER_SEC = 1;

export class ChatHistory {
  private buffer: ChatMessage[] = [];
  private loaded = false;
  private subscribers = new Set<Subscriber>();
  // Soft per-address rate limit — allow a small burst then 1 msg/sec sustained.
  // Tracked in memory per room; a relay restart resets it (acceptable, it's a
  // soft cap).
  private lastBy = new Map<string, { ts: number; tokens: number }>();

  constructor(
    private readonly filePath: string,
    private readonly legacyPath: string | null = null,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.readFrom(this.filePath)) return;
    if (this.legacyPath) this.readFrom(this.legacyPath);
  }

  private readFrom(path: string): boolean {
    try {
      const raw = readFileSync(path, "utf8");
      const lines = raw.split("\n").filter(l => l.trim());
      // Take only the tail; older messages are kept on disk but not in memory.
      const tail = lines.slice(-MAX_HISTORY);
      for (const line of tail) {
        try {
          this.buffer.push(JSON.parse(line) as ChatMessage);
        } catch {
          /* skip corrupt line */
        }
      }
      return this.buffer.length > 0;
    } catch {
      return false;
    }
  }

  private persist(msg: ChatMessage): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(msg) + "\n", "utf8");
    } catch {
      // Disk write failed — log stays in memory. We don't want a full disk
      // to take down chat entirely.
    }
  }

  // Caller is responsible for auth + rate limiting. This just normalizes
  // the payload, stamps server fields, persists, and returns the canonical
  // message.
  append(input: {
    address: string | null;
    handle: string | null;
    text: string;
    source: ChatMessage["source"];
  }): ChatMessage | null {
    this.load();
    const text = input.text.trim().slice(0, MAX_TEXT_LEN);
    if (!text) return null;
    const msg: ChatMessage = {
      id: randomBytes(8).toString("hex"),
      ts: Date.now(),
      address: input.address ? input.address.toLowerCase() : null,
      handle: input.handle ?? null,
      text,
      source: input.source,
    };
    this.buffer.push(msg);
    if (this.buffer.length > MAX_HISTORY) this.buffer = this.buffer.slice(-MAX_HISTORY);
    this.persist(msg);
    for (const fn of this.subscribers) {
      try {
        fn(msg);
      } catch {
        /* one bad sub shouldn't kill the rest */
      }
    }
    return msg;
  }

  recent(): ChatMessage[] {
    this.load();
    return [...this.buffer];
  }

  // Read the full on-disk JSONL log + count of non-empty lines. Used at
  // finalize time to pin a snapshot to IPFS; the in-memory `buffer` only
  // holds the last MAX_HISTORY messages so we go to disk for the archive.
  readArchive(): { content: string; messageCount: number } | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return null;
    }
    let messageCount = 0;
    for (const line of raw.split("\n")) {
      if (line.trim()) messageCount++;
    }
    return { content: raw, messageCount };
  }

  allow(addressOrTok: string): boolean {
    const now = Date.now();
    const entry = this.lastBy.get(addressOrTok) ?? { ts: now, tokens: BURST };
    const elapsed = (now - entry.ts) / 1000;
    const tokens = Math.min(BURST, entry.tokens + elapsed * REFILL_PER_SEC);
    if (tokens < 1) {
      this.lastBy.set(addressOrTok, { ts: now, tokens });
      return false;
    }
    this.lastBy.set(addressOrTok, { ts: now, tokens: tokens - 1 });
    return true;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}

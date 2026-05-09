import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Single global chat log. In-memory ring of the last MAX messages, mirrored
// to an append-only JSONL file so a relay restart replays the recent
// scrollback. No DB — the relay's other state (sessions, slots, avatars)
// follows the same simple pattern.
//
// Persistence path is overridable via env so the systemd unit can pin it
// to /var/lib/slop-relay/chat.jsonl on the box.

const CHAT_LOG_FILE = process.env.CHAT_LOG_FILE ?? "./.slop-data/chat.jsonl";
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

let buffer: ChatMessage[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(CHAT_LOG_FILE, "utf8");
    const lines = raw.split("\n").filter(l => l.trim());
    // Take only the tail; older messages are kept on disk but not in memory.
    const tail = lines.slice(-MAX_HISTORY);
    for (const line of tail) {
      try {
        buffer.push(JSON.parse(line) as ChatMessage);
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* fresh log */
  }
}

function persist(msg: ChatMessage): void {
  try {
    mkdirSync(dirname(CHAT_LOG_FILE), { recursive: true });
    appendFileSync(CHAT_LOG_FILE, JSON.stringify(msg) + "\n", "utf8");
  } catch {
    // Disk write failed — log stays in memory. We don't want a full disk
    // to take down chat entirely.
  }
}

export const MAX_TEXT_LEN = 500;

// Caller is responsible for auth + rate limiting. This just normalizes the
// payload, stamps server fields, persists, and returns the canonical message.
export function append(input: {
  address: string | null;
  handle: string | null;
  text: string;
  source: ChatMessage["source"];
}): ChatMessage | null {
  load();
  const text = input.text.trim().slice(0, MAX_TEXT_LEN);
  if (!text) return null;
  const msg: ChatMessage = {
    id: cryptoRandomId(),
    ts: Date.now(),
    address: input.address ? input.address.toLowerCase() : null,
    handle: input.handle ?? null,
    text,
    source: input.source,
  };
  buffer.push(msg);
  if (buffer.length > MAX_HISTORY) buffer = buffer.slice(-MAX_HISTORY);
  persist(msg);
  for (const fn of subscribers) {
    try {
      fn(msg);
    } catch {
      /* one bad sub shouldn't kill the rest */
    }
  }
  return msg;
}

export function recent(): ChatMessage[] {
  load();
  return [...buffer];
}

// Soft per-address rate limit — allow a small burst then 1 msg/sec sustained.
// Tracked in memory; a relay restart resets it (acceptable, it's a soft cap).
const lastBy = new Map<string, { ts: number; tokens: number }>();
const BURST = 5;
const REFILL_PER_SEC = 1;

export function allow(addressOrTok: string): boolean {
  const now = Date.now();
  const entry = lastBy.get(addressOrTok) ?? { ts: now, tokens: BURST };
  const elapsed = (now - entry.ts) / 1000;
  const tokens = Math.min(BURST, entry.tokens + elapsed * REFILL_PER_SEC);
  if (tokens < 1) {
    lastBy.set(addressOrTok, { ts: now, tokens });
    return false;
  }
  lastBy.set(addressOrTok, { ts: now, tokens: tokens - 1 });
  return true;
}

type Subscriber = (msg: ChatMessage) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function cryptoRandomId(): string {
  // Match the existing convention (browsers/fanouts use hex ids).
  return randomBytes(8).toString("hex");
}

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Live transcript stream. Each peer runs Web Speech in the browser and
// POSTs final segments here; the relay stamps `ts` + identity and persists.
// Mirrors chat.ts (same JSONL-on-disk + in-memory ring pattern) so the
// finalize flow can snapshot it the same way.
//
// Kept as its own module instead of folding into chat because:
// 1) STT cadence is much higher than typed chat (a fast conversation can
//    emit several finals per second across all peers) so the rate limit
//    and ring size need to be larger.
// 2) Consumers can subscribe to one stream without the other (live
//    captions overlay wants transcript only; spectator chat wants chat only).
// 3) The on-IPFS archive is a separate artifact (manifest.transcript vs
//    manifest.chat) — keeping the on-disk file separate avoids a server-
//    side filter step at pin time.

const TRANSCRIPT_LOG_FILE =
  process.env.TRANSCRIPT_LOG_FILE ?? "./.slop-data/transcript.jsonl";
const MAX_HISTORY = 500;

export type TranscriptSegment = {
  id: string;
  // Server-stamped — ms epoch when the segment was received.
  ts: number;
  // Wallet address (lowercased) of the speaker.
  address: string | null;
  // ENS / handle if available; falls back to short address client-side.
  handle: string | null;
  // Final-result text from the speaker's STT engine. Interim results MUST
  // NOT be sent here — they're noisy and self-correct.
  text: string;
  // Same classification as chat: "live" inside the desktop session,
  // "spectator" from slop.computer SIWE, "agent" via bearer token.
  source: "live" | "spectator" | "agent";
};

let buffer: TranscriptSegment[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(TRANSCRIPT_LOG_FILE, "utf8");
    const lines = raw.split("\n").filter(l => l.trim());
    const tail = lines.slice(-MAX_HISTORY);
    for (const line of tail) {
      try {
        buffer.push(JSON.parse(line) as TranscriptSegment);
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* fresh log */
  }
}

function persist(seg: TranscriptSegment): void {
  try {
    mkdirSync(dirname(TRANSCRIPT_LOG_FILE), { recursive: true });
    appendFileSync(TRANSCRIPT_LOG_FILE, JSON.stringify(seg) + "\n", "utf8");
  } catch {
    // Disk write failed — segment stays in memory. We don't want a full
    // disk to kill live transcription entirely.
  }
}

// Larger than typed chat: STT can pop several finals per second across
// multiple peers without being a flood.
export const MAX_TEXT_LEN = 1000;

export function append(input: {
  address: string | null;
  handle: string | null;
  text: string;
  source: TranscriptSegment["source"];
}): TranscriptSegment | null {
  load();
  const text = input.text.trim().slice(0, MAX_TEXT_LEN);
  if (!text) return null;
  const seg: TranscriptSegment = {
    id: cryptoRandomId(),
    ts: Date.now(),
    address: input.address ? input.address.toLowerCase() : null,
    handle: input.handle ?? null,
    text,
    source: input.source,
  };
  buffer.push(seg);
  if (buffer.length > MAX_HISTORY) buffer = buffer.slice(-MAX_HISTORY);
  persist(seg);
  for (const fn of subscribers) {
    try {
      fn(seg);
    } catch {
      /* one bad sub shouldn't kill the rest */
    }
  }
  return seg;
}

export function recent(): TranscriptSegment[] {
  load();
  return [...buffer];
}

// Read the full on-disk JSONL log + segment count. Used at finalize time
// to pin a snapshot to IPFS; the in-memory `buffer` only holds the last
// MAX_HISTORY segments so we go to disk for the archive.
export function readArchive(): { content: string; segmentCount: number } | null {
  let raw: string;
  try {
    raw = readFileSync(TRANSCRIPT_LOG_FILE, "utf8");
  } catch {
    return null;
  }
  let segmentCount = 0;
  for (const line of raw.split("\n")) {
    if (line.trim()) segmentCount++;
  }
  return { content: raw, segmentCount };
}

// Looser than chat: STT cadence can spike to 3-4 finals/sec briefly when
// someone speaks quickly. 20-burst + 2/sec sustained absorbs that without
// becoming an unbounded firehose.
const lastBy = new Map<string, { ts: number; tokens: number }>();
const BURST = 20;
const REFILL_PER_SEC = 2;

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

type Subscriber = (seg: TranscriptSegment) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function cryptoRandomId(): string {
  return randomBytes(8).toString("hex");
}

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Per-room live transcript stream. Each peer runs Web Speech in the
// browser and POSTs final segments here; the relay stamps `ts` +
// identity and persists. Mirrors chat.ts (same JSONL-on-disk +
// in-memory ring pattern) so the finalize flow can snapshot it the
// same way.
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

// Larger than typed chat: STT can pop several finals per second across
// multiple peers without being a flood.
export const MAX_TEXT_LEN = 1000;

type Subscriber = (seg: TranscriptSegment) => void;

// Looser than chat: STT cadence can spike to 3-4 finals/sec briefly when
// someone speaks quickly. 20-burst + 2/sec sustained absorbs that without
// becoming an unbounded firehose.
const BURST = 20;
const REFILL_PER_SEC = 2;

export class Transcript {
  private buffer: TranscriptSegment[] = [];
  private loaded = false;
  private subscribers = new Set<Subscriber>();
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
      const tail = lines.slice(-MAX_HISTORY);
      for (const line of tail) {
        try {
          this.buffer.push(JSON.parse(line) as TranscriptSegment);
        } catch {
          /* skip corrupt line */
        }
      }
      return this.buffer.length > 0;
    } catch {
      return false;
    }
  }

  private persist(seg: TranscriptSegment): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(seg) + "\n", "utf8");
    } catch {
      // Disk write failed — segment stays in memory. We don't want a full
      // disk to kill live transcription entirely.
    }
  }

  append(input: {
    address: string | null;
    handle: string | null;
    text: string;
    source: TranscriptSegment["source"];
  }): TranscriptSegment | null {
    this.load();
    const text = input.text.trim().slice(0, MAX_TEXT_LEN);
    if (!text) return null;
    const seg: TranscriptSegment = {
      id: randomBytes(8).toString("hex"),
      ts: Date.now(),
      address: input.address ? input.address.toLowerCase() : null,
      handle: input.handle ?? null,
      text,
      source: input.source,
    };
    this.buffer.push(seg);
    if (this.buffer.length > MAX_HISTORY) this.buffer = this.buffer.slice(-MAX_HISTORY);
    this.persist(seg);
    for (const fn of this.subscribers) {
      try {
        fn(seg);
      } catch {
        /* one bad sub shouldn't kill the rest */
      }
    }
    return seg;
  }

  recent(): TranscriptSegment[] {
    this.load();
    return [...this.buffer];
  }

  // Wipe the on-disk JSONL + in-memory ring. Called automatically at the
  // end of a successful finalize (the just-pinned manifest captured the
  // archive; next episode starts fresh) and exposed as DELETE /admin/transcript
  // so the host can wipe pre-show test segments.
  clear(): { clearedCount: number } {
    this.load();
    const clearedCount = this.buffer.length;
    this.buffer = [];
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, "", "utf8");
    } catch {
      /* disk write failed — ring is wiped, file may still hold old content */
    }
    return { clearedCount };
  }

  readArchive(): { content: string; segmentCount: number } | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return null;
    }
    let segmentCount = 0;
    for (const line of raw.split("\n")) {
      if (line.trim()) segmentCount++;
    }
    return { content: raw, segmentCount };
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

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

// What produced a segment. Absent ⇒ a spoken line (the original behaviour);
// the rest are in-room *actions* narrated by the relay (someone played a
// track, uploaded a file, proposed a tx, made a notable chess move, won at
// pong, set the on-screen chyron banner, added/removed a desktop app).
// Action rows are archive/poll-only — see room.ts, they're kept out of the
// live `transcript_seg` caption broadcast.
export type TranscriptKind =
  | "speech"
  | "music"
  | "file"
  | "wallet"
  | "chess"
  | "pong"
  | "worm"
  | "chyron"
  | "app"
  | "browser"
  | "card"
  | "research"
  | "leftclaw"
  | "room"
  | "window"
  | "todo"
  | "note"
  | "glossary"
  | "clock"
  | "qr"
  | "avatar"
  | "name";

// Structured bits for an action row (track index, filename, tx target, SAN,
// pong score, …). The rendered one-liner lives in `text`; this is the raw
// data alongside it for any future richer rendering / archive parsing.
export type TranscriptMeta = Record<string, string | number | boolean | null>;

export type TranscriptSegment = {
  id: string;
  // Server-stamped — ms epoch when the segment was received.
  ts: number;
  // Wallet address (lowercased) of the speaker.
  address: string | null;
  // ENS / handle if available; falls back to short address client-side.
  handle: string | null;
  // Stable anon id for anon speakers — lets SlopAddress look up the
  // current display name + keep flag colors stable across renames.
  anonId?: string | null;
  // Final-result text from the speaker's STT engine, OR the rendered
  // one-liner for an action row (which bakes in the actor's name so the
  // archive reads on its own). Interim STT results MUST NOT be sent here.
  text: string;
  // Same classification as chat: "live" inside the desktop session,
  // "spectator" from slop.computer SIWE, "agent" via bearer token.
  source: "live" | "spectator" | "agent";
  // Absent ⇒ speech (every legacy row). Set ⇒ an action row.
  kind?: TranscriptKind;
  // Structured action metadata; only set on action rows.
  meta?: TranscriptMeta;
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

// Content dedupe window. When two STT engines independently transcribe
// the same speech (e.g. two god-mode tabs accidentally open, or the
// old per-browser Web Speech path still running alongside god-mode),
// we'd get back-to-back rows with the same speaker + same (or nearly
// the same) text. Drop the second if it lands within this many ms of
// the previous one with the same address. Keyed on address so two
// people genuinely echoing each other word-for-word still both
// appear; the goal is filtering retransmits, not legitimate repeats.
const DEDUPE_WINDOW_MS = 3500;

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
    anonId?: string | null;
    text: string;
    source: TranscriptSegment["source"];
  }): TranscriptSegment | null {
    this.load();
    const text = input.text.trim().slice(0, MAX_TEXT_LEN);
    if (!text) return null;
    const now = Date.now();
    const addr = input.address ? input.address.toLowerCase() : null;
    const anonId = input.anonId ?? null;
    // Speaker dedupe key: address for SIWE/passkey, anonId for anon.
    // Same identity → same key → dedupe applies; different identities
    // never collapse even if they say the same thing.
    const speakerKey = addr ?? anonId;

    // Content dedupe — see DEDUPE_WINDOW_MS comment. Compare against
    // recent segments from the same speaker. Normalize whitespace +
    // case + trailing punctuation so "Hello." and "hello" collapse
    // (the two STT engines that race during a transition tend to
    // differ on exactly those).
    if (speakerKey) {
      const norm = normalizeForDedupe(text);
      for (let i = this.buffer.length - 1; i >= 0; i--) {
        const prev = this.buffer[i];
        if (!prev) continue;
        if (now - prev.ts > DEDUPE_WINDOW_MS) break;
        const prevKey = prev.address ?? prev.anonId ?? null;
        if (prevKey !== speakerKey) continue;
        if (normalizeForDedupe(prev.text) === norm) return null;
      }
    }

    const seg: TranscriptSegment = {
      id: randomBytes(8).toString("hex"),
      ts: now,
      address: addr,
      handle: input.handle ?? null,
      anonId,
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

  // Narrate an in-room action (music/file/wallet/chess/pong). Shares the
  // ring + persist + subscriber path with `append`, but intentionally
  // SKIPS the content-dedupe and per-speaker rate limit: actions are
  // discrete, deliberate events (two identical txs, the same pawn move in
  // two games) and must never collapse the way racing STT finals do. The
  // relay-side capture points already diff their own state so this never
  // becomes a firehose.
  appendAction(input: {
    kind: TranscriptKind;
    address: string | null;
    handle: string | null;
    anonId?: string | null;
    text: string;
    meta?: TranscriptMeta;
    source?: TranscriptSegment["source"];
  }): TranscriptSegment | null {
    this.load();
    const text = input.text.trim().slice(0, MAX_TEXT_LEN);
    if (!text) return null;
    const seg: TranscriptSegment = {
      id: randomBytes(8).toString("hex"),
      ts: Date.now(),
      address: input.address ? input.address.toLowerCase() : null,
      handle: input.handle ?? null,
      anonId: input.anonId ?? null,
      text,
      source: input.source ?? "live",
      kind: input.kind,
      ...(input.meta ? { meta: input.meta } : {}),
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

  // Wipe the on-disk JSONL + in-memory ring. Only triggered manually now —
  // exposed as DELETE /admin/transcript so the host can wipe pre-show test
  // segments. The transcript is intentionally NEVER auto-cleared after a
  // successful finalize: re-finalize needs to read this file, and the
  // auto-clear it used to do silently produced bare manifests on the
  // second run.
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

// Strip whitespace, lowercase, and remove trailing punctuation so the
// dedupe path sees "Hello, there." and "hello there" as the same row.
// Whisper variants from two independent runs of the same audio
// typically differ on case + commas + periods.
function normalizeForDedupe(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:…"'`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

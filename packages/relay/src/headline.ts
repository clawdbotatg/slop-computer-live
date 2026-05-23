import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room "headline" — a single short string the host writes by hand
// during a live show (or that an AI agent could set from the transcript
// down the line). Renders as a static banner above the Twitter timeline
// bar on every peer's desktop; collapses to zero height when empty so
// the rest of the bar stack doesn't shift around.
//
// Same on-disk + subscribe pattern as Clock — small enough that we
// don't need a richer abstraction, but kept out of RoomMeta so the
// concern stays isolated from auth/payment metadata.

export type HeadlineState = {
  text: string;
  updatedAt: number; // unix ms; 0 when never set
};

const DEFAULT_STATE: HeadlineState = { text: "", updatedAt: 0 };

// Hard ceiling on length — the bar is one line, no scroll. The UI
// will visually truncate before this, but enforcing here keeps a
// runaway agent from parking the whole room transcript in here.
const MAX_LEN = 280;

function sanitize(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
}

type Subscriber = (state: HeadlineState) => void;

export class Headline {
  private state: HeadlineState = DEFAULT_STATE;
  private loaded = false;
  private subscribers = new Set<Subscriber>();

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HeadlineState>;
      this.state = {
        text: sanitize(parsed.text),
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      };
    } catch {
      /* fresh — keep default empty state */
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify(this.state));
    } catch (err) {
      console.warn("[headline] persist failed", err);
    }
  }

  private emit(): void {
    for (const fn of this.subscribers) {
      try {
        fn(this.state);
      } catch {
        /* one bad sub shouldn't kill the rest */
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  getState(): HeadlineState {
    this.load();
    return this.state;
  }

  /** Write the headline. Empty/whitespace-only text clears it. Returns
   *  the resulting state. No-ops (and skips persist/emit) when the
   *  sanitized text matches what's already there. */
  setText(raw: unknown): HeadlineState {
    this.load();
    const text = sanitize(raw);
    if (text === this.state.text) return this.state;
    this.state = { text, updatedAt: Date.now() };
    this.persist();
    this.emit();
    return this.state;
  }
}

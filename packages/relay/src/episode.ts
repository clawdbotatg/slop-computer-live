import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room episode flags the host can flip on the fly. Currently just
// `sttOn` (gates whether peer browsers post Web Speech transcripts to
// /v1/transcript) but built as a stateful class so other flags can
// join (e.g. recording-on, chat-locked) without restructuring.
//
// Persistence is a tiny JSON file so a relay restart mid-show doesn't
// lose the toggle state. State is broadcast on `subscribe(fn)` so SSE
// consumers can push updates to the desktop in real-time.

export type EpisodeState = {
  /** When true, peer browsers run Web Speech and POST final segments to
   *  /v1/transcript. When false, the hook is dormant even with a live mic —
   *  host-controlled so the show can dink around pre-air without polluting
   *  the archive. Defaults to true on a cold start; the host can flip it
   *  off from the admin row if they want a silent warmup. */
  sttOn: boolean;
};

type Subscriber = (s: EpisodeState) => void;

export class EpisodeFlags {
  private state: EpisodeState = { sttOn: true };
  private loaded = false;
  private subscribers = new Set<Subscriber>();

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
      const parsed = JSON.parse(raw) as Partial<EpisodeState>;
      if (typeof parsed.sttOn === "boolean") {
        this.state.sttOn = parsed.sttOn;
        return true;
      }
    } catch {
      /* missing or unparseable */
    }
    return false;
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify(this.state));
    } catch {
      /* disk write failed — state stays in memory; not load-bearing */
    }
  }

  private emit(): void {
    for (const fn of this.subscribers) {
      try {
        fn({ ...this.state });
      } catch {
        /* one bad sub shouldn't kill the rest */
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  getState(): EpisodeState {
    this.load();
    return { ...this.state };
  }

  setSttOn(on: boolean): EpisodeState {
    this.load();
    if (this.state.sttOn === on) return { ...this.state };
    this.state = { ...this.state, sttOn: on };
    this.persist();
    this.emit();
    return { ...this.state };
  }
}

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room episode flags the host (or any participant) can flip on the
// fly. Currently `sttOn` (host-only gate on whether the god-mode box
// generates transcripts at all) and `captionsOn` (anyone-in-the-room
// gate on whether the on-screen subtitle overlay paints). Built as a
// stateful class so other flags can join (e.g. recording-on,
// chat-locked) without restructuring.
//
// Persistence is a tiny JSON file so a relay restart mid-show doesn't
// lose the toggle state. State is broadcast on `subscribe(fn)` so SSE
// consumers can push updates to the desktop in real-time.

export type EpisodeState = {
  /** When true, the god-mode box runs Whisper STT against every peer's
   *  audio and POSTs segments to /v1/transcript/relay. When false, the
   *  pipeline is dormant — host-controlled so the show can dink around
   *  pre-air without polluting the archive. Defaults to true on a cold
   *  start; the host flips it from the admin row. */
  sttOn: boolean;
  /** When true, the SubtitleCaption overlay paints the most recent
   *  transcript segment on screen. When false, transcripts still flow
   *  into the transcript window and archive, but the auto-rising
   *  caption is hidden. Anyone in the room can flip it from the
   *  transcript app — it's a viewing preference, not a kill switch. */
  captionsOn: boolean;
};

type Subscriber = (s: EpisodeState) => void;

export class EpisodeFlags {
  private state: EpisodeState = { sttOn: true, captionsOn: true };
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
      let touched = false;
      if (typeof parsed.sttOn === "boolean") {
        this.state.sttOn = parsed.sttOn;
        touched = true;
      }
      if (typeof parsed.captionsOn === "boolean") {
        this.state.captionsOn = parsed.captionsOn;
        touched = true;
      }
      return touched;
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

  setCaptionsOn(on: boolean): EpisodeState {
    this.load();
    if (this.state.captionsOn === on) return { ...this.state };
    this.state = { ...this.state, captionsOn: on };
    this.persist();
    this.emit();
    return { ...this.state };
  }
}

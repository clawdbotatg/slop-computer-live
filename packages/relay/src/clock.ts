import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room shared clock app state — synchronized across every peer in
// a room. Tab, timezone pick, stopwatch, and countdown all live here.
// The wall-clock "Now" display is computed locally in each browser, so
// it stays naturally consistent without us syncing the literal time.
//
// Countdown sync: state.countdown is "running" with an `endAt` field
// that's a `Date.now()` epoch. Every peer's UI computes the remaining
// from `max(0, endAt - now)`, so the countdown ticks at exactly the
// same wall-clock moment everywhere. Same idea for the stopwatch
// (`startedAt` is wall-clock-anchored).
//
// On-disk persistence so a relay restart doesn't reset everyone's
// running timer.

export type ClockTab = "time" | "timer" | "countdown";

export type StopwatchState =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number; pausedElapsedMs: number }
  | { phase: "paused"; pausedElapsedMs: number };

export type CountdownState =
  | { phase: "idle" }
  | { phase: "running"; totalSecs: number; endAt: number }
  | { phase: "paused"; totalSecs: number; remainingSecs: number }
  | { phase: "done"; totalSecs: number };

export type ClockState = {
  tab: ClockTab;
  selectedZone: string;
  stopwatch: StopwatchState;
  countdown: CountdownState;
};

const DEFAULT_STATE: ClockState = {
  tab: "time",
  selectedZone: "local",
  stopwatch: { phase: "idle" },
  countdown: { phase: "idle" },
};

function validTab(t: unknown): t is ClockTab {
  return t === "time" || t === "timer" || t === "countdown";
}

function validStopwatch(s: unknown): s is StopwatchState {
  if (!s || typeof s !== "object") return false;
  const obj = s as { phase?: unknown; startedAt?: unknown; pausedElapsedMs?: unknown };
  if (obj.phase === "idle") return true;
  if (obj.phase === "running") {
    return typeof obj.startedAt === "number" && typeof obj.pausedElapsedMs === "number";
  }
  if (obj.phase === "paused") {
    return typeof obj.pausedElapsedMs === "number";
  }
  return false;
}

function validCountdown(c: unknown): c is CountdownState {
  if (!c || typeof c !== "object") return false;
  const obj = c as { phase?: unknown; totalSecs?: unknown; endAt?: unknown; remainingSecs?: unknown };
  if (obj.phase === "idle") return true;
  if (obj.phase === "running") {
    return typeof obj.totalSecs === "number" && typeof obj.endAt === "number";
  }
  if (obj.phase === "paused") {
    return typeof obj.totalSecs === "number" && typeof obj.remainingSecs === "number";
  }
  if (obj.phase === "done") {
    return typeof obj.totalSecs === "number";
  }
  return false;
}

type Subscriber = (state: ClockState) => void;

export class Clock {
  private state: ClockState = DEFAULT_STATE;
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
      const parsed = JSON.parse(raw) as Partial<ClockState>;
      this.state = {
        tab: validTab(parsed.tab) ? parsed.tab : DEFAULT_STATE.tab,
        selectedZone: typeof parsed.selectedZone === "string" ? parsed.selectedZone : DEFAULT_STATE.selectedZone,
        stopwatch: validStopwatch(parsed.stopwatch) ? parsed.stopwatch : DEFAULT_STATE.stopwatch,
        countdown: validCountdown(parsed.countdown) ? parsed.countdown : DEFAULT_STATE.countdown,
      };
      return true;
    } catch {
      return false;
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify(this.state));
    } catch (err) {
      console.warn("[clock] persist failed", err);
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

  getState(): ClockState {
    this.load();
    return this.state;
  }

  /** Partial update — fields not in `patch` are preserved. Validation
   *  rejects bad shapes so a misbehaving client can't park us in a state
   *  the typed UI can't render. */
  setState(patch: Partial<ClockState>): ClockState {
    this.load();
    const next: ClockState = {
      tab: validTab(patch.tab) ? patch.tab : this.state.tab,
      selectedZone:
        typeof patch.selectedZone === "string" && patch.selectedZone ? patch.selectedZone : this.state.selectedZone,
      stopwatch:
        patch.stopwatch !== undefined && validStopwatch(patch.stopwatch) ? patch.stopwatch : this.state.stopwatch,
      countdown:
        patch.countdown !== undefined && validCountdown(patch.countdown) ? patch.countdown : this.state.countdown,
    };
    this.state = next;
    this.persist();
    this.emit();
    return this.state;
  }
}

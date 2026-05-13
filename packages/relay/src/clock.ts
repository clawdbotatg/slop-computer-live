import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Shared clock app state — synchronized across every peer. Tab,
// timezone pick, stopwatch, and countdown all live here. The wall-
// clock "Now" display is computed locally in each browser, so it
// stays naturally consistent without us syncing the literal time.
//
// Countdown sync: state.countdown is "running" with an `endAt` field
// that's a `Date.now()` epoch. Every peer's UI computes the remaining
// from `max(0, endAt - now)`, so the countdown ticks at exactly the
// same wall-clock moment everywhere. Same idea for the stopwatch
// (`startedAt` is wall-clock-anchored).
//
// On-disk persistence so a relay restart doesn't reset everyone's
// running timer.

const CLOCK_STATE_FILE = process.env.CLOCK_STATE_FILE ?? "./.slop-data/clock-state.json";

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

let state: ClockState = DEFAULT_STATE;
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(CLOCK_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<ClockState>;
    state = {
      tab: validTab(parsed.tab) ? parsed.tab : DEFAULT_STATE.tab,
      selectedZone: typeof parsed.selectedZone === "string" ? parsed.selectedZone : DEFAULT_STATE.selectedZone,
      stopwatch: validStopwatch(parsed.stopwatch) ? parsed.stopwatch : DEFAULT_STATE.stopwatch,
      countdown: validCountdown(parsed.countdown) ? parsed.countdown : DEFAULT_STATE.countdown,
    };
  } catch {
    /* fresh — keep DEFAULT_STATE */
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(CLOCK_STATE_FILE), { recursive: true });
    writeFileSync(CLOCK_STATE_FILE, JSON.stringify(state), "utf8");
  } catch (err) {
    console.warn("[clock] persist failed", err);
  }
}

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

// --- Subscribers -----------------------------------------------------------

type Subscriber = (state: ClockState) => void;
const subscribers = new Set<Subscriber>();
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
function emit(): void {
  for (const fn of subscribers) {
    try {
      fn(state);
    } catch {
      /* one bad sub shouldn't kill the rest */
    }
  }
}

// --- Public API ------------------------------------------------------------

export function getState(): ClockState {
  load();
  return state;
}

/** Partial update — fields not in `patch` are preserved. Validation
 *  rejects bad shapes so a misbehaving client can't park us in a state
 *  the typed UI can't render. */
export function setState(patch: Partial<ClockState>): ClockState {
  load();
  const next: ClockState = {
    tab: validTab(patch.tab) ? patch.tab : state.tab,
    selectedZone:
      typeof patch.selectedZone === "string" && patch.selectedZone ? patch.selectedZone : state.selectedZone,
    stopwatch: patch.stopwatch !== undefined && validStopwatch(patch.stopwatch) ? patch.stopwatch : state.stopwatch,
    countdown: patch.countdown !== undefined && validCountdown(patch.countdown) ? patch.countdown : state.countdown,
  };
  state = next;
  persist();
  emit();
  return state;
}

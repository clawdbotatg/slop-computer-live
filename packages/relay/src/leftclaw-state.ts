// Per-room Leftclaw "Hire" state — shared across the mesh within a room.
// The Hire app lets the host post a Research / Build / Audit job to
// Leftclaw Services (leftclaw.services). The form + posting phase are
// broadcast to every peer so spectators watch the job go out and read
// the resulting job link, mirroring the Research app.
//
// IMPORTANT difference from research-state.ts: the actual work (signing
// the CV-spend message or the x402 USDC authorization, and sending the
// on-chain postJobWithCV tx) runs IN THE DRIVER'S BROWSER, not on the
// relay. The relay only proxies the CORS-blocked Leftclaw HTTP calls and
// holds this advisory phase/step snapshot. The driving browser POSTs
// `start` (to take the lock), `update` (step labels), then `done`/`error`.
//
// Because the post is browser-driven, a relay restart does NOT kill it —
// so reconcileLoaded can't assume an in-flight `posting` snapshot is dead
// the way research can. If we already recorded a jobId it's done;
// otherwise we drop the dead lock back to idle (keeping the typed form so
// the host can retry) — see reconcileLoaded.
//
// Persisted to leftclaw.json. A finished `done` stays up for the whole
// show across relay restarts / deploys; only an explicit reset clears it.
//
// State machine:
//   idle    — fresh / reset. Form is editable, no job in flight.
//   posting — someone took the lock and is driving the wallet flow.
//             `step` is the human label spectators see.
//   done    — job posted. jobId/jobUrl/txHash populated.
//   error   — the flow failed; `error` holds the message.
// Last-writer-wins; the routes refuse overlapping posts with 409.

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

export type LeftclawPhase = "idle" | "posting" | "done" | "error";

// Leftclaw service-type IDs we support from the desktop. Audit=4,
// Build=6, Research=7 (the bot-accepted, non-human-only types).
export type LeftclawServiceId = 4 | 6 | 7;

export type LeftclawPayment = "cv" | "usdc";

export type LeftclawJob = {
  startedAt: number;
  startedBy: string | null;
};

// A finished job, kept in the room's history list so the link is still
// reachable after the host posts another / closes and reopens the app.
// Newest-first; capped at HISTORY_LIMIT.
export type LeftclawJobRecord = {
  jobId: number;
  jobUrl: string;
  serviceTypeId: LeftclawServiceId | null;
  paymentMethod: LeftclawPayment | null;
  txHash: string | null;
  postedAt: number;
  postedBy: string | null;
};

const HISTORY_LIMIT = 50;

export type LeftclawSnapshot = {
  phase: LeftclawPhase;
  serviceTypeId: LeftclawServiceId | null;
  description: string;
  context: string;
  paymentMethod: LeftclawPayment | null;
  /** Human-readable progress label shown to spectators while posting. */
  step: string | null;
  /** Non-null while a post is in flight — gates the 409 overlap guard. */
  job: LeftclawJob | null;
  jobId: number | null;
  jobUrl: string | null;
  txHash: string | null;
  error: string | null;
  /** Newest-first list of every job posted in this room — survives reset
   *  ("Post another") and relay restarts so the links stay reachable. */
  history: LeftclawJobRecord[];
};

const DEFAULT_SNAPSHOT: LeftclawSnapshot = {
  phase: "idle",
  serviceTypeId: null,
  description: "",
  context: "",
  paymentMethod: null,
  step: null,
  job: null,
  jobId: null,
  jobUrl: null,
  txHash: null,
  error: null,
  history: [],
};

// The post runs in the driver's browser, so a relay restart can't tell us
// whether an in-flight `posting` snapshot finished. If a jobId was already
// recorded it's done; otherwise drop the dead lock back to idle but keep
// the typed form so the host can retry.
function reconcileLoaded(s: LeftclawSnapshot): LeftclawSnapshot {
  // A persisted `error` is noise on next load — don't make a stale failure
  // greet the next visitor / survive a relay restart. Drop it to idle, but
  // keep the posted-jobs history.
  if (s.phase === "error") return { ...DEFAULT_SNAPSHOT, history: s.history ?? [] };
  if (s.phase !== "posting") return s;
  if (s.jobId != null) return { ...s, phase: "done", job: null, step: null };
  return { ...s, phase: "idle", job: null, step: null, error: null };
}

type Listener = (snapshot: LeftclawSnapshot) => void;

export class LeftclawState {
  private snapshot: LeftclawSnapshot = { ...DEFAULT_SNAPSHOT };
  private listeners: Listener[] = [];
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LeftclawSnapshot>;
      this.snapshot = reconcileLoaded({ ...DEFAULT_SNAPSHOT, ...parsed });
    } catch {
      /* missing or unparseable — keep the fresh DEFAULT_SNAPSHOT */
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify(this.snapshot));
    } catch {
      /* disk write failed — state stays in memory, broadcast still fires */
    }
  }

  current(): { state: LeftclawSnapshot } {
    this.load();
    return { state: this.snapshot };
  }

  setPatch(patch: Partial<LeftclawSnapshot>): LeftclawSnapshot {
    this.load();
    this.snapshot = { ...this.snapshot, ...patch };
    this.persist();
    this.notify();
    return this.snapshot;
  }

  reset(): LeftclawSnapshot {
    this.load();
    // "Post another" / dismiss-error route through reset — keep the posted-jobs
    // history so the links survive going back to the empty form.
    this.snapshot = { ...DEFAULT_SNAPSHOT, history: this.snapshot.history };
    this.persist();
    this.notify();
    return this.snapshot;
  }

  /** Prepend a finished job to the history (dedup by jobId, capped). */
  appendHistory(record: LeftclawJobRecord): LeftclawSnapshot {
    this.load();
    const history = [record, ...this.snapshot.history.filter(h => h.jobId !== record.jobId)].slice(0, HISTORY_LIMIT);
    this.snapshot = { ...this.snapshot, history };
    this.persist();
    this.notify();
    return this.snapshot;
  }

  /** Wipe the posted-jobs history (and the rest of the snapshot). */
  clearHistory(): LeftclawSnapshot {
    this.load();
    this.snapshot = { ...this.snapshot, history: [] };
    this.persist();
    this.notify();
    return this.snapshot;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.snapshot);
      } catch {
        /* ignore */
      }
    }
  }
}

// Per-room guest-research state — shared across the mesh within a room.
// The Research app used to be single-player (each peer ran their own
// /v1/guest-lookup + /v1/guest-research and stored the result locally).
// Now the dossier and the in-flight progress bar are broadcast to every
// peer in the room: the host hits "Look up", everyone sees the same
// loading bar, everyone reads the same answers when they land.
//
// Last-writer-wins. If two peers click "Research" within ms of each
// other only one job actually runs (the relay refuses overlapping jobs
// per-room — see the 409 branch in index.ts).
//
// Persisted to research.json. A finished dossier is meant to stay up
// for the whole show — a relay restart (every deploy bounces the relay)
// or a room hibernation must NOT wipe it. The room reloads it on the
// next peer connect; only an explicit `reset()` ("Start over", or
// DELETE /v1/research) clears it.
//
// State machine:
//   idle           — fresh room. Lookup box is empty.
//   lookup-pending — someone submitted the lookup query; AI call in flight.
//   form           — lookup returned. Editable form is prefilled with the
//                    model's best guess. Each peer's local edits stay
//                    local; only the submit broadcasts.
//   research-pending — someone hit "Research". Dossier call in flight.
//   done           — result is in. Everyone sees the same dossier.
// All transitions go through the relay; clients only POST intents.
//
// Each request also stamps the issuer in `job.startedBy` so spectators
// can read "Alice is researching @vitalik…" if we want that later.

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";
import type { ResearchResult, Socials } from "./guest-research.js";

export type ResearchPhase =
  | "idle"
  | "lookup-pending"
  | "form"
  | "research-pending"
  | "done";

export type ResearchJob = {
  kind: "lookup" | "research";
  startedAt: number;
  startedBy: string | null;
};

export type ResearchSnapshot = {
  phase: ResearchPhase;
  /** The freeform "name or @handle" string most-recently submitted to
   *  /v1/research/lookup. Used to keep the lookup screen's input in
   *  sync across peers while a lookup is in flight. */
  lookupQuery: string;
  /** Form fields. After a successful lookup, populated with the model's
   *  best guess; the host can edit locally before submitting research. */
  name: string;
  socials: Socials;
  notes: string;
  /** Research result, populated when phase === "done". */
  result: ResearchResult | null;
  /** Non-null while an AI call is in flight. Drives the shared loading bar. */
  job: ResearchJob | null;
  /** Last user-facing error, displayed in the window until "Start over". */
  error: string | null;
};

const DEFAULT_SNAPSHOT: ResearchSnapshot = {
  phase: "idle",
  lookupQuery: "",
  name: "",
  socials: {},
  notes: "",
  result: null,
  job: null,
  error: null,
};

function hasFormData(s: ResearchSnapshot): boolean {
  const so = s.socials ?? {};
  return Boolean(
    s.name ||
      s.notes ||
      so.twitter ||
      so.github ||
      so.linkedin ||
      so.website ||
      so.other,
  );
}

// A relay restart kills the process running any in-flight lookup /
// research call — the awaited promise dies with it. A snapshot saved
// mid-job would otherwise reload stuck in `*-pending` behind a loading
// bar nothing will ever clear. So on load we drop the dead job and
// fall back to the most complete resting phase the saved data supports:
// a finished dossier survives, a half-filled form survives, otherwise
// we land back on the empty lookup screen.
function reconcileLoaded(s: ResearchSnapshot): ResearchSnapshot {
  if (s.phase !== "lookup-pending" && s.phase !== "research-pending") return s;
  const next: ResearchSnapshot = { ...s, job: null };
  if (s.result) next.phase = "done";
  else if (hasFormData(s)) next.phase = "form";
  else next.phase = "idle";
  return next;
}

type Listener = (snapshot: ResearchSnapshot) => void;

export class ResearchState {
  private snapshot: ResearchSnapshot = { ...DEFAULT_SNAPSHOT };
  private listeners: Listener[] = [];
  private loaded = false;

  constructor(private readonly filePath: string) {}

  /** Lazy-load from disk on first access. Room constructs every
   *  subsystem eagerly; the file read is deferred until something
   *  actually reads the state — same pattern as EpisodeFlags etc. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ResearchSnapshot>;
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

  current(): { state: ResearchSnapshot } {
    this.load();
    return { state: this.snapshot };
  }

  /** Apply a partial patch and notify listeners. `socials` is replaced
   *  wholesale (not merged) when present in the patch — that matches the
   *  "form submit replaces the form" contract used by the routes. */
  setPatch(patch: Partial<ResearchSnapshot>): ResearchSnapshot {
    this.load();
    this.snapshot = { ...this.snapshot, ...patch };
    this.persist();
    this.notify();
    return this.snapshot;
  }

  reset(): ResearchSnapshot {
    // Wholesale overwrite — no need to read disk first.
    this.loaded = true;
    this.snapshot = { ...DEFAULT_SNAPSHOT };
    this.persist();
    this.notify();
    return this.snapshot;
  }

  /** Subscribe to every snapshot change. Used by Room to wire the
   *  broadcast: a single listener forwards `research_state` to every peer. */
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

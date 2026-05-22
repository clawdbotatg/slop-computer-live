// Per-room guest-research state — shared across the mesh within a room.
// The Research app used to be single-player (each peer ran their own
// /v1/guest-lookup + /v1/guest-research and stored the result locally).
// Now the dossier and the in-flight progress bar are broadcast to every
// peer in the room: the host hits "Look up", everyone sees the same
// loading bar, everyone reads the same answers when they land.
//
// Last-writer-wins. If two peers click "Research" within ms of each
// other only one job actually runs (the relay refuses overlapping jobs
// per-room — see the 409 branch in index.ts). Not persisted; transient
// session state, lost on relay restart.
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

type Listener = (snapshot: ResearchSnapshot) => void;

export class ResearchState {
  private snapshot: ResearchSnapshot = { ...DEFAULT_SNAPSHOT };
  private listeners: Listener[] = [];

  current(): { state: ResearchSnapshot } {
    return { state: this.snapshot };
  }

  /** Apply a partial patch and notify listeners. `socials` is replaced
   *  wholesale (not merged) when present in the patch — that matches the
   *  "form submit replaces the form" contract used by the routes. */
  setPatch(patch: Partial<ResearchSnapshot>): ResearchSnapshot {
    this.snapshot = { ...this.snapshot, ...patch };
    this.notify();
    return this.snapshot;
  }

  reset(): ResearchSnapshot {
    this.snapshot = { ...DEFAULT_SNAPSHOT };
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

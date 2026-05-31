// Per-room "catch me up" TLDR state — shared across the mesh within a
// room. Anyone hits the TLDR button in the Transcript app; the relay
// reads the recent transcript, asks Claude for a summary, and broadcasts
// the same result (and the in-flight pending flag) to every peer. So a
// late joiner clicks once and the whole room sees the catch-up.
//
// In-memory only (like Pong / QrState / ScrollSync). A TLDR is a transient
// "what's happened so far" snapshot — persisting it across a relay restart
// would resurrect a stale summary that no longer matches the transcript,
// which is worse than just regenerating on demand. Cold start = idle.
//
// Last-writer-wins. While a job is in flight (status === "pending") the
// relay ignores new requests rather than running overlapping AI calls.

export type TldrStatus = "idle" | "pending" | "ready" | "error";

export type TldrRequester = {
  address: string | null;
  handle: string | null;
  anonId: string | null;
};

export type TldrSnapshot = {
  status: TldrStatus;
  /** The generated summary (bullet lines). Empty until status === "ready". */
  summary: string;
  /** ms epoch the summary landed, or null while idle/pending. */
  generatedAt: number | null;
  /** Who kicked off the most recent TLDR. Lets the UI say "Alice asked for
   *  a recap". */
  requestedBy: TldrRequester | null;
  /** How many transcript rows the summary covered — surfaced as a small
   *  "based on N lines" hint. */
  segmentCount: number;
};

const DEFAULT_SNAPSHOT: TldrSnapshot = {
  status: "idle",
  summary: "",
  generatedAt: null,
  requestedBy: null,
  segmentCount: 0,
};

type Listener = (snapshot: TldrSnapshot) => void;

export class TldrState {
  private snapshot: TldrSnapshot = { ...DEFAULT_SNAPSHOT };
  private listeners: Listener[] = [];

  current(): { state: TldrSnapshot } {
    return { state: this.snapshot };
  }

  /** Mark a job in flight. Returns false if one is already running so the
   *  caller can drop the duplicate request instead of racing AI calls. */
  setPending(by: TldrRequester): boolean {
    if (this.snapshot.status === "pending") return false;
    this.snapshot = {
      status: "pending",
      // Keep the prior summary on screen while regenerating — feels less
      // jarring than blanking to nothing for the few seconds the call takes.
      summary: this.snapshot.summary,
      generatedAt: this.snapshot.generatedAt,
      requestedBy: by,
      segmentCount: this.snapshot.segmentCount,
    };
    this.notify();
    return true;
  }

  setReady(summary: string, segmentCount: number, generatedAt: number): TldrSnapshot {
    this.snapshot = {
      status: "ready",
      summary,
      generatedAt,
      requestedBy: this.snapshot.requestedBy,
      segmentCount,
    };
    this.notify();
    return this.snapshot;
  }

  setError(message: string): TldrSnapshot {
    this.snapshot = {
      ...this.snapshot,
      status: "error",
      summary: message,
    };
    this.notify();
    return this.snapshot;
  }

  /** Subscribe to every snapshot change. Room wires a single listener that
   *  forwards `tldr_state` to every peer. */
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
        /* one bad sub shouldn't kill the rest */
      }
    }
  }
}

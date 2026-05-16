import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Per-episode flags the host can flip on the fly. Currently just `sttOn`
// (gates whether peer browsers post Web Speech transcripts to /v1/transcript)
// but built as a stateful module so other flags can join (e.g. recording-on,
// chat-locked) without restructuring.
//
// Persistence is a tiny JSON file so a relay restart mid-show doesn't lose
// the toggle state. State is broadcast on `subscribe(fn)` so SSE consumers
// can push updates to the desktop in real-time.

const EPISODE_STATE_FILE =
  process.env.EPISODE_STATE_FILE ?? "./.slop-data/episode.json";

export type EpisodeState = {
  /** When true, peer browsers run Web Speech and POST final segments to
   *  /v1/transcript. When false, the hook is dormant even with a live mic —
   *  host-controlled so the show can dink around pre-air without polluting
   *  the archive. Defaults to false on a cold start. */
  sttOn: boolean;
};

let state: EpisodeState = { sttOn: false };
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(EPISODE_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<EpisodeState>;
    if (typeof parsed.sttOn === "boolean") state.sttOn = parsed.sttOn;
  } catch {
    /* fresh — keep defaults */
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(EPISODE_STATE_FILE), { recursive: true });
    writeFileSync(EPISODE_STATE_FILE, JSON.stringify(state), "utf8");
  } catch {
    /* disk write failed — state stays in memory; not load-bearing */
  }
}

export function getState(): EpisodeState {
  load();
  return { ...state };
}

export function setSttOn(on: boolean): EpisodeState {
  load();
  if (state.sttOn === on) return { ...state };
  state = { ...state, sttOn: on };
  persist();
  for (const fn of subscribers) {
    try {
      fn({ ...state });
    } catch {
      /* one bad sub shouldn't kill the rest */
    }
  }
  return { ...state };
}

type Subscriber = (s: EpisodeState) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";

// Jamendo-backed genre playlists. Each supported genre maps to a Jamendo
// `tags` query; we pull the top trending-this-week tracks, download the
// MP3 bytes to /var/lib/slop-relay/jamendo-music/<genre>/<trackId>.mp3,
// and write a playlist.json next to them.
//
// Dedupe: filenames are keyed by Jamendo trackId, so a track that's
// still trending next week is recognized on disk and not re-downloaded.
// We rebuild the playlist.json every refresh (this week's order may
// differ even when all tracks are cached).
//
// State stays on disk — the relay can restart mid-show and the genre
// each peer has selected is reloaded from the persisted current-genre
// pointer. No in-memory authoritative store.

const JAMENDO_DIR = process.env.JAMENDO_DIR ?? "./.slop-data/jamendo-music";
const STATE_FILE = `${JAMENDO_DIR}/state.json`;
const TRACKS_PER_GENRE = 20;
const REFRESH_TTL_MS = 60 * 60 * 1000; // re-poll Jamendo at most once per hour
const FETCH_TIMEOUT_MS = 30_000;

// Genre -> Jamendo tag. Keep the public id short and lowercase; the
// `tag` is what we pass to the API.
export const GENRES: Record<string, { label: string; tag: string }> = {
  pop: { label: "Pop", tag: "pop" },
  rock: { label: "Rock", tag: "rock" },
  electronic: { label: "Electronic", tag: "electronic" },
  hiphop: { label: "Hip-Hop", tag: "hiphop" },
  indie: { label: "Indie", tag: "indie" },
  dance: { label: "Dance", tag: "dance" },
  folk: { label: "Folk", tag: "folk" },
  punk: { label: "Punk", tag: "punk" },
  country: { label: "Country", tag: "country" },
  house: { label: "House", tag: "house" },
};

export type Genre = keyof typeof GENRES;
export const GENRE_IDS = Object.keys(GENRES);

export function isGenre(s: string): s is Genre {
  return Object.prototype.hasOwnProperty.call(GENRES, s);
}

export type JamendoTrack = {
  /** Local playlist track shape — same fields the player + skill expect. */
  title: string;
  artist: string;
  /** Root-relative path served by the relay's static route. */
  src: string;
  /** Duration in seconds, from the Jamendo API. Useful for the DJ loop. */
  duration: number;
  /** Original Jamendo track id (string). Stable across queries. */
  jamendoId: string;
  license: string;
  source: string;
};

export type GenrePlaylist = {
  genre: string;
  label: string;
  tag: string;
  fetchedAt: number;
  tracks: JamendoTrack[];
};

// --- Persistent state -------------------------------------------------------

type GenreState = { lastFetchedAt: number; lastError?: string };
type StateFile = { currentGenre: string | null; genres: Record<string, GenreState> };

function loadState(): StateFile {
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<StateFile>;
    return {
      currentGenre: typeof parsed.currentGenre === "string" ? parsed.currentGenre : null,
      genres: parsed.genres && typeof parsed.genres === "object" ? (parsed.genres as Record<string, GenreState>) : {},
    };
  } catch {
    return { currentGenre: null, genres: {} };
  }
}

function saveState(state: StateFile): void {
  try {
    mkdirSync(JAMENDO_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("[jamendo] saveState failed", err);
  }
}

// --- Subscribers ------------------------------------------------------------

type Subscriber = (event: { type: "genre_changed"; genre: string | null }) => void;
const subscribers = new Set<Subscriber>();
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
function emit(genre: string | null): void {
  for (const fn of subscribers) {
    try {
      fn({ type: "genre_changed", genre });
    } catch {
      /* ignore */
    }
  }
}

// --- Public read -----------------------------------------------------------

export function getCurrentGenre(): string | null {
  return loadState().currentGenre;
}

export function readPlaylist(genre: string): GenrePlaylist | null {
  if (!isGenre(genre)) return null;
  const path = `${JAMENDO_DIR}/${genre}/playlist.json`;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as GenrePlaylist;
  } catch {
    return null;
  }
}

// --- Refresh from Jamendo --------------------------------------------------

// Fetch the trending-this-week list for `genre` from Jamendo and download
// any new tracks. Returns the resulting playlist.
//
// Concurrency: multiple POSTs racing on the same genre would re-fetch
// and re-write the same playlist. We guard with a per-genre in-flight
// promise map so the second caller awaits the first.
const inFlight = new Map<string, Promise<GenrePlaylist>>();

export async function refreshGenre(genre: string, opts: { force?: boolean } = {}): Promise<GenrePlaylist> {
  if (!isGenre(genre)) throw new Error(`unknown-genre:${genre}`);
  const cached = inFlight.get(genre);
  if (cached) return cached;
  const p = doRefresh(genre, opts).finally(() => inFlight.delete(genre));
  inFlight.set(genre, p);
  return p;
}

async function doRefresh(genre: string, opts: { force?: boolean }): Promise<GenrePlaylist> {
  if (!config.jamendoClientId) {
    throw new Error("jamendo-client-id-missing");
  }
  const entry = GENRES[genre]!;
  const state = loadState();
  const genreState = state.genres[genre];
  const now = Date.now();
  const fresh = !opts.force && genreState && now - genreState.lastFetchedAt < REFRESH_TTL_MS;
  const existing = readPlaylist(genre);
  if (fresh && existing) {
    return existing;
  }

  // Pull the top trending-this-week tracks. `audiodownload_allowed=true`
  // filters out streaming-only items at the API layer so we don't waste
  // a download attempt on something the CDN will 403 us on.
  const params = new URLSearchParams({
    client_id: config.jamendoClientId,
    format: "json",
    tags: entry.tag,
    order: "popularity_week",
    limit: String(TRACKS_PER_GENRE),
    audioformat: "mp32",
    audiodownload_allowed: "true",
    include: "musicinfo",
  });
  const url = `https://api.jamendo.com/v3.0/tracks/?${params.toString()}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let listing: { results?: unknown[]; headers?: { status?: string; error_message?: string } };
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`jamendo-http-${res.status}`);
    listing = (await res.json()) as typeof listing;
  } finally {
    clearTimeout(timer);
  }
  if (listing.headers?.status && listing.headers.status !== "success") {
    throw new Error(`jamendo-api-${listing.headers.error_message ?? "error"}`);
  }
  const raw = Array.isArray(listing.results) ? listing.results : [];

  mkdirSync(`${JAMENDO_DIR}/${genre}`, { recursive: true });

  type RawTrack = {
    id?: unknown;
    name?: unknown;
    artist_name?: unknown;
    audiodownload?: unknown;
    audiodownload_allowed?: unknown;
    duration?: unknown;
    license_ccurl?: unknown;
    shareurl?: unknown;
  };
  const tracks: JamendoTrack[] = [];

  for (const rawTrack of raw) {
    const t = rawTrack as RawTrack;
    if (typeof t.id !== "string") continue;
    if (t.audiodownload_allowed === false) continue;
    if (typeof t.audiodownload !== "string") continue;
    const trackId = t.id;
    const title = typeof t.name === "string" ? t.name : `track-${trackId}`;
    const artist = typeof t.artist_name === "string" ? t.artist_name : "Unknown";
    const filename = `${trackId}.mp3`;
    const onDisk = `${JAMENDO_DIR}/${genre}/${filename}`;
    if (!existsSync(onDisk)) {
      try {
        await downloadTrack(t.audiodownload, onDisk);
      } catch (err) {
        console.warn(`[jamendo] download failed: ${genre}/${trackId}`, (err as Error).message);
        continue;
      }
    }
    tracks.push({
      title,
      artist,
      src: `/jamendo-music/${genre}/${filename}`,
      duration: typeof t.duration === "number" ? t.duration : 0,
      jamendoId: trackId,
      license: typeof t.license_ccurl === "string" ? t.license_ccurl : "",
      source: typeof t.shareurl === "string" ? t.shareurl : `https://www.jamendo.com/track/${trackId}`,
    });
  }

  if (tracks.length === 0) throw new Error("jamendo-empty-result");

  const playlist: GenrePlaylist = {
    genre,
    label: entry.label,
    tag: entry.tag,
    fetchedAt: Date.now(),
    tracks,
  };
  writeFileSync(`${JAMENDO_DIR}/${genre}/playlist.json`, JSON.stringify(playlist, null, 2), "utf8");
  state.genres[genre] = { lastFetchedAt: playlist.fetchedAt };
  saveState(state);
  return playlist;
}

async function downloadTrack(url: string, dest: string): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`http-${res.status}`);
    if (!res.body) throw new Error("no-body");
    // Pipe the response straight to disk to avoid buffering whole MP3s
    // in memory (some Jamendo tracks are 8+ MB).
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
}

// --- Genre selection -------------------------------------------------------

export async function setCurrentGenre(genre: string | null): Promise<{ genre: string | null }> {
  const state = loadState();
  if (genre === null) {
    if (state.currentGenre !== null) {
      state.currentGenre = null;
      saveState(state);
      emit(null);
    }
    return { genre: null };
  }
  if (!isGenre(genre)) throw new Error(`unknown-genre:${genre}`);
  // Flip the pointer + broadcast IMMEDIATELY so every peer's UI shows
  // the new genre as selected (with a "loading…" placeholder) within
  // milliseconds. Then kick off the refresh in the background — the
  // playlist endpoint joins the same in-flight promise so the first
  // client to hit it gets the freshly-downloaded list. Cold downloads
  // can take ~30s, but the user never sees an unresponsive UI.
  if (state.currentGenre !== genre) {
    state.currentGenre = genre;
    saveState(state);
    emit(genre);
  }
  // Kick off the refresh. We DON'T await it — the POST returns
  // immediately so the client doesn't sit on a 30s connection. The
  // background promise records errors via console.warn; the playlist
  // endpoint a peer hits will await the same in-flight promise.
  refreshGenre(genre).catch(err => {
    console.warn(`[jamendo] background refresh failed for ${genre}:`, (err as Error).message);
  });
  return { genre };
}

export { JAMENDO_DIR };

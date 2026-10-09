import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { writeFileAtomic } from "./fs-atomic.js";

// Jamendo-backed genre playlists. Each supported genre maps to a Jamendo
// `tags` query; we pull the top trending-this-week tracks, download the
// MP3 bytes to /var/lib/slop-relay/jamendo-music/<genre>/<trackId>.mp3,
// and write a playlist.json next to them.
//
// The MP3 cache + the per-genre last-fetched-at pointer are
// **process-global** — a rock track downloaded for room A is reused by
// room B (same files, same CDN cost, same content). Only the
// "currently-selected genre" and the user-curated "custom" playlist are
// **per-room**, owned by JamendoRoomState below.

export const JAMENDO_DIR = process.env.JAMENDO_DIR ?? "./.slop-data/jamendo-music";
const GLOBAL_STATE_FILE = `${JAMENDO_DIR}/state.json`;
// The list a genre shows. Big enough that a show doesn't loop it, small
// enough that a cold genre downloads in about a minute.
const TRACKS_PER_GENRE = 60;
// Where the pool comes from. History: `popularity_week` alone froze every
// genre to the same ~20 evergreens for months; then (05-31) "popularity
// within the last 14 days of releases" — brand-new uploads have ~0 plays,
// so that ranking was noise and bulk uploaders filled the list (10-09:
// one artist was 11 of 20 house tracks, plus 60s clips and re-uploads).
// Now: recent tracks people actually listened to, plus a slice of
// evergreen hits, cleaned up (pickTracks) and shuffled per refresh.
const RECENT_DAYS = 180;
const RECENT_SHARE = 0.7;
const DAY_MS = 24 * 60 * 60 * 1000;
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
  // "custom" is special — not Jamendo-backed, never auto-refreshed.
  // Tracks land here when a user clicks [+] on any other genre. Stored
  // **per-room** so each room curates its own list. The underlying MP3
  // files are reused from whatever genre they were originally fetched
  // into — refreshGenre never deletes, only appends, so once a file is
  // on disk it stays.
  custom: { label: "Custom", tag: "" },
};

export type Genre = keyof typeof GENRES;
export const GENRE_IDS = Object.keys(GENRES);
export const CUSTOM_GENRE = "custom";

export function isGenre(s: string): s is Genre {
  return Object.prototype.hasOwnProperty.call(GENRES, s);
}

function isCustom(genre: string): boolean {
  return genre === CUSTOM_GENRE;
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

// --- Global cache state (last-fetched-at per genre) -----------------------

type GenreState = { lastFetchedAt: number; lastError?: string };
type GlobalStateFile = { genres: Record<string, GenreState> };

function loadGlobalState(): GlobalStateFile {
  try {
    const raw = readFileSync(GLOBAL_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<GlobalStateFile>;
    return {
      genres: parsed.genres && typeof parsed.genres === "object" ? (parsed.genres as Record<string, GenreState>) : {},
    };
  } catch {
    return { genres: {} };
  }
}

function saveGlobalState(state: GlobalStateFile): void {
  try {
    writeFileAtomic(GLOBAL_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("[jamendo] saveGlobalState failed", err);
  }
}

export function readPlaylist(genre: string): GenrePlaylist | null {
  if (!isGenre(genre)) return null;
  if (isCustom(genre)) {
    // Custom is per-room — callers must use the JamendoRoomState's
    // method directly. Returning null here flags misuse rather than
    // silently mixing up rooms.
    return null;
  }
  const path = `${JAMENDO_DIR}/${genre}/playlist.json`;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as GenrePlaylist;
  } catch {
    return null;
  }
}

// --- Refresh from Jamendo (global, shared MP3 cache) ----------------------

const inFlight = new Map<string, Promise<GenrePlaylist>>();

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

// One Jamendo `/tracks` query. `dateBetween` (a `YYYY-MM-DD_YYYY-MM-DD`
// release-date range) is optional. Returns the raw result rows
// (parsing/filtering happens in doRefresh).
async function fetchListing(
  tag: string,
  opts: { order: string; limit: number; dateBetween?: string },
): Promise<RawTrack[]> {
  const params = new URLSearchParams({
    client_id: config.jamendoClientId,
    format: "json",
    tags: tag,
    order: opts.order,
    limit: String(opts.limit),
    audioformat: "mp32",
    audiodownload_allowed: "true",
    include: "musicinfo",
  });
  if (opts.dateBetween) params.set("datebetween", opts.dateBetween);
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
  return Array.isArray(listing.results) ? (listing.results as RawTrack[]) : [];
}

// Jamendo intermittently answers a valid query with zero rows and no
// error (seen 10-09: same query empty, then full a second later). Retry.
async function fetchListingRetry(tag: string, opts: Parameters<typeof fetchListing>[1]): Promise<RawTrack[]> {
  for (let i = 0; ; i++) {
    const rows = await fetchListing(tag, opts);
    if (rows.length > 0 || i >= 2) return rows;
    await new Promise(r => setTimeout(r, 1000));
  }
}

// `datebetween` range covering the last `days` of releases. End is
// pinned to tomorrow so tracks uploaded today (any timezone) are always
// included rather than missed at the boundary.
function recencyRange(now: number, days: number): string {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return `${fmt(now - days * DAY_MS)}_${fmt(now + DAY_MS)}`;
}

const MIN_DURATION_S = 90;
const MAX_PER_ARTIST = 2;
// Clips, edits and stock-library fragments, not songs.
const JUNK_TITLE = /\b(edit|short\d*|loop|jingle|stinger|teaser|preview|intro|outro|sting|\d+\s*(min|minute|sec|second)s?)\b/i;

/** Clean + mix + shuffle. Pure (except Math.random) so it's testable. */
export function pickTracks(recent: RawTrack[], evergreen: RawTrack[], want: number, sendBack = new Set<string>()): RawTrack[] {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const perArtist = new Map<string, number>();
  const ok = (t: RawTrack): boolean => {
    if (typeof t.id !== "string" || typeof t.audiodownload !== "string") return false;
    if (t.audiodownload_allowed === false) return false;
    if (typeof t.duration !== "number" || t.duration < MIN_DURATION_S) return false;
    const title = typeof t.name === "string" ? t.name : "";
    if (JUNK_TITLE.test(title)) return false;
    const artist = typeof t.artist_name === "string" ? t.artist_name.toLowerCase() : "";
    // Same song re-uploaded: same title minus "(…)"/"v2", or same
    // artist + exact length (catches the translated-title duplicates).
    const base = title.toLowerCase().replace(/\(.*?\)|\[.*?\]|\bv\d+\b|[^\p{L}\p{N}]+/gu, "");
    const keys = [`${artist}|${base}`, `${artist}|${t.duration}`];
    if (seenIds.has(t.id) || keys.some(k => seenTitles.has(k))) return false;
    if ((perArtist.get(artist) ?? 0) >= MAX_PER_ARTIST) return false;
    seenIds.add(t.id);
    keys.forEach(k => seenTitles.add(k));
    perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
    return true;
  };
  const r = recent.filter(ok);
  const e = evergreen.filter(ok);
  const nEver = Math.min(e.length, Math.max(want - r.length, Math.round(want * (1 - RECENT_SHARE))));
  const pool = shuffle([...r.slice(0, want - nEver), ...e.slice(0, nEver)]);
  return [...pool.filter(t => !sendBack.has(t.id as string)), ...pool.filter(t => sendBack.has(t.id as string))];
}

function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

export async function refreshGenre(genre: string, opts: { force?: boolean } = {}): Promise<GenrePlaylist> {
  if (!isGenre(genre)) throw new Error(`unknown-genre:${genre}`);
  if (isCustom(genre)) throw new Error("custom-genre-not-refreshable");
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
  const state = loadGlobalState();
  const genreState = state.genres[genre];
  const now = Date.now();
  const fresh = !opts.force && genreState && now - genreState.lastFetchedAt < REFRESH_TTL_MS;
  const existing = readPlaylist(genre);
  if (fresh && existing) {
    return existing;
  }

  const [recent, evergreen] = await Promise.all([
    fetchListingRetry(entry.tag, { order: "listens_total", limit: 200, dateBetween: recencyRange(now, RECENT_DAYS) }),
    fetchListingRetry(entry.tag, { order: "popularity_month", limit: 100 }),
  ]);
  // Tracks that sat at the top of the last list go to the back of this
  // one, so "play from the top" is fresh each time.
  const lastTop = new Set((existing?.tracks ?? []).slice(0, 15).map(t => t.jamendoId));
  const candidates = pickTracks(recent, evergreen, TRACKS_PER_GENRE * 2, lastTop);
  if (candidates.length === 0) throw new Error("jamendo-empty-result");

  mkdirSync(`${JAMENDO_DIR}/${genre}`, { recursive: true });

  // Download 4 at a time, keep the pick order, drop failures. The 2x
  // over-pick is the headroom for failed downloads.
  const settled: (JamendoTrack | null)[] = new Array(candidates.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= candidates.length || settled.filter(Boolean).length >= TRACKS_PER_GENRE) return;
      const t = candidates[i]!;
      const trackId = t.id as string;
      const filename = `${trackId}.mp3`;
      const onDisk = `${JAMENDO_DIR}/${genre}/${filename}`;
      if (!existsSync(onDisk)) {
        try {
          await downloadTrack(t.audiodownload as string, onDisk);
        } catch (err) {
          console.warn(`[jamendo] download failed: ${genre}/${trackId}`, (err as Error).message);
          continue;
        }
      }
      settled[i] = {
        title: typeof t.name === "string" ? t.name : `track-${trackId}`,
        artist: typeof t.artist_name === "string" ? t.artist_name : "Unknown",
        src: `/jamendo-music/${genre}/${filename}`,
        duration: typeof t.duration === "number" ? t.duration : 0,
        jamendoId: trackId,
        license: typeof t.license_ccurl === "string" ? t.license_ccurl : "",
        source: typeof t.shareurl === "string" ? t.shareurl : `https://www.jamendo.com/track/${trackId}`,
      };
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const tracks = settled.filter((t): t is JamendoTrack => t !== null).slice(0, TRACKS_PER_GENRE);

  if (tracks.length === 0) throw new Error("jamendo-empty-result");

  const playlist: GenrePlaylist = {
    genre,
    label: entry.label,
    tag: entry.tag,
    fetchedAt: Date.now(),
    tracks,
  };
  writeFileAtomic(`${JAMENDO_DIR}/${genre}/playlist.json`, JSON.stringify(playlist, null, 2));
  state.genres[genre] = { lastFetchedAt: playlist.fetchedAt };
  saveGlobalState(state);
  return playlist;
}

async function downloadTrack(url: string, dest: string): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`http-${res.status}`);
    if (!res.body) throw new Error("no-body");
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
}

// --- Per-room jamendo state -----------------------------------------------

const CUSTOM_MAX_TRACKS = 200;

type GenreSubscriber = (event: { type: "genre_changed"; genre: string | null }) => void;
type CustomSubscriber = (tracks: JamendoTrack[]) => void;

type RoomStateFile = {
  currentGenre: string | null;
  customTracks: JamendoTrack[];
};

export class JamendoRoomState {
  private currentGenre: string | null = null;
  private customTracks: JamendoTrack[] = [];
  private loaded = false;
  private genreSubscribers = new Set<GenreSubscriber>();
  private customSubscribers = new Set<CustomSubscriber>();

  constructor(
    private readonly filePath: string,
    /** Legacy paths (per-process before per-room) — checked in order. */
    private readonly legacyState: string | null = null,
    private readonly legacyCustom: string | null = null,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    // Prefer the canonical per-room file. Falls back to splitting the
    // pre-room global state.json + custom-playlist.json into the room
    // for the "main" room only.
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RoomStateFile>;
      this.currentGenre = typeof parsed.currentGenre === "string" ? parsed.currentGenre : null;
      this.customTracks = Array.isArray(parsed.customTracks) ? (parsed.customTracks as JamendoTrack[]) : [];
      return;
    } catch {
      /* fall through to legacy */
    }
    if (this.legacyState) {
      try {
        const raw = readFileSync(this.legacyState, "utf8");
        const parsed = JSON.parse(raw) as { currentGenre?: unknown };
        if (typeof parsed.currentGenre === "string") this.currentGenre = parsed.currentGenre;
      } catch {
        /* fresh */
      }
    }
    if (this.legacyCustom) {
      try {
        const raw = readFileSync(this.legacyCustom, "utf8");
        const parsed = JSON.parse(raw) as { tracks?: unknown };
        if (Array.isArray(parsed.tracks)) this.customTracks = parsed.tracks as JamendoTrack[];
      } catch {
        /* fresh */
      }
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(
        this.filePath,
        JSON.stringify({ currentGenre: this.currentGenre, customTracks: this.customTracks }, null, 2),
      );
    } catch (err) {
      console.warn("[jamendo] room persist failed", err);
    }
  }

  private emitGenre(genre: string | null): void {
    for (const fn of this.genreSubscribers) {
      try {
        fn({ type: "genre_changed", genre });
      } catch {
        /* ignore */
      }
    }
  }

  private emitCustom(): void {
    for (const fn of this.customSubscribers) {
      try {
        fn(this.customTracks);
      } catch {
        /* ignore */
      }
    }
  }

  subscribe(fn: GenreSubscriber): () => void {
    this.genreSubscribers.add(fn);
    return () => this.genreSubscribers.delete(fn);
  }

  subscribeCustom(fn: CustomSubscriber): () => void {
    this.customSubscribers.add(fn);
    return () => this.customSubscribers.delete(fn);
  }

  getCurrentGenre(): string | null {
    this.load();
    return this.currentGenre;
  }

  getCustomPlaylist(): GenrePlaylist {
    this.load();
    return {
      genre: CUSTOM_GENRE,
      label: GENRES[CUSTOM_GENRE]!.label,
      tag: "",
      fetchedAt: Date.now(),
      tracks: [...this.customTracks],
    };
  }

  async setCurrentGenre(genre: string | null): Promise<{ genre: string | null }> {
    this.load();
    if (genre === null) {
      if (this.currentGenre !== null) {
        this.currentGenre = null;
        this.persist();
        this.emitGenre(null);
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
    if (this.currentGenre !== genre) {
      this.currentGenre = genre;
      this.persist();
      this.emitGenre(genre);
    }
    if (!isCustom(genre)) {
      refreshGenre(genre).catch(err => {
        console.warn(`[jamendo] background refresh failed for ${genre}:`, (err as Error).message);
      });
    }
    return { genre };
  }

  addToCustom(track: JamendoTrack): JamendoTrack[] {
    this.load();
    // Dedupe by jamendoId — clicking [+] on a track that's already in
    // custom is a no-op rather than an error.
    if (this.customTracks.some(t => t.jamendoId === track.jamendoId)) return [...this.customTracks];
    this.customTracks.push(track);
    if (this.customTracks.length > CUSTOM_MAX_TRACKS) {
      this.customTracks.splice(0, this.customTracks.length - CUSTOM_MAX_TRACKS);
    }
    this.persist();
    this.emitCustom();
    return [...this.customTracks];
  }

  removeFromCustom(jamendoId: string): JamendoTrack[] {
    this.load();
    const next = this.customTracks.filter(t => t.jamendoId !== jamendoId);
    if (next.length === this.customTracks.length) return [...this.customTracks];
    this.customTracks = next;
    this.persist();
    this.emitCustom();
    return [...this.customTracks];
  }

  reorderCustom(orderedIds: string[]): JamendoTrack[] {
    this.load();
    const byId = new Map(this.customTracks.map(t => [t.jamendoId, t]));
    const out: JamendoTrack[] = [];
    const used = new Set<string>();
    for (const id of orderedIds) {
      const t = byId.get(id);
      if (t && !used.has(id)) {
        out.push(t);
        used.add(id);
      }
    }
    for (const t of this.customTracks) {
      if (!used.has(t.jamendoId)) out.push(t);
    }
    const sameOrder = out.length === this.customTracks.length && out.every((t, i) => t.jamendoId === this.customTracks[i]?.jamendoId);
    if (sameOrder) return [...this.customTracks];
    this.customTracks = out;
    this.persist();
    this.emitCustom();
    return [...this.customTracks];
  }
}

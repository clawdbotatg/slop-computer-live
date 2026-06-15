import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

/**
 * Fanout manager: spawns ffmpeg children that re-publish the slop.computer
 * stream to external destinations (YouTube Live, Twitch, X/Twitter Live, Kick).
 *
 * Pattern adapted from clawd-conclave: OBS pushes ONCE to our MediaMTX, the
 * relay fans out to socials with `-c copy` (no transcode). Stream keys live
 * in relay env, never leave the EC2 box.
 *
 * Process model: one long-lived ffmpeg per destination. The admin's
 * desired on/off state is persisted to disk on every start/stop so that
 * a relay restart (deploy) can restore the previously-running fanouts —
 * see restoreFanouts() below.
 *
 * Self-heal: when a fanout the admin wants ON dies unexpectedly (RTMP
 * blip, destination drop, source not yet publishing at boot), the
 * supervisor respawns it with exponential backoff (2s → 60s) until it
 * comes back. A run that stays up past STABLE_MS resets the backoff so a
 * stream that finally blips after hours reconnects fast. Admin Stop and
 * relay shutdown (deploy SIGTERM) suppress respawns — we only fight to
 * keep ALIVE what the admin asked to be alive. Diagnosing the LAST
 * incident was impossible because nothing was logged; every lifecycle
 * transition now appends a structured event to FANOUT_EVENTS_PATH
 * (JSONL, survives the relay's per-request log flood and restarts).
 *
 * X/Twitter caveat: studio.x.com generates RTMP keys per-broadcast.
 * Regenerate in studio.x.com → Producer if it stops working.
 */

type FanoutId = "youtube" | "twitch" | "twitter" | "kick";

const ALL_IDS: readonly FanoutId[] = ["youtube", "twitch", "twitter", "kick"];

const STATE_FILE = process.env.FANOUT_STATE_PATH ?? "/var/lib/slop-relay/fanouts.json";
const EVENTS_FILE = process.env.FANOUT_EVENTS_PATH ?? "/var/lib/slop-relay/fanout-events.jsonl";

// Supervisor tuning. Backoff doubles per consecutive failure, capped.
// A process that stays up past STABLE_MS is considered healthy and
// resets that destination's backoff to zero.
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const STABLE_MS = 30_000;
// Keep the on-disk event log bounded — most recent N events.
const MAX_EVENTS = 1_000;
// Per-destination ring of the last few ffmpeg stderr lines, dumped into
// the exit event so we can see WHY ffmpeg died (connection reset, RTMP
// error, bad key) without trawling the request-flood journal.
const STDERR_TAIL_LINES = 12;

type DesiredState = Record<FanoutId, boolean>;

function loadDesired(): DesiredState {
  const empty: DesiredState = { youtube: false, twitch: false, twitter: false, kick: false };
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return empty;
    return {
      youtube: (parsed as Record<string, unknown>).youtube === true,
      twitch: (parsed as Record<string, unknown>).twitch === true,
      twitter: (parsed as Record<string, unknown>).twitter === true,
      kick: (parsed as Record<string, unknown>).kick === true,
    };
  } catch {
    return empty;
  }
}

const desired: DesiredState = loadDesired();

function persistDesired(): void {
  try {
    writeFileAtomic(STATE_FILE, JSON.stringify(desired));
  } catch {
    /* best-effort — losing this file just means the next restart starts nothing */
  }
}

// --- Logging ---------------------------------------------------------------

let emit: (line: string) => void = () => {};

/** Wire the relay's logger once at boot so every lifecycle event is logged. */
export function setFanoutLogger(fn: (line: string) => void): void {
  emit = fn;
}

export type FanoutEvent = {
  ts: string;
  id: FanoutId;
  event:
    | "start" // admin clicked Start
    | "stop" // admin clicked Stop
    | "restore" // brought back at boot from persisted state
    | "spawn-failed" // ffmpeg could not be started (e.g. missing key)
    | "exit" // ffmpeg process ended
    | "respawn-scheduled" // supervisor queued a retry after an unexpected death
    | "respawn"; // supervisor brought it back up
  code?: number | null;
  signal?: string | null;
  uptimeSec?: number;
  expected?: boolean; // exit was admin/shutdown-intended (not a crash)
  attempt?: number; // respawn attempt counter
  delayMs?: number; // backoff delay for a scheduled respawn
  error?: string;
  tail?: string[]; // last ffmpeg stderr lines (on a crash)
};

// In-memory ring, mirrored to disk as JSONL. Loaded on boot so the
// history endpoint survives a restart.
const events: FanoutEvent[] = loadEvents();

function loadEvents(): FanoutEvent[] {
  try {
    const raw = readFileSync(EVENTS_FILE, "utf8");
    const out: FanoutEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as FanoutEvent);
      } catch {
        /* skip a torn line */
      }
    }
    return out.slice(-MAX_EVENTS);
  } catch {
    return [];
  }
}

function recordEvent(ev: Omit<FanoutEvent, "ts">): void {
  const full: FanoutEvent = { ts: new Date().toISOString(), ...ev };
  events.push(full);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  // Human-readable line → relay log (journald).
  const parts = [`[fanout ${full.id}] ${full.event}`];
  if (full.attempt != null) parts.push(`attempt=${full.attempt}`);
  if (full.delayMs != null) parts.push(`in=${Math.round(full.delayMs / 1000)}s`);
  if (full.code != null) parts.push(`code=${full.code}`);
  if (full.signal) parts.push(`signal=${full.signal}`);
  if (full.uptimeSec != null) parts.push(`uptime=${full.uptimeSec}s`);
  if (full.expected != null) parts.push(full.expected ? "expected" : "UNEXPECTED");
  if (full.error) parts.push(`error=${JSON.stringify(full.error)}`);
  emit(parts.join(" "));
  if (full.tail && full.tail.length) emit(`[fanout ${full.id}] ffmpeg tail: ${full.tail.join(" / ")}`);
  // Mirror the bounded ring to disk atomically.
  try {
    writeFileAtomic(EVENTS_FILE, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  } catch {
    /* best-effort — we still have the in-memory ring + journald line */
  }
}

/** Recent lifecycle events, newest last (most recent `limit`). */
export function fanoutEvents(limit = 100): FanoutEvent[] {
  return events.slice(-Math.max(0, limit));
}

// --- Process registry + supervisor state -----------------------------------

const registry = new Map<FanoutId, ChildProcess>();
const startedAts = new Map<FanoutId, string>();
const stderrTail = new Map<FanoutId, string[]>();
const attempts = new Map<FanoutId, number>(); // consecutive failures → backoff
const retryTimers = new Map<FanoutId, NodeJS.Timeout>();

// Set during relay shutdown (deploy SIGTERM) so the exit handler does
// NOT try to respawn children we are intentionally killing — the new
// process will restore them via restoreFanouts().
let shuttingDown = false;

export type FanoutDestination = {
  id: FanoutId;
  name: string;
  configured: boolean;
  running: boolean;
  desired: boolean; // admin wants it on (may be respawning while !running)
  startedAt?: string;
  attempt?: number; // current consecutive-failure count (0 when healthy)
  reconnecting: boolean; // wanted on, not running, a retry is queued
};

function nameOf(id: FanoutId): string {
  return id === "youtube"
    ? "YouTube Live"
    : id === "twitch"
      ? "Twitch"
      : id === "twitter"
        ? "X / Twitter Live"
        : "Kick";
}

function destinationUrl(id: FanoutId): string | null {
  if (id === "youtube") {
    const key = process.env.YOUTUBE_STREAM_KEY;
    if (!key) return null;
    const base = process.env.YOUTUBE_RTMP_URL || "rtmp://a.rtmp.youtube.com/live2";
    return `${base}/${key}`;
  }
  if (id === "twitch") {
    const key = process.env.TWITCH_STREAM_KEY;
    if (!key) return null;
    const base = process.env.TWITCH_RTMP_URL || "rtmp://live.twitch.tv/app";
    return `${base}/${key}`;
  }
  if (id === "twitter") {
    const key = process.env.TWITTER_STREAM_KEY;
    if (!key) return null;
    const base = process.env.TWITTER_RTMP_URL || "rtmps://va.pscp.tv:443/x";
    return `${base}/${key}`;
  }
  if (id === "kick") {
    const key = process.env.KICK_STREAM_KEY;
    if (!key) return null;
    const raw = process.env.KICK_RTMP_URL ?? "";
    const base = raw.replace(/\/$/, "");
    if (!base) return null;
    return `${base}/${key}`;
  }
  return null;
}

export function listFanouts(): FanoutDestination[] {
  return ALL_IDS.map(id => ({
    id,
    name: nameOf(id),
    configured: destinationUrl(id) !== null,
    running: registry.has(id),
    desired: desired[id],
    startedAt: startedAts.get(id),
    attempt: attempts.get(id) ?? 0,
    reconnecting: desired[id] && !registry.has(id) && retryTimers.has(id),
  }));
}

// --- Spawn / supervise -----------------------------------------------------

/**
 * Spawn the ffmpeg child for `id`. Does NOT touch desired-state — callers
 * (startFanout / restoreFanouts / supervisor) own that. Wires the exit
 * handler that logs a rich exit event and, for an UNEXPECTED death of a
 * still-desired destination, schedules a backed-off respawn.
 */
function spawnProcess(id: FanoutId): { ok: true } | { ok: false; error: string } {
  if (registry.has(id)) return { ok: false, error: "Already running" };
  const url = destinationUrl(id);
  if (!url) {
    const error = `${id} is not configured (missing stream key in relay env)`;
    recordEvent({ id, event: "spawn-failed", error });
    return { ok: false, error };
  }

  // Pull from our local MediaMTX. Read on path "live" doesn't require
  // publish auth (only the "live" user can publish; "any" user reads).
  const source = "rtmp://127.0.0.1:1935/live";
  const proc = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "warning", "-i", source, "-c", "copy", "-f", "flv", url],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const startedAt = new Date().toISOString();
  const startedMs = Date.parse(startedAt);
  stderrTail.set(id, []);

  const capture = (d: Buffer) => {
    const line = d.toString().trim();
    if (!line) return;
    const tail = stderrTail.get(id) ?? [];
    tail.push(line);
    while (tail.length > STDERR_TAIL_LINES) tail.shift();
    stderrTail.set(id, tail);
  };
  proc.stdout?.on("data", capture);
  proc.stderr?.on("data", capture);

  proc.on("exit", (code, signal) => {
    registry.delete(id);
    startedAts.delete(id);
    const uptimeSec = Math.round((Date.now() - startedMs) / 1000);
    // Expected = we asked it to stop (admin Stop flipped desired off) or
    // the whole relay is going down. Anything else is a crash.
    const expected = shuttingDown || !desired[id];
    recordEvent({
      id,
      event: "exit",
      code: code ?? null,
      signal: signal ?? null,
      uptimeSec,
      expected,
      tail: expected ? undefined : stderrTail.get(id),
    });
    stderrTail.delete(id);
    if (expected) {
      attempts.delete(id);
      return;
    }
    // Unexpected death of a still-wanted destination. Only a run that
    // stayed up past STABLE_MS counts as "healthy" and resets the
    // backoff — so a stream that connects then instantly drops (flapping)
    // still backs off 2s→4s→…→60s instead of hammering every 2s.
    if (uptimeSec * 1000 >= STABLE_MS) attempts.set(id, 0);
    scheduleRespawn(id);
  });

  registry.set(id, proc);
  startedAts.set(id, startedAt);
  return { ok: true };
}

function scheduleRespawn(id: FanoutId): void {
  if (shuttingDown || !desired[id]) return;
  if (retryTimers.has(id) || registry.has(id)) return;
  const n = attempts.get(id) ?? 0;
  const delayMs = Math.min(BASE_BACKOFF_MS * 2 ** n, MAX_BACKOFF_MS);
  attempts.set(id, n + 1);
  recordEvent({ id, event: "respawn-scheduled", attempt: n + 1, delayMs });
  const timer = setTimeout(() => {
    retryTimers.delete(id);
    if (shuttingDown || !desired[id] || registry.has(id)) return;
    const result = spawnProcess(id);
    if (result.ok) {
      recordEvent({ id, event: "respawn", attempt: n + 1 });
    } else {
      // spawn-failed already recorded inside spawnProcess; keep retrying.
      scheduleRespawn(id);
    }
  }, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  retryTimers.set(id, timer);
}

function cancelRespawn(id: FanoutId): void {
  const t = retryTimers.get(id);
  if (t) {
    clearTimeout(t);
    retryTimers.delete(id);
  }
}

// --- Public API ------------------------------------------------------------

export function startFanout(id: FanoutId): { ok: true } | { ok: false; error: string } {
  if (registry.has(id)) return { ok: false, error: "Already running" };
  desired[id] = true;
  persistDesired();
  attempts.set(id, 0);
  cancelRespawn(id);
  const result = spawnProcess(id);
  if (result.ok) {
    recordEvent({ id, event: "start" });
  } else {
    // Couldn't start now (e.g. source not publishing yet) — keep the
    // desire and let the supervisor retry instead of giving up.
    scheduleRespawn(id);
  }
  return result;
}

export function stopFanout(id: FanoutId): { ok: true } | { ok: false; error: string } {
  // Persist the admin's intent first — this Stop means "don't bring it
  // back," so it must win over any in-flight respawn.
  const wasDesired = desired[id];
  desired[id] = false;
  persistDesired();
  cancelRespawn(id);
  attempts.delete(id);
  const proc = registry.get(id);
  if (!proc) {
    // No live process. If it was desired (running OR mid-respawn) the
    // Stop still did real work — it cancelled the self-heal — so report
    // success and log the intent. Only a fanout that was already off is a
    // genuine no-op.
    if (wasDesired) {
      recordEvent({ id, event: "stop" });
      return { ok: true };
    }
    return { ok: false, error: "Not running" };
  }
  recordEvent({ id, event: "stop" });
  proc.kill("SIGTERM");
  registry.delete(id);
  startedAts.delete(id);
  return { ok: true };
}

export function isKnownFanoutId(id: string): id is FanoutId {
  return id === "youtube" || id === "twitch" || id === "twitter" || id === "kick";
}

export function shutdownAllFanouts(): void {
  // Process shutdown (deploy / SIGTERM), not admin intent. Flag it so the
  // exit handlers log "expected" and do NOT schedule respawns, then leave
  // the desired-state file untouched so restoreFanouts() brings back
  // whatever was running before.
  shuttingDown = true;
  for (const [, t] of retryTimers) clearTimeout(t);
  retryTimers.clear();
  for (const [, proc] of registry) {
    proc.kill("SIGTERM");
  }
  registry.clear();
  startedAts.clear();
}

/**
 * Boot-time restore: for each destination the admin had previously
 * marked "on", spawn it. Unlike before, a destination that fails to come
 * up (source not publishing yet, transient error) is NOT abandoned —
 * the supervisor retries it with backoff until it sticks.
 */
export function restoreFanouts(): void {
  for (const id of ALL_IDS) {
    if (!desired[id]) continue;
    const result = spawnProcess(id);
    if (result.ok) {
      recordEvent({ id, event: "restore" });
    } else {
      scheduleRespawn(id);
    }
  }
}

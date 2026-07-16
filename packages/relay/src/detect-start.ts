// Auto-detect a VOD start point by reading the intro countdown timer.
//
// The slop.computer intro renders a big glitchy M:SS countdown that hits ~0:00
// when the show begins. It runs as a real-time (1:1 with video) clock once it's
// going, but in some episodes it FREEZES for the first ~minute before catching
// up — so a single early frame can't be trusted. We instead walk frames forward
// in 30s steps, read the timer with Claude vision, and the first consecutive
// pair whose value drops by ~30s proves the clock is running 1:1; from there
// start = t + (timer - TARGET). TARGET is a few seconds of countdown left so the
// viewer still sees the "0:05…" before the episode.
//
// Vision read is dead simple for the model even through the glitch (validated on
// real episodes: 0:14, 0:19, 3:29, 0:56 all read exactly), and it ignores the
// distractor numbers on the fake-desktop UI (music time, tickers).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const TIMER_PROMPT =
  "This is a frame from a livestream intro that shows a large glitchy countdown timer in the format M:SS or MM:SS " +
  "(big digits, center of the screen). Read ONLY that big central countdown timer. Ignore any smaller numbers " +
  "(music-player time, tickers, prices, addresses). Respond with ONLY strict JSON and nothing else: " +
  '{"seconds":<the timer as total integer seconds>} . ' +
  'If you cannot confidently read a big countdown timer, respond {"seconds":null}.';

export type StartSample = { t: number; seconds: number | null };
export type DetectResult = {
  startSeconds: number;
  /** What value the timer showed where we locked on, for the admin to sanity-check. */
  lockTimer: number;
  lockAt: number;
  method: string;
  samples: StartSample[];
};

export type DetectEvent =
  | { phase: "sample"; t: number; seconds: number | null }
  | { phase: "done"; startSeconds: number }
  | { phase: "error"; message: string };

/** Container duration in seconds via ffprobe. Used to map a global session
 *  timestamp onto the right segment when MediaMTX split the recording. */
async function probeDurationSec(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let out = "";
    let err = "";
    ff.stdout.on("data", d => (out += String(d)));
    ff.stderr.on("data", d => (err += String(d)));
    ff.on("error", reject);
    ff.on("close", code => {
      const n = Number(out.trim());
      if (code === 0 && Number.isFinite(n) && n >= 0) resolve(n);
      else reject(new Error(`ffprobe ${code}: ${err.slice(0, 200)}`));
    });
  });
}

/** Extract one frame at `atSec` as a downscaled JPEG buffer (1280px wide is
 *  plenty for the timer and keeps vision tokens low). Input-seek (`-ss` before
 *  `-i`) so it's fast even on a long file. */
async function extractFrameJpeg(videoPath: string, atSec: number): Promise<Buffer> {
  const out = join(tmpdir(), `slop-detect-${Date.now()}-${randomBytes(4).toString("hex")}.jpg`);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-ss",
      String(atSec),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=1280:-1",
      "-q:v",
      "4",
      "-y",
      out,
    ]);
    let err = "";
    ff.stderr.on("data", d => (err += String(d)));
    ff.on("error", reject);
    ff.on("close", code => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 200)}`))));
  });
  try {
    return await readFile(out);
  } finally {
    void unlink(out).catch(() => {});
  }
}

/** Read the countdown timer (in seconds) from a frame via Claude vision. Returns
 *  null when the model can't read a timer (frozen/garbled/absent). */
async function readTimerSeconds(jpeg: Buffer, opts: { apiKey: string; model: string }): Promise<number | null> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 60,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
            { type: "text", text: TIMER_PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${text.slice(0, 200)}`);
  }
  const j = (await res.json()) as { content?: { text?: string }[] };
  const text = j?.content?.[0]?.text ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { seconds?: unknown };
    const s = parsed.seconds;
    return typeof s === "number" && Number.isFinite(s) && s >= 0 ? Math.round(s) : null;
  } catch {
    return null;
  }
}

/**
 * Detect the start point across `videoPaths` — the contiguous recording
 * session, oldest→newest (usually one file; more when MediaMTX rotated
 * mid-stream). Sample times are GLOBAL stitched-VOD seconds, mapped onto the
 * owning segment by cumulative container duration — the same arithmetic the
 * concat stitch produces, so the returned start point is valid for the pinned
 * VOD. Walks frames in 30s steps until a consecutive pair confirms the
 * countdown is running 1:1, then extrapolates to `TARGET` seconds-left.
 * Returns null if no countdown could be read at all.
 */
export async function detectStartPoint(opts: {
  videoPaths: string[];
  apiKey: string;
  model: string;
  /** Seconds of countdown to leave visible at the start point (default 8). */
  target?: number;
  /** Stop scanning past this many seconds in (default 360 — covers a long frozen intro). */
  maxScanSec?: number;
  onEvent?: (ev: DetectEvent) => void;
}): Promise<DetectResult | null> {
  const TARGET = opts.target ?? 8;
  const STEP = 30;
  const cap = opts.maxScanSec ?? 360;
  const emit = opts.onEvent ?? (() => {});

  // Cumulative-duration table: segment i covers [startAt, startAt + dur) in
  // global session time. A segment whose duration can't be probed is skipped
  // (treated as zero-length) rather than aborting the scan.
  const segments: { file: string; startAt: number; dur: number }[] = [];
  let total = 0;
  for (const file of opts.videoPaths) {
    const dur = await probeDurationSec(file).catch(() => 0);
    segments.push({ file, startAt: total, dur });
    total += dur;
  }

  const samples: StartSample[] = [];
  let prev: StartSample | null = null;

  for (let t = STEP; t <= Math.min(cap, total - 1); t += STEP) {
    const seg = segments.find(s => t >= s.startAt && t < s.startAt + s.dur);
    let seconds: number | null = null;
    try {
      if (!seg) throw new Error(`no segment covers t=${t}`);
      const buf = await extractFrameJpeg(seg.file, t - seg.startAt);
      seconds = await readTimerSeconds(buf, { apiKey: opts.apiKey, model: opts.model });
    } catch {
      seconds = null; // a single bad frame/read shouldn't abort the whole scan
    }
    samples.push({ t, seconds });
    emit({ phase: "sample", t, seconds });

    if (seconds != null && prev?.seconds != null) {
      const delta = prev.seconds - seconds; // ~STEP when the clock is running 1:1
      if (delta >= STEP * 0.6 && delta <= STEP * 1.5) {
        const startSeconds = Math.max(0, Math.round(t + (seconds - TARGET)));
        emit({ phase: "done", startSeconds });
        return { startSeconds, lockTimer: seconds, lockAt: t, method: `1:1 between ${prev.t}s and ${t}s`, samples };
      }
    }
    prev = { t, seconds };
  }

  // Never saw a clean running pair (e.g. frozen the whole scan). Fall back to the
  // last frame we COULD read, assuming the clock is real-time there — for the
  // frozen-intro episodes the tail is always running 1:1, so this still lands close.
  const lastReadable = [...samples].reverse().find(s => s.seconds != null);
  if (lastReadable && lastReadable.seconds != null) {
    const startSeconds = Math.max(0, Math.round(lastReadable.t + (lastReadable.seconds - TARGET)));
    emit({ phase: "done", startSeconds });
    return { startSeconds, lockTimer: lastReadable.seconds, lockAt: lastReadable.t, method: "fallback (single frame)", samples };
  }

  emit({ phase: "error", message: "no countdown timer could be read" });
  return null;
}

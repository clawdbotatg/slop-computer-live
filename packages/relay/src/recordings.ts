import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
// `openAsBlob` lands in Node 19.8+ (we're on 22) but @types/node@18 in
// this workspace doesn't ship the declaration yet. Import it dynamically
// with a typed signature instead of pulling in newer types repo-wide.
import * as nodeFs from "node:fs";
const openAsBlob = (nodeFs as unknown as { openAsBlob: (path: string) => Promise<Blob> }).openAsBlob;

import { type EpisodeMeta, generateEpisodeMeta } from "./meta-ai.js";

// Post-stream archival: MediaMTX writes the live session to disk
// (see deploy/mediamtx.yml `record:` block); this module finds the
// newest recording for a path and pins it to the LOCAL kubo daemon
// running on the same box. Pinning goes through kubo's HTTP API
// (POST /api/v0/add) which streams a newline-delimited JSON response —
// each chunk is a {Bytes:N} progress update, the final chunk carries
// {Hash:CID, Size:N}. The audience plays back via
// https://media.slop.computer/ipfs/<cid>, which Caddy proxies to
// localhost:8080 (the kubo gateway).
//
// Previously we shelled out to the `bgipfs upload` CLI which hit the
// public bgipfs.com endpoint. That had per-key quotas that don't fit
// a regular podcast cadence — self-hosting gives us unlimited pins
// plus real byte-level progress for the UI.

export type RecordingFile = {
  /** Absolute path on disk. */
  file: string;
  /** Filename only — convenient for the client. */
  name: string;
  sizeBytes: number;
  /** Last-modified epoch ms. */
  mtime: number;
};

export type FinalizeResult = {
  /** CID of the actual video file (mp4). */
  cid: string;
  /** CID of the manifest JSON pinned alongside, which references the video CID. */
  manifestCid: string;
  file: string;
  name: string;
  sizeBytes: number;
  mtime: number;
};

/** Streaming progress events emitted by finalizeRecording. */
export type FinalizeEvent =
  | { phase: "starting"; file: string; name: string; totalBytes: number; segmentCount: number }
  | { phase: "remuxing" }
  | { phase: "stitching"; segmentCount: number }
  | { phase: "uploading"; bytes: number; totalBytes: number }
  | { phase: "pinning-chat"; messageCount: number }
  | { phase: "pinning-transcript"; segmentCount: number }
  | { phase: "pinning-geometry"; sampleCount: number }
  | { phase: "pinning-card"; sizeBytes: number }
  | { phase: "generating-meta" }
  | { phase: "pinning-manifest" }
  | {
      phase: "done";
      cid: string;
      manifestCid: string;
      file: string;
      name: string;
      sizeBytes: number;
      mtime: number;
    }
  | { phase: "error"; message: string };

/**
 * Scan `<recordingsDir>/<pathName>/` and return the most recently modified
 * file. Returns null if the dir is missing or empty — the caller should
 * surface that as a user-friendly "no recording found" error.
 */
export async function findLatestRecording(
  recordingsDir: string,
  pathName: string,
): Promise<RecordingFile | null> {
  const dir = join(recordingsDir, pathName);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: RecordingFile | null = null;
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    if (!best || s.mtimeMs > best.mtime) {
      best = { file: full, name, sizeBytes: s.size, mtime: s.mtimeMs };
    }
  }
  return best;
}

/** A recording file plus the timing we recover by probing it. */
export type RecordingSegment = RecordingFile & {
  /** Container duration in seconds (ffprobe). */
  durationSec: number;
  /** Real content start = mtime − duration. We derive it this way rather than
   *  from the filename because MediaMTX gives ROTATION files a wrong filename
   *  timestamp (observed: a file named `15-51-20` whose content began at
   *  `15-26-18`), whereas mtime (write-finished = content-end) and the probed
   *  duration are always accurate. */
  startMs: number;
};

/** Two contiguous segments meet within this slack. MediaMTX takes ~2s to
 *  restart its recorder after a reordered-frames burst, so the real-content
 *  gap is a second or two; distinct episodes are minutes-to-days apart, so a
 *  small window can't accidentally merge two separate shows. */
const SEGMENT_GAP_TOLERANCE_MS = 12_000;

/** ffprobe a file's container duration in seconds. Returns null if ffprobe is
 *  missing, the file is unreadable, or the duration can't be parsed (e.g. a
 *  zero-byte file still being written). */
async function probeDurationSec(file: string): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const v = Number.parseFloat(out.trim());
      resolve(Number.isFinite(v) && v > 0 ? v : null);
    });
  });
}

/**
 * Reassemble the contiguous run of recording segments that ENDS at the newest
 * file — the durable fix for the mid-session split. MediaMTX rotates to a fresh
 * file when the encoder sends a burst of out-of-order frames (`too many
 * reordered frames`), so one continuous show can land in 2+ files; finalize
 * used to pin only the single newest by mtime, dropping everything before the
 * last split ("VOD starts N minutes in").
 *
 * We detect contiguity by real content time, not filenames (which the rotation
 * files mislabel): each file's end is its mtime, its start is mtime − duration.
 * Starting from the newest, we walk backwards through mtime-adjacent files while
 * each predecessor's end meets the next segment's start within
 * {@link SEGMENT_GAP_TOLERANCE_MS}. Segments are written sequentially, so the
 * run is always mtime-adjacent — we only probe the session's own files plus the
 * first non-matching predecessor, not the whole directory.
 *
 * Returns the segments oldest→newest (concat order), or an empty array if the
 * dir is missing/empty. A single-file session returns one segment — finalize
 * then takes its original (un-stitched) remux path.
 */
export async function findRecordingSession(recordingsDir: string, pathName: string): Promise<RecordingSegment[]> {
  const dir = join(recordingsDir, pathName);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files: RecordingFile[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    files.push({ file: full, name, sizeBytes: s.size, mtime: s.mtimeMs });
  }
  if (files.length === 0) return [];
  files.sort((a, b) => a.mtime - b.mtime);

  const toSegment = async (f: RecordingFile): Promise<RecordingSegment | null> => {
    const durationSec = await probeDurationSec(f.file);
    if (durationSec == null) return null;
    return { ...f, durationSec, startMs: f.mtime - durationSec * 1000 };
  };

  const newest = await toSegment(files[files.length - 1]!);
  if (!newest) {
    // Can't probe the newest file (corrupt, or still being written). Fall back
    // to a lone segment so finalize still produces something rather than failing.
    const f = files[files.length - 1]!;
    return [{ ...f, durationSec: 0, startMs: f.mtime }];
  }
  const session: RecordingSegment[] = [newest];
  for (let i = files.length - 2; i >= 0; i--) {
    const prev = await toSegment(files[i]!);
    if (!prev) break; // unprobeable predecessor → treat the chain as broken
    const head = session[0]!;
    // prev's recording end (its mtime) should meet head's real start.
    if (Math.abs(head.startMs - prev.mtime) > SEGMENT_GAP_TOLERANCE_MS) break;
    session.unshift(prev);
  }
  return session;
}

/**
 * Parse the recording start time (epoch ms) out of a MediaMTX recording
 * filename. MediaMTX writes files as `%Y-%m-%d_%H-%M-%S-%f` (see
 * `deploy/mediamtx.yml` recordPath), e.g. `2026-06-03_16-00-23-923649.mp4`,
 * in the box's local time — which is UTC on the deploy host, so we parse as
 * UTC. The `%f` microseconds are truncated to ms. Returns null if the name
 * doesn't match (older recordings, manual files), in which case the meta
 * generator falls back to anchoring on the first transcript segment.
 */
export function parseRecordingStartMs(name: string): number | null {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d{1,6}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
  if (Number.isNaN(ms)) return null;
  // Pad/truncate the fractional part to milliseconds (first 3 digits).
  const subMs = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
  return ms + subMs;
}

/**
 * POST the file to kubo's /api/v0/add and parse its newline-delimited JSON
 * progress stream. kubo emits `{Bytes: N}` chunks as it ingests the file
 * and a final `{Hash: CID, Size: N}` chunk when the CID is settled. We
 * surface those Bytes updates via `onProgress` so the UI can render a
 * real percentage.
 *
 * `openAsBlob` returns a file-backed Blob that the built-in FormData
 * streams lazily, so we never buffer the whole recording in RAM — fine
 * for multi-GB shows.
 */
export async function pinToLocalIpfs(opts: {
  apiUrl: string;
  file: string;
  onProgress?: (bytes: number) => void;
}): Promise<{ cid: string; size: number }> {
  const blob = await openAsBlob(opts.file);
  const form = new FormData();
  form.append("file", blob, basename(opts.file));
  const res = await fetch(`${opts.apiUrl}/api/v0/add?stream-channels=true&progress=true`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`kubo /api/v0/add ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.body) throw new Error("kubo /api/v0/add returned no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cid = "";
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let ev: { Name?: string; Bytes?: number; Hash?: string; Size?: string };
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // ignore garbage
      }
      if (typeof ev.Bytes === "number") opts.onProgress?.(ev.Bytes);
      if (ev.Hash) {
        cid = ev.Hash;
        size = ev.Size ? Number(ev.Size) : 0;
      }
    }
  }
  if (!cid) throw new Error("kubo: stream ended without a Hash");
  return { cid, size };
}

/**
 * Pin a small in-memory Blob to kubo via /api/v0/add. Returns the CID.
 * Shared by the JSON manifest and the chat-archive JSONL pins — both
 * are tiny enough to buffer fully in memory, so the streaming/progress
 * machinery in `pinToLocalIpfs` isn't worth the noise here.
 */
async function pinBlobToLocalIpfs(opts: {
  apiUrl: string;
  blob: Blob;
  filename: string;
}): Promise<string> {
  const form = new FormData();
  form.append("file", opts.blob, opts.filename);
  const res = await fetch(`${opts.apiUrl}/api/v0/add?pin=true`, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`kubo /api/v0/add (${opts.filename}) ${res.status}: ${text.slice(0, 200)}`);
  }
  // kubo returns one JSON object on the final line for a single small file.
  const text = await res.text();
  const lastLine = text.trim().split("\n").pop() || "";
  const parsed = JSON.parse(lastLine) as { Hash?: string };
  if (!parsed.Hash) throw new Error(`kubo: ${opts.filename} pin returned no Hash: ${text.slice(0, 200)}`);
  return parsed.Hash;
}

/**
 * Pin an in-memory JSON blob to kubo via /api/v0/add. Returns the CID.
 * Used to publish a tiny manifest alongside the (much larger) video.
 */
export async function pinJsonToLocalIpfs(opts: { apiUrl: string; json: unknown }): Promise<string> {
  const blob = new Blob([JSON.stringify(opts.json, null, 2)], { type: "application/json" });
  return pinBlobToLocalIpfs({ apiUrl: opts.apiUrl, blob, filename: "manifest.json" });
}

/**
 * Read a small object back out of the LOCAL kubo node by CID via
 * /api/v0/cat. Used by the meta-only regenerate path to pull a past
 * episode's already-pinned manifest + transcript without touching any
 * recording on disk. Strips a leading `ipfs://` so callers can pass either
 * a bare CID or the on-chain `ipfs://<cid>` URL. Throws on a non-200 (e.g.
 * the content was garbage-collected off this node).
 */
export async function catFromLocalIpfs(opts: { apiUrl: string; cid: string }): Promise<string> {
  const cid = opts.cid.replace(/^ipfs:\/\//, "").trim();
  if (!cid) throw new Error("catFromLocalIpfs: empty cid");
  const res = await fetch(`${opts.apiUrl}/api/v0/cat?arg=${encodeURIComponent(cid)}`, { method: "POST" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`kubo /api/v0/cat (${cid}) ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.text();
}

/**
 * Remux a fragmented-MP4 recording (what MediaMTX writes with
 * `recordFormat: fmp4`) into a standard non-fragmented MP4 with
 * `-c copy` (no re-encode, ~30x realtime) and `+faststart` (moov atom
 * at the front so the file is streamable over HTTP without
 * pre-buffering).
 *
 * Why: fmp4 keeps both audio + video tracks but some players (incl.
 * a few macOS/Chrome combos) silently skip the audio track when handed
 * a fragmented file. The standard-mp4 container plays everywhere.
 *
 * Output lands in $TMPDIR with a random name; the returned `cleanup`
 * removes it. The caller MUST call cleanup once the file is pinned (or
 * the pin fails) or we leak files into /tmp.
 */
async function remuxToStandardMp4(input: string): Promise<{ output: string; cleanup: () => Promise<void> }> {
  const output = join(tmpdir(), `slop-remux-${Date.now()}-${randomBytes(4).toString("hex")}.mp4`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-y", "-i", input, "-c", "copy", "-movflags", "+faststart", "-loglevel", "error", output],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) reject(new Error(`ffmpeg remux exited ${code}: ${stderr.trim().slice(0, 300)}`));
      else resolve();
    });
  });
  return {
    output,
    cleanup: async () => {
      await unlink(output).catch(() => {});
    },
  };
}

/**
 * Stitch a multi-segment recording session (see {@link findRecordingSession})
 * into one standard, faststart MP4 with the concat demuxer and `-c copy` (no
 * re-encode — the segments share codecs since they're the same MediaMTX
 * session). The result is already a non-fragmented +faststart MP4, so it needs
 * no separate remux pass.
 *
 * Same $TMPDIR + caller-owned `cleanup` contract as {@link remuxToStandardMp4}.
 * The list file is written with ABSOLUTE paths — the concat demuxer resolves
 * relative entries against the list file's own dir, not the cwd.
 */
async function concatToStandardMp4(inputs: string[]): Promise<{ output: string; cleanup: () => Promise<void> }> {
  const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const listPath = join(tmpdir(), `slop-concat-${stamp}.txt`);
  const output = join(tmpdir(), `slop-stitch-${stamp}.mp4`);
  // ffmpeg concat list escaping: a single quote becomes '\'' .
  const listBody = inputs.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  await writeFile(listPath, listBody, "utf8");
  await new Promise<void>((resolve, reject) => {
    // prettier-ignore
    const args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", "-loglevel", "error", output];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) reject(new Error(`ffmpeg concat exited ${code}: ${stderr.trim().slice(0, 300)}`));
      else resolve();
    });
  });
  return {
    output,
    cleanup: async () => {
      await unlink(output).catch(() => {});
      await unlink(listPath).catch(() => {});
    },
  };
}

// Guards against firing two finalizes for the same recording at once —
// re-uploading the same bytes is wasted bandwidth and confuses the host.
let inFlight: Promise<FinalizeResult> | null = null;

/**
 * Drive a single finalize and emit progress events to `onEvent` as the
 * upload streams through kubo. Resolves with the final FinalizeResult
 * (also emitted as a `done` event). Throws via the `error` event AND a
 * rejection so callers can pick either pattern.
 */
export async function finalizeRecording(opts: {
  recordingsDir: string;
  pathName: string;
  ipfsApiUrl: string;
  /** Caller snapshots these from the room and passes them in — keeps
   *  recordings.ts decoupled from per-room subsystem APIs. */
  chatArchive: { content: string; messageCount: number } | null;
  transcriptArchive: { content: string; segmentCount: number } | null;
  /** Long-running participant roster captured every time a peer joined the
   *  room. Inlined into the manifest under `participants` — no separate IPFS
   *  pin (the list is tiny relative to chat/transcript/video). SIWE/passkey
   *  peers carry `address`; anon peers carry `anonId` plus the display name
   *  they chose (already resolved by the caller against `peerNames`). Pass
   *  `null` to omit. */
  participants:
    | {
        address: string | null;
        anonId: string | null;
        handle: string | null;
        role: "host" | "guest";
      }[]
    | null;
  /** The host-baked unfurl card PNG (the one CardWindow's disk-save button
   *  produced). Pinned to IPFS during finalize and referenced under
   *  `manifest.card.cid` so the per-episode preview image is content-addressed,
   *  not dependent on `live.slop.computer/v1/cards/<slug>/published.png`
   *  staying up. Pass `null` if the host never saved a card. */
  cardArchive: { bytes: Buffer; format: string } | null;
  /** Append-only window-geometry timeline (geometry.jsonl), snapshotted from
   *  the room. Pinned to IPFS and referenced under `manifest.geometry.cid` so
   *  the clipper can read exact window rects instead of recovering them from
   *  the recorded pixels. A `header` line carrying `videoStartMs` (so consumers
   *  can map `ts` → video seconds) is prepended here at finalize. Pass `null`
   *  to omit (older rooms, no log) — the clipper falls back to its CV pipeline. */
  geometryArchive: { content: string; sampleCount: number } | null;
  /** Authoritative non-transcript context for the AI-meta pass so it doesn't
   *  repeat speech-to-text spelling errors in names. `roomSlug` is the
   *  host-chosen slug (usually the guest's name/topic); `researchContext` is the
   *  pre-assembled guest-research dossier text. All best-effort. */
  roomSlug?: string;
  roomName?: string;
  researchContext?: string;
  onEvent?: (ev: FinalizeEvent) => void;
}): Promise<FinalizeResult> {
  if (inFlight) return inFlight;
  const emit = opts.onEvent ?? (() => {});

  const task = (async () => {
    // A "session" is the contiguous run of segments MediaMTX wrote for one
    // continuous show — usually one file, but more when it rotated mid-stream
    // on a reordered-frames burst. Stitching the whole run is the durable fix
    // for the "VOD starts N minutes in" split (see findRecordingSession).
    const session = await findRecordingSession(opts.recordingsDir, opts.pathName);
    if (session.length === 0) {
      const msg = `No recording found in ${opts.recordingsDir}/${opts.pathName}`;
      emit({ phase: "error", message: msg });
      throw new Error(msg);
    }
    const first = session[0]!; // true show start (correct even when later names lie)
    const latest = session[session.length - 1]!; // newest segment = session end / identity
    const totalBytes = session.reduce((n, s) => n + s.sizeBytes, 0);
    emit({ phase: "starting", file: latest.file, name: latest.name, totalBytes, segmentCount: session.length });

    try {
      // Prepare a single standard, faststart MP4 to pin. One segment → remux
      // fmp4 → standard mp4 (some non-Safari players silently drop the audio
      // track on fragmented input). Multiple segments → concat them, which
      // already yields a standard faststart mp4. Both run at `-c copy` speed.
      let prepared: { output: string; cleanup: () => Promise<void> };
      if (session.length > 1) {
        emit({ phase: "stitching", segmentCount: session.length });
        prepared = await concatToStandardMp4(session.map(s => s.file));
      } else {
        emit({ phase: "remuxing" });
        prepared = await remuxToStandardMp4(first.file);
      }
      const { output: remuxed, cleanup } = prepared;
      try {
        const { cid, size } = await pinToLocalIpfs({
          apiUrl: opts.ipfsApiUrl,
          file: remuxed,
          onProgress: bytes => emit({ phase: "uploading", bytes, totalBytes }),
        });

        // Snapshot the chat archive and pin it before the manifest so its CID
        // can be referenced from `manifest.chat`. The on-disk JSONL is global
        // across all episodes; we pin the full file each finalize and let the
        // per-episode manifest point at its own snapshot CID. JSONL is pinned
        // as-is (no JSON wrapper) since the frontpage just opens the raw CID.
        let chatPin: { cid: string; messageCount: number } | null = null;
        const chatArchive = opts.chatArchive;
        if (chatArchive && chatArchive.messageCount > 0) {
          emit({ phase: "pinning-chat", messageCount: chatArchive.messageCount });
          const chatCid = await pinBlobToLocalIpfs({
            apiUrl: opts.ipfsApiUrl,
            blob: new Blob([chatArchive.content], { type: "application/x-ndjson" }),
            filename: "chat.jsonl",
          });
          chatPin = { cid: chatCid, messageCount: chatArchive.messageCount };
        }

        // Snapshot the live transcript JSONL the same way as chat. Each line
        // is one server-stamped Web Speech "final" segment; merged across
        // peers and sorted by `ts` to form the canonical episode transcript.
        let transcriptPin: { cid: string; segmentCount: number } | null = null;
        const transcriptArchive = opts.transcriptArchive;
        if (transcriptArchive && transcriptArchive.segmentCount > 0) {
          emit({
            phase: "pinning-transcript",
            segmentCount: transcriptArchive.segmentCount,
          });
          const transcriptCid = await pinBlobToLocalIpfs({
            apiUrl: opts.ipfsApiUrl,
            blob: new Blob([transcriptArchive.content], {
              type: "application/x-ndjson",
            }),
            filename: "transcript.jsonl",
          });
          transcriptPin = {
            cid: transcriptCid,
            segmentCount: transcriptArchive.segmentCount,
          };
        }

        // Anchor for time alignment: the FIRST segment's start, so chat/geometry
        // and AI-meta chapters line up with t0 of the stitched video — not the
        // last split's (wrong) filename, which is what broke alignment whenever a
        // session rotated. Prefer the filename time (microsecond-exact, correct
        // for the cleanly-started first file); fall back to the probed
        // mtime−duration start if the name doesn't parse. Null only when neither
        // is available, in which case meta anchors on the first transcript seg.
        const videoStartMs =
          parseRecordingStartMs(first.name) ?? (first.durationSec > 0 ? Math.round(first.startMs) : null);

        // Snapshot the window-geometry timeline the same way as chat/transcript.
        // We prepend a `header` line carrying `videoStartMs` so the consumer can
        // map each event's wall-clock `ts` to video seconds, then pin the JSONL.
        let geometryPin: { cid: string; sampleCount: number; format: string } | null = null;
        const geometryArchive = opts.geometryArchive;
        if (geometryArchive && geometryArchive.sampleCount > 0) {
          emit({ phase: "pinning-geometry", sampleCount: geometryArchive.sampleCount });
          const header = JSON.stringify({ v: 1, kind: "header", videoStartMs: videoStartMs ?? null }) + "\n";
          const geometryCid = await pinBlobToLocalIpfs({
            apiUrl: opts.ipfsApiUrl,
            blob: new Blob([header + geometryArchive.content], { type: "application/x-ndjson" }),
            filename: "geometry.jsonl",
          });
          geometryPin = {
            cid: geometryCid,
            sampleCount: geometryArchive.sampleCount,
            format: "application/jsonl",
          };
        }

        // Pin the host-baked unfurl card PNG. Same dedup-on-content-hash
        // semantics as everything else kubo pins — same PNG → same CID
        // across re-finalizes.
        let cardPin: { cid: string; format: string; sizeBytes: number } | null = null;
        const cardArchive = opts.cardArchive;
        if (cardArchive && cardArchive.bytes.length > 0) {
          emit({ phase: "pinning-card", sizeBytes: cardArchive.bytes.length });
          const cardCid = await pinBlobToLocalIpfs({
            apiUrl: opts.ipfsApiUrl,
            blob: new Blob([cardArchive.bytes], { type: cardArchive.format }),
            filename: "card.png",
          });
          cardPin = {
            cid: cardCid,
            format: cardArchive.format,
            sizeBytes: cardArchive.bytes.length,
          };
        }

        // Best-effort AI pass: title, one-liner, description, topics, chapters
        // from the transcript + chat. Wrapped in try/catch and returns null on
        // any failure (no key, API down, malformed JSON) — finalize never fails
        // because of this, the manifest just ships without `meta` and the host
        // can re-finalize or fill it in manually later.
        let aiMeta: EpisodeMeta | null = null;
        if (transcriptArchive && transcriptArchive.segmentCount >= 3) {
          emit({ phase: "generating-meta" });
          try {
            // Anchor chapter times to the video recording window so they line
            // up with the player clock — start parsed from the filename (above),
            // end from the file mtime. Without this, pre-show mic-checks and
            // post-show chatter in the transcript anchor t0 hours early.
            aiMeta = await generateEpisodeMeta({
              transcriptJsonl: transcriptArchive.content,
              chatJsonl: chatArchive?.content,
              videoStartMs: videoStartMs ?? undefined,
              videoEndMs: videoStartMs != null ? latest.mtime : undefined,
              slug: opts.roomSlug,
              roomName: opts.roomName,
              participants: opts.participants ?? undefined,
              research: opts.researchContext,
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("[finalize] meta generation threw", err);
          }
        }

        // Build + pin the minimal manifest. The host UI can later issue a
        // setManifest tx with a richer manifest CID (description, transcript,
        // etc.) — we just guarantee a valid v1 manifest exists out of the gate
        // so the on-chain reference is never half-baked.
        emit({ phase: "pinning-manifest" });
        const manifestJson: {
          version: 1;
          video: { cid: string; sizeBytes: number; format: string };
          chat?: { cid: string; messageCount: number };
          transcript?: { cid: string; segmentCount: number };
          geometry?: { cid: string; sampleCount: number; format: string };
          card?: { cid: string; format: string; sizeBytes: number };
          participants?: {
            address: string | null;
            anonId: string | null;
            role: "host" | "guest";
            handle: string | null;
          }[];
          meta?: EpisodeMeta;
        } = {
          version: 1,
          video: {
            cid,
            sizeBytes: size || totalBytes,
            format: "video/mp4",
          },
        };
        if (chatPin) manifestJson.chat = chatPin;
        if (transcriptPin) manifestJson.transcript = transcriptPin;
        if (geometryPin) manifestJson.geometry = geometryPin;
        if (cardPin) manifestJson.card = cardPin;
        if (opts.participants && opts.participants.length > 0) {
          // Strip extras the frontend doesn't read (firstSeenAt etc.) so the
          // manifest stays minimal. Anon entries carry `anonId` instead of an
          // address; their `handle` is already resolved to the chosen display
          // name by the caller.
          manifestJson.participants = opts.participants.map(p => ({
            address: p.address,
            anonId: p.anonId,
            role: p.role,
            handle: p.handle,
          }));
        }
        if (aiMeta) manifestJson.meta = aiMeta;
        const manifestCid = await pinJsonToLocalIpfs({ apiUrl: opts.ipfsApiUrl, json: manifestJson });

        // We KEEP the transcript JSONL on disk after pinning. Previously this
        // was auto-cleared "so the next episode starts fresh" — but rooms are
        // already per-slug (different episode = different room = different
        // JSONL file), so cross-episode contamination was never a real risk,
        // and the auto-clear silently broke re-finalize: every subsequent run
        // read an empty transcript file and shipped a manifest with no
        // transcript + no AI meta. The host can still manually wipe pre-show
        // test segments via DELETE /admin/transcript.

        const result: FinalizeResult = {
          cid,
          manifestCid,
          file: latest.file,
          name: latest.name,
          sizeBytes: size || totalBytes,
          mtime: latest.mtime,
        };
        emit({ phase: "done", ...result });
        return result;
      } finally {
        await cleanup();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ phase: "error", message });
      throw err;
    }
  })();

  inFlight = task;
  try {
    return await task;
  } finally {
    inFlight = null;
  }
}

export function isFinalizeInFlight(): boolean {
  return inFlight !== null;
}

/** The subset of the v1 manifest the regenerate path reads + rewrites. We keep
 *  every field as-is and only swap `meta`, so unknown future fields survive via
 *  the spread in {@link regenerateEpisodeMeta}. */
type EpisodeManifestV1 = {
  version: 1;
  video: { cid: string; sizeBytes: number; format: string };
  chat?: { cid: string; messageCount: number };
  transcript?: { cid: string; segmentCount: number };
  geometry?: { cid: string; sampleCount: number; format: string };
  card?: { cid: string; format: string; sizeBytes: number };
  participants?: {
    address: string | null;
    anonId: string | null;
    role: "host" | "guest";
    handle: string | null;
  }[];
  meta?: EpisodeMeta;
};

/** Streaming progress events for the meta-only regenerate flow. Reuses the
 *  phase names the admin UI already parses from finalize (`generating-meta`,
 *  `pinning-manifest`, `done`, `error`) so the client handler is near-identical. */
export type RegenerateEvent =
  | { phase: "starting" }
  | { phase: "fetching-manifest"; manifestCid: string }
  | { phase: "generating-meta" }
  | { phase: "pinning-manifest" }
  | { phase: "done"; manifestCid: string; meta: EpisodeMeta }
  | { phase: "error"; message: string };

/** Recover the recording's wall-clock start (epoch ms) from a geometry archive,
 *  whose first line is a `{kind:"header", videoStartMs}` record (see the geometry
 *  pin in finalizeRecording). Returns null when geometry is absent or headerless
 *  — the meta generator then anchors t0 on the first transcript segment, the same
 *  fallback the original finalize used for pre-geometry rooms. */
function videoStartFromGeometry(geometryJsonl: string): number | null {
  const first = geometryJsonl.split("\n").find(l => l.trim());
  if (!first) return null;
  try {
    const h = JSON.parse(first) as { kind?: string; videoStartMs?: number | null };
    if (h.kind === "header" && typeof h.videoStartMs === "number") return h.videoStartMs;
  } catch {
    /* not a header line — fall through */
  }
  return null;
}

/** Largest transcript timestamp (epoch ms), so the meta generator can bound the
 *  trim window at the real end of speech instead of needing the (now-gone)
 *  recording file mtime. Returns null on an empty/garbled transcript. */
function lastTranscriptTs(transcriptJsonl: string): number | null {
  let max: number | null = null;
  for (const line of transcriptJsonl.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ts = (JSON.parse(s) as { ts?: number }).ts;
      if (typeof ts === "number" && (max == null || ts > max)) max = ts;
    } catch {
      /* skip */
    }
  }
  return max;
}

/**
 * Regenerate ONLY the AI metadata for an already-finalized episode, leaving its
 * video / transcript / chat / card / participants untouched. This exists because
 * {@link finalizeRecording} always pins the NEWEST file in the recordings dir —
 * re-running it days later would replace a past episode's video with whatever was
 * recorded most recently. Here we instead read the episode's existing manifest +
 * its already-pinned transcript back out of the local kubo node, run the meta
 * generator (now with slug/roster/research context), and pin a NEW manifest that
 * is byte-identical to the old one except for `meta`.
 *
 * Nothing is destructive: the old manifest CID stays pinned and on-chain until
 * the host signs `setManifest` with the new CID returned here (and they can point
 * back at the old CID at any time — both are immutable, content-addressed).
 *
 * Deliberately NO single-flight guard (unlike `finalizeRecording`'s `inFlight`):
 * the only cost of a double-fire is a wasted Opus call + a duplicate pin of the
 * same content (content-addressed → same CID), and there's no newest-file race to
 * lose. The admin button disables itself while running, which covers the common
 * case; a global lock isn't worth the coupling.
 */
export async function regenerateEpisodeMeta(opts: {
  ipfsApiUrl: string;
  /** Existing manifest CID (bare or `ipfs://`-prefixed) read off-chain by the caller. */
  manifestCid: string;
  roomSlug?: string;
  roomName?: string;
  researchContext?: string;
  onEvent?: (ev: RegenerateEvent) => void;
}): Promise<{ manifestCid: string; meta: EpisodeMeta }> {
  const emit = opts.onEvent ?? (() => {});
  try {
    emit({ phase: "starting" });

    const bareCid = opts.manifestCid.replace(/^ipfs:\/\//, "").trim();
    if (!bareCid) throw new Error("no manifest CID provided");
    emit({ phase: "fetching-manifest", manifestCid: bareCid });

    const manifestText = await catFromLocalIpfs({ apiUrl: opts.ipfsApiUrl, cid: bareCid });
    let manifest: EpisodeManifestV1;
    try {
      manifest = JSON.parse(manifestText) as EpisodeManifestV1;
    } catch {
      throw new Error("existing manifest is not valid JSON");
    }
    if (!manifest.transcript?.cid) {
      throw new Error("existing manifest has no transcript — nothing to regenerate meta from");
    }

    const transcriptJsonl = await catFromLocalIpfs({ apiUrl: opts.ipfsApiUrl, cid: manifest.transcript.cid });
    const chatJsonl = manifest.chat?.cid
      ? await catFromLocalIpfs({ apiUrl: opts.ipfsApiUrl, cid: manifest.chat.cid }).catch(() => undefined)
      : undefined;

    // Recover the video window so chapter times stay aligned with how the
    // episode was originally finalized: start from the geometry header (if the
    // manifest has one), end at the last spoken line.
    let videoStartMs: number | undefined;
    if (manifest.geometry?.cid) {
      const geo = await catFromLocalIpfs({ apiUrl: opts.ipfsApiUrl, cid: manifest.geometry.cid }).catch(() => "");
      videoStartMs = videoStartFromGeometry(geo) ?? undefined;
    }
    const lastTs = lastTranscriptTs(transcriptJsonl);
    const videoEndMs = videoStartMs != null && lastTs != null ? lastTs : undefined;

    emit({ phase: "generating-meta" });
    const meta = await generateEpisodeMeta({
      transcriptJsonl,
      chatJsonl,
      videoStartMs,
      videoEndMs,
      slug: opts.roomSlug,
      roomName: opts.roomName,
      participants: manifest.participants,
      research: opts.researchContext,
    });
    if (!meta) throw new Error("meta generation returned nothing (no transcript content or no AI key)");

    emit({ phase: "pinning-manifest" });
    // Spread the existing manifest so any field we don't model survives; only
    // `meta` is replaced. The AI pass never emits `startSeconds` (it's a
    // human-authored countdown-skip set via /admin/set-start), so carry the
    // previous value forward — otherwise a metadata regenerate would silently
    // wipe the host's start point.
    const prevStart = manifest.meta?.startSeconds;
    const mergedMeta: EpisodeMeta = prevStart && prevStart > 0 ? { ...meta, startSeconds: prevStart } : meta;
    const next: EpisodeManifestV1 = { ...manifest, meta: mergedMeta };
    const newCid = await pinJsonToLocalIpfs({ apiUrl: opts.ipfsApiUrl, json: next });

    emit({ phase: "done", manifestCid: newCid, meta });
    return { manifestCid: newCid, meta };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ phase: "error", message });
    throw err;
  }
}

/**
 * Patch the VOD start point (`meta.startSeconds`) into an already-finalized
 * episode's manifest and re-pin it — video/transcript/chat/AI-meta all
 * untouched. `startSeconds <= 0` clears the field (play from the start). Unlike
 * {@link regenerateEpisodeMeta} this runs NO AI: it's a cheap one-field edit.
 * Returns the new manifest CID; the caller writes it on-chain via setManifest.
 *
 * If the manifest somehow has no `meta` yet (pre-AI finalize), we still attach a
 * minimal meta carrying just the start point so the player can act on it.
 */
export async function setEpisodeStartPoint(opts: {
  ipfsApiUrl: string;
  /** Existing manifest CID (bare or `ipfs://`-prefixed) read off-chain by the caller. */
  manifestCid: string;
  /** Literal seek position in seconds. <= 0 clears the start point. */
  startSeconds: number;
}): Promise<{ manifestCid: string; startSeconds: number }> {
  const bareCid = opts.manifestCid.replace(/^ipfs:\/\//, "").trim();
  if (!bareCid) throw new Error("no manifest CID provided");

  const manifestText = await catFromLocalIpfs({ apiUrl: opts.ipfsApiUrl, cid: bareCid });
  let manifest: EpisodeManifestV1;
  try {
    manifest = JSON.parse(manifestText) as EpisodeManifestV1;
  } catch {
    throw new Error("existing manifest is not valid JSON");
  }

  const start = Math.max(0, Math.floor(opts.startSeconds));
  const baseMeta: EpisodeMeta = manifest.meta ?? {
    title: "",
    oneLiner: "",
    description: "",
    topics: [],
    chapters: [],
    generatedBy: "manual",
    generatedAt: 0,
  };
  const meta: EpisodeMeta = { ...baseMeta };
  if (start > 0) meta.startSeconds = start;
  else delete meta.startSeconds;

  const next: EpisodeManifestV1 = { ...manifest, meta };
  const newCid = await pinJsonToLocalIpfs({ apiUrl: opts.ipfsApiUrl, json: next });
  return { manifestCid: newCid, startSeconds: start };
}

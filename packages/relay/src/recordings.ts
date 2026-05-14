import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
// `openAsBlob` lands in Node 19.8+ (we're on 22) but @types/node@18 in
// this workspace doesn't ship the declaration yet. Import it dynamically
// with a typed signature instead of pulling in newer types repo-wide.
import * as nodeFs from "node:fs";
const openAsBlob = (nodeFs as unknown as { openAsBlob: (path: string) => Promise<Blob> }).openAsBlob;

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
  cid: string;
  file: string;
  name: string;
  sizeBytes: number;
  mtime: number;
};

/** Streaming progress events emitted by finalizeRecording. */
export type FinalizeEvent =
  | { phase: "starting"; file: string; name: string; totalBytes: number }
  | { phase: "remuxing" }
  | { phase: "uploading"; bytes: number; totalBytes: number }
  | { phase: "done"; cid: string; file: string; name: string; sizeBytes: number; mtime: number }
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
  onEvent?: (ev: FinalizeEvent) => void;
}): Promise<FinalizeResult> {
  if (inFlight) return inFlight;
  const emit = opts.onEvent ?? (() => {});

  const task = (async () => {
    const latest = await findLatestRecording(opts.recordingsDir, opts.pathName);
    if (!latest) {
      const msg = `No recording found in ${opts.recordingsDir}/${opts.pathName}`;
      emit({ phase: "error", message: msg });
      throw new Error(msg);
    }
    emit({ phase: "starting", file: latest.file, name: latest.name, totalBytes: latest.sizeBytes });

    try {
      // Remux fmp4 → standard mp4 so audio plays in all browsers / players,
      // not just fmp4-aware ones (Safari OK, others sometimes silently drop
      // the audio track). `-c copy` keeps quality identical and runs at
      // ~300x realtime.
      emit({ phase: "remuxing" });
      const { output: remuxed, cleanup } = await remuxToStandardMp4(latest.file);
      try {
        const { cid, size } = await pinToLocalIpfs({
          apiUrl: opts.ipfsApiUrl,
          file: remuxed,
          onProgress: bytes => emit({ phase: "uploading", bytes, totalBytes: latest.sizeBytes }),
        });
        const result: FinalizeResult = {
          cid,
          file: latest.file,
          name: latest.name,
          sizeBytes: size || latest.sizeBytes,
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

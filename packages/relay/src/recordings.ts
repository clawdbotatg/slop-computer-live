import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Post-stream archival: MediaMTX writes the live session to disk
// (see deploy/mediamtx.yml `record:` block); this module finds the newest
// recording for a path and pins it to bgipfs so the host can write the
// resulting CID onto the episode contract.
//
// The CLI returns the CID on a "✓ File uploaded. CID: <cid>" line — we
// parse stdout for it. The bgipfs config file lives at
// $HOME/.bgipfs/credentials.json by default.

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
 * Spawn `bgipfs upload <file> --config <config>` and resolve with the CID
 * parsed from stdout. Rejects if the process exits non-zero or no CID line
 * is found. Streams stdout/stderr to the provided logger so long uploads
 * show progress in journalctl.
 */
export function pinToBgipfs(opts: {
  bin: string;
  configPath: string;
  file: string;
  log?: (line: string) => void;
}): Promise<string> {
  const log = opts.log ?? (() => {});
  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin, ["upload", opts.file, "--config", opts.configPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      for (const line of text.split("\n")) if (line.trim()) log(`[bgipfs] ${line}`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      for (const line of text.split("\n")) if (line.trim()) log(`[bgipfs:err] ${line}`);
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        return reject(new Error(`bgipfs exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
      // SKILL.md documents the format as `✓ File uploaded. CID: <cid>` —
      // we match the trailing CID greedily to survive minor wording changes.
      const m = stdout.match(/CID[:\s]+([A-Za-z0-9]+)/);
      const cid = m?.[1];
      if (!cid) return reject(new Error(`bgipfs ok but no CID in output: ${stdout.trim()}`));
      resolve(cid);
    });
  });
}

// Guards against firing two finalizes for the same recording at once —
// re-uploading the same bytes is wasted bandwidth and confuses the host.
let inFlight: Promise<FinalizeResult> | null = null;

export async function finalizeRecording(opts: {
  recordingsDir: string;
  pathName: string;
  bgipfsBin: string;
  bgipfsConfigPath: string;
  log?: (line: string) => void;
}): Promise<FinalizeResult> {
  if (inFlight) return inFlight;
  const task = (async () => {
    const latest = await findLatestRecording(opts.recordingsDir, opts.pathName);
    if (!latest) {
      throw new Error(`No recording found in ${opts.recordingsDir}/${opts.pathName}`);
    }
    const cid = await pinToBgipfs({
      bin: opts.bgipfsBin,
      configPath: opts.bgipfsConfigPath,
      file: latest.file,
      log: opts.log,
    });
    return { cid, ...latest };
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

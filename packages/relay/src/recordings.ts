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
  | { phase: "starting"; file: string; name: string; totalBytes: number }
  | { phase: "remuxing" }
  | { phase: "uploading"; bytes: number; totalBytes: number }
  | { phase: "pinning-chat"; messageCount: number }
  | { phase: "pinning-transcript"; segmentCount: number }
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
  /** Caller snapshots these from the room and passes them in — keeps
   *  recordings.ts decoupled from per-room subsystem APIs. */
  chatArchive: { content: string; messageCount: number } | null;
  transcriptArchive: { content: string; segmentCount: number } | null;
  /** Long-running participant roster captured every time a peer joined the
   *  room. Inlined into the manifest under `participants` — no separate IPFS
   *  pin (the list is tiny relative to chat/transcript/video). Pass `null`
   *  to omit. */
  participants: { address: string; handle: string | null; role: "host" | "guest" }[] | null;
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

        // Best-effort AI pass: title, one-liner, description, topics, chapters
        // from the transcript + chat. Wrapped in try/catch and returns null on
        // any failure (no key, API down, malformed JSON) — finalize never fails
        // because of this, the manifest just ships without `meta` and the host
        // can re-finalize or fill it in manually later.
        let aiMeta: EpisodeMeta | null = null;
        if (transcriptArchive && transcriptArchive.segmentCount >= 3) {
          emit({ phase: "generating-meta" });
          try {
            aiMeta = await generateEpisodeMeta({
              transcriptJsonl: transcriptArchive.content,
              chatJsonl: chatArchive?.content,
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
          participants?: { address: string; role: "host" | "guest"; handle: string | null }[];
          meta?: EpisodeMeta;
        } = {
          version: 1,
          video: {
            cid,
            sizeBytes: size || latest.sizeBytes,
            format: "video/mp4",
          },
        };
        if (chatPin) manifestJson.chat = chatPin;
        if (transcriptPin) manifestJson.transcript = transcriptPin;
        if (opts.participants && opts.participants.length > 0) {
          // Strip extras the frontend doesn't read (firstSeenAt etc.) so the
          // manifest stays minimal. Frontend schema: { address, role?, ens? }.
          manifestJson.participants = opts.participants.map(p => ({
            address: p.address,
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

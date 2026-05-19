// Thin client for the local kubo daemon (BGIPFS in prod, a colocated
// kubo in dev). Centralized so files.ts, recordings.ts, and any future
// pinners share one HTTP shape — bug fixes and timeout tweaks land in
// one place.
//
// Why kubo's HTTP API and not js-ipfs or pinata-style remote pinning:
//   - kubo runs as a sibling daemon on the same box → zero auth, zero
//     network egress for the upload itself, and the bytes are pinned
//     before the API call returns
//   - The CID is content-addressed → safe to replay, dedupe trivially
//     if the same file lands twice
//
// All callers should treat IPFS pinning as best-effort: a pin failure
// shouldn't take down a user-visible operation (file upload, recording
// finalize). The fallbacks live in those callers.

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Pin in-memory bytes to the local kubo daemon. Returns the CID. The
 * file is small enough to buffer in memory; streaming uploads live in
 * recordings.ts's `pinToLocalIpfs` (handles multi-GB MP4s).
 */
export async function pinBlob(opts: {
  apiUrl: string;
  bytes: Buffer | Blob;
  filename: string;
}): Promise<string> {
  const form = new FormData();
  const blob =
    opts.bytes instanceof Blob
      ? opts.bytes
      : new Blob([new Uint8Array(opts.bytes.buffer, opts.bytes.byteOffset, opts.bytes.byteLength)]);
  form.append("file", blob, opts.filename);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${opts.apiUrl}/api/v0/add?pin=true`, { method: "POST", body: form, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`kubo /api/v0/add (${opts.filename}) ${res.status}: ${text.slice(0, 200)}`);
  }
  const text = await res.text();
  const lastLine = text.trim().split("\n").pop() ?? "";
  const parsed = JSON.parse(lastLine) as { Hash?: string };
  if (!parsed.Hash) throw new Error(`kubo: ${opts.filename} pin returned no Hash: ${text.slice(0, 200)}`);
  return parsed.Hash;
}

export async function pinJson(opts: { apiUrl: string; json: unknown }): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(opts.json, null, 2), "utf8");
  return pinBlob({ apiUrl: opts.apiUrl, bytes, filename: "manifest.json" });
}

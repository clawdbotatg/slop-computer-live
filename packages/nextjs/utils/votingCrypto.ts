// Client-side threshold-BFV helper for the Voting Booth. Wraps the
// vendored wasm worker (public/fhe-wasm/voting.worker.js — see the
// README there) behind typed promises, converts between base64 (what
// rides the relay) and bytes (what the wasm eats), and persists the
// poll creator's committee secret shares in localStorage so the reveal
// ceremony survives a page reload.
//
// Committee model (phase 1): all 5 DKG parties run inside the poll
// creator's browser — same trust model as weft-web's demo. The shares
// never leave this browser; the relay only ever sees the public key,
// ciphertexts, and the final plaintext tally.

export const COMMITTEE_SIZE = 5;
export const COMMITTEE_THRESHOLD = 3;

export type CommitteeShares = { partyIndex: number; b64: string }[];

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<string, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker("/fhe-wasm/voting.worker.js", { type: "module" });
    worker.onmessage = ev => {
      const { id, ok, result, error } = ev.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error || "crypto worker error"));
    };
    worker.onerror = () => {
      // A crashed worker strands every in-flight op — fail them and let
      // the next call spin up a fresh worker.
      for (const p of pending.values()) p.reject(new Error("crypto worker crashed"));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function call<T>(op: string, args: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = `${++seq}`;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, op, args });
  });
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Key ceremony: returns the joint public key (base64) and the per-party
 *  secret shares. Takes a few seconds at the 8192 preset. */
export async function runKeyCeremony(): Promise<{ pubKeyB64: string; shares: CommitteeShares }> {
  const out = await call<{ publicKey: Uint8Array; shares: { partyIndex: number; bytes: Uint8Array }[] }>("dkg", {
    committeeSize: COMMITTEE_SIZE,
    threshold: COMMITTEE_THRESHOLD,
  });
  return {
    pubKeyB64: bytesToB64(out.publicKey),
    shares: out.shares.map(s => ({ partyIndex: s.partyIndex, b64: bytesToB64(s.bytes) })),
  };
}

/** Encrypt a one-hot ballot (choice index over `numOptions`). */
export async function encryptBallot(pubKeyB64: string, choice: number, numOptions: number): Promise<string> {
  const plaintext = new Array(numOptions).fill(0);
  plaintext[choice] = 1;
  const ct = await call<Uint8Array>("encrypt", { publicKey: b64ToBytes(pubKeyB64), plaintext });
  return bytesToB64(ct);
}

/** Homomorphically sum all ballots into a single tally ciphertext. */
export async function aggregateBallots(ctsB64: string[]): Promise<Uint8Array> {
  return call<Uint8Array>("aggregate", { ciphertexts: ctsB64.map(b64ToBytes) });
}

/** One committee member's contribution to decrypting the tally. */
export async function partialDecrypt(shareB64: string, tallyCt: Uint8Array): Promise<Uint8Array> {
  return call<Uint8Array>("partialDecrypt", { share: b64ToBytes(shareB64), ciphertext: tallyCt });
}

/** Combine >= threshold decryption shares into the plaintext tally. The
 *  wasm-level threshold is decoded from the share bundles in the worker. */
export async function combineShares(shares: Uint8Array[], tallyCt: Uint8Array, numOptions: number): Promise<number[]> {
  const plain = await call<Int32Array>("combine", { shares, ciphertext: tallyCt });
  return Array.from(plain.slice(0, numOptions));
}

// --- creator share persistence ---------------------------------------------
// Keyed by a prefix of the poll's public key (the poll id doesn't exist
// yet when the ceremony runs). ~1.5 MB of shares per poll; if
// localStorage's quota rejects it we keep them in memory only and the
// reveal simply requires the creator to stay on the page.

const memShares = new Map<string, CommitteeShares>();

function shareKey(pubKeyB64: string): string {
  return `voting-shares:${pubKeyB64.slice(0, 64)}`;
}

export function saveShares(pubKeyB64: string, shares: CommitteeShares): void {
  // The reveal ceremony only ever uses the first `threshold` shares, and
  // each bundle is ~600 KB — persisting all 5 would blow the ~5 MB
  // localStorage quota. Keep the full set in memory for this session.
  memShares.set(shareKey(pubKeyB64), shares);
  try {
    localStorage.setItem(shareKey(pubKeyB64), JSON.stringify(shares.slice(0, COMMITTEE_THRESHOLD)));
  } catch {
    /* quota — in-memory fallback above still serves this session */
  }
}

export function loadShares(pubKeyB64: string): CommitteeShares | null {
  const mem = memShares.get(shareKey(pubKeyB64));
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(shareKey(pubKeyB64));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CommitteeShares;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function dropShares(pubKeyB64: string): void {
  memShares.delete(shareKey(pubKeyB64));
  try {
    localStorage.removeItem(shareKey(pubKeyB64));
  } catch {
    /* ignore */
  }
}

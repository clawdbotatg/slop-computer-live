import { p256 } from "@noble/curves/p256";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";

// Browser-side WebAuthn passkey flow. Two flavors:
//
//   createPasskeyAndAuth(): user creates a new passkey, signs a
//     server-issued nonce with it, server verifies and issues a session.
//
//   loginWithExistingPasskey(): user picks one of their existing
//     passkeys (browser sheet, no `allowCredentials`). We recover up
//     to 4 candidate public keys from the first signature, then ask
//     the SAME passkey to sign a second message with `allowCredentials`
//     so we can disambiguate. The verified-against-2nd-sig public key
//     is the real one — POST it + the second signature to the relay,
//     which double-checks server-side.
//
// Address derivation matches slopwallet so the same passkey lands on
// the same identity:  keccak256(qx ‖ qy)[-20:].

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

const RP_NAME = "Slop Computer Live";

export type PasskeyAuthResult = { address: string; credentialIdBase64Url: string };

// Stages reported via onStage so a progress UI can advance in lockstep
// with the two passkey prompts:
//   first  — about to show the first passkey sheet
//   second — about to show the second passkey sheet
//   verify — both sigs collected, posting to the relay
export type PasskeyStage = "first" | "second" | "verify";

export type PasskeyFlowOptions = {
  onStage?: (stage: PasskeyStage) => void;
  /** Pause between the first and second prompt, in ms. Lets the UI
   *  advance the progress bar before the next browser sheet steals
   *  focus. Defaults to 500. */
  betweenStagesDelayMs?: number;
};

export type LoginOptions = PasskeyFlowOptions & {
  /** Base64url-encoded rawId of a previously-used passkey. When set,
   *  both sign calls are scoped via `allowCredentials` so the browser
   *  skips its passkey picker entirely. Throws `preferred-credential-failed`
   *  if the first sign rejects — caller should clear the stored id and
   *  retry without a preference. */
  preferredCredentialId?: string;
};

// ---- public API ------------------------------------------------------------

export async function createPasskeyAndAuth(opts: PasskeyFlowOptions = {}): Promise<PasskeyAuthResult> {
  if (typeof window === "undefined") throw new Error("no-window");
  const { onStage, betweenStagesDelayMs = 500 } = opts;
  // Throwaway challenge for the create step — the create response carries
  // the public key directly, we don't need it to be server-issued.
  const createChallenge = crypto.getRandomValues(new Uint8Array(32));
  onStage?.("first");
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: createChallenge,
      rp: { name: RP_NAME, id: window.location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: "slop user",
        displayName: "slop user",
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      timeout: 60000,
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey-create-cancelled");

  const attestation = cred.response as AuthenticatorAttestationResponse;
  const spki = attestation.getPublicKey();
  if (!spki) throw new Error("no-public-key");
  const { qx, qy } = parseSpkiPublicKey(new Uint8Array(spki));

  // Brief pause so the modal can advance to stage 2 before the next
  // browser sheet pops.
  if (betweenStagesDelayMs > 0) await sleep(betweenStagesDelayMs);
  onStage?.("second");

  // Now sign a real server nonce with the freshly-created passkey.
  const nonceHex = await fetchServerNonce();
  const sign = await signWithCredentialId({
    rawId: cred.rawId,
    challenge: hexToBytes(nonceHex),
  });

  onStage?.("verify");
  return postPasskeyAuth({
    qx,
    qy,
    r: sign.r,
    s: sign.s,
    authenticatorData: sign.authenticatorData,
    clientDataJSON: sign.clientDataJSON,
    nonceHex,
    credentialIdBase64Url: base64UrlFromBytes(new Uint8Array(cred.rawId)),
  });
}

export async function loginWithExistingPasskey(opts: LoginOptions = {}): Promise<PasskeyAuthResult> {
  if (typeof window === "undefined") throw new Error("no-window");
  const { onStage, betweenStagesDelayMs = 500, preferredCredentialId } = opts;

  // When the caller has a remembered passkey id, scope both prompts to it
  // via allowCredentials so the browser skips its picker. Otherwise the
  // first call has no allowCredentials → discoverable-credential picker.
  const allowList = preferredCredentialId
    ? [
        {
          id: bytesFromBase64Url(preferredCredentialId),
          type: "public-key" as const,
          transports: ["internal", "hybrid"] as AuthenticatorTransport[],
        },
      ]
    : undefined;

  // First sign — the challenge is purely client-side; only the SECOND sig
  // (which gets server-bound to the server nonce) is sent to the relay.
  const challenge1 = crypto.getRandomValues(new Uint8Array(32));
  onStage?.("first");
  let cred1: PublicKeyCredential | null;
  try {
    cred1 = (await navigator.credentials.get({
      publicKey: {
        challenge: challenge1,
        rpId: window.location.hostname,
        userVerification: "required",
        ...(allowList ? { allowCredentials: allowList } : {}),
      },
    })) as PublicKeyCredential | null;
  } catch (err) {
    // With a preferred credential set, a NotAllowedError might mean the
    // passkey no longer exists (deleted, device switched). Signal that
    // distinctly so the caller can clear storage and retry without a
    // preference instead of giving up.
    if (preferredCredentialId) {
      const e = new Error("preferred-credential-failed");
      (e as Error & { cause?: unknown }).cause = err;
      throw e;
    }
    throw err;
  }
  if (!cred1) throw new Error("passkey-pick-cancelled");
  const a1 = cred1.response as AuthenticatorAssertionResponse;
  const sig1 = parseDerSignature(new Uint8Array(a1.signature));
  const authData1 = new Uint8Array(a1.authenticatorData);
  const clientData1 = new Uint8Array(a1.clientDataJSON);
  const message1 = sha256(concat(authData1, sha256(clientData1)));

  // Recover up to 4 candidate (qx, qy) pairs — try both recovery bits ×
  // both s & N-s. Each is a valid ECDSA pubkey for sig1; only the real
  // one will verify the SECOND signature below.
  const candidates = recoverCandidatePubkeys({ r: sig1.r, s: sig1.s, message: message1 });
  if (candidates.length === 0) throw new Error("no-candidates");

  // Brief pause so the modal can advance to stage 2 before the next
  // browser sheet pops.
  if (betweenStagesDelayMs > 0) await sleep(betweenStagesDelayMs);
  onStage?.("second");

  // Second sign — same credential, this time signing the server's nonce.
  const nonceHex = await fetchServerNonce();
  const cred2 = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(nonceHex),
      rpId: window.location.hostname,
      userVerification: "required",
      allowCredentials: [{ id: cred1.rawId, type: "public-key", transports: ["internal", "hybrid"] }],
    },
  })) as PublicKeyCredential | null;
  if (!cred2) throw new Error("passkey-sign-cancelled");
  const a2 = cred2.response as AuthenticatorAssertionResponse;
  const sig2 = parseDerSignature(new Uint8Array(a2.signature));
  const authData2 = new Uint8Array(a2.authenticatorData);
  const clientData2 = new Uint8Array(a2.clientDataJSON);
  const message2 = sha256(concat(authData2, sha256(clientData2)));

  const sig2Compact = new Uint8Array(64);
  sig2Compact.set(bigintTo32(sig2.r), 0);
  sig2Compact.set(bigintTo32(sig2.s), 32);

  // Whichever candidate verifies sig2 is the real public key. Send THAT
  // sig (which is already bound to the server nonce) for server verify.
  let chosen: { qx: Uint8Array; qy: Uint8Array } | null = null;
  for (const c of candidates) {
    const pubKey = uncompressedPubKey(c.qx, c.qy);
    try {
      if (p256.verify(sig2Compact, message2, pubKey)) {
        chosen = { qx: c.qx, qy: c.qy };
        break;
      }
    } catch {
      /* ignore — try next candidate */
    }
  }
  if (!chosen) throw new Error("no-candidate-matched-second-sig");

  onStage?.("verify");
  return postPasskeyAuth({
    qx: chosen.qx,
    qy: chosen.qy,
    r: bigintTo32(sig2.r),
    s: bigintTo32(sig2.s),
    authenticatorData: authData2,
    clientDataJSON: clientData2,
    nonceHex,
    credentialIdBase64Url: base64UrlFromBytes(new Uint8Array(cred1.rawId)),
  });
}

export function passkeyAddressFromPubkey(qx: Uint8Array, qy: Uint8Array): string {
  return "0x" + bytesToHex(keccak_256(concat(qx, qy)).slice(-20));
}

// ---- helpers (server I/O) --------------------------------------------------

async function fetchServerNonce(): Promise<string> {
  const res = await fetch(`${RELAY_HTTP}/auth/siwe/nonce`, { credentials: "include" });
  if (!res.ok) throw new Error("nonce-fetch-failed");
  const j = (await res.json()) as { nonce?: string };
  if (!j.nonce) throw new Error("no-nonce");
  return j.nonce;
}

async function postPasskeyAuth(args: {
  qx: Uint8Array;
  qy: Uint8Array;
  r: Uint8Array;
  s: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  nonceHex: string;
  credentialIdBase64Url: string;
}): Promise<PasskeyAuthResult> {
  const body = {
    qx: bytesToHex(args.qx),
    qy: bytesToHex(args.qy),
    r: bytesToHex(args.r),
    s: bytesToHex(args.s),
    authenticatorData: bytesToHex(args.authenticatorData),
    clientDataJSON: bytesToHex(args.clientDataJSON),
    nonce: args.nonceHex,
  };
  const res = await fetch(`${RELAY_HTTP}/auth/passkey`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`passkey-auth-failed:${j.error ?? res.status}`);
  }
  const j = (await res.json()) as { address?: string };
  if (!j.address) throw new Error("no-address-returned");
  return { address: j.address, credentialIdBase64Url: args.credentialIdBase64Url };
}

// ---- helpers (signing) -----------------------------------------------------

async function signWithCredentialId(args: { rawId: ArrayBuffer; challenge: Uint8Array }): Promise<{
  r: Uint8Array;
  s: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
}> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: args.challenge,
      rpId: window.location.hostname,
      userVerification: "required",
      allowCredentials: [{ id: args.rawId, type: "public-key", transports: ["internal", "hybrid"] }],
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey-sign-cancelled");
  const a = cred.response as AuthenticatorAssertionResponse;
  const sig = parseDerSignature(new Uint8Array(a.signature));
  return {
    r: bigintTo32(sig.r),
    s: bigintTo32(sig.s),
    authenticatorData: new Uint8Array(a.authenticatorData),
    clientDataJSON: new Uint8Array(a.clientDataJSON),
  };
}

// ---- helpers (parsing + math) ----------------------------------------------

// SPKI for a P-256 EC public key embeds a `04 || x(32) || y(32)` block.
// Typical layout (91 bytes):
//   30 59                  (SEQUENCE)
//     30 13                (SEQUENCE alg)
//       06 07 2A 86 48 CE 3D 02 01     (OID id-ecPublicKey)
//       06 08 2A 86 48 CE 3D 03 01 07  (OID prime256v1)
//     03 42 00             (BIT STRING, 66 bytes, 0 unused bits)
//       04 || x(32) || y(32)
// We just scan for the `00 04` preamble — the 0x00 unused-bits byte
// followed by the 0x04 uncompressed-point marker, with at least 64
// trailing bytes of x ‖ y.
function parseSpkiPublicKey(spki: Uint8Array): { qx: Uint8Array; qy: Uint8Array } {
  for (let i = 0; i + 65 <= spki.length; i++) {
    if (spki[i] !== 0x04) continue;
    if (i > 0 && spki[i - 1] !== 0x00) continue;
    return { qx: spki.slice(i + 1, i + 33), qy: spki.slice(i + 33, i + 65) };
  }
  throw new Error("spki-parse-failed");
}

// DER ECDSA signature: 0x30 LL  0x02 RL <r>  0x02 SL <s>
// r/s may be 33 bytes if their high bit was set (DER pads with 0x00).
function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new Error("der-not-sequence");
  let i = 2; // skip seq tag + length byte
  if (der[i] !== 0x02) throw new Error("der-no-r-int");
  const rLen = der[i + 1]!;
  const rBytes = der.slice(i + 2, i + 2 + rLen);
  i += 2 + rLen;
  if (der[i] !== 0x02) throw new Error("der-no-s-int");
  const sLen = der[i + 1]!;
  const sBytes = der.slice(i + 2, i + 2 + sLen);
  return { r: bytesToBigInt(rBytes), s: bytesToBigInt(sBytes) };
}

const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

function recoverCandidatePubkeys(args: {
  r: bigint;
  s: bigint;
  message: Uint8Array;
}): { qx: Uint8Array; qy: Uint8Array }[] {
  const out: { qx: Uint8Array; qy: Uint8Array }[] = [];
  for (const sCandidate of [args.s, P256_N - args.s]) {
    for (const recovery of [0, 1]) {
      try {
        const sig = new p256.Signature(args.r, sCandidate).addRecoveryBit(recovery);
        const pub = sig.recoverPublicKey(args.message);
        const raw = pub.toRawBytes(false); // 65 bytes: 04 || x || y
        out.push({ qx: raw.slice(1, 33), qy: raw.slice(33, 65) });
      } catch {
        /* invalid — skip */
      }
    }
  }
  return out;
}

function uncompressedPubKey(qx: Uint8Array, qy: Uint8Array): Uint8Array {
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(qx, 1);
  out.set(qy, 33);
  return out;
}

// ---- byte helpers ----------------------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (const v of b) out += v.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex-odd-length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

function bigintTo32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function base64UrlFromBytes(b: Uint8Array): string {
  let bin = "";
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

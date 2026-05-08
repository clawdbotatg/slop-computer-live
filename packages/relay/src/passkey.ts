import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";

// Server-side WebAuthn / passkey signature verification.
//
// We don't deploy a smart-wallet contract for this version (slopwallet
// uses one for on-chain verification via EIP-1271). Instead, the
// browser hands us {qx, qy, r, s, authenticatorData, clientDataJSON}
// and we re-run the same P-256 check that the OS authenticator did:
//
//   message = sha256( authenticatorData || sha256(clientDataJSON) )
//   p256.verify( {r, s}, message, pubKey(qx, qy) )
//
// The "address" we hand to the rest of the system is a synthetic
// 20-byte identifier derived from the passkey's public key — same
// formula slopwallet uses (`keccak256(qx || qy).slice(-20)`) — so
// the same passkey on the same device always lands on the same
// address.

export type VerifyArgs = {
  qx: Uint8Array;
  qy: Uint8Array;
  r: Uint8Array;
  s: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  expectedChallengeBase64Url: string;
  expectedType?: string;
};

export type VerifyResult = { ok: true; address: string } | { ok: false; error: string };

export function verifyPasskey(args: VerifyArgs): VerifyResult {
  const { qx, qy, r, s, authenticatorData, clientDataJSON, expectedChallengeBase64Url, expectedType } = args;

  if (qx.length !== 32 || qy.length !== 32) return { ok: false, error: "bad-pubkey" };
  if (r.length !== 32 || s.length !== 32) return { ok: false, error: "bad-signature" };

  // Parse clientDataJSON; assert challenge + type match what we issued.
  let parsed: { type?: string; challenge?: string };
  try {
    parsed = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch {
    return { ok: false, error: "bad-client-data-json" };
  }
  if (parsed.type !== (expectedType ?? "webauthn.get")) {
    return { ok: false, error: "wrong-type" };
  }
  if (parsed.challenge !== expectedChallengeBase64Url) {
    return { ok: false, error: "challenge-mismatch" };
  }

  const message = sha256(concat(authenticatorData, sha256(clientDataJSON)));
  const pubKey = new Uint8Array(65);
  pubKey[0] = 0x04;
  pubKey.set(qx, 1);
  pubKey.set(qy, 33);
  const sig = new Uint8Array(64);
  sig.set(r, 0);
  sig.set(s, 32);

  if (!p256.verify(sig, message, pubKey)) {
    return { ok: false, error: "signature-failed" };
  }

  const addrBytes = keccak_256(concat(qx, qy)).slice(-20);
  return { ok: true, address: "0x" + bytesToHex(addrBytes) };
}

export function passkeyAddressFromPubkey(qx: Uint8Array, qy: Uint8Array): string {
  return "0x" + bytesToHex(keccak_256(concat(qx, qy)).slice(-20));
}

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

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex-odd-length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

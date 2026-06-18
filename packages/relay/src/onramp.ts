// Apple Pay → personal-wallet on-ramp (Coinbase Onramp; docs/PASSKEY-WALLET.md §13).
//
// Mints a single-use Coinbase Onramp *session* server-side and hands the browser
// back the ready-to-use `onrampUrl` (the session token is embedded in it). The
// user opens that URL → Apple Pay sheet → ETH on Base lands directly at their
// personal-wallet address (counterfactual is fine; receiving needs no deploy).
//
// Why server-side: since 2025-07-31 onramp URLs must be initialized with a
// short-lived, one-time session token minted with a CDP Secret API key — that
// key is a server secret and never touches the browser.
//
// CDP auth is a 120s EdDSA (Ed25519) JWT. We hand-roll it with @noble/curves
// (already a relay dep) rather than pull in @coinbase/cdp-sdk — matches the
// relay's noble-based crypto style and keeps the dependency surface small.

import { ed25519 } from "@noble/curves/ed25519";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

const CDP_HOST = "api.cdp.coinbase.com";
const SESSIONS_PATH = "/platform/v2/onramp/sessions";

export function isOnrampConfigured(): boolean {
  return !!config.cdpApiKeyId && !!config.cdpApiKeySecret;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

// Build the CDP Bearer JWT for one request. Claims per CDP's JWT auth spec:
// header { alg:EdDSA, typ:JWT, kid, nonce } and payload
// { sub, iss:"cdp", aud:["cdp_service"], nbf, exp:+120s, uri:"METHOD host/path" }.
function generateCdpJwt(method: string, path: string): string {
  // The secret is a base64-encoded 64-byte Ed25519 key: [0..32) seed (private),
  // [32..64) public. @noble/curves signs from the 32-byte seed.
  const keyBytes = Buffer.from(config.cdpApiKeySecret, "base64");
  if (keyBytes.length !== 64) {
    throw new Error(`CDP_API_KEY_SECRET must decode to 64 bytes (got ${keyBytes.length})`);
  }
  const seed = keyBytes.subarray(0, 32);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: config.cdpApiKeyId, nonce: randomBytes(8).toString("hex") };
  const payload = {
    sub: config.cdpApiKeyId,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    exp: now + 120,
    uri: `${method} ${CDP_HOST}${path}`,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = ed25519.sign(new TextEncoder().encode(signingInput), seed);
  return `${signingInput}.${b64url(Buffer.from(sig))}`;
}

type OnrampResult = { url: string } | { error: string };

// Mint a single-use onramp session for `address` (ETH on Base). Returns the
// one-time onramp URL, or a short error string the route maps to a status code.
export async function createOnrampSession(address: string): Promise<OnrampResult> {
  if (!isOnrampConfigured()) return { error: "onramp-not-configured" };

  let jwt: string;
  try {
    jwt = generateCdpJwt("POST", SESSIONS_PATH);
  } catch (e) {
    return { error: `jwt: ${(e as Error).message}` };
  }

  try {
    const res = await fetch(`https://${CDP_HOST}${SESSIONS_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({
        destinationAddress: address,
        purchaseCurrency: "ETH",
        destinationNetwork: "base",
      }),
    });

    const j = (await res.json().catch(() => ({}))) as {
      session?: { onrampUrl?: string };
      onrampUrl?: string;
      errorMessage?: string;
      message?: string;
    };

    if (!res.ok) {
      return { error: `cdp ${res.status}: ${j.errorMessage ?? j.message ?? "unknown"}` };
    }
    const url = j.session?.onrampUrl ?? j.onrampUrl;
    if (typeof url !== "string" || !url) return { error: "no-onramp-url" };
    return { url };
  } catch (e) {
    return { error: `network: ${(e as Error).message}` };
  }
}

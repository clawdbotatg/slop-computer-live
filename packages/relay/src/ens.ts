import { createPublicClient, http, namehash } from "viem";
import { mainnet as mainnetBase } from "viem/chains";
import { config } from "./config.js";

// Native ENS contenthash resolution. Goal: when a user types `foo.eth`
// in the slop-computer browser, we look up the contenthash record
// directly via Alchemy, decode it to an IPFS/IPNS/Swarm address, and
// hand back a public-gateway URL to load. No eth.link or eth.limo
// indirection.
//
// Scope: handles the common cases (IPFS CIDv0 + CIDv1, IPNS, Swarm).
// Unhandled cases return { ok:false, error:"unsupported-codec" } and
// the caller falls back to a normal HTTPS fetch.

const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const ensRegistryAbi = [
  {
    name: "resolver",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const resolverAbi = [
  {
    name: "contenthash",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export type EnsResolveOk = {
  ok: true;
  name: string;
  protocol: "ipfs" | "ipns" | "swarm";
  value: string;
  /** Public-gateway URL ready to navigate to (with trailing slash). */
  gateway: string;
};

export type EnsResolveErr = {
  ok: false;
  error:
    | "invalid-name"
    | "no-resolver"
    | "no-contenthash"
    | "unsupported-codec"
    | "resolve-failed"
    | "no-alchemy-key";
};

export type EnsResolveResult = EnsResolveOk | EnsResolveErr;

// --- Base encoding helpers ---------------------------------------------------

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// --- Contenthash decoding ----------------------------------------------------

// EIP-1577 contenthash format: a multicodec varint prefix followed by the
// protocol-specific payload. Common prefixes (varint-encoded):
//   0xe3 0x01 = ipfs-ns       (IPFS)
//   0xe5 0x01 = ipns-ns       (IPNS)
//   0xe4 0x01 = swarm-ns      (Swarm bzz)
//
// Inside IPFS/IPNS the payload is a CID. CIDv0 = bare multihash starting
// 0x12 0x20 (sha2-256, 32 bytes), encoded as base58btc with "Qm" prefix.
// CIDv1 = version byte 0x01, codec byte (e.g. 0x70 dag-pb), then
// multihash, encoded as multibase base32 with "b" prefix → "bafy...".

function encodeCID(bytes: Uint8Array): string | null {
  if (bytes.length < 2) return null;
  if (bytes[0] === 0x12 && bytes[1] === 0x20) {
    // CIDv0 multihash. Convert to CIDv1 dag-pb so the result is DNS-safe
    // (lowercase base32) — subdomain-style IPFS gateways require it.
    // CIDv1 = [version=0x01, codec=0x70 (dag-pb)] ++ original multihash.
    const cidv1 = new Uint8Array(bytes.length + 2);
    cidv1[0] = 0x01;
    cidv1[1] = 0x70;
    cidv1.set(bytes, 2);
    return "b" + base32Encode(cidv1);
  }
  if (bytes[0] === 0x01) {
    // CIDv1: multibase "b" prefix indicates base32.
    return "b" + base32Encode(bytes);
  }
  return null;
}

function decodeContenthash(hex: string): { protocol: "ipfs" | "ipns" | "swarm"; value: string } | null {
  if (!hex || hex === "0x" || hex === "0x00") return null;
  const bytes = hexToBytes(hex);
  if (bytes.length < 4) return null;

  // Codec prefix is a varint. For the protocols we care about, the
  // wire form is exactly 2 bytes (codec values 0xe3 / 0xe4 / 0xe5
  // happen to need 2 varint bytes).
  const c0 = bytes[0];
  const c1 = bytes[1];

  if (c0 === 0xe3 && c1 === 0x01) {
    const cid = encodeCID(bytes.slice(2));
    if (!cid) return null;
    return { protocol: "ipfs", value: cid };
  }
  if (c0 === 0xe5 && c1 === 0x01) {
    const cid = encodeCID(bytes.slice(2));
    if (!cid) return null;
    return { protocol: "ipns", value: cid };
  }
  if (c0 === 0xe4 && c1 === 0x01) {
    // Swarm: payload is the raw hash. Gateways take hex.
    const hexPayload = Array.from(bytes.slice(2), b => b.toString(16).padStart(2, "0")).join("");
    return { protocol: "swarm", value: hexPayload };
  }
  return null;
}

function gatewayUrlFor(protocol: "ipfs" | "ipns" | "swarm", value: string): string {
  // Subdomain-style gateway on `community.bgipfs.com`. Each CID gets
  // its own origin which keeps cookies/localStorage isolated between
  // sites (the way native domain-loaded apps expect). Subdomain mode
  // requires DNS-safe CIDs — `encodeCID` already upgrades CIDv0 →
  // CIDv1 base32 above so this always holds for IPFS/IPNS.
  if (protocol === "ipfs") return `https://${value}.ipfs.community.bgipfs.com/`;
  if (protocol === "ipns") return `https://${value}.ipns.community.bgipfs.com/`;
  // Swarm — Ethswarm's public gateway (path-based; no subdomain mode).
  return `https://api.gateway.ethswarm.org/bzz/${value}/`;
}

// --- Public API --------------------------------------------------------------

// Simple 10-minute in-memory cache. ENS records change rarely; agents
// retyping the same name shouldn't hammer Alchemy.
const TTL_MS = 10 * 60 * 1000;
type CacheEntry = { expiresAt: number; result: EnsResolveResult };
const cache = new Map<string, CacheEntry>();

let client: ReturnType<typeof createPublicClient> | null = null;

function getClient() {
  if (client) return client;
  if (!config.alchemyApiKey) return null;
  const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`;
  const mainnet = {
    ...mainnetBase,
    rpcUrls: { default: { http: [alchemyUrl] }, public: { http: [alchemyUrl] } },
  } as const;
  client = createPublicClient({ chain: mainnet, transport: http(alchemyUrl) });
  return client;
}

export async function resolveEns(rawName: string): Promise<EnsResolveResult> {
  const name = rawName.toLowerCase().trim();
  if (!name || !name.endsWith(".eth")) return { ok: false, error: "invalid-name" };

  const cached = cache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const c = getClient();
  if (!c) return { ok: false, error: "no-alchemy-key" };

  try {
    const node = namehash(name);
    const resolver = (await c.readContract({
      address: ENS_REGISTRY,
      abi: ensRegistryAbi,
      functionName: "resolver",
      args: [node],
    })) as string;
    if (!resolver || resolver.toLowerCase() === ZERO_ADDR) {
      const result: EnsResolveResult = { ok: false, error: "no-resolver" };
      cache.set(name, { result, expiresAt: Date.now() + TTL_MS });
      return result;
    }
    const contenthashBytes = (await c.readContract({
      address: resolver as `0x${string}`,
      abi: resolverAbi,
      functionName: "contenthash",
      args: [node],
    })) as `0x${string}`;
    const decoded = decodeContenthash(contenthashBytes);
    if (!decoded) {
      const result: EnsResolveResult =
        contenthashBytes === "0x" ? { ok: false, error: "no-contenthash" } : { ok: false, error: "unsupported-codec" };
      cache.set(name, { result, expiresAt: Date.now() + TTL_MS });
      return result;
    }
    const result: EnsResolveOk = {
      ok: true,
      name,
      protocol: decoded.protocol,
      value: decoded.value,
      gateway: gatewayUrlFor(decoded.protocol, decoded.value),
    };
    cache.set(name, { result, expiresAt: Date.now() + TTL_MS });
    return result;
  } catch (err) {
    console.warn("[ens] resolve failed", name, err);
    return { ok: false, error: "resolve-failed" };
  }
}

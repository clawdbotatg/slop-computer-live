// Server-side ERC-7730 "clear signing" engine.
//
// Wraps @ethereum-sourcify/clear-signing so the browser never has to:
//   - fetch descriptors from the GitHub registry (CSP / CORS headache), or
//   - hold an RPC transport to read token metadata.
//
// The library is a *pure formatter*: it resolves an ERC-7730 descriptor for
// (chainId, contract), decodes the calldata against the matched function
// signature, and renders each field per the descriptor's display rules. It
// does zero network itself for token/ENS/chain data — that's delegated to the
// `ExternalDataProvider` we supply below, which reads on-chain via the app's
// existing Alchemy endpoints.
//
// Two facts that shape this file:
//   1. Standard ERC-20s have NO descriptor in the registry. To clear-sign a
//      plain transfer/approve (the multisig's bread-and-butter) we must pass a
//      `trustedTokens` list so the lib can synthesize an ERC-20 descriptor on
//      the fly. We build that list by probing each target for `decimals()`.
//   2. Token symbol/name come straight from the contract — a hostile token can
//      claim "USDC". That's the documented ERC-7730 "external data spoofing"
//      surface; here we surface the on-chain value and let the UI mark it. A
//      production wallet would gate this behind a curated trusted-token list.
import { fetchPrebuiltRegistryIndex, format, formatEip5792Batch } from "@ethereum-sourcify/clear-signing";
import type { ExternalDataProvider, RegistryIndex, TokenResult, TrustedTokens } from "@ethereum-sourcify/clear-signing";
import { createPublicClient, getAddress, http, isAddress, parseAbi } from "viem";
import type { Address, PublicClient } from "viem";
import { arbitrum, base, gnosis, mainnet, optimism, polygon } from "viem/chains";
import { getAlchemyHttpUrl } from "~~/utils/scaffold-eth/networks";

const CHAINS = { 1: mainnet, 10: optimism, 100: gnosis, 137: polygon, 8453: base, 42161: arbitrum } as const;

// Native currency per supported chain — feeds ERC-7730 `amount` / `chainId`
// formats (native value transfers, gas, etc.).
const NATIVE: Record<number, { name: string; symbol: string; decimals: number }> = {
  1: { name: "Ether", symbol: "ETH", decimals: 18 },
  10: { name: "Ether", symbol: "ETH", decimals: 18 },
  100: { name: "xDAI", symbol: "xDAI", decimals: 18 },
  137: { name: "POL", symbol: "POL", decimals: 18 },
  8453: { name: "Ether", symbol: "ETH", decimals: 18 },
  42161: { name: "Ether", symbol: "ETH", decimals: 18 },
};

const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

// ---- caches (module-scoped, survive across requests on a warm server) ----
const clients = new Map<number, PublicClient | null>();
const tokenCache = new Map<string, TokenResult | null>();
const ensCache = new Map<string, string | null>();
let indexPromise: Promise<RegistryIndex | undefined> | null = null;

function clientFor(chainId: number): PublicClient | null {
  if (clients.has(chainId)) return clients.get(chainId)!;
  const chain = CHAINS[chainId as keyof typeof CHAINS];
  const url = getAlchemyHttpUrl(chainId);
  const client = chain && url ? (createPublicClient({ chain, transport: http(url) }) as PublicClient) : null;
  clients.set(chainId, client);
  return client;
}

// Prebuilt registry index — fetched once, reused. If GitHub is unreachable we
// resolve to `undefined` and let the formatter degrade to its raw fallback.
export function getRegistryIndex(): Promise<RegistryIndex | undefined> {
  if (!indexPromise) {
    indexPromise = fetchPrebuiltRegistryIndex().catch(err => {
      console.warn("[clear-sign] registry index fetch failed:", err?.message ?? err);
      indexPromise = null; // allow retry on a later request
      return undefined;
    });
  }
  return indexPromise;
}

async function resolveToken(chainId: number, tokenAddress: string): Promise<TokenResult | null> {
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  if (tokenCache.has(key)) return tokenCache.get(key)!;
  const client = clientFor(chainId);
  if (!client || !isAddress(tokenAddress)) {
    tokenCache.set(key, null);
    return null;
  }
  const address = getAddress(tokenAddress) as Address;
  try {
    // `decimals()` is the discriminator: if it reverts, this isn't an ERC-20.
    const decimals = await client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" });
    const [symbol, name] = await Promise.all([
      client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "???"),
      client.readContract({ address, abi: ERC20_ABI, functionName: "name" }).catch(() => ""),
    ]);
    const result: TokenResult = {
      name: String(name || symbol || "Token"),
      symbol: String(symbol),
      decimals: Number(decimals),
    };
    tokenCache.set(key, result);
    return result;
  } catch {
    tokenCache.set(key, null); // not a token (e.g. an EOA recipient or non-ERC20 contract)
    return null;
  }
}

async function resolveEns(address: string): Promise<string | null> {
  const key = address.toLowerCase();
  if (ensCache.has(key)) return ensCache.get(key)!;
  const client = clientFor(1);
  if (!client || !isAddress(address)) {
    ensCache.set(key, null);
    return null;
  }
  try {
    const name = await client.getEnsName({ address: getAddress(address) as Address });
    ensCache.set(key, name ?? null);
    return name ?? null;
  } catch {
    ensCache.set(key, null);
    return null;
  }
}

export const externalDataProvider: ExternalDataProvider = {
  resolveToken,
  resolveEnsName: async address => {
    const name = await resolveEns(address);
    return name ? { name, typeMatch: true } : null;
  },
  resolveChainInfo: async chainId => {
    const native = NATIVE[chainId];
    if (!native) return null;
    const chain = CHAINS[chainId as keyof typeof CHAINS];
    return { name: chain?.name ?? `chain ${chainId}`, nativeCurrency: native };
  },
};

// Probe candidate target addresses; any that answer `decimals()` become
// trusted ERC-20s so the formatter can synthesize a descriptor for them.
export async function buildTrustedTokens(chainId: number, addresses: string[]): Promise<TrustedTokens> {
  const uniq = [...new Set(addresses.filter(a => isAddress(a)).map(a => getAddress(a)))];
  const entries = await Promise.all(uniq.map(async a => [a, await resolveToken(chainId, a)] as const));
  const map: Record<string, "erc20"> = {};
  for (const [addr, tok] of entries) if (tok) map[addr] = "erc20";
  return Object.keys(map).length ? { [chainId]: map } : {};
}

export { format, formatEip5792Batch };

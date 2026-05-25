// Shared types for the wallet window's portfolio/header/assets panel.
// Mirrors the shape that `relay /v1/wallet/portfolio` returns
// (see packages/relay/src/wallet-data.ts).

export type PortfolioAsset = {
  blockchain: string;
  tokenName: string;
  tokenSymbol: string;
  positionType: string;
  protocol: string | null;
  balance: string;
  balanceUsd: string;
  // Zerion implementation decimals for this chain — defaults to 18 if
  // missing. Needed to convert the human balance back into raw units
  // for ERC-20 transfer calldata or native msg.value.
  tokenDecimals: number;
  contractAddress: string;
  thumbnail: string;
};

export type Portfolio = {
  totalBalanceUsd: string;
  assets: PortfolioAsset[];
  defiPositions: PortfolioAsset[];
  change1dUsd: string;
  change1dPct: string;
  error?: string;
};

// Map a Zerion chain slug (the `blockchain` field on PortfolioAsset)
// to the viem chain id used by the multisig. Returns null when the
// chain isn't one of the three the multisig factory deploys on — the
// send UI uses that null to disable the send affordance.
export function zerionChainToId(slug: string): number | null {
  const s = slug.toLowerCase();
  if (s === "ethereum") return 1;
  if (s === "base") return 8453;
  if (s === "gnosis" || s === "xdai") return 100;
  return null;
}

// Convert a human balance string (e.g. "1.5", "1234.567") into raw
// base units (BigInt) given the asset's decimals. Truncates excess
// fractional digits rather than rounding, so we never propose a
// transfer larger than what the wallet actually holds. Negative values
// or non-numeric input return 0n.
export function toRawUnits(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (!trimmed) return 0n;
  if (!/^[0-9]*\.?[0-9]*$/.test(trimmed)) return 0n;
  const [whole = "0", frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  } catch {
    return 0n;
  }
}

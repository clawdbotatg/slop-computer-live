import { formatEther } from "viem";

// Render USD alongside ETH amounts. The *Suffix helpers return a parenthesized,
// space-prefixed string (e.g. " (~$12.34)") so they append cleanly after an
// existing "… ETH" label, and return "" when the price is unknown — so a missing
// price just hides the USD rather than printing a broken value.

export function formatUsd(usd: number): string {
  if (!isFinite(usd)) return "";
  if (usd >= 1000) return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (usd >= 1) return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Sub-dollar: a couple of significant cents (e.g. $0.04, $0.0012).
  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: usd >= 0.01 ? 2 : 4 })}`;
}

/** " (~$X)" for an ETH amount given as a number or decimal string. "" if no price. */
export function usdSuffixFromEth(eth: number | string, priceUsd: number | null): string {
  const n = typeof eth === "string" ? Number(eth) : eth;
  if (priceUsd == null || !isFinite(n)) return "";
  return ` (~${formatUsd(n * priceUsd)})`;
}

/** " (~$X)" for an ETH amount given in wei (bigint or string). "" if no price. */
export function usdSuffixFromWei(wei: bigint | string, priceUsd: number | null): string {
  if (priceUsd == null) return "";
  try {
    const eth = Number(formatEther(typeof wei === "bigint" ? wei : BigInt(wei)));
    return usdSuffixFromEth(eth, priceUsd);
  } catch {
    return "";
  }
}

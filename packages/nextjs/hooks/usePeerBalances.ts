"use client";

import { useMemo } from "react";
import type { Abi } from "viem";
import { formatEther } from "viem";
import { base } from "viem/chains";
import { useReadContracts } from "wagmi";

// Batched native-ETH balances for a set of addresses (the guest list).
//
// Native balance isn't a contract call, so to fetch N of them in ONE round
// trip we lean on Multicall3's `getEthBalance(address)` view — the canonical
// multicall reads every balance in a single multicall the way
// PasskeyWalletContext batches its factory reads. Pass the SPENDABLE addresses
// (already passkey→personal-wallet resolved); the returned map is keyed by
// lowercased address → balance in wei.
//
// Multicall3 lives at the same address on every chain we touch, Base included.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const GET_ETH_BALANCE_ABI = [
  {
    inputs: [{ name: "addr", type: "address" }],
    name: "getEthBalance",
    outputs: [{ name: "balance", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export function usePeerBalances(addresses: (string | null | undefined)[]): Record<string, bigint> {
  const uniq = useMemo(
    () =>
      [...new Set(addresses.filter((a): a is string => !!a).map(a => a.toLowerCase()))].filter(a =>
        /^0x[0-9a-f]{40}$/.test(a),
      ),
    [addresses],
  );

  const contracts = useMemo(
    () =>
      uniq.map(a => ({
        address: MULTICALL3,
        abi: GET_ETH_BALANCE_ABI as unknown as Abi,
        functionName: "getEthBalance",
        args: [a],
        chainId: base.id,
      })),
    [uniq],
  );

  const { data } = useReadContracts({
    contracts,
    // Cheap, frequent: refresh every 30s so a fresh deposit shows up without a
    // reload. Guests come and go faster than balances move, so this is plenty.
    query: { enabled: contracts.length > 0, refetchInterval: 30_000 },
  });

  return useMemo(() => {
    const m: Record<string, bigint> = {};
    uniq.forEach((a, i) => {
      const r = data?.[i]?.result;
      if (typeof r === "bigint") m[a] = r;
    });
    return m;
  }, [uniq, data]);
}

/** Compact ETH label for a wei balance — trimmed to the leading significant
 *  digits so it fits the narrow guest panel. */
export function formatBalanceShort(wei: bigint): string {
  const eth = Number(formatEther(wei));
  if (eth === 0) return "0";
  if (eth < 0.0001) return "<0.0001";
  const decimals = eth < 1 ? 4 : eth < 1000 ? 3 : 1;
  return eth.toFixed(decimals).replace(/\.?0+$/, "");
}

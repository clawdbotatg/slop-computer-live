"use client";

import { useMemo } from "react";
import { useSession } from "./useSession";
import type { Address } from "viem";
import { formatEther } from "viem";
import { base } from "viem/chains";
import { useBalance, useBytecode } from "wagmi";
import { type StoredPasskeyIdentity, getStoredPasskeyIdentity } from "~~/utils/passkey";
import { personalCosignerUnset, personalWalletFor } from "~~/utils/personalWallet";

// The personal ("single-player") wallet for the signed-in passkey user.
//
// Derives the counterfactual personal Safe address from the passkey (pure
// math, utils/personalWallet.ts), reads its balance + deploy status on Base.
// Receive works before deploy (funding-before-deploy), so this is meaningful
// even when `deployed` is false. See ops/PLAN-safe.md phase 5.
//
// "Is this a passkey user?" is answered locally: a passkey sign-in leaves a
// StoredPasskeyIdentity in localStorage keyed by the passkey-derived address,
// which also carries qx/qy (needed to derive + sign). A SIWE (EOA) session has
// no such record → no personal wallet (they have their own).

export type PersonalWallet = {
  /** True when the current session is a passkey identity on this browser. */
  isPasskey: boolean;
  /** The raw passkey-derived address (UNSPENDABLE identity — never a fund target). */
  passkeyAddress: Address | null;
  /** The counterfactual personal Safe address — spendable, fundable. */
  personalAddress: Address | null;
  /** The passkey's Safe owner (its signer contract) — what signatures are filed under. */
  ownerAddress: Address | null;
  balanceWei: bigint | null;
  balanceFormatted: string | null;
  /** Whether the Safe has been deployed on Base yet (false = counterfactual). */
  deployed: boolean;
  /** Stored passkey identity (qx/qy/credential id), if present. */
  passkeyIdentity: StoredPasskeyIdentity | null;
  /** True until the cosigner is configured (can't derive without it). */
  deployerUnset: boolean;
  loading: boolean;
  refetchBalance: () => void;
  refetchDeployed: () => void;
};

export function usePersonalWallet(): PersonalWallet {
  const { session } = useSession();

  const sessionAddress = session.authenticated && session.address ? (session.address.toLowerCase() as Address) : null;

  // Local passkey identity (also our passkey-vs-EOA signal).
  const passkeyIdentity = useMemo(
    () => (sessionAddress ? getStoredPasskeyIdentity(sessionAddress) : null),
    [sessionAddress],
  );
  const isPasskey = !!passkeyIdentity;
  const passkeyAddress = isPasskey ? sessionAddress : null;

  const deployerUnset = personalCosignerUnset();
  const derived = useMemo(
    () =>
      passkeyIdentity
        ? personalWalletFor(passkeyIdentity.qx as `0x${string}`, passkeyIdentity.qy as `0x${string}`)
        : null,
    [passkeyIdentity],
  );
  const personalAddress = derived?.address ?? null;

  const {
    data: balance,
    isLoading: balLoading,
    refetch: refetchBalance,
  } = useBalance({
    address: personalAddress ?? undefined,
    chainId: base.id,
    query: { enabled: !!personalAddress },
  });

  const { data: code, refetch: refetchDeployed } = useBytecode({
    address: personalAddress ?? undefined,
    chainId: base.id,
    query: { enabled: !!personalAddress },
  });

  return {
    isPasskey,
    passkeyAddress,
    personalAddress,
    ownerAddress: derived?.owner ?? null,
    balanceWei: balance?.value ?? null,
    balanceFormatted: balance ? formatEther(balance.value) : null,
    deployed: !!code && code !== "0x",
    passkeyIdentity,
    deployerUnset,
    loading: !!personalAddress && balLoading,
    refetchBalance: () => void refetchBalance(),
    refetchDeployed: () => void refetchDeployed(),
  };
}

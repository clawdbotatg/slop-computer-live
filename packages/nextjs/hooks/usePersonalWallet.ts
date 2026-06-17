"use client";

import { useMemo } from "react";
import { useSession } from "./useSession";
import type { Address } from "viem";
import { formatEther } from "viem";
import { base } from "viem/chains";
import { useBalance, useBytecode, useReadContract } from "wagmi";
import { FACTORY_ADDRESS, MultisigFactoryAbi } from "~~/contracts/multisig";
import { type StoredPasskeyIdentity, getStoredPasskeyIdentity } from "~~/utils/passkey";
import { PERSONAL_WALLET_DEPLOYER, personalWalletSalt } from "~~/utils/personalWallet";

// The personal ("single-player") wallet for the signed-in passkey user.
//
// Derives the counterfactual personal-multisig address from the passkey, reads
// its balance + deploy status on Base. Receive works before deploy
// (funding-before-deploy), so this is meaningful even when `deployed` is false.
// See docs/PASSKEY-WALLET.md.
//
// "Is this a passkey user?" is answered locally: a passkey sign-in leaves a
// StoredPasskeyIdentity in localStorage keyed by the passkey-derived address,
// which also carries qx/qy/credentialIdHash for Phase 2 (deploy + sign). A SIWE
// (EOA) session has no such record → no personal wallet (they have their own).

export type PersonalWallet = {
  /** True when the current session is a passkey identity on this browser. */
  isPasskey: boolean;
  /** The raw passkey-derived address (UNSPENDABLE identity — never a fund target). */
  passkeyAddress: Address | null;
  /** The counterfactual personal-multisig address — spendable, fundable. */
  personalAddress: Address | null;
  balanceWei: bigint | null;
  balanceFormatted: string | null;
  /** Whether the multisig has been deployed on Base yet (false = counterfactual). */
  deployed: boolean;
  /** Stored passkey identity (qx/qy/credentialIdHash) for Phase 2, if present. */
  passkeyIdentity: StoredPasskeyIdentity | null;
  /** True until the deployer is configured (can't derive without it). */
  deployerUnset: boolean;
  loading: boolean;
  refetchBalance: () => void;
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

  const deployerUnset = /^0x0*$/i.test(PERSONAL_WALLET_DEPLOYER);
  const salt = useMemo(
    () => (passkeyAddress && !deployerUnset ? personalWalletSalt(passkeyAddress) : null),
    [passkeyAddress, deployerUnset],
  );

  const { data: predicted, isLoading: addrLoading } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: MultisigFactoryAbi,
    functionName: "getMultisigAddress",
    args: salt ? [PERSONAL_WALLET_DEPLOYER, salt] : undefined,
    chainId: base.id,
    query: { enabled: !!salt },
  });
  const personalAddress = (predicted as Address | undefined) ?? null;

  const {
    data: balance,
    isLoading: balLoading,
    refetch: refetchBalance,
  } = useBalance({
    address: personalAddress ?? undefined,
    chainId: base.id,
    query: { enabled: !!personalAddress },
  });

  const { data: code } = useBytecode({
    address: personalAddress ?? undefined,
    chainId: base.id,
    query: { enabled: !!personalAddress },
  });

  return {
    isPasskey,
    passkeyAddress,
    personalAddress,
    balanceWei: balance?.value ?? null,
    balanceFormatted: balance ? formatEther(balance.value) : null,
    deployed: !!code && code !== "0x",
    passkeyIdentity,
    deployerUnset,
    loading: !!salt && (addrLoading || balLoading),
    refetchBalance: () => void refetchBalance(),
  };
}

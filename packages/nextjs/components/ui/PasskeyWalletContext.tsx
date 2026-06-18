"use client";

import { createContext, useContext, useMemo } from "react";
import type { Abi, Address } from "viem";
import { base } from "viem/chains";
import { useReadContracts } from "wagmi";
import { FACTORY_ADDRESS, MultisigFactoryAbi } from "~~/contracts/multisig";
import { PERSONAL_WALLET_DEPLOYER, personalWalletSalt } from "~~/utils/personalWallet";

// Display-only passkey → personal-wallet address resolution.
//
// A passkey user's session/identity address is the raw P-256-derived address
// (keccak256(qx‖qy)[-20:]) — UNSPENDABLE: ETH sent there is locked forever.
// Their spendable address is a counterfactual slop Multisig derived from it
// (deployer + personalWalletSalt(passkeyAddress)). Everywhere we *show* a
// passkey user (guest list, transcript, chat, signer rows, …) we want their
// spendable wallet address, so a viewer who copies it can actually fund them.
//
// This is purely cosmetic: the map is keyed by passkey address → wallet
// address, and only `SlopAddress` (the shared identity row) consults it to swap
// the displayed/copied address. Stored signer data keeps the passkey address —
// that's the real on-chain signer.

const PasskeyWalletContext = createContext<Record<string, string>>({});

/** The passkey-address(lowercased) → personal-wallet-address(lowercased) map. */
export function usePasskeyWalletMap(): Record<string, string> {
  return useContext(PasskeyWalletContext);
}

/** Returns a resolver: a passkey address → its spendable wallet address, or the
 *  input unchanged for everyone else (EOA / anon / unknown). Display-only. */
export function useResolveWalletAddress(): (addr?: string | null) => string | null | undefined {
  const map = usePasskeyWalletMap();
  return useMemo(() => (addr?: string | null) => (addr ? (map[addr.toLowerCase()] ?? addr) : addr), [map]);
}

/** Resolves the given passkey addresses to their personal-wallet addresses via
 *  the factory (one batched multicall on Base, cached by wagmi) and provides the
 *  map to descendants. Pass ONLY genuine passkey addresses — an EOA address must
 *  never be resolved (its "salt" wallet isn't its wallet). */
export function PasskeyWalletProvider({
  passkeyAddresses,
  children,
}: {
  passkeyAddresses: string[];
  children: React.ReactNode;
}) {
  const deployerUnset = /^0x0*$/i.test(PERSONAL_WALLET_DEPLOYER);
  const uniq = useMemo(
    () => [...new Set(passkeyAddresses.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{40}$/.test(a)),
    [passkeyAddresses],
  );
  const contracts = useMemo(
    () =>
      deployerUnset
        ? []
        : uniq.map(a => ({
            address: FACTORY_ADDRESS as Address,
            abi: MultisigFactoryAbi as unknown as Abi,
            functionName: "getMultisigAddress",
            args: [PERSONAL_WALLET_DEPLOYER, personalWalletSalt(a as Address)],
            chainId: base.id,
          })),
    [uniq, deployerUnset],
  );
  const { data } = useReadContracts({
    contracts,
    query: { enabled: contracts.length > 0 },
  });
  const map = useMemo(() => {
    const m: Record<string, string> = {};
    uniq.forEach((a, i) => {
      const r = data?.[i]?.result as string | undefined;
      if (r && /^0x[0-9a-fA-F]{40}$/.test(r)) m[a] = r.toLowerCase();
    });
    return m;
  }, [uniq, data]);

  return <PasskeyWalletContext.Provider value={map}>{children}</PasskeyWalletContext.Provider>;
}

export default PasskeyWalletProvider;

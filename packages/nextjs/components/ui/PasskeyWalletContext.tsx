"use client";

import { createContext, useContext, useMemo } from "react";
import { personalWalletFor } from "~~/utils/personalWallet";

// Display-only passkey → personal-wallet address resolution.
//
// A passkey user's session/identity address is the raw P-256-derived address
// (keccak256(qx‖qy)[-20:]) — UNSPENDABLE: ETH sent there is locked forever.
// Their spendable address is their personal Safe, derived offline from the
// passkey's public key (utils/personalWallet.ts). Everywhere we *show* a
// passkey user (guest list, transcript, chat, signer rows, …) we want their
// spendable wallet address, so a viewer who copies it can actually fund them.
//
// This is purely cosmetic: the map is keyed by passkey address → wallet
// address, and only `SlopAddress` (the shared identity row) consults it to swap
// the displayed/copied address.

export type PasskeyKey = { address: string; qx: string; qy: string };

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

/** Resolves the given passkeys to their personal-wallet addresses (pure math,
 *  no RPC) and provides the map to descendants. Pass ONLY genuine passkeys. */
export function PasskeyWalletProvider({ passkeys, children }: { passkeys: PasskeyKey[]; children: React.ReactNode }) {
  const map = useMemo(() => {
    const m: Record<string, string> = {};
    for (const k of passkeys) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(k.qx) || !/^0x[0-9a-fA-F]{64}$/.test(k.qy)) continue;
      const w = personalWalletFor(k.qx as `0x${string}`, k.qy as `0x${string}`);
      if (w) m[k.address.toLowerCase()] = w.address.toLowerCase();
    }
    return m;
  }, [passkeys]);

  return <PasskeyWalletContext.Provider value={map}>{children}</PasskeyWalletContext.Provider>;
}

export default PasskeyWalletProvider;

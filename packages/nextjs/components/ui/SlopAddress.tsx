"use client";

import { useMemo } from "react";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import { AddressBlockie } from "~~/components/scaffold-eth";
import { BandFlag } from "~~/components/ui/BandFlag";
import { useResolveWalletAddress } from "~~/components/ui/PasskeyWalletContext";
import { bandsFromIdentity } from "~~/utils/blockieBands";

// The canonical identity row used everywhere a user is shown by their
// wallet. Renders three pieces inline:
//   1. BandFlag — the chunky three-stripe swatch matching the user's
//      cursor bands, so a glance maps name → cursor color.
//   2. Either the user's chosen display name (when one is set) or the
//      scaffold-ui <Address /> (ENS-or-short-address with avatar).
//   3. AddressBlockie — only shown when a custom name is in use, since
//      the custom name otherwise hides the underlying address; the
//      blockie + copy icon keep the real identity recoverable.

export type SlopAddressProps = {
  address?: string | null;
  /** ENS-resolved handle from the peer state. Used as a label when no
   *  custom name is set and no on-chain address is known. */
  handle?: string | null;
  /** Stable per-session anon id (no wallet/passkey). Drives customNames
   *  lookups + flag colors for anon users so renaming doesn't break
   *  their visual identity across chat history, transcript, peer list,
   *  etc. Use the same `anonId` baked into the record that we're
   *  rendering — it's a stable id, not a name. */
  anonId?: string | null;
  /** Last-resort hash input for BandFlag colors and label, e.g. the
   *  peer id or message id when neither address nor handle exists. */
  fallback?: string;
  customNames?: Record<string, string>;
  /** Pixel size of the inline blockie when a custom name is shown.
   *  Defaults to 14 to match the BandFlag height. */
  blockieSize?: number;
};

export const SlopAddress = ({ address, handle, anonId, fallback, customNames, blockieSize = 14 }: SlopAddressProps) => {
  // Lookup key for the global customNames map. Address for SIWE/passkey
  // (set via the set_custom_name WS path), anonId for anon (set via
  // POST /auth/handle). Either way, the same dictionary holds the
  // user's chosen display name and broadcasts updates as `peer_name`.
  // NB: name + color identity stay keyed by the ORIGINAL (passkey/SIWE)
  // address so they're stable; only what's shown/copied is swapped below.
  const lookupKey = (address ?? anonId)?.toLowerCase();
  const customName = lookupKey && customNames ? customNames[lookupKey] : undefined;
  const bands = useMemo(
    () => bandsFromIdentity({ address, anonId, handle, fallback }),
    [address, anonId, handle, fallback],
  );

  // Swap a passkey identity address for its spendable personal-wallet address
  // so the shown/copied value is fundable (the raw passkey address locks ETH).
  // No-op for EOA / anon / unknown addresses. Display-only — see context doc.
  const resolveWalletAddress = useResolveWalletAddress();
  const displayAddress = resolveWalletAddress(address);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <BandFlag bands={bands} />
      {customName && address ? (
        <>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{customName}</span>
          <AddressBlockie address={(displayAddress ?? address) as AddressType} size={blockieSize} />
        </>
      ) : customName ? (
        // Anon with a chosen name — no blockie (no underlying address)
        // and no copy icon, just the name.
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{customName}</span>
      ) : address ? (
        <Address address={(displayAddress ?? address) as AddressType} size="xs" onlyEnsOrAddress disableAddressLink />
      ) : (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {handle ?? fallback?.slice(0, 6) ?? "anon"}
        </span>
      )}
    </span>
  );
};

export default SlopAddress;

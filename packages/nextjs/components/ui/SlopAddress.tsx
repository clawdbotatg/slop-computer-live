"use client";

import { useMemo } from "react";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import { AddressBlockie } from "~~/components/scaffold-eth";
import { BandFlag } from "~~/components/ui/BandFlag";
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
  /** Last-resort hash input for BandFlag colors and label, e.g. the
   *  peer id or message id when neither address nor handle exists. */
  fallback?: string;
  customNames?: Record<string, string>;
  /** Pixel size of the inline blockie when a custom name is shown.
   *  Defaults to 14 to match the BandFlag height. */
  blockieSize?: number;
};

export const SlopAddress = ({ address, handle, fallback, customNames, blockieSize = 14 }: SlopAddressProps) => {
  const lower = address?.toLowerCase();
  const customName = lower && customNames ? customNames[lower] : undefined;
  const bands = useMemo(() => bandsFromIdentity({ address, handle, fallback }), [address, handle, fallback]);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <BandFlag bands={bands} />
      {customName && address ? (
        <>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{customName}</span>
          <AddressBlockie address={address as AddressType} size={blockieSize} />
        </>
      ) : address ? (
        <Address address={address as AddressType} size="xs" onlyEnsOrAddress disableAddressLink />
      ) : (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {handle ?? fallback?.slice(0, 6) ?? "anon"}
        </span>
      )}
    </span>
  );
};

export default SlopAddress;

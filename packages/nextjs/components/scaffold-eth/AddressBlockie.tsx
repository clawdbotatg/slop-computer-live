"use client";

import { useState } from "react";
import { useAddress } from "@scaffold-ui/hooks";
import type { Address as AddressType, Chain } from "viem";

// Identity hint shown next to a custom display name: the blockie (clickable
// to the block explorer) + a small copy icon for the underlying address.
// Use this anywhere the user has set a custom name — without it the address
// itself would be invisible and there'd be no way to inspect or copy it.

export type AddressBlockieProps = {
  address: AddressType;
  size?: number;
  chain?: Chain;
};

const COPY_FEEDBACK_MS = 800;

export const AddressBlockie = ({ address, size = 14, chain }: AddressBlockieProps) => {
  const { checkSumAddress, ensAvatar, blockieUrl, blockExplorerAddressLink, isValidAddress } = useAddress({
    address,
    chain,
  });
  const [copied, setCopied] = useState(false);

  if (!isValidAddress || !checkSumAddress) return null;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(checkSumAddress);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch (err) {
      console.error("Failed to copy address:", err);
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
      <a
        href={blockExplorerAddressLink}
        target="_blank"
        rel="noopener noreferrer"
        title={`open ${checkSumAddress} on block explorer`}
        onClick={e => e.stopPropagation()}
        style={{ display: "inline-flex", lineHeight: 0 }}
      >
        {/* Blockie / ENS avatar. <img> is fine — these are tiny inline
            identity hints and Next/Image would force a remote-patterns
            roundtrip for every ENS gateway URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={ensAvatar || blockieUrl}
          width={size}
          height={size}
          alt=""
          aria-hidden
          style={{ borderRadius: "50%", display: "block" }}
        />
      </a>
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? "copied!" : `copy ${checkSumAddress}`}
        aria-label="copy address"
        style={{
          background: "transparent",
          border: 0,
          padding: 0,
          margin: 0,
          cursor: "pointer",
          color: "var(--slop-text-muted)",
          lineHeight: 0,
          display: "inline-flex",
        }}
      >
        {copied ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size - 2}
            height={size - 2}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size - 2}
            height={size - 2}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </span>
  );
};

export default AddressBlockie;

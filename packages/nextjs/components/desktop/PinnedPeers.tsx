"use client";

import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import { BandFlag } from "~~/components/ui";
import type { Peer } from "~~/hooks/usePeerMesh";
import { bandsFromIdentity } from "~~/utils/blockieBands";

// Always-visible "who's here" panel pinned to the top-right of the
// viewport, sitting just under the menubar. Replaces the old
// (X guests ▾) dropdown that used to live in the menubar itself.
// Position is per-peer (fixed in viewport coords), not in the shared
// slot system — every viewer has their own top-right corner.
//
// Z-index sits between desktop icons (z=1) and the menubar
// dropdowns (9100), so a sign-out / power dropdown opening will
// naturally overlay the list. Windows can still cover it (windows
// can climb past 50), matching the trash can's behavior.

export type PinnedPeersProps = {
  peers: Peer[];
  myId: string | null;
};

const MENUBAR_HEIGHT = 38;
const TOP_GAP = 10;

const labelOf = (p: Peer) => {
  if (p.handle) return <span>{p.handle}</span>;
  if (p.address) return <Address address={p.address as AddressType} size="xs" onlyEnsOrAddress />;
  return <span>{p.id.slice(0, 6)}</span>;
};

export const PinnedPeers = ({ peers, myId }: PinnedPeersProps) => {
  return (
    <div
      style={{
        position: "fixed",
        top: MENUBAR_HEIGHT + TOP_GAP,
        right: 14,
        zIndex: 50,
        minWidth: 220,
        maxWidth: 300,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: "linear-gradient(180deg, rgba(20,10,40,0.92) 0%, rgba(6,3,13,0.92) 100%)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255,62,201,0.45)",
        borderRadius: 8,
        boxShadow: "0 8px 24px #000a, 0 0 16px rgba(255,62,201,0.18)",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        fontSize: 12,
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontFamily: "var(--slop-font-display)",
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--slop-text-muted)",
          paddingBottom: 4,
          borderBottom: "1px solid rgba(255,62,201,0.18)",
        }}
      >
        Who&apos;s Here — {peers.length}
      </div>
      {peers.length === 0 ? (
        <div style={{ color: "var(--slop-text-muted)", fontStyle: "italic", padding: "4px 2px" }}>just you so far.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {peers.map(p => {
            const isMe = p.id === myId;
            return (
              <li
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 4,
                  background: isMe ? "rgba(255,62,201,0.14)" : "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(255,255,255,0.04)",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontWeight: p.role === "host" ? 600 : undefined,
                  }}
                >
                  {p.role === "host" ? (
                    <span aria-hidden style={{ color: "var(--slop-amber, #ffae00)" }}>
                      ★
                    </span>
                  ) : null}
                  {labelOf(p)}
                  {isMe ? <span style={{ color: "var(--slop-text-muted)", fontSize: 10 }}>(you)</span> : null}
                  <BandFlag bands={bandsFromIdentity({ address: p.address, handle: p.handle, fallback: p.id })} />
                </span>
                <span
                  style={{
                    color: "var(--slop-text-muted)",
                    fontSize: 10,
                    fontFamily: "var(--slop-font-display)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    flexShrink: 0,
                  }}
                >
                  {p.role}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default PinnedPeers;

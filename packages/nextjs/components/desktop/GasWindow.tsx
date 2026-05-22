"use client";

import { useEffect, useRef, useState } from "react";
import type { GasState, PeerMeshState } from "~~/hooks/usePeerMesh";
import { useSyncedScroll } from "~~/hooks/useSyncedScroll";

// Ethereum gas tracker window. Reads `mesh.gasState` (polled and
// broadcast by the relay every ~12s) and renders:
//   - the slow / medium / fast gwei prices with their USD-cost-per-tx
//     for a simple ETH transfer
//   - a table of common ops with their gas-unit estimate and USD cost
//     at each speed tier
//
// All conversions happen on the client: gwei × gasUnits × ethUsd is
// cheap enough that we don't bother caching, and it lets us re-render
// the "x seconds ago" freshness label without server roundtrips.

export type GasWindowProps = {
  mesh: PeerMeshState;
};

type Op = {
  label: string;
  gasUnits: number;
  hint?: string;
};

// Conservative typical-cost gas estimates. Reality varies — a USDC
// transfer is ~50k, a USDT can spike to ~80k when the from-balance was
// previously zero, Aave deposits depend on whether it's a first-time
// supply, etc. These numbers are "what most users would actually pay"
// estimates, not worst-case.
const OPS: Op[] = [
  { label: "Send ETH", gasUnits: 21_000 },
  { label: "Send ERC20", gasUnits: 65_000, hint: "USDC/DAI/etc." },
  { label: "Uniswap V3 swap", gasUnits: 184_000 },
  { label: "Aave V3 supply", gasUnits: 250_000 },
  { label: "Aave V3 borrow", gasUnits: 350_000 },
  { label: "NFT mint", gasUnits: 200_000, hint: "ERC721, simple" },
];

function usdForOp(state: GasState, gwei: number, gasUnits: number): number {
  // gwei * gas = wei; wei / 1e9 = gwei; we have gwei already so:
  // cost in ETH = gwei * gas / 1e9
  const eth = (gwei * gasUnits) / 1e9;
  return eth * state.ethUsd;
}

function formatGwei(gwei: number): string {
  if (gwei < 1) return gwei.toFixed(3);
  if (gwei < 10) return gwei.toFixed(2);
  if (gwei < 100) return gwei.toFixed(1);
  return Math.round(gwei).toString();
}

function formatUsd(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd)}`;
  if (usd >= 10) return `$${usd.toFixed(1)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

function freshness(updatedAt: number, now: number): string {
  const secs = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

const TIER_COLORS: Record<"slow" | "medium" | "fast", string> = {
  slow: "#7ec0ff",
  medium: "#ffe27a",
  fast: "#ff6bd1",
};

export const GasWindow = ({ mesh }: GasWindowProps) => {
  const state = mesh.gasState;
  const opsRef = useRef<HTMLDivElement>(null);
  // Multiplayer scroll sync for the ops-cost table.
  const onScroll = useSyncedScroll(mesh, "gas", opsRef);
  // Tick once per second so the "x seconds ago" label stays live even
  // when no new gas snapshot has arrived. Wall-clock only — doesn't
  // trigger a fetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!state) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--slop-text-muted)",
          fontFamily: "var(--slop-font-body)",
          fontSize: 12,
          fontStyle: "italic",
          padding: 20,
          textAlign: "center",
          background: "#06030d",
        }}
      >
        Waiting for gas data… (relay polls every 12s)
      </div>
    );
  }

  const tiers = [
    { key: "slow" as const, label: "Slow", gwei: state.slowGwei },
    { key: "medium" as const, label: "Medium", gwei: state.mediumGwei },
    { key: "fast" as const, label: "Fast", gwei: state.fastGwei },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
      }}
    >
      {/* Header: tier cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 6,
          padding: 8,
          borderBottom: "1px solid var(--slop-border, #2a1d4a)",
        }}
      >
        {tiers.map(t => {
          const usd = usdForOp(state, t.gwei, 21_000);
          return (
            <div
              key={t.key}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: `1px solid ${TIER_COLORS[t.key]}`,
                borderRadius: 4,
                padding: "8px 6px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  fontFamily: "var(--slop-font-display)",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: TIER_COLORS[t.key],
                }}
              >
                {t.label}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{formatGwei(t.gwei)}</div>
              <div style={{ fontSize: 9, color: "var(--slop-text-muted)" }}>gwei</div>
              <div style={{ fontSize: 11, color: "var(--slop-text-muted)" }}>{formatUsd(usd)} send</div>
            </div>
          );
        })}
      </div>

      {/* Ops table */}
      <div ref={opsRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 11,
          }}
        >
          <thead>
            <tr>
              <th style={thStyle}>Operation</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Gas</th>
              <th style={{ ...thStyle, textAlign: "right", color: TIER_COLORS.slow }}>Slow</th>
              <th style={{ ...thStyle, textAlign: "right", color: TIER_COLORS.medium }}>Medium</th>
              <th style={{ ...thStyle, textAlign: "right", color: TIER_COLORS.fast }}>Fast</th>
            </tr>
          </thead>
          <tbody>
            {OPS.map(op => {
              const slowUsd = usdForOp(state, state.slowGwei, op.gasUnits);
              const medUsd = usdForOp(state, state.mediumGwei, op.gasUnits);
              const fastUsd = usdForOp(state, state.fastGwei, op.gasUnits);
              return (
                <tr key={op.label}>
                  <td style={tdStyle}>
                    {op.label}
                    {op.hint ? (
                      <span style={{ marginLeft: 4, color: "var(--slop-text-muted)", fontSize: 9 }}>({op.hint})</span>
                    ) : null}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", color: "var(--slop-text-muted)" }}>
                    {op.gasUnits.toLocaleString()}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{formatUsd(slowUsd)}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{formatUsd(medUsd)}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{formatUsd(fastUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer: base fee + freshness + ETH price */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "6px 10px",
          fontSize: 10,
          color: "var(--slop-text-muted)",
          borderTop: "1px solid var(--slop-border, #2a1d4a)",
          background: "#0a061a",
        }}
      >
        <span>Base: {formatGwei(state.baseFeeGwei)} gwei</span>
        <span>·</span>
        <span>ETH: {formatUsd(state.ethUsd)}</span>
        <span style={{ marginLeft: "auto" }}>{freshness(state.updatedAt, now)}</span>
      </div>
    </div>
  );
};

const thStyle: React.CSSProperties = {
  padding: "6px 8px",
  fontFamily: "var(--slop-font-display)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontSize: 9,
  fontWeight: 600,
  color: "var(--slop-text-muted)",
  textAlign: "left",
  background: "#0a061a",
  borderBottom: "1px solid var(--slop-border, #2a1d4a)",
  position: "sticky",
  top: 0,
};

const tdStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid rgba(42,29,74,0.5)",
};

export default GasWindow;

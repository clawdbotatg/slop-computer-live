"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { type Portfolio, type PortfolioAsset, toRawUnits, zerionChainToId } from "./types";
import { Address, AddressInput } from "@scaffold-ui/components";
import { type Address as AddressType, type Hex, encodeFunctionData, erc20Abi } from "viem";
import { usePublicClient } from "wagmi";
import { MultisigAbi } from "~~/contracts/multisig";
import type { PeerMeshState, WalletRecord, WalletTxCall } from "~~/hooks/usePeerMesh";
import { defaultDeadline } from "~~/utils/multisig";

// Sticky header above the wallet window's tab bar. Always shows total
// USD balance + refresh + send-all icons on the left, multisig Address
// on the right. The send-all button opens a modal (same shape as the
// per-asset SendAssetModal) that proposes one execBatchTransaction per
// chain bundling every transfer on that chain.

const ACCENT = "var(--slop-magenta, #ff3ec9)";
const NATIVE_TOKEN_PLACEHOLDER = "0x0000000000000000000000000000000000000000";

const fmtUsd = (v: string | number) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!Number.isFinite(n)) return "$0";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
};

const isNativeAsset = (a: PortfolioAsset): boolean =>
  !a.contractAddress || a.contractAddress.toLowerCase() === NATIVE_TOKEN_PLACEHOLDER;

// Group sendable assets by chainId. Only chains where the multisig is
// actually deployed get a batch — others are unreachable from the
// multisig, so we drop them from the proposal silently.
function groupAssetsByChain(
  assets: PortfolioAsset[],
  deployments: Record<number, unknown>,
): Map<number, PortfolioAsset[]> {
  const out = new Map<number, PortfolioAsset[]>();
  for (const a of assets) {
    const chainId = zerionChainToId(a.blockchain);
    if (chainId == null) continue;
    if (!(chainId in deployments)) continue;
    const arr = out.get(chainId) ?? [];
    arr.push(a);
    out.set(chainId, arr);
  }
  return out;
}

export type WalletHeaderProps = {
  wallet: WalletRecord;
  mesh: PeerMeshState;
  portfolio: Portfolio | null;
  loading: boolean;
  onRefresh: () => void;
};

export const WalletHeader = ({ wallet, mesh, portfolio, loading, onRefresh }: WalletHeaderProps) => {
  const [sendAllOpen, setSendAllOpen] = useState(false);

  const sendableChains = useMemo(
    () => (portfolio ? groupAssetsByChain(portfolio.assets, wallet.deployments) : new Map()),
    [portfolio, wallet.deployments],
  );
  const sendAllAvailable = sendableChains.size > 0;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        flexWrap: "wrap",
        borderBottom: "1px solid rgba(255,62,201,0.18)",
        background: "linear-gradient(180deg, rgba(255,62,201,0.06) 0%, rgba(255,62,201,0.01) 100%)",
      }}
    >
      {/* Left: balance + refresh + send-all */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 8,
              color: "var(--slop-text-muted)",
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            Wallet balance
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              fontFamily: "var(--slop-font-display)",
              lineHeight: 1.1,
              marginTop: 1,
            }}
          >
            {portfolio ? fmtUsd(portfolio.totalBalanceUsd) : loading ? "…" : "$0"}
          </div>
          {portfolio && parseFloat(portfolio.change1dUsd) !== 0 ? (
            <div
              style={{
                fontSize: 10,
                marginTop: 1,
                color: parseFloat(portfolio.change1dUsd) >= 0 ? "#7be88a" : "#ff7676",
              }}
            >
              {parseFloat(portfolio.change1dUsd) >= 0 ? "▲" : "▼"} {fmtUsd(Math.abs(parseFloat(portfolio.change1dUsd)))}{" "}
              ({portfolio.change1dPct}%) 24h
            </div>
          ) : null}
        </div>
        <IconButton
          label="Refresh balance"
          onClick={onRefresh}
          disabled={loading}
          spinning={loading}
          title={loading ? "Refreshing…" : "Refresh balance"}
        >
          ↻
        </IconButton>
        <IconButton
          label="Send all assets"
          onClick={() => setSendAllOpen(true)}
          disabled={!sendAllAvailable}
          title={
            sendAllAvailable
              ? "Send every asset to one address"
              : portfolio
                ? "No sendable assets on a chain where the multisig is deployed."
                : "Loading portfolio…"
          }
        >
          ↗
        </IconButton>
      </div>

      {/* Right: multisig address */}
      <div style={{ flexShrink: 0 }}>
        <Address address={wallet.address as AddressType} size="sm" />
      </div>

      {sendAllOpen && sendAllAvailable ? (
        <SendAllModal
          wallet={wallet}
          mesh={mesh}
          sendableChains={sendableChains}
          onClose={() => setSendAllOpen(false)}
        />
      ) : null}
    </div>
  );
};

// Square outline button used for refresh + send-all. Same dimensions
// so the two glyphs line up. Spinning prop drives the rotation on the
// refresh button — Tailwind's global `spin` keyframe is loaded so we
// can just name it from inline CSS.
const IconButton = ({
  onClick,
  disabled,
  title,
  label,
  spinning,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  label: string;
  spinning?: boolean;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={label}
    style={{
      width: 28,
      height: 28,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      background: "transparent",
      border: `1px solid ${ACCENT}`,
      color: ACCENT,
      borderRadius: 4,
      cursor: disabled ? "not-allowed" : "pointer",
      fontSize: 14,
      lineHeight: 1,
      opacity: disabled ? 0.4 : 1,
      animation: spinning ? "spin 1s linear infinite" : undefined,
    }}
  >
    {children}
  </button>
);

// ----------------------------------------------------------------------------
// SendAllModal — overlay modal styled like SendAssetModal but with
// "(all assets)" in place of an amount field. AddressInput on top,
// Propose at the bottom. On submit, proposes one
// execBatchTransaction per chain that has sendable assets.
// ----------------------------------------------------------------------------

type ProposeOutcome = { chainId: number; ok: boolean; reason?: string; calls: number };

const SendAllModal = ({
  wallet,
  mesh,
  sendableChains,
  onClose,
}: {
  wallet: WalletRecord;
  mesh: PeerMeshState;
  sendableChains: Map<number, PortfolioAsset[]>;
  onClose: () => void;
}) => {
  const [recipient, setRecipient] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [outcomes, setOutcomes] = useState<ProposeOutcome[] | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const recipientValid = /^0x[a-fA-F0-9]{40}$/.test(recipient.trim());
  const chainEntries = useMemo(() => Array.from(sendableChains.entries()), [sendableChains]);
  const callCountTotal = useMemo(() => chainEntries.reduce((s, [, a]) => s + a.length, 0), [chainEntries]);

  // Esc closes — matches SendAssetModal UX.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // One publicClient per supported chain — wagmi hooks must be called
  // unconditionally on render, so we fan out across all three (Base,
  // Mainnet, Gnosis) and pick at proposal time.
  const baseClient = usePublicClient({ chainId: 8453 });
  const mainnetClient = usePublicClient({ chainId: 1 });
  const gnosisClient = usePublicClient({ chainId: 100 });
  const clientFor = useCallback(
    (chainId: number) => {
      if (chainId === 8453) return baseClient;
      if (chainId === 1) return mainnetClient;
      if (chainId === 100) return gnosisClient;
      return null;
    },
    [baseClient, mainnetClient, gnosisClient],
  );

  const onSendAll = useCallback(async () => {
    setTopError(null);
    setOutcomes(null);
    if (!recipientValid) {
      setTopError("paste a valid recipient address");
      return;
    }
    const to = recipient.trim() as AddressType;
    setSubmitting(true);
    const results: ProposeOutcome[] = [];
    let anyOk = false;
    try {
      for (const [chainId, assets] of chainEntries) {
        const client = clientFor(chainId);
        if (!client) {
          results.push({ chainId, ok: false, reason: "no RPC client", calls: assets.length });
          continue;
        }
        try {
          // One call per asset on this chain. Skip dust (rounds to 0n)
          // so we don't ship a no-op.
          const calls: WalletTxCall[] = [];
          for (const a of assets) {
            const decimals = a.tokenDecimals ?? 18;
            const raw = toRawUnits(a.balance, decimals);
            if (raw <= 0n) continue;
            if (isNativeAsset(a)) {
              calls.push({ target: to.toLowerCase(), value: raw.toString(), data: "0x" });
            } else {
              const data = encodeFunctionData({
                abi: erc20Abi,
                functionName: "transfer",
                args: [to, raw],
              });
              calls.push({ target: a.contractAddress.toLowerCase(), value: "0", data });
            }
          }
          if (calls.length === 0) {
            results.push({ chainId, ok: false, reason: "no non-dust balances", calls: 0 });
            continue;
          }
          const nonce = (await client.readContract({
            address: wallet.address as AddressType,
            abi: MultisigAbi,
            functionName: "nonce",
          })) as bigint;
          const deadline = defaultDeadline();
          // Batch exec hash from the contract view function — safer than
          // re-implementing the encoding; available because the multisig
          // is deployed here (otherwise this chain wouldn't be in
          // sendableChains).
          const execHash = (await client.readContract({
            address: wallet.address as AddressType,
            abi: MultisigAbi,
            functionName: "getBatchExecHash",
            args: [
              calls.map(c => ({
                target: c.target as AddressType,
                value: BigInt(c.value),
                data: c.data as Hex,
              })),
              deadline,
            ],
          })) as Hex;
          mesh.walletProposeTx({
            chainId,
            // Sentinel target/value/data — batch txs ignore these at
            // exec time. We point the sentinel at the multisig itself
            // so the explorer view shows a self-call.
            target: wallet.address,
            value: "0",
            data: "0x",
            deadline: deadline.toString(),
            nonce: nonce.toString(),
            execHash,
            source: "manual",
            browserId: null,
            calls,
          });
          results.push({ chainId, ok: true, calls: calls.length });
          anyOk = true;
        } catch (err) {
          results.push({ chainId, ok: false, reason: String(err).slice(0, 120), calls: assets.length });
        }
      }
    } finally {
      setSubmitting(false);
      setOutcomes(results);
      // If at least one chain proposed successfully, close the modal so
      // the user lands on the Transactions tab to sign. WalletWindow
      // auto-jumps on the `wallet_tx_attention` ping the relay sends
      // for every successful propose. Keep the modal open only when
      // EVERY chain failed — that's the case the user has to look at.
      if (anyOk) onClose();
    }
  }, [recipientValid, recipient, chainEntries, clientFor, wallet.address, mesh, onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 420,
          background: "var(--slop-panel, #0a0f24)",
          border: `1px solid ${ACCENT}`,
          borderRadius: 8,
          boxShadow: "0 10px 60px rgba(255,62,201,0.25)",
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header — matches the per-asset send modal so the two read
         *  as siblings. The avatar slot is a chunky ↗ icon since
         *  there's no single token to portrait here. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: 14,
            paddingRight: 44,
            borderBottom: "1px dashed rgba(255,62,201,0.25)",
            position: "relative",
          }}
        >
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              border: `1px solid ${ACCENT}`,
              color: ACCENT,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              fontFamily: "var(--slop-font-display)",
              flexShrink: 0,
            }}
          >
            ↗
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: "var(--slop-font-display)",
                fontSize: 12,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: ACCENT,
              }}
            >
              Send all assets
            </div>
            <div style={{ fontSize: 11, color: "var(--slop-text-muted)", marginTop: 2 }}>
              {callCountTotal} transfer{callCountTotal === 1 ? "" : "s"} across{" "}
              {chainEntries.map((e, i) => (
                <span key={e[0]}>
                  {i > 0 ? ", " : ""}
                  <strong style={{ color: "var(--slop-text)" }}>{e[1][0].blockchain}</strong> ({e[1].length})
                </span>
              ))}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              width: 24,
              height: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: "1px solid rgba(255,62,201,0.3)",
              color: ACCENT,
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
              borderRadius: 4,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label
              style={{
                fontSize: 10,
                color: "var(--slop-text-muted)",
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                display: "block",
                marginBottom: 4,
              }}
            >
              Recipient
            </label>
            <AddressInput
              value={recipient}
              placeholder="0x… or vitalik.eth"
              onChange={next => setRecipient(next ?? "")}
            />
          </div>

          {/* Amount slot — locked to "(all assets)" so the form mirrors
           *  the per-asset send modal layout. Not editable. */}
          <div>
            <label
              style={{
                fontSize: 10,
                color: "var(--slop-text-muted)",
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                display: "block",
                marginBottom: 4,
              }}
            >
              Amount
            </label>
            <div
              style={{
                padding: "8px 10px",
                background: "rgba(255,62,201,0.06)",
                border: "1px solid rgba(255,62,201,0.25)",
                borderRadius: 4,
                fontSize: 13,
                fontFamily: "var(--slop-font-display)",
                color: "var(--slop-text)",
                letterSpacing: "0.04em",
              }}
            >
              (all assets)
            </div>
          </div>

          {topError ? <div style={{ fontSize: 11, color: "#ff7676" }}>{topError}</div> : null}

          {outcomes ? (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {outcomes.map(o => (
                <li
                  key={o.chainId}
                  style={{
                    fontSize: 11,
                    display: "flex",
                    gap: 8,
                    padding: "4px 8px",
                    borderRadius: 3,
                    background: o.ok ? "rgba(123,232,138,0.08)" : "rgba(255,118,118,0.08)",
                    border: `1px solid ${o.ok ? "rgba(123,232,138,0.25)" : "rgba(255,118,118,0.25)"}`,
                    color: o.ok ? "#7be88a" : "#ff9a9a",
                  }}
                >
                  <span style={{ flex: 1 }}>
                    chain {o.chainId}:{" "}
                    {o.ok ? `proposed (${o.calls} calls)` : `failed — ${o.reason ?? "unknown error"}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => void onSendAll()}
              disabled={!recipientValid || submitting}
              style={{
                flex: 1,
                padding: "8px 12px",
                fontSize: 11,
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                fontWeight: 700,
                background: recipientValid && !submitting ? ACCENT : "rgba(255,62,201,0.2)",
                color: recipientValid && !submitting ? "#06030d" : "var(--slop-text-muted)",
                border: "none",
                borderRadius: 4,
                cursor: recipientValid && !submitting ? "pointer" : "not-allowed",
              }}
            >
              {submitting
                ? "Proposing…"
                : outcomes
                  ? `Propose again (${chainEntries.length} chain${chainEntries.length === 1 ? "" : "s"})`
                  : `Propose batch${chainEntries.length > 1 ? `es (${chainEntries.length})` : ""}`}
            </button>
            {outcomes && outcomes.every(o => o.ok) ? (
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "8px 12px",
                  fontSize: 11,
                  fontFamily: "var(--slop-font-display)",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                  background: "transparent",
                  color: "var(--slop-text)",
                  border: `1px solid ${ACCENT}`,
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            ) : null}
          </div>

          {outcomes && outcomes.every(o => o.ok) ? (
            <div style={{ fontSize: 10, color: "var(--slop-text-muted)", textAlign: "center" }}>
              Open the Transactions tab to sign + execute.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default WalletHeader;

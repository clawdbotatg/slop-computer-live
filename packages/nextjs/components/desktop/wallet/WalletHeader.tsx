"use client";

import { useCallback, useMemo, useState } from "react";
import { type Portfolio, type PortfolioAsset, toRawUnits, zerionChainToId } from "./types";
import { Address, AddressInput } from "@scaffold-ui/components";
import { type Address as AddressType, type Hex, encodeFunctionData, erc20Abi } from "viem";
import { usePublicClient } from "wagmi";
import { MultisigAbi } from "~~/contracts/multisig";
import type { PeerMeshState, WalletRecord, WalletTxCall } from "~~/hooks/usePeerMesh";
import { defaultDeadline } from "~~/utils/multisig";

// Sticky header that lives ABOVE the wallet window's tab bar. Always
// shows total USD balance + refresh + send-all on the left, multisig
// Address on the right. The send-all popover proposes one
// execBatchTransaction per chain bundling every transfer on that chain.

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
// multisig, so we drop them from the proposal silently. Returns null if
// no assets are sendable from a deployed chain at all.
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
        flexDirection: "column",
        borderBottom: "1px solid rgba(255,62,201,0.18)",
        background: "linear-gradient(180deg, rgba(255,62,201,0.06) 0%, rgba(255,62,201,0.01) 100%)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          flexWrap: "wrap",
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
                {parseFloat(portfolio.change1dUsd) >= 0 ? "▲" : "▼"}{" "}
                {fmtUsd(Math.abs(parseFloat(portfolio.change1dUsd)))} ({portfolio.change1dPct}%) 24h
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title={loading ? "Refreshing…" : "Refresh balance"}
            aria-label="Refresh balance"
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
              cursor: loading ? "default" : "pointer",
              fontSize: 14,
              lineHeight: 1,
              opacity: loading ? 0.6 : 1,
              // Spin while loading. The keyframe is declared inline in
              // the global stylesheet but we only need a `transform`
              // animation here — Browser handles `rotate` natively.
              animation: loading ? "spin 1s linear infinite" : undefined,
            }}
          >
            ↻
          </button>
          <button
            type="button"
            onClick={() => setSendAllOpen(o => !o)}
            disabled={!sendAllAvailable}
            title={
              sendAllAvailable
                ? "Propose a batch tx that sends every asset to one address"
                : portfolio
                  ? "No sendable assets on a chain where the multisig is deployed."
                  : "Loading portfolio…"
            }
            style={{
              padding: "5px 10px",
              fontSize: 10,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              fontWeight: 700,
              background: sendAllAvailable ? ACCENT : "rgba(255,62,201,0.2)",
              color: sendAllAvailable ? "#06030d" : "var(--slop-text-muted)",
              border: "none",
              borderRadius: 4,
              cursor: sendAllAvailable ? "pointer" : "not-allowed",
            }}
          >
            {sendAllOpen ? "× Cancel" : "Send all ↗"}
          </button>
        </div>

        {/* Right: multisig address */}
        <div style={{ flexShrink: 0 }}>
          <Address address={wallet.address as AddressType} size="sm" />
        </div>
      </div>

      {sendAllOpen && sendAllAvailable ? (
        <SendAllPopover
          wallet={wallet}
          mesh={mesh}
          sendableChains={sendableChains}
          onDone={() => setSendAllOpen(false)}
        />
      ) : null}
    </div>
  );
};

// ----------------------------------------------------------------------------
// SendAllPopover — sticks to the bottom of the header when expanded.
// Reads recipient address; on Send, proposes one execBatchTransaction
// WalletTx per chain that has assets + a deployed multisig.
// ----------------------------------------------------------------------------

type ProposeOutcome = { chainId: number; ok: boolean; reason?: string; calls: number };

const SendAllPopover = ({
  wallet,
  mesh,
  sendableChains,
  onDone,
}: {
  wallet: WalletRecord;
  mesh: PeerMeshState;
  sendableChains: Map<number, PortfolioAsset[]>;
  onDone: () => void;
}) => {
  const [recipient, setRecipient] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [outcomes, setOutcomes] = useState<ProposeOutcome[] | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const recipientValid = /^0x[a-fA-F0-9]{40}$/.test(recipient.trim());
  const chainEntries = useMemo(() => Array.from(sendableChains.entries()), [sendableChains]);
  const callCountTotal = useMemo(() => chainEntries.reduce((s, [, a]) => s + a.length, 0), [chainEntries]);

  // We need a publicClient per chain to read nonce + getBatchExecHash.
  // wagmi gives us one per chainId — render-time hooks fan out across
  // each chain we might propose on (Base, Mainnet, Gnosis), pick the
  // right one inside the loop.
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
    try {
      for (const [chainId, assets] of chainEntries) {
        const client = clientFor(chainId);
        if (!client) {
          results.push({ chainId, ok: false, reason: "no RPC client", calls: assets.length });
          continue;
        }
        try {
          // Build the call list — one entry per asset on this chain.
          // Skip dust (rounded to 0n) so we don't propose a no-op.
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
          // Compute the batch exec hash via the contract's view function
          // — safer than re-implementing the encoding off-chain, and
          // available because the multisig is deployed on this chain
          // (otherwise the chain wouldn't be in sendableChains).
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
            // exec time. We use the multisig's own address so the
            // explorer view shows a self-call.
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
        } catch (err) {
          results.push({ chainId, ok: false, reason: String(err).slice(0, 120), calls: assets.length });
        }
      }
    } finally {
      setSubmitting(false);
      setOutcomes(results);
    }
  }, [recipientValid, recipient, chainEntries, clientFor, wallet.address, mesh]);

  return (
    <div
      style={{
        padding: 12,
        borderTop: "1px dashed rgba(255,62,201,0.25)",
        background: "rgba(0,0,0,0.25)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: "var(--slop-text-muted)",
          fontFamily: "var(--slop-font-display)",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        Send all assets to one address
      </div>
      <div style={{ fontSize: 11, color: "var(--slop-text-muted)", lineHeight: 1.5 }}>
        Proposes one batch tx per chain via <code>execBatchTransaction</code>. {callCountTotal} transfer
        {callCountTotal === 1 ? "" : "s"} across{" "}
        {chainEntries.map((e, i) => (
          <span key={e[0]}>
            {i > 0 ? ", " : ""}
            <strong style={{ color: "var(--slop-text)" }}>{e[1][0].blockchain}</strong> ({e[1].length})
          </span>
        ))}
        . Sign + execute each from the Transactions tab.
      </div>
      <div>
        <AddressInput value={recipient} placeholder="0x… or vitalik.eth" onChange={next => setRecipient(next ?? "")} />
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
                chain {o.chainId}: {o.ok ? `proposed (${o.calls} calls)` : `failed — ${o.reason ?? "unknown error"}`}
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
            padding: "7px 10px",
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
            onClick={onDone}
            style={{
              padding: "7px 10px",
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
    </div>
  );
};

export default WalletHeader;

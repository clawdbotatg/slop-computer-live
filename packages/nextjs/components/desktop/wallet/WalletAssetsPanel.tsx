"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CHAIN_ICONS, TokenAvatar } from "./TokenAvatar";
import { type Portfolio, type PortfolioAsset, toRawUnits, zerionChainToId } from "./types";
import { AddressInput } from "@scaffold-ui/components";
import { type Address as AddressType, type Hex, encodeFunctionData, erc20Abi, formatUnits } from "viem";
import { usePublicClient } from "wagmi";
import { LoadingBar } from "~~/components/ui";
import { MultisigAbi } from "~~/contracts/multisig";
import type { PeerMeshState, WalletRecord } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
import { computeExecHash, defaultDeadline } from "~~/utils/multisig";

const NATIVE_TOKEN_PLACEHOLDER = "0x0000000000000000000000000000000000000000";

// True for ETH/native rows — they have no real ERC-20 contract on the
// chain, so a send goes as msg.value with empty calldata.
const isNativeAsset = (a: PortfolioAsset): boolean =>
  !a.contractAddress || a.contractAddress.toLowerCase() === NATIVE_TOKEN_PLACEHOLDER;

// Read-only portfolio + activity view for the multisig. Fetched from the
// relay's /v1/wallet/* proxies (which hold the Zerion key). The data is
// inherently the same for every peer — it's just the multisig's on-chain
// state — so there's no mesh state here, each viewer fetches their own.
//
// Portfolio state is now owned by WalletWindow (so the wallet header
// above the tabs and this panel share one fetch). This panel renders
// the list + activity + per-asset send affordance.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const ACCENT = "var(--slop-magenta, #ff3ec9)";

// `${base}${address}` opens a token page on that chain's explorer.
const CHAIN_TOKEN_EXPLORER: Record<string, string> = {
  ethereum: "https://etherscan.io/token/",
  base: "https://basescan.org/token/",
  arbitrum: "https://arbiscan.io/token/",
  optimism: "https://optimistic.etherscan.io/token/",
  polygon: "https://polygonscan.com/token/",
  gnosis: "https://gnosisscan.io/token/",
  xdai: "https://gnosisscan.io/token/",
  linea: "https://lineascan.build/token/",
  scroll: "https://scrollscan.com/token/",
  mantle: "https://mantlescan.xyz/token/",
  zora: "https://explorer.zora.energy/address/",
  unichain: "https://uniscan.xyz/token/",
  "binance-smart-chain": "https://bscscan.com/token/",
  avalanche: "https://snowtrace.io/token/",
};

type ActivityItem = {
  id: string;
  chain: string;
  type: string;
  minedAt: string;
  valueUsd: number | null;
  out: { symbol: string; amount: string } | null;
  in: { symbol: string; amount: string } | null;
  explorerUrl: string;
};

// Matches the shape returned by relay's fetchAssetModal (Zerion fungibles).
type AssetDetail = {
  symbol: string;
  name: string;
  price: number | null;
  priceChange24h: number | null;
  marketCap: number | null;
  volume24h: number | null;
  description: string | null;
  icon: string | null;
  links: { type: string; url: string; name: string }[];
  implementations: { chain: string; address: string | null; decimals: number }[];
  error?: string;
};

const fmtUsd = (v: string | number) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// Compact formatter for big USD numbers (market cap / volume).
const fmtUsdCompact = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
};

const truncAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      fontSize: 9,
      color: ACCENT,
      fontFamily: "var(--slop-font-display)",
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      paddingBottom: 4,
      borderBottom: "1px dashed rgba(255,62,201,0.18)",
      marginBottom: 6,
    }}
  >
    {children}
  </div>
);

const AssetRow = ({
  a,
  onOpen,
  onSend,
}: {
  a: PortfolioAsset;
  onOpen: (a: PortfolioAsset) => void;
  onSend: ((a: PortfolioAsset) => void) | null;
}) => {
  // Send affordance is only enabled when (a) we have an onSend handler
  // (DeFi positions don't get one — they're not raw transfers), (b) the
  // asset is on a chain the multisig is deployed on. The icon still
  // renders disabled so users learn it exists, with a tooltip.
  const chainId = zerionChainToId(a.blockchain);
  const sendable = !!onSend && chainId != null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 0,
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,62,201,0.14)",
        borderRadius: 4,
        overflow: "hidden",
        transition: "background 120ms, border-color 120ms",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = "rgba(255,62,201,0.08)";
        e.currentTarget.style.borderColor = "rgba(255,62,201,0.4)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = "rgba(255,255,255,0.025)";
        e.currentTarget.style.borderColor = "rgba(255,62,201,0.14)";
      }}
    >
      <button
        type="button"
        onClick={() => onOpen(a)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 10px",
          background: "transparent",
          border: 0,
          flex: 1,
          minWidth: 0,
          cursor: "pointer",
          textAlign: "left",
          color: "inherit",
          font: "inherit",
        }}
        title={`View details for ${a.tokenSymbol}`}
      >
        <TokenAvatar symbol={a.tokenSymbol} thumbnail={a.thumbnail} chain={a.blockchain} size={28} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, display: "flex", alignItems: "baseline", gap: 6 }}>
            <span>{a.tokenSymbol}</span>
            {a.tokenName && a.tokenName.toLowerCase() !== a.tokenSymbol.toLowerCase() ? (
              <span
                style={{
                  color: "var(--slop-text-muted)",
                  fontWeight: 400,
                  fontSize: 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {a.tokenName}
              </span>
            ) : null}
            {a.protocol ? (
              <span style={{ color: "var(--slop-text-muted)", fontWeight: 400 }}> · {a.protocol}</span>
            ) : null}
          </div>
          <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
            {parseFloat(a.balance).toLocaleString("en-US", { maximumFractionDigits: 4 })} on {a.blockchain}
          </div>
        </div>
      </button>
      {onSend ? (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            if (sendable) onSend(a);
          }}
          disabled={!sendable}
          title={
            sendable
              ? `Send ${a.tokenSymbol}…`
              : `Multisig isn't deployed on ${a.blockchain} — can't send from this chain.`
          }
          aria-label={`Send ${a.tokenSymbol}`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 10px",
            background: "transparent",
            border: 0,
            borderLeft: "1px dashed rgba(255,62,201,0.18)",
            color: sendable ? ACCENT : "var(--slop-text-muted)",
            cursor: sendable ? "pointer" : "not-allowed",
            opacity: sendable ? 1 : 0.4,
            fontSize: 14,
          }}
        >
          ↗
        </button>
      ) : null}
      <div
        style={{
          padding: "8px 10px",
          fontSize: 12,
          fontFamily: "var(--slop-font-mono, monospace)",
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        {fmtUsd(a.balanceUsd)}
      </div>
    </div>
  );
};

export type WalletAssetsPanelProps = {
  wallet: WalletRecord;
  mesh: PeerMeshState;
  portfolio: Portfolio | null;
  loading: boolean;
  error: string | null;
};

export const WalletAssetsPanel = ({ wallet, mesh, portfolio, loading, error }: WalletAssetsPanelProps) => {
  const slug = useRoomSlug();
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [selected, setSelected] = useState<PortfolioAsset | null>(null);
  const [sendAsset, setSendAsset] = useState<PortfolioAsset | null>(null);

  // Activity has its own fetch (it's not used outside this panel, so
  // there's no reason to hoist it the way portfolio is). Re-runs only
  // when the wallet address or slug changes.
  useEffect(() => {
    let cancelled = false;
    fetch(withSlug(`${RELAY_HTTP}/v1/wallet/activity?address=${wallet.address}`, slug), {
      credentials: "include",
    })
      .then(r => (r.ok ? r.json() : null))
      .then((data: { items?: ActivityItem[] } | null) => {
        if (cancelled) return;
        setActivity(data?.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setActivity([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wallet.address, slug]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 14 }}>
      {error ? (
        <div
          style={{
            padding: 8,
            fontSize: 11,
            color: "#ff9a9a",
            background: "rgba(255,62,62,0.08)",
            border: "1px solid rgba(255,62,62,0.4)",
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      ) : null}

      {loading && !portfolio ? <LoadingBar cells={16} caption="loading portfolio" /> : null}

      {portfolio && portfolio.assets.length > 0 ? (
        <div>
          <SectionLabel>Assets ({portfolio.assets.length})</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {portfolio.assets.map((a, i) => (
              <AssetRow
                key={`${a.contractAddress}-${a.blockchain}-${i}`}
                a={a}
                onOpen={setSelected}
                onSend={setSendAsset}
              />
            ))}
          </div>
        </div>
      ) : portfolio && !loading ? (
        <div style={{ fontSize: 12, color: "var(--slop-text-muted)", fontStyle: "italic" }}>
          No tokens in this wallet yet.
        </div>
      ) : null}

      {portfolio && portfolio.defiPositions.length > 0 ? (
        <div>
          <SectionLabel>DeFi positions ({portfolio.defiPositions.length})</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {portfolio.defiPositions.map((a, i) => (
              // DeFi positions aren't simple transfers — no send affordance.
              <AssetRow key={`defi-${a.contractAddress}-${i}`} a={a} onOpen={setSelected} onSend={null} />
            ))}
          </div>
        </div>
      ) : null}

      {activity && activity.length > 0 ? (
        <div>
          <SectionLabel>Recent activity</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {activity.slice(0, 15).map(it => (
              <a
                key={it.id}
                href={it.explorerUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 8px",
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 4,
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <span
                  style={{
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "var(--slop-text-muted)",
                    minWidth: 56,
                  }}
                >
                  {it.type}
                </span>
                <span style={{ flex: 1, fontSize: 11 }}>
                  {it.out ? `−${it.out.amount} ${it.out.symbol}` : ""}
                  {it.out && it.in ? " → " : ""}
                  {it.in ? `+${it.in.amount} ${it.in.symbol}` : ""}
                </span>
                <span style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>{it.minedAt?.slice(0, 10)}</span>
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {selected ? <AssetDetailModal asset={selected} slug={slug} onClose={() => setSelected(null)} /> : null}
      {sendAsset ? (
        <SendAssetModal asset={sendAsset} wallet={wallet} mesh={mesh} onClose={() => setSendAsset(null)} />
      ) : null}
    </div>
  );
};

// ============================================================================
// AssetDetailModal — fullscreen overlay showing rich metadata for one token.
// Fetches /v1/wallet/asset?symbol= for price/market cap/description/contracts.
// ============================================================================

const AssetDetailModal = ({ asset, slug, onClose }: { asset: PortfolioAsset; slug: string; onClose: () => void }) => {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDetailErr(null);
    fetch(withSlug(`${RELAY_HTTP}/v1/wallet/asset?symbol=${encodeURIComponent(asset.tokenSymbol)}`, slug), {
      credentials: "include",
    })
      .then(r => r.json())
      .then((d: AssetDetail) => {
        if (cancelled) return;
        if (d.error) setDetailErr(d.error);
        else setDetail(d);
      })
      .catch(e => {
        if (!cancelled) setDetailErr(String(e).slice(0, 160));
      });
    return () => {
      cancelled = true;
    };
  }, [asset.tokenSymbol, slug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const balanceQty = parseFloat(asset.balance);
  const balanceUsd = parseFloat(asset.balanceUsd);
  const pricePerToken =
    detail?.price != null
      ? detail.price
      : balanceQty > 0 && Number.isFinite(balanceUsd) && balanceUsd > 0
        ? balanceUsd / balanceQty
        : null;
  const change = detail?.priceChange24h;

  // Prefer Zerion's implementations list (per-chain contract addresses).
  // Fall back to the single (chain, address) we have on the asset itself.
  const implementations =
    detail?.implementations && detail.implementations.length > 0
      ? detail.implementations
      : asset.contractAddress && asset.contractAddress !== "0x0000000000000000000000000000000000000000"
        ? [{ chain: asset.blockchain, address: asset.contractAddress, decimals: 18 }]
        : [];

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
          maxWidth: 460,
          // Cap to the containing block, not the viewport. `.slop-window` has
          // `backdrop-filter` + `overflow: hidden`, which makes our `position:
          // fixed` backdrop resolve to the wallet window (not the viewport) and
          // clip anything taller than it. `85vh` is viewport-relative, so in a
          // short window the card overflowed and the scrollable body was hidden
          // below the clip with no way to reach it. `100%` keeps the card
          // inside the window (minus the backdrop's 16px padding) so the body's
          // overflowY:auto can actually scroll.
          maxHeight: "100%",
          // Card itself doesn't scroll — the body region inside does. This
          // way the header (with close button) stays pinned and the user
          // can always dismiss without scrolling back to the top.
          overflow: "hidden",
          background: "var(--slop-panel, #0a0f24)",
          border: `1px solid ${ACCENT}`,
          borderRadius: 8,
          boxShadow: "0 10px 60px rgba(255,62,201,0.25), 0 0 0 1px rgba(255,62,201,0.15) inset",
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {/* Header: icon + name + symbol + close. flexShrink: 0 keeps it
            pinned at the top while the body scrolls underneath. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: 16,
            paddingRight: 44,
            borderBottom: "1px dashed rgba(255,62,201,0.25)",
            flexShrink: 0,
            position: "relative",
            background: "var(--slop-panel, #0a0f24)",
          }}
        >
          <TokenAvatar
            symbol={asset.tokenSymbol}
            thumbnail={asset.thumbnail || detail?.icon}
            chain={asset.blockchain}
            size={48}
          />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: "var(--slop-font-display)",
                fontSize: 16,
                letterSpacing: "0.06em",
                color: "var(--slop-text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {detail?.name || asset.tokenName || asset.tokenSymbol}
            </div>
            <div
              style={{
                fontFamily: "var(--slop-font-display)",
                fontSize: 11,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: ACCENT,
                marginTop: 2,
              }}
            >
              {asset.tokenSymbol}
              {asset.protocol ? <span style={{ color: "var(--slop-text-muted)" }}> · via {asset.protocol}</span> : null}
            </div>
          </div>
          {/* Close button — lives inside the pinned header so it's always
              reachable regardless of how far the body has scrolled. */}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              position: "absolute",
              top: 12,
              right: 12,
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

        {/* Body — the scrollable region. flex:1 + minHeight:0 lets it shrink
            inside the column flexbox; overscrollBehavior:contain stops wheel
            scroll at the edges from bubbling to the wallet window underneath. */}
        <div
          style={{
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overscrollBehavior: "contain",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {/* Your holdings — pulled from the row that opened the modal */}
          <div
            style={{
              padding: 10,
              borderRadius: 6,
              background: "rgba(255,62,201,0.06)",
              border: "1px solid rgba(255,62,201,0.25)",
            }}
          >
            <div
              style={{
                fontSize: 9,
                color: "var(--slop-text-muted)",
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                marginBottom: 4,
              }}
            >
              Your holdings
            </div>
            <div style={{ fontSize: 14, fontFamily: "var(--slop-font-display)" }}>
              {balanceQty.toLocaleString("en-US", { maximumFractionDigits: 6 })} {asset.tokenSymbol}
            </div>
            <div style={{ fontSize: 11, color: "var(--slop-text-muted)", marginTop: 2 }}>
              ≈ {fmtUsd(asset.balanceUsd)} on {asset.blockchain}
            </div>
          </div>

          {/* Market stats */}
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <DataRow
              label="Price"
              value={
                pricePerToken != null ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "var(--slop-font-mono, monospace)" }}>
                      {fmtUsdCompact(pricePerToken)}
                    </span>
                    {change != null ? (
                      <span style={{ color: change >= 0 ? "#7be88a" : "#ff7676", fontSize: 11 }}>
                        {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
                      </span>
                    ) : null}
                  </span>
                ) : detailErr ? (
                  "—"
                ) : null
              }
            />
            <DataRow label="Market cap" value={detail ? fmtUsdCompact(detail.marketCap) : detailErr ? "—" : null} />
            <DataRow label="24h volume" value={detail ? fmtUsdCompact(detail.volume24h) : detailErr ? "—" : null} />
          </div>

          {/* Per-chain contracts */}
          {implementations.length > 0 ? (
            <div>
              <SectionLabel>Contracts</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {implementations.map((impl, i) => {
                  const chainIcon = CHAIN_ICONS[impl.chain.toLowerCase()] ?? null;
                  const explorerBase = CHAIN_TOKEN_EXPLORER[impl.chain.toLowerCase()];
                  const href = impl.address && explorerBase ? `${explorerBase}${impl.address}` : null;
                  const content = (
                    <>
                      {chainIcon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={chainIcon}
                          alt={impl.chain}
                          width={14}
                          height={14}
                          style={{ width: 14, height: 14, borderRadius: "50%" }}
                        />
                      ) : null}
                      <span
                        style={{
                          fontSize: 11,
                          textTransform: "capitalize",
                          color: "var(--slop-text)",
                          minWidth: 64,
                        }}
                      >
                        {impl.chain}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          fontFamily: "var(--slop-font-mono, monospace)",
                          fontSize: 10,
                          color: "var(--slop-text-muted)",
                          textAlign: "right",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {impl.address ? truncAddr(impl.address) : "native"}
                      </span>
                    </>
                  );
                  return href ? (
                    <a
                      key={`${impl.chain}-${i}`}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 8px",
                        borderRadius: 4,
                        background: "rgba(255,255,255,0.02)",
                        border: "1px solid rgba(255,62,201,0.18)",
                        color: "inherit",
                        textDecoration: "none",
                      }}
                      title="Open token contract on explorer"
                    >
                      {content}
                    </a>
                  ) : (
                    <div
                      key={`${impl.chain}-${i}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 8px",
                        borderRadius: 4,
                        background: "rgba(255,255,255,0.02)",
                        border: "1px solid rgba(255,62,201,0.12)",
                      }}
                    >
                      {content}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Description */}
          {detail?.description ? (
            <div>
              <SectionLabel>About</SectionLabel>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--slop-text)" }}>
                {detail.description.length > 320 ? `${detail.description.slice(0, 320)}…` : detail.description}
              </p>
            </div>
          ) : null}

          {/* External links */}
          {detail?.links && detail.links.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {detail.links.map((l, i) => (
                <a
                  key={`${l.type}-${i}`}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    padding: "4px 8px",
                    fontSize: 10,
                    fontFamily: "var(--slop-font-display)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    background: "transparent",
                    color: ACCENT,
                    border: `1px solid ${ACCENT}`,
                    borderRadius: 3,
                    textDecoration: "none",
                  }}
                >
                  {l.name || l.type} ↗
                </a>
              ))}
            </div>
          ) : null}

          {/* Loading / error fallback */}
          {!detail && !detailErr ? <LoadingBar cells={12} caption="loading token data" /> : null}
          {detailErr ? (
            <div style={{ fontSize: 11, color: "#ff9a9a", fontStyle: "italic" }}>
              couldn&apos;t load token metadata: {detailErr}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const DataRow = ({ label, value }: { label: string; value: React.ReactNode | null }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "6px 0",
      borderBottom: "1px solid rgba(255,62,201,0.08)",
      fontSize: 12,
    }}
  >
    <span style={{ color: "var(--slop-text-muted)" }}>{label}</span>
    {value != null ? (
      <span style={{ color: "var(--slop-text)" }}>{value}</span>
    ) : (
      <span
        style={{
          width: 60,
          height: 10,
          background: "rgba(255,62,201,0.12)",
          borderRadius: 2,
          display: "inline-block",
        }}
      />
    )}
  </div>
);

// ============================================================================
// SendAssetModal — per-asset send form. AddressInput + editable amount
// (prefilled to max balance with a [max] chip). On send, proposes a
// single WalletTx — ERC-20 transfer for token rows, msg.value for the
// native row. Drops it into the multisig queue (Transactions tab) where
// signers approve + execute.
// ============================================================================

const SendAssetModal = ({
  asset,
  wallet,
  mesh,
  onClose,
}: {
  asset: PortfolioAsset;
  wallet: WalletRecord;
  mesh: PeerMeshState;
  onClose: () => void;
}) => {
  const chainId = zerionChainToId(asset.blockchain);
  const publicClient = usePublicClient({ chainId: chainId ?? undefined });
  const native = isNativeAsset(asset);
  const decimals = asset.tokenDecimals ?? 18;

  // Local form state. Amount string mirrors what the user typed so we
  // can re-fill it from [max] without losing the input element's
  // selection/cursor on each keystroke.
  const [recipient, setRecipient] = useState<string>("");
  const [amount, setAmount] = useState<string>(() => asset.balance);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Esc closes — same UX as AssetDetailModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const maxRaw = useMemo(() => toRawUnits(asset.balance, decimals), [asset.balance, decimals]);
  const amountRaw = useMemo(() => toRawUnits(amount, decimals), [amount, decimals]);
  const recipientValid = /^0x[a-fA-F0-9]{40}$/.test(recipient.trim());
  const amountValid = amountRaw > 0n && amountRaw <= maxRaw;
  const overMax = amountRaw > maxRaw;
  const chainSupported = chainId != null;
  const deployedOnChain = chainId != null && chainId in wallet.deployments;
  const canSend = recipientValid && amountValid && chainSupported && deployedOnChain && !submitting;

  const onSend = useCallback(async () => {
    setError(null);
    if (!chainId) {
      setError(`${asset.blockchain} isn't supported by the multisig`);
      return;
    }
    if (!deployedOnChain) {
      setError(`multisig isn't deployed on ${asset.blockchain} yet`);
      return;
    }
    if (!publicClient) {
      setError("no RPC client for this chain");
      return;
    }
    if (!recipientValid) {
      setError("recipient is not a valid address");
      return;
    }
    if (!amountValid) {
      setError(overMax ? "amount exceeds balance" : "amount must be greater than 0");
      return;
    }
    setSubmitting(true);
    try {
      const nonce = (await publicClient.readContract({
        address: wallet.address as AddressType,
        abi: MultisigAbi,
        functionName: "nonce",
      })) as bigint;
      const deadline = defaultDeadline();
      const to = recipient.trim() as AddressType;
      // ERC-20 row → encode `transfer(to, amount)`, send to the token
      // contract with value=0. Native row → send raw to recipient with
      // amount as value and empty calldata.
      const target: AddressType = native ? to : (asset.contractAddress as AddressType);
      const value: bigint = native ? amountRaw : 0n;
      const data: Hex = native
        ? "0x"
        : encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [to, amountRaw],
          });
      const execHash = computeExecHash({
        chainId,
        multisig: wallet.address as AddressType,
        nonce,
        deadline,
        target,
        value,
        data,
      });
      mesh.walletProposeTx({
        chainId,
        target,
        value: value.toString(),
        data,
        deadline: deadline.toString(),
        nonce: nonce.toString(),
        execHash,
        source: "manual",
        browserId: null,
      });
      setSent(true);
      // Close so the user lands on the Transactions tab — WalletWindow
      // auto-jumps on the wallet_tx_attention ping that the relay
      // broadcasts for every successful propose.
      onClose();
    } catch (err) {
      setError(String(err).slice(0, 200));
    } finally {
      setSubmitting(false);
    }
  }, [
    chainId,
    deployedOnChain,
    publicClient,
    recipient,
    recipientValid,
    amountRaw,
    amountValid,
    overMax,
    native,
    asset.contractAddress,
    asset.blockchain,
    wallet.address,
    mesh,
    onClose,
  ]);

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
          <TokenAvatar symbol={asset.tokenSymbol} thumbnail={asset.thumbnail} chain={asset.blockchain} size={36} />
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
              Send {asset.tokenSymbol}
            </div>
            <div style={{ fontSize: 11, color: "var(--slop-text-muted)", marginTop: 2 }}>
              on {asset.blockchain} · balance{" "}
              {parseFloat(asset.balance).toLocaleString("en-US", { maximumFractionDigits: 6 })} {asset.tokenSymbol}
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
          {!chainSupported ? (
            <div style={{ fontSize: 11, color: "#ff9a9a" }}>
              The multisig factory isn&apos;t deployed on {asset.blockchain} — sends from this chain are not supported.
            </div>
          ) : !deployedOnChain ? (
            <div style={{ fontSize: 11, color: "#ff9a9a" }}>
              The multisig isn&apos;t deployed on {asset.blockchain} yet — deploy it on that chain first.
            </div>
          ) : null}

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

          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <label
                style={{
                  fontSize: 10,
                  color: "var(--slop-text-muted)",
                  fontFamily: "var(--slop-font-display)",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                }}
              >
                Amount
              </label>
              <button
                type="button"
                onClick={() => setAmount(asset.balance)}
                style={{
                  background: "transparent",
                  border: `1px solid ${ACCENT}`,
                  color: ACCENT,
                  fontSize: 9,
                  fontFamily: "var(--slop-font-display)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  padding: "2px 6px",
                  borderRadius: 3,
                  cursor: "pointer",
                }}
              >
                Max
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
              <input
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.0"
                inputMode="decimal"
                style={{
                  flex: 1,
                  padding: "6px 8px",
                  background: "rgba(0,0,0,0.4)",
                  border: `1px solid ${overMax ? "#ff7676" : "rgba(255,62,201,0.3)"}`,
                  borderRadius: 4,
                  color: "var(--slop-text)",
                  fontFamily: "var(--slop-font-mono, monospace)",
                  fontSize: 13,
                  minWidth: 0,
                }}
              />
              <span
                style={{
                  padding: "6px 8px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,62,201,0.2)",
                  borderRadius: 4,
                  fontSize: 12,
                  color: "var(--slop-text-muted)",
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                {asset.tokenSymbol}
              </span>
            </div>
            {overMax ? (
              <div style={{ fontSize: 10, color: "#ff7676", marginTop: 4 }}>
                exceeds balance ({formatUnits(maxRaw, decimals)} {asset.tokenSymbol})
              </div>
            ) : null}
          </div>

          {error ? <div style={{ fontSize: 11, color: "#ff7676" }}>{error}</div> : null}

          <button
            type="button"
            onClick={() => void onSend()}
            disabled={!canSend && !sent}
            style={{
              marginTop: 4,
              padding: "8px 12px",
              fontSize: 11,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              fontWeight: 700,
              background: sent ? "rgba(123,232,138,0.2)" : canSend ? ACCENT : "rgba(255,62,201,0.25)",
              color: sent ? "#7be88a" : canSend ? "#06030d" : "var(--slop-text-muted)",
              border: sent ? "1px solid rgba(123,232,138,0.4)" : "none",
              borderRadius: 4,
              cursor: canSend ? "pointer" : "default",
            }}
          >
            {sent ? "✓ In multisig queue" : submitting ? "Proposing…" : "Propose send"}
          </button>
          {sent ? (
            <div style={{ fontSize: 10, color: "var(--slop-text-muted)", textAlign: "center" }}>
              Open the Transactions tab to sign + execute.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default WalletAssetsPanel;

"use client";

import { useCallback, useEffect, useState } from "react";
import { LoadingBar } from "~~/components/ui";
import type { WalletRecord } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";

// Read-only portfolio + activity view for the multisig. Fetched from the
// relay's /v1/wallet/* proxies (which hold the Zerion key). The data is
// inherently the same for every peer — it's just the multisig's on-chain
// state — so there's no mesh state here, each viewer fetches their own.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const ACCENT = "var(--slop-magenta, #ff3ec9)";

// llamao chain logos — same source the AI wallet UI uses. Keys match the
// Zerion `chain_id` slug that comes back on PortfolioAsset.blockchain.
const CHAIN_ICONS: Record<string, string> = {
  ethereum: "https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg",
  base: "https://icons.llamao.fi/icons/chains/rsz_base.jpg",
  arbitrum: "https://icons.llamao.fi/icons/chains/rsz_arbitrum.jpg",
  optimism: "https://icons.llamao.fi/icons/chains/rsz_optimism.jpg",
  polygon: "https://icons.llamao.fi/icons/chains/rsz_polygon.jpg",
  xdai: "https://icons.llamao.fi/icons/chains/rsz_xdai.jpg",
  gnosis: "https://icons.llamao.fi/icons/chains/rsz_xdai.jpg",
  linea: "https://icons.llamao.fi/icons/chains/rsz_linea.jpg",
  scroll: "https://icons.llamao.fi/icons/chains/rsz_scroll.jpg",
  "zksync-era": "https://icons.llamao.fi/icons/chains/rsz_zksync%20era.jpg",
  zksync: "https://icons.llamao.fi/icons/chains/rsz_zksync%20era.jpg",
  mantle: "https://icons.llamao.fi/icons/chains/rsz_mantle.jpg",
  zora: "https://icons.llamao.fi/icons/chains/rsz_zora.jpg",
  unichain: "https://icons.llamao.fi/icons/chains/rsz_unichain.jpg",
  "binance-smart-chain": "https://icons.llamao.fi/icons/chains/rsz_binance.jpg",
  avalanche: "https://icons.llamao.fi/icons/chains/rsz_avalanche.jpg",
};

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

type PortfolioAsset = {
  blockchain: string;
  tokenName: string;
  tokenSymbol: string;
  positionType: string;
  protocol: string | null;
  balance: string;
  balanceUsd: string;
  contractAddress: string;
  thumbnail: string;
};
type Portfolio = {
  totalBalanceUsd: string;
  assets: PortfolioAsset[];
  defiPositions: PortfolioAsset[];
  change1dUsd: string;
  change1dPct: string;
  error?: string;
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
  if (!Number.isFinite(n)) return "$0";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
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

// Token icon with a chain badge in the corner. Falls back to a colored
// monogram tile if no thumbnail is available or the image 404s.
const TokenAvatar = ({
  symbol,
  thumbnail,
  chain,
  size = 28,
}: {
  symbol: string;
  thumbnail?: string | null;
  chain?: string | null;
  size?: number;
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const chainIcon = chain ? CHAIN_ICONS[chain.toLowerCase()] : null;
  const badgeSize = Math.max(10, Math.round(size * 0.42));
  return (
    <span
      style={{
        position: "relative",
        flexShrink: 0,
        width: size,
        height: size,
        display: "inline-block",
      }}
    >
      {thumbnail && !imgFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnail}
          alt={symbol}
          width={size}
          height={size}
          onError={() => setImgFailed(true)}
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.05)",
            display: "block",
          }}
        />
      ) : (
        <span
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            background: "rgba(255,62,201,0.14)",
            border: "1px solid rgba(255,62,201,0.4)",
            color: ACCENT,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--slop-font-display)",
            fontSize: Math.max(9, Math.round(size * 0.38)),
            letterSpacing: 0,
          }}
        >
          {symbol.slice(0, 2).toUpperCase()}
        </span>
      )}
      {chainIcon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={chainIcon}
          alt={chain ?? ""}
          width={badgeSize}
          height={badgeSize}
          style={{
            position: "absolute",
            bottom: -2,
            right: -2,
            width: badgeSize,
            height: badgeSize,
            borderRadius: "50%",
            boxShadow: "0 0 0 2px #06030d",
            background: "#06030d",
          }}
        />
      ) : null}
    </span>
  );
};

const AssetRow = ({ a, onOpen }: { a: PortfolioAsset; onOpen: (a: PortfolioAsset) => void }) => (
  <button
    type="button"
    onClick={() => onOpen(a)}
    style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "8px 10px",
      background: "rgba(255,255,255,0.025)",
      border: "1px solid rgba(255,62,201,0.14)",
      borderRadius: 4,
      cursor: "pointer",
      width: "100%",
      textAlign: "left",
      color: "inherit",
      font: "inherit",
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
        {a.protocol ? <span style={{ color: "var(--slop-text-muted)", fontWeight: 400 }}> · {a.protocol}</span> : null}
      </div>
      <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
        {parseFloat(a.balance).toLocaleString("en-US", { maximumFractionDigits: 4 })} on {a.blockchain}
      </div>
    </div>
    <div style={{ fontSize: 12, fontFamily: "var(--slop-font-mono, monospace)" }}>{fmtUsd(a.balanceUsd)}</div>
  </button>
);

export const WalletAssetsPanel = ({ wallet }: { wallet: WalletRecord }) => {
  const slug = useRoomSlug();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PortfolioAsset | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, aRes] = await Promise.all([
        fetch(withSlug(`${RELAY_HTTP}/v1/wallet/portfolio?address=${wallet.address}`, slug), {
          credentials: "include",
        }),
        fetch(withSlug(`${RELAY_HTTP}/v1/wallet/activity?address=${wallet.address}`, slug), {
          credentials: "include",
        }),
      ]);
      if (pRes.ok) setPortfolio((await pRes.json()) as Portfolio);
      else setError(`portfolio: relay ${pRes.status}`);
      if (aRes.ok) {
        const data = (await aRes.json()) as { items?: ActivityItem[] };
        setActivity(data.items ?? []);
      }
    } catch (err) {
      setError(`network error: ${String(err).slice(0, 160)}`);
    } finally {
      setLoading(false);
    }
  }, [wallet.address, slug]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 14 }}>
      {/* Total */}
      <div
        style={{
          padding: 12,
          borderRadius: 6,
          background: "linear-gradient(180deg, rgba(255,62,201,0.08) 0%, rgba(255,62,201,0.02) 100%)",
          border: "1px solid rgba(255,62,201,0.3)",
        }}
      >
        <div
          style={{
            fontSize: 9,
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Wallet balance
        </div>
        <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "var(--slop-font-display)", marginTop: 2 }}>
          {portfolio ? fmtUsd(portfolio.totalBalanceUsd) : loading ? "…" : "$0"}
        </div>
        {portfolio && parseFloat(portfolio.change1dUsd) !== 0 ? (
          <div
            style={{
              fontSize: 11,
              marginTop: 2,
              color: parseFloat(portfolio.change1dUsd) >= 0 ? "#7be88a" : "#ff7676",
            }}
          >
            {parseFloat(portfolio.change1dUsd) >= 0 ? "▲" : "▼"} {fmtUsd(Math.abs(parseFloat(portfolio.change1dUsd)))} (
            {portfolio.change1dPct}%) 24h
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{
            marginTop: 8,
            padding: "3px 8px",
            fontSize: 9,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            background: "transparent",
            color: "var(--slop-text-muted)",
            border: "1px solid rgba(255,62,201,0.3)",
            borderRadius: 3,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

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
              <AssetRow key={`${a.contractAddress}-${a.blockchain}-${i}`} a={a} onOpen={setSelected} />
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
              <AssetRow key={`defi-${a.contractAddress}-${i}`} a={a} onOpen={setSelected} />
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
          maxHeight: "85vh",
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

export default WalletAssetsPanel;

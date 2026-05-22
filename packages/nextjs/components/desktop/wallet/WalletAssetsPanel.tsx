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

const fmtUsd = (v: string | number) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!Number.isFinite(n)) return "$0";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
};

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

const ACCENT = "var(--slop-magenta, #ff3ec9)";

const AssetRow = ({ a }: { a: PortfolioAsset }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "6px 8px",
      background: "rgba(255,255,255,0.025)",
      border: "1px solid rgba(255,62,201,0.14)",
      borderRadius: 4,
    }}
  >
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>
        {a.tokenSymbol}
        {a.protocol ? <span style={{ color: "var(--slop-text-muted)", fontWeight: 400 }}> · {a.protocol}</span> : null}
      </div>
      <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
        {parseFloat(a.balance).toLocaleString("en-US", { maximumFractionDigits: 4 })} on {a.blockchain}
      </div>
    </div>
    <div style={{ fontSize: 12, fontFamily: "monospace" }}>{fmtUsd(a.balanceUsd)}</div>
  </div>
);

export const WalletAssetsPanel = ({ wallet }: { wallet: WalletRecord }) => {
  const slug = useRoomSlug();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
              <AssetRow key={`${a.contractAddress}-${a.blockchain}-${i}`} a={a} />
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
              <AssetRow key={`defi-${a.contractAddress}-${i}`} a={a} />
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
    </div>
  );
};

export default WalletAssetsPanel;

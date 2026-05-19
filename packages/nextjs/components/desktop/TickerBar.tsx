"use client";

import type { PeerMeshState, TickerItem } from "~~/hooks/usePeerMesh";
import { shouldInterceptClick } from "~~/utils/openInSlopBrowser";

// Render a sub-cent USD price using the "0.0₍N₎digits" subscript-zeros
// convention common in DEX UIs (Uniswap, DexScreener) for tokens where
// most of the decimal is leading zeros. e.g. 0.00002012 → "0.0₍4₎20",
// where the 4 is the count of leading zeros after the decimal point.
// For prices ≥ $0.01 we return null so the caller can fall back to a
// normal `$0.0123` rendering.
function subzero(p: number): { zeros: number; sig: string } | null {
  if (!Number.isFinite(p) || p <= 0 || p >= 0.01) return null;
  // 20 digits is plenty for any realistic token price (smallest ERC-20
  // wei-priced thing tops out around 1e-18 USD).
  const s = p.toFixed(20);
  const dot = s.indexOf(".");
  if (dot < 0) return null;
  const decimals = s.slice(dot + 1);
  // Count leading zeros in the decimal portion.
  let zeros = 0;
  while (zeros < decimals.length && decimals[zeros] === "0") zeros += 1;
  if (zeros === 0) return null;
  // Take a couple of significant digits after the zeros; trim trailing
  // zeros so "00002000" → "2" not "2000".
  const after = decimals.slice(zeros);
  // Take up to 4 significant digits after the run of zeros; trim
  // trailing zeros so 0.000020 renders as "2" not "2000". Matches the
  // precision DexScreener / Uniswap use for sub-cent tokens.
  const sig = after.slice(0, 4).replace(/0+$/, "") || "0";
  return { zeros, sig };
}

// Slop-themed crypto/AI ticker pinned to the bottom of the desktop.
// Reads `mesh.tickerState`, which the relay refreshes every 60s
// (CoinGecko for crypto, Stooq for stocks, hardcoded for private AI
// labs, synthetic random-walk for $CLAWD). One source of truth across
// every peer — no per-client API calls.
//
// The scrolling is pure CSS: a single track is rendered twice
// side-by-side and translated -50% so the seam is invisible. No JS
// rAF loop, no scroll listeners.

export const TICKER_HEIGHT = 28;

export type TickerBarProps = {
  mesh: PeerMeshState;
  /** Route plain left-clicks into the shared slop browser instead of a
   *  new tab. Modifier-clicks fall through to the anchor's `_blank`. */
  onOpenUrl: (url: string) => void;
};

// Compact USD formatter. Stock prices want $123.45 precision; private
// valuations want $500B-style abbreviations; meme tokens want a few
// decimals; ETH/BTC sit in between.
function formatPrice(item: TickerItem): string {
  const p = item.price;
  if (item.kind === "private") {
    // Trillions / billions / millions.
    if (p >= 1_000_000_000_000) return `$${(p / 1_000_000_000_000).toFixed(2)}T`;
    if (p >= 1_000_000_000) return `$${(p / 1_000_000_000).toFixed(1)}B`;
    if (p >= 1_000_000) return `$${(p / 1_000_000).toFixed(1)}M`;
    return `$${Math.round(p)}`;
  }
  if (p >= 10_000) return `$${Math.round(p).toLocaleString()}`;
  if (p >= 100) return `$${p.toFixed(2)}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p >= 0.01) return `$${p.toFixed(3)}`;
  return `$${p.toFixed(5)}`;
}

function formatChange(pct: number): string {
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.005) return "0.00%";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function changeColor(pct: number, kind: TickerItem["kind"]): string {
  // Private valuations don't have an intraday change — render in
  // neutral text-muted so the eye doesn't read it as flat zero-percent
  // movement (it's just "no data" by design).
  if (kind === "private") return "var(--slop-text-muted)";
  if (pct > 0.005) return "var(--slop-lime)";
  if (pct < -0.005) return "var(--slop-red)";
  return "var(--slop-text-muted)";
}

function kindColor(kind: TickerItem["kind"]): string {
  switch (kind) {
    case "crypto":
      return "var(--slop-cyan)";
    case "stock":
      return "var(--slop-amber)";
    case "private":
      return "var(--slop-purple)";
    case "meme":
      return "var(--slop-magenta)";
  }
}

function Cell({ item, onOpenUrl }: { item: TickerItem; onOpenUrl: (url: string) => void }) {
  // Render as a link when we have a destination (CoinGecko / Yahoo
  // Finance / DexScreener). Private valuations get rendered as plain
  // spans because there's no canonical "what does this number even
  // mean" page to send users to.
  const Tag = (item.url ? "a" : "span") as "a" | "span";
  const url = item.url;
  const linkProps = url
    ? ({
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
        className: "slop-ticker-cell",
        onClick: (e: React.MouseEvent) => {
          if (!shouldInterceptClick(e)) return;
          e.preventDefault();
          onOpenUrl(url);
        },
      } as const)
    : {};
  return (
    <Tag
      {...linkProps}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "0 18px",
        whiteSpace: "nowrap",
        textDecoration: "none",
        color: "inherit",
        // Outer bar is pointer-events: none so drags pass through;
        // re-enable here so the link actually clicks.
        pointerEvents: item.url ? "auto" : "none",
        cursor: item.url ? "pointer" : "default",
      }}
    >
      <span
        style={{
          color: kindColor(item.kind),
          fontFamily: "var(--slop-font-display)",
          fontSize: 11,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {item.symbol}
      </span>
      <span
        style={{
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-mono)",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {formatPrice(item)}
      </span>
      <span
        style={{
          color: changeColor(item.changePct, item.kind),
          fontFamily: "var(--slop-font-mono)",
          fontSize: 11,
        }}
      >
        {item.kind === "private" ? "private" : formatChange(item.changePct)}
      </span>
      <span style={{ color: "rgba(255,62,201,0.35)", fontSize: 10, marginLeft: 4 }}>•</span>
    </Tag>
  );
}

// Live CLAWD price + 24h change, rendered as the ticker bar's left-edge
// badge. Uses the DEX subscript-zeros convention for sub-cent prices
// (e.g. $0.00002012 → $0.0₍4₎20). Clickable when the relay has
// populated `item.url` (the DexScreener page for CLAWD on Base).
function ClawdBadge({ item, onOpenUrl }: { item: TickerItem | null; onOpenUrl: (url: string) => void }) {
  // Always render the badge shell, even while item is null, so the
  // ticker's left-edge always has the right width and doesn't reflow
  // when the first poll lands.
  const price = item?.price ?? null;
  const change = item?.changePct ?? 0;
  const sub = price !== null ? subzero(price) : null;
  const isUp = change > 0.005;
  const isDown = change < -0.005;
  const changeColorVal = isUp ? "var(--slop-lime)" : isDown ? "var(--slop-red)" : "var(--slop-text-muted)";

  const badgeUrl = item?.url;
  const Tag = (badgeUrl ? "a" : "span") as "a" | "span";
  const linkProps = badgeUrl
    ? ({
        href: badgeUrl,
        target: "_blank",
        rel: "noopener noreferrer",
        onClick: (e: React.MouseEvent) => {
          if (!shouldInterceptClick(e)) return;
          e.preventDefault();
          onOpenUrl(badgeUrl);
        },
      } as const)
    : {};
  return (
    <Tag
      {...linkProps}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 30px 0 14px",
        background:
          "linear-gradient(90deg, rgba(255,62,201,0.95) 0%, rgba(124,77,255,0.95) 70%, rgba(124,77,255,0.0) 100%)",
        color: "#fff",
        textDecoration: "none",
        // Outer bar is pointer-events: none — re-enable on the badge
        // itself so the click reaches the DexScreener link.
        pointerEvents: item?.url ? "auto" : "none",
        cursor: item?.url ? "pointer" : "default",
        zIndex: 2,
        textShadow: "0 1px 0 rgba(0,0,0,0.45)",
        width: 320,
        // Soft fade into the scrolling track so the seam is invisible.
        maskImage: "linear-gradient(90deg, #000 0%, #000 88%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(90deg, #000 0%, #000 88%, transparent 100%)",
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontFamily: "var(--slop-font-display)",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          letterSpacing: "0.16em",
          fontSize: 11,
        }}
      >
        <span style={{ fontSize: 8, opacity: 0.75, marginRight: 4 }}>Built by</span>
        $CLAWD
      </span>
      {price === null ? (
        <span
          style={{
            fontFamily: "var(--slop-font-mono)",
            fontSize: 11,
            fontStyle: "italic",
            opacity: 0.85,
          }}
        >
          loading…
        </span>
      ) : (
        <span
          style={{
            fontFamily: "var(--slop-font-mono)",
            fontSize: 13,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "baseline",
          }}
        >
          {sub ? (
            <>
              $0.0
              <sub
                style={{
                  // Slightly smaller and pushed down ~50% from baseline,
                  // matching the DexScreener/Uniswap subscript-zeros look.
                  fontSize: "0.7em",
                  verticalAlign: "sub",
                  margin: "0 1px",
                }}
              >
                {sub.zeros}
              </sub>
              {sub.sig}
            </>
          ) : price >= 1 ? (
            `$${price.toFixed(2)}`
          ) : (
            `$${price.toFixed(4)}`
          )}
        </span>
      )}
      {price !== null ? (
        <span
          style={{
            fontFamily: "var(--slop-font-mono)",
            fontSize: 11,
            color: changeColorVal,
            // Force the text-shadow off for the change pill so the
            // green/red reads as cleanly as in the rest of the bar.
            textShadow: "none",
            background: "rgba(0,0,0,0.32)",
            borderRadius: 4,
            padding: "1px 6px",
          }}
        >
          {isUp ? "+" : ""}
          {change.toFixed(2)}%
        </span>
      ) : null}
    </Tag>
  );
}

export const TickerBar = ({ mesh, onOpenUrl }: TickerBarProps) => {
  const allItems = mesh.tickerState?.items ?? [];
  // CLAWD lives in the left-edge badge (live price + 24h change),
  // featured separately from the rest of the strip. Pull it out of the
  // scrolling track so it isn't shown twice.
  const clawd = allItems.find(i => i.symbol === "$CLAWD") ?? null;
  const items = allItems.filter(i => i.symbol !== "$CLAWD");

  return (
    <>
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          height: TICKER_HEIGHT,
          background: "linear-gradient(180deg, rgba(10,15,36,0.96) 0%, rgba(6,8,24,0.98) 100%)",
          borderTop: "1px solid rgba(255,62,201,0.35)",
          boxShadow: "0 -2px 12px rgba(255,62,201,0.18)",
          zIndex: 60, // above icons + trash so it always wins the bottom strip
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        {/* Left-edge CLAWD price tile. Doubles as the "logo handle" of
            the ticker bar AND the headline price feature — CLAWD is a
            real ERC-20 on Base; the relay pulls the deepest-liquidity
            pair from DexScreener every 60s. */}
        <ClawdBadge item={clawd} onOpenUrl={onOpenUrl} />

        {items.length === 0 ? (
          // No data yet (relay still on first poll). Show a static
          // placeholder so the bar's height is always reserved.
          <span
            style={{
              marginLeft: 290,
              color: "var(--slop-text-muted)",
              fontFamily: "var(--slop-font-mono)",
              fontSize: 11,
              fontStyle: "italic",
            }}
          >
            loading market data...
          </span>
        ) : (
          <div
            className="slop-ticker-track"
            style={{
              display: "flex",
              alignItems: "center",
              paddingLeft: 330, // clear the CLAWD badge
              willChange: "transform",
            }}
          >
            {/* Track is rendered as two halves (-a / -b) with keys
                derived from a stable id, not the array index. That way
                when the relay pushes a new poll, React reconciles each
                cell in place instead of remounting — the CSS animation
                keeps running and the marquee never jumps back to 0. */}
            {items.map(item => (
              <Cell key={`${item.symbol}-a`} item={item} onOpenUrl={onOpenUrl} />
            ))}
            {items.map(item => (
              <Cell key={`${item.symbol}-b`} item={item} onOpenUrl={onOpenUrl} />
            ))}
          </div>
        )}
      </div>
      {/* Animation lives in a <style> tag so we don't need to touch
          globals.css for a one-component effect. Width 200% + translate
          -50% gives a seamless loop because the second half of the
          track is an exact duplicate of the first. */}
      <style jsx global>{`
        .slop-ticker-track {
          animation: slop-ticker-scroll 120s linear infinite;
          /* Re-enable pointer events on the scroll track so children
             can fire hover/click (the outer bar is pointer-events:none
             so drags pass through, but ticker-cell links need to work). */
          pointer-events: auto;
        }
        /* Pause the marquee while the cursor is over a ticker cell so
           the user has a stationary target to click. */
        .slop-ticker-track:hover {
          animation-play-state: paused;
        }
        .slop-ticker-cell:hover {
          background: rgba(255, 62, 201, 0.08);
          border-radius: 4px;
        }
        @keyframes slop-ticker-scroll {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-50%);
          }
        }
      `}</style>
    </>
  );
};

export default TickerBar;

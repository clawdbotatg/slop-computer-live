"use client";

import { useState } from "react";
import type { Headline, PeerMeshState } from "~~/hooks/usePeerMesh";
import { shouldInterceptClick } from "~~/utils/openInSlopBrowser";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// Headlines marquee — sits directly above the price ticker. Crypto +
// AI news interleaved, scrolling left a touch faster than the prices
// so the two bars don't feel locked together but the text still has
// time to read. Data comes from `mesh.headlinesState` which the relay
// refreshes every hour; clicking the HEADLINES badge forces an
// immediate refresh (host-only).
//
// Implementation mirrors TickerBar: duplicated track + CSS translate
// for a seamless loop, no rAF.

export const HEADLINES_HEIGHT = 24;

// Headlines duration sits at the arithmetic midpoint between the
// ticker (120s) and the timeline (~400s) so the three bars feel like
// an evenly-spaced cadence cascade rather than two slow + one fast.
// Timeline (above) auto-scales by item count via its own per-item
// budget; this constant is hand-tuned.
const SCROLL_DURATION_S = 260;

export type HeadlinesBarProps = {
  mesh: PeerMeshState;
  /** Route plain left-clicks into the shared slop browser instead of a
   *  new tab. Modifier-clicks fall through to the anchor's `_blank`. */
  onOpenUrl: (url: string) => void;
};

function badgeColor(kind: Headline["kind"]): string {
  return kind === "crypto" ? "var(--slop-cyan)" : "var(--slop-magenta)";
}

function badgeLabel(kind: Headline["kind"]): string {
  return kind === "crypto" ? "CRYPTO" : "AI";
}

function Item({ headline, onOpenUrl }: { headline: Headline; onOpenUrl: (url: string) => void }) {
  return (
    <a
      href={headline.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => {
        if (!shouldInterceptClick(e)) return;
        e.preventDefault();
        onOpenUrl(headline.url);
      }}
      className="slop-headline-item"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "0 18px",
        whiteSpace: "nowrap",
        textDecoration: "none",
        // Pointer events are off on the outer bar (so drags pass
        // through). Re-enable them on the link itself so clicks work
        // and the hover state can pause the marquee.
        pointerEvents: "auto",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          color: badgeColor(headline.kind),
          fontFamily: "var(--slop-font-display)",
          fontSize: 9,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          padding: "1px 6px",
          border: `1px solid ${badgeColor(headline.kind)}`,
          borderRadius: 3,
          opacity: 0.9,
        }}
      >
        {badgeLabel(headline.kind)}
      </span>
      <span
        className="slop-headline-title"
        style={{
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          fontSize: 12,
        }}
      >
        {headline.title}
      </span>
      <span
        style={{
          color: "var(--slop-text-muted)",
          fontFamily: "var(--slop-font-mono)",
          fontSize: 10,
        }}
      >
        — {headline.source}
      </span>
      <span style={{ color: "rgba(63,207,255,0.35)", fontSize: 10, marginLeft: 4 }}>•</span>
    </a>
  );
}

export const HeadlinesBar = ({ mesh, onOpenUrl }: HeadlinesBarProps) => {
  const items = mesh.headlinesState?.items ?? [];
  const [refreshing, setRefreshing] = useState(false);

  // Hidden host-only refresh: clicking the HEADLINES badge POSTs to the
  // relay. Non-host clicks return 403 silently — the bar just flashes
  // the reload glyph and stops.
  const onBadgeClick = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetch(`${RELAY_HTTP}/v1/headlines/refresh`, { method: "POST", credentials: "include" });
    } catch {
      /* network error — silent, badge will just stop flashing */
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          // Sits directly on top of the ticker bar (TICKER_HEIGHT = 28).
          bottom: 28,
          height: HEADLINES_HEIGHT,
          background: "linear-gradient(180deg, rgba(6,8,24,0.96) 0%, rgba(10,15,36,0.96) 100%)",
          borderTop: "1px solid rgba(63,207,255,0.22)",
          borderBottom: "1px solid rgba(63,207,255,0.10)",
          zIndex: 60, // same band as the ticker bar
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        {/* Left badge — counterpart to the ticker's CLAWD tile. Plain
            "HEADLINES" label so this band's purpose is obvious. Hidden
            host affordance: clicking the badge forces a fresh pull. */}
        <button
          type="button"
          onClick={onBadgeClick}
          aria-label="Refresh headlines"
          title="Refresh headlines"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 24px 0 14px",
            background:
              "linear-gradient(90deg, rgba(63,207,255,0.85) 0%, rgba(124,77,255,0.7) 70%, rgba(124,77,255,0.0) 100%)",
            color: "#fff",
            fontFamily: "var(--slop-font-display)",
            fontSize: 10,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            textShadow: "0 1px 0 rgba(0,0,0,0.45)",
            zIndex: 2,
            maskImage: "linear-gradient(90deg, #000 0%, #000 85%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(90deg, #000 0%, #000 85%, transparent 100%)",
            border: "none",
            cursor: refreshing ? "wait" : "pointer",
            pointerEvents: "auto",
            appearance: "none",
            WebkitAppearance: "none",
          }}
        >
          HEADLINES
          {refreshing && (
            <span
              aria-hidden
              className="slop-headlines-refresh-glyph"
              style={{
                display: "inline-block",
                fontFamily: "var(--slop-font-mono)",
                fontSize: 12,
                color: "var(--slop-cyan)",
                letterSpacing: 0,
              }}
            >
              ↻
            </span>
          )}
        </button>

        {items.length === 0 ? (
          <span
            style={{
              marginLeft: 150,
              color: "var(--slop-text-muted)",
              fontFamily: "var(--slop-font-mono)",
              fontSize: 11,
              fontStyle: "italic",
            }}
          >
            loading headlines...
          </span>
        ) : (
          <div
            className="slop-headlines-track"
            style={{
              display: "flex",
              alignItems: "center",
              paddingLeft: 150,
              willChange: "transform",
            }}
          >
            {/* Two halves (-a / -b) keyed by url, not index, so a
                refresh reuses DOM nodes instead of remounting them
                and the CSS marquee keeps its scroll position. */}
            {items.map(h => (
              <Item key={`${h.url}-a`} headline={h} onOpenUrl={onOpenUrl} />
            ))}
            {items.map(h => (
              <Item key={`${h.url}-b`} headline={h} onOpenUrl={onOpenUrl} />
            ))}
          </div>
        )}
      </div>
      <style jsx global>{`
        .slop-headlines-track {
          animation: slop-headlines-scroll ${SCROLL_DURATION_S}s linear infinite;
          /* Re-enable pointer events on the scroll track so children
             can fire hover/click (the outer bar is pointer-events:none
             so drags pass through, but headline links need to work). */
          pointer-events: auto;
        }
        /* Pause the marquee whenever the cursor is over a headline so
           the user has a stationary target to click. The pause is on
           the parent track because the keyframes live there. */
        .slop-headlines-track:hover {
          animation-play-state: paused;
        }
        .slop-headline-item:hover .slop-headline-title {
          color: var(--slop-cyan);
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .slop-headlines-refresh-glyph {
          animation:
            slop-headlines-spin 0.8s linear infinite,
            slop-headlines-flash 0.8s ease-in-out infinite;
        }
        @keyframes slop-headlines-scroll {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-50%);
          }
        }
        @keyframes slop-headlines-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes slop-headlines-flash {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.3;
          }
        }
      `}</style>
    </>
  );
};

export default HeadlinesBar;

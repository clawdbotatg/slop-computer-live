"use client";

import { useMemo } from "react";
import type { Headline, PeerMeshState } from "~~/hooks/usePeerMesh";

// Headlines marquee — sits directly above the price ticker. Crypto +
// AI news interleaved, scrolling left a touch faster than the prices
// so the two bars don't feel locked together but the text still has
// time to read. Data comes from `mesh.headlinesState` which the relay
// refreshes every 5 min.
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
};

function badgeColor(kind: Headline["kind"]): string {
  return kind === "crypto" ? "var(--slop-cyan)" : "var(--slop-magenta)";
}

function badgeLabel(kind: Headline["kind"]): string {
  return kind === "crypto" ? "CRYPTO" : "AI";
}

function Item({ headline }: { headline: Headline }) {
  return (
    <a
      href={headline.url}
      target="_blank"
      rel="noopener noreferrer"
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

export const HeadlinesBar = ({ mesh }: HeadlinesBarProps) => {
  const items = mesh.headlinesState?.items ?? [];

  // Duplicate the track so a -50% translate gives a seamless loop.
  const track = useMemo(() => items.concat(items), [items]);

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
            "HEADLINES" label so this band's purpose is obvious. */}
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
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
          }}
        >
          HEADLINES
        </span>

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
            {track.map((h, i) => (
              <Item key={`${h.url}-${i}`} headline={h} />
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
        @keyframes slop-headlines-scroll {
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

export default HeadlinesBar;

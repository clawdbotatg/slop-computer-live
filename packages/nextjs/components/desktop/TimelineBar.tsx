"use client";

import { useMemo } from "react";
import type { PeerMeshState, TimelineItem } from "~~/hooks/usePeerMesh";

// Twitter timeline marquee — top of the three-bar stack. Reads the
// host's home timeline (polled on the relay every 5 min, ranked by
// engagement), and scrolls noticeably faster than headlines + ticker
// so the visual hierarchy is "fastest at the top, slowest at the
// bottom". Same duplicated-track + CSS translate pattern as the other
// two bars.

export const TIMELINE_HEIGHT = 24;

// The marquee animates `transform: translateX(-50%)`, so the visual
// pixels-per-second depends on the track width — which depends on
// item count. We scale duration with count so a 50-tweet bar doesn't
// scroll at 2× the pace of a 25-tweet bar.
//
// Tuned by feel: each tweet needs ~8s on screen to be readable as it
// crosses the viewport.
//   50 items × 8s/item = 400s ≈ 6.7 min loop
//   25 items × 8s/item = 200s ≈ 3.3 min loop
const SECONDS_PER_ITEM = 8;
const MIN_DURATION_S = 120;
const MAX_DURATION_S = 720;

const MAX_TEXT_LEN = 140;

export type TimelineBarProps = {
  mesh: PeerMeshState;
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  // Snap to a word boundary if one's close, otherwise hard-cut.
  const cut = s.slice(0, n);
  const lastSpace = cut.lastIndexOf(" ");
  const safe = lastSpace > n - 20 ? cut.slice(0, lastSpace) : cut;
  return `${safe}…`;
}

// Format engagement compactly: 12.3K, 1.2M etc.
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function Item({ tweet }: { tweet: TimelineItem }) {
  return (
    <a
      href={tweet.url}
      target="_blank"
      rel="noopener noreferrer"
      className="slop-timeline-item"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "0 18px",
        whiteSpace: "nowrap",
        textDecoration: "none",
        // Outer bar is pointer-events: none — re-enable on the link.
        pointerEvents: "auto",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          color: "var(--slop-magenta)",
          fontFamily: "var(--slop-font-display)",
          fontSize: 11,
          letterSpacing: "0.04em",
        }}
      >
        @{tweet.authorUsername}
      </span>
      <span
        className="slop-timeline-text"
        style={{
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          fontSize: 12,
        }}
      >
        {truncate(tweet.text.replace(/\s+/g, " "), MAX_TEXT_LEN)}
      </span>
      <span
        style={{
          color: "var(--slop-text-muted)",
          fontFamily: "var(--slop-font-mono)",
          fontSize: 10,
        }}
      >
        ♥ {compact(tweet.likes)} · ⇄ {compact(tweet.retweets)}
      </span>
      <span style={{ color: "rgba(63,207,255,0.35)", fontSize: 10, marginLeft: 4 }}>•</span>
    </a>
  );
}

export const TimelineBar = ({ mesh }: TimelineBarProps) => {
  const items = mesh.timelineState?.items ?? [];

  const track = useMemo(() => items.concat(items), [items]);
  // Per-item duration × count = total loop time, so the visual speed
  // stays roughly constant whether we surface 25 tweets or 100.
  const durationS = Math.min(MAX_DURATION_S, Math.max(MIN_DURATION_S, items.length * SECONDS_PER_ITEM));

  return (
    <>
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          // Sits on top of the headlines bar (24px) which sits on top
          // of the ticker bar (28px). 24 + 28 = 52.
          bottom: 52,
          height: TIMELINE_HEIGHT,
          background: "linear-gradient(180deg, rgba(6,8,24,0.96) 0%, rgba(10,15,36,0.96) 100%)",
          borderTop: "1px solid rgba(63,207,255,0.22)",
          borderBottom: "1px solid rgba(63,207,255,0.10)",
          zIndex: 60,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            padding: "0 24px 0 14px",
            // Dark grey → transparent gradient, matching X's dark
            // brand-mark vibe. The bar's own backdrop is already
            // near-black, so the badge grey has to be noticeably
            // lighter than the bar to be visible at all. (Earlier
            // value rgba(20,20,22) was indistinguishable from the
            // bar — bumped to rgba(60,60,66) for clear contrast.)
            background:
              "linear-gradient(90deg, rgba(60,60,66,0.98) 0%, rgba(60,60,66,0.75) 60%, rgba(60,60,66,0.0) 100%)",
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
          TIMELINE
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
            loading timeline...
          </span>
        ) : (
          <div
            className="slop-timeline-track"
            style={{
              display: "flex",
              alignItems: "center",
              paddingLeft: 150,
              willChange: "transform",
            }}
          >
            {track.map((tw, i) => (
              <Item key={`${tw.id}-${i}`} tweet={tw} />
            ))}
          </div>
        )}
      </div>
      <style jsx global>{`
        .slop-timeline-track {
          animation: slop-timeline-scroll ${durationS}s linear infinite;
          pointer-events: auto;
        }
        .slop-timeline-track:hover {
          animation-play-state: paused;
        }
        .slop-timeline-item:hover .slop-timeline-text {
          color: var(--slop-magenta);
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        @keyframes slop-timeline-scroll {
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

export default TimelineBar;

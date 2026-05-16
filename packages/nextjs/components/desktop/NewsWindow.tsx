"use client";

import type { NewsDigestItem, PeerMeshState } from "~~/hooks/usePeerMesh";

// "News" app — the curated front page. Two sections:
//   1. ⭐ FEATURED — 3-5 items the relay's AI pass picked as the most
//      important right now, each with a one-line "why this matters"
//      explanation underneath.
//   2. THE FEED  — 15 items interleaved crypto-headline → AI-headline
//      → tweet, repeating. Same items the AI picked from; featured
//      rows get a subtle highlight so they're easy to spot in context.
//
// All data comes from `mesh.newsDigestState` — the relay builds the
// list AND runs the AI pass server-side, so every peer renders the
// exact same curated digest with no per-client cost or duplication.

export type NewsWindowProps = {
  mesh: PeerMeshState;
};

function timeAgo(ts: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function kindColor(kind: NewsDigestItem["kind"]): string {
  switch (kind) {
    case "crypto-headline":
      return "var(--slop-cyan)";
    case "ai-headline":
      return "var(--slop-magenta)";
    case "tweet":
      return "var(--slop-lime)";
    case "polymarket":
      return "var(--slop-amber)";
  }
}

function kindLabel(kind: NewsDigestItem["kind"]): string {
  switch (kind) {
    case "crypto-headline":
      return "CRYPTO";
    case "ai-headline":
      return "AI";
    case "tweet":
      return "TWEET";
    case "polymarket":
      return "MARKET";
  }
}

function compactUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

function KindBadge({ kind }: { kind: NewsDigestItem["kind"] }) {
  return (
    <span
      style={{
        color: kindColor(kind),
        fontFamily: "var(--slop-font-display)",
        fontSize: 9,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        padding: "2px 6px",
        border: `1px solid ${kindColor(kind)}`,
        borderRadius: 3,
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      {kindLabel(kind)}
    </span>
  );
}

// Featured row — big, with the AI's reason underneath.
function FeaturedRow({ item, rank }: { item: NewsDigestItem; rank: number }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="slop-news-row slop-news-featured"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "14px 16px",
        textDecoration: "none",
        color: "inherit",
        // Subtle gold glow to mark a featured pick.
        background: "linear-gradient(180deg, rgba(255,174,0,0.06) 0%, rgba(255,174,0,0.02) 100%)",
        border: "1px solid rgba(255,174,0,0.30)",
        borderRadius: 6,
        margin: "8px 12px",
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span
          style={{
            color: "var(--slop-amber)",
            fontFamily: "var(--slop-font-display)",
            fontSize: 11,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          }}
        >
          ⭐ #{rank}
        </span>
        <KindBadge kind={item.kind} />
        <span
          style={{
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-mono)",
            fontSize: 11,
            marginLeft: "auto",
          }}
        >
          {item.source}
          {item.publishedAt ? ` · ${timeAgo(item.publishedAt)}` : ""}
        </span>
      </div>
      <span
        className="slop-news-row-title"
        style={{
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          fontSize: 15,
          lineHeight: 1.35,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {item.title}
      </span>
      {item.kind === "tweet" ? (
        <span
          style={{
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-mono)",
            fontSize: 11,
          }}
        >
          ♥ {compact(item.likes ?? 0)} · ⇄ {compact(item.retweets ?? 0)} · 💬 {compact(item.replies ?? 0)}
        </span>
      ) : null}
      {item.kind === "polymarket" ? (
        <span
          style={{
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-mono)",
            fontSize: 11,
          }}
        >
          {compactUsd(item.pmVolume24h ?? 0)}/24h
          {typeof item.pmTopOutcomeProb === "number"
            ? ` · ${Math.round(item.pmTopOutcomeProb * 100)}% ${item.pmTopOutcomeLabel ?? ""}`
            : ""}
        </span>
      ) : null}
      {item.featuredReason ? (
        <span
          style={{
            color: "var(--slop-amber)",
            fontFamily: "var(--slop-font-body)",
            fontSize: 12,
            lineHeight: 1.4,
            fontStyle: "italic",
            paddingLeft: 12,
            borderLeft: "2px solid rgba(255,174,0,0.4)",
          }}
        >
          “{item.featuredReason}”
        </span>
      ) : null}
    </a>
  );
}

// Compact feed row — used for non-featured items. Featured items in
// the feed get a subtle gold tint so they're recognizable here too.
function FeedRow({ item }: { item: NewsDigestItem }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="slop-news-row"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 14px",
        borderBottom: "1px solid rgba(255,62,201,0.10)",
        textDecoration: "none",
        color: "inherit",
        // Featured items still in the lower feed get a hint of gold.
        background: item.featured ? "rgba(255,174,0,0.04)" : undefined,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <KindBadge kind={item.kind} />
        {item.featured ? (
          <span
            style={{
              color: "var(--slop-amber)",
              fontFamily: "var(--slop-font-display)",
              fontSize: 9,
              letterSpacing: "0.14em",
            }}
            title="picked as featured"
          >
            ⭐
          </span>
        ) : null}
        <span
          style={{
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-mono)",
            fontSize: 11,
            marginLeft: "auto",
          }}
        >
          {item.source}
          {item.publishedAt ? ` · ${timeAgo(item.publishedAt)}` : ""}
        </span>
      </div>
      <span
        className="slop-news-row-title"
        style={{
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          fontSize: 13,
          lineHeight: 1.4,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {item.title}
      </span>
      {item.kind === "tweet" ? (
        <span
          style={{
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-mono)",
            fontSize: 10,
          }}
        >
          ♥ {compact(item.likes ?? 0)} · ⇄ {compact(item.retweets ?? 0)}
        </span>
      ) : null}
      {item.kind === "polymarket" ? (
        <span
          style={{
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-mono)",
            fontSize: 10,
          }}
        >
          {compactUsd(item.pmVolume24h ?? 0)}/24h
          {typeof item.pmTopOutcomeProb === "number"
            ? ` · ${Math.round(item.pmTopOutcomeProb * 100)}% ${item.pmTopOutcomeLabel ?? ""}`
            : ""}
        </span>
      ) : null}
    </a>
  );
}

function SectionHeader({ label, count, sub }: { label: string; count?: number; sub?: string }) {
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 1,
        padding: "10px 14px",
        background: "linear-gradient(180deg, rgba(10,15,36,0.98), rgba(6,8,24,0.95))",
        borderBottom: "1px solid rgba(255,62,201,0.25)",
        display: "flex",
        alignItems: "baseline",
        gap: 10,
      }}
    >
      <span
        style={{
          color: "var(--slop-magenta)",
          fontFamily: "var(--slop-font-display)",
          fontSize: 12,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {typeof count === "number" ? (
        <span
          style={{
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-mono)",
            fontSize: 11,
          }}
        >
          {count} item{count === 1 ? "" : "s"}
        </span>
      ) : null}
      {sub ? (
        <span
          style={{
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-mono)",
            fontSize: 11,
            marginLeft: "auto",
          }}
        >
          {sub}
        </span>
      ) : null}
    </div>
  );
}

export const NewsWindow = ({ mesh }: NewsWindowProps) => {
  const digest = mesh.newsDigestState;
  const featured = digest?.featured ?? [];
  const feed = digest?.feed ?? [];

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--slop-bg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        <SectionHeader
          label="⭐ FEATURED"
          count={featured.length}
          sub={digest?.aiRanAt ? `AI ranked ${timeAgo(digest.aiRanAt)}` : "AI ranking…"}
        />
        {featured.length === 0 ? (
          <div
            style={{
              padding: "20px 14px",
              color: "var(--slop-text-muted)",
              fontFamily: "var(--slop-font-mono)",
              fontSize: 12,
              fontStyle: "italic",
            }}
          >
            {digest ? "AI hasn't picked featured items yet…" : "loading digest…"}
          </div>
        ) : (
          featured.map((item, i) => <FeaturedRow key={item.url} item={item} rank={i + 1} />)
        )}

        <SectionHeader label="THE FEED" count={feed.length} sub="crypto · ai · tweets" />
        {feed.length === 0 ? (
          <div
            style={{
              padding: "20px 14px",
              color: "var(--slop-text-muted)",
              fontFamily: "var(--slop-font-mono)",
              fontSize: 12,
              fontStyle: "italic",
            }}
          >
            building feed…
          </div>
        ) : (
          feed.map(item => <FeedRow key={item.url} item={item} />)
        )}

        <div
          style={{
            padding: "16px 14px 24px",
            textAlign: "center",
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-mono)",
            fontSize: 10,
            fontStyle: "italic",
          }}
        >
          digest refreshes when headlines / tweets update · AI picks every ~10 min
        </div>
      </div>
      <style jsx global>{`
        .slop-news-row:hover {
          background: rgba(255, 62, 201, 0.06) !important;
        }
        .slop-news-featured:hover {
          background: linear-gradient(180deg, rgba(255, 174, 0, 0.12) 0%, rgba(255, 174, 0, 0.04) 100%) !important;
        }
        .slop-news-row:hover .slop-news-row-title {
          color: var(--slop-magenta);
        }
        .slop-news-featured:hover .slop-news-row-title {
          color: var(--slop-amber);
        }
      `}</style>
    </div>
  );
};

export default NewsWindow;

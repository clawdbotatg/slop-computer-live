// News digest. Server-side curation of the "front page" the News app
// shows: an interleaved feed (crypto headline → AI headline → tweet →
// repeat) plus a small AI-ranked "featured" set picked from that feed.
//
// Architecture: this module *consumes* the existing headlines + timeline
// state (no new upstream polling). It rebuilds whenever either source
// updates AND every AI_REFRESH_MIN_MS ticks (so the AI re-ranks even on
// a quiet hour). The Claude pass is debounced to that same interval to
// keep token cost bounded — one shared call across the whole mesh.

import { subscribe as subscribeHeadlines, getState as getHeadlinesState } from "./headlines.js";
import { subscribe as subscribeTimeline, getState as getTimelineState } from "./timeline.js";
import { subscribe as subscribePolymarket, getState as getPolymarketState } from "./polymarket.js";

const AI_REFRESH_MIN_MS = 10 * 60_000;
// 4 source types × 4 rounds = 16 slots. Bumped from 15/3 to fit the
// new Polymarket source into the interleave pattern without
// shortchanging any single source.
const FEED_SIZE = 16;
const NEWS_MODEL = process.env.ANTHROPIC_NEWS_MODEL ?? "claude-haiku-4-5-20251001";

export type NewsDigestItem = {
  kind: "crypto-headline" | "ai-headline" | "tweet" | "polymarket";
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  // tweet-only metadata
  authorUsername?: string;
  authorFollowers?: number;
  likes?: number;
  retweets?: number;
  replies?: number;
  // polymarket-only metadata
  pmVolume24h?: number;
  pmTopOutcomeLabel?: string;
  pmTopOutcomeProb?: number;
  pmTags?: string[];
  // AI-pass-only metadata
  featured?: boolean;
  featuredReason?: string;
};

export type NewsDigestState = {
  feed: NewsDigestItem[];
  /** Subset of `feed` items that the AI pass marked as must-read.
   *  Same objects (so `featured.length` is small but identity-equal). */
  featured: NewsDigestItem[];
  updatedAt: number;
  /** ms-epoch of the last successful AI ranking pass. 0 if never run. */
  aiRanAt: number;
};

let state: NewsDigestState | null = null;
let lastAIRun = 0;

type Subscriber = (state: NewsDigestState) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getState(): NewsDigestState | null {
  return state;
}

// Round-robin interleave: [crypto, ai, tweet, polymarket] × 4 = 16.
// If any one source is shorter than the others, we skip that slot
// rather than padding — the result is naturally a smaller list
// (better than filler).
function buildFeed(): NewsDigestItem[] {
  const h = getHeadlinesState()?.items ?? [];
  const t = getTimelineState()?.items ?? [];
  const pm = getPolymarketState()?.items ?? [];
  const crypto = h.filter(x => x.kind === "crypto");
  const ai = h.filter(x => x.kind === "ai");

  const out: NewsDigestItem[] = [];
  const rounds = Math.ceil(FEED_SIZE / 4);
  for (let i = 0; i < rounds; i += 1) {
    if (crypto[i]) {
      out.push({
        kind: "crypto-headline",
        title: crypto[i]!.title,
        url: crypto[i]!.url,
        source: crypto[i]!.source,
        publishedAt: crypto[i]!.publishedAt,
      });
    }
    if (ai[i]) {
      out.push({
        kind: "ai-headline",
        title: ai[i]!.title,
        url: ai[i]!.url,
        source: ai[i]!.source,
        publishedAt: ai[i]!.publishedAt,
      });
    }
    if (t[i]) {
      out.push({
        kind: "tweet",
        title: t[i]!.text,
        url: t[i]!.url,
        source: `@${t[i]!.authorUsername}`,
        publishedAt: t[i]!.createdAt,
        authorUsername: t[i]!.authorUsername,
        authorFollowers: t[i]!.authorFollowers,
        likes: t[i]!.likes,
        retweets: t[i]!.retweets,
        replies: t[i]!.replies,
      });
    }
    if (pm[i]) {
      out.push({
        kind: "polymarket",
        title: pm[i]!.title,
        url: pm[i]!.url,
        source: "Polymarket",
        // Polymarket events don't have a "published_at" — closest
        // equivalent is `endsAt`, but conceptually 0 here means
        // "evergreen": the importance signal is the volume, not
        // recency.
        publishedAt: 0,
        pmVolume24h: pm[i]!.volume24h,
        pmTopOutcomeLabel: pm[i]!.topOutcome?.label,
        pmTopOutcomeProb: pm[i]!.topOutcome?.prob,
        pmTags: pm[i]!.tags,
      });
    }
  }
  return out.slice(0, FEED_SIZE);
}

type AnthropicBlock = { type: string; text?: string };
type AnthropicResponse = {
  content?: AnthropicBlock[];
  error?: { message?: string };
};

type PickResponse = { picks?: Array<{ index?: number; reason?: string }> };

// Claude pass: given the 15 interleaved items, pick the 3 most
// important ones for an AI+crypto podcast audience and explain WHY for
// each. Output is JSON-only so we can parse deterministically.
async function rankWithAI(items: NewsDigestItem[]): Promise<{ index: number; reason: string }[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  const itemLines = items
    .map((it, i) => {
      const tag =
        it.kind === "crypto-headline"
          ? "CRYPTO"
          : it.kind === "ai-headline"
            ? "AI"
            : it.kind === "tweet"
              ? "TWEET"
              : "POLYMARKET";
      let meta = ` (${it.source})`;
      if (it.kind === "tweet") {
        meta = ` (${it.likes ?? 0}♥ ${it.retweets ?? 0}⇄ from ${it.source})`;
      } else if (it.kind === "polymarket") {
        // Polymarket items get vol + odds context. Volume tells the
        // model how much real money is currently betting on this
        // question — a strong "this matters right now" signal.
        const odds =
          typeof it.pmTopOutcomeProb === "number"
            ? ` — ${Math.round(it.pmTopOutcomeProb * 100)}% ${it.pmTopOutcomeLabel ?? ""}`
            : "";
        meta = ` ($${Math.round((it.pmVolume24h ?? 0) / 1000)}k vol/24h${odds})`;
      }
      return `${i}. [${tag}] ${it.title.slice(0, 220)}${meta}`;
    })
    .join("\n");
  const prompt = `You are curating a news digest for an AI + crypto podcast audience (builders, founders, traders). Below are ${items.length} candidate items — a mix of crypto news headlines, AI news headlines, tweets, and Polymarket prediction markets.

Pick the 3 MOST IMPORTANT items the audience absolutely needs to know about right now.

Prioritize:
- Major breaking news (big funding rounds, regulatory shifts, technical breakthroughs, exploits, M&A)
- Genuinely interesting takes from credible voices
- Polymarket questions with HIGH volume (>$1M/24h) — that's real money signaling the market thinks this question matters right now
- Things that will dominate conversations in the next 24h

Avoid:
- Generic recycled news with no fresh angle
- Politics unless directly tied to crypto/AI/macro
- Marketing fluff or product launches without substance
- Low-volume Polymarket questions ($<500k/24h) — noise, not signal

Candidates:
${itemLines}

Respond with JSON only — no preamble, no markdown fences:
{"picks":[{"index":<int 0-${items.length - 1}>,"reason":"<1 sentence: why this matters NOW>"},...]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: NEWS_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as AnthropicResponse;
  const text = (data.content ?? [])
    .filter(c => c.type === "text" && typeof c.text === "string")
    .map(c => c.text!)
    .join("\n")
    .trim();
  // Tolerate a code-fenced response in case the model ignored the
  // "no markdown" instruction.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]) as PickResponse;
    if (!Array.isArray(parsed.picks)) return [];
    return parsed.picks
      .filter((p): p is { index: number; reason: string } => typeof p.index === "number" && typeof p.reason === "string")
      .filter(p => p.index >= 0 && p.index < items.length)
      .slice(0, 5);
  } catch {
    return [];
  }
}

let rebuilding = false;
async function rebuild(force = false): Promise<void> {
  // Coalesce concurrent triggers — headlines + timeline can both fire
  // in the same tick when the relay first boots.
  if (rebuilding) return;
  rebuilding = true;
  try {
    const items = buildFeed();
    if (items.length === 0) return;

    const now = Date.now();
    const shouldRunAI = force || now - lastAIRun > AI_REFRESH_MIN_MS;

    let picks: { index: number; reason: string }[] = [];
    if (shouldRunAI) {
      try {
        picks = await rankWithAI(items);
        if (picks.length > 0) lastAIRun = now;
      } catch (err) {
        console.warn("[news-digest] AI rank failed", err);
      }
    } else if (state) {
      // Between AI runs, preserve the previous featured set by
      // matching URLs — so an item that's still in the new feed
      // keeps its "featured" badge until the next AI pass.
      const prevByUrl = new Map(state.featured.map(f => [f.url, f.featuredReason]));
      picks = items.flatMap((it, i) => {
        const reason = prevByUrl.get(it.url);
        return reason ? [{ index: i, reason }] : [];
      });
    }

    for (const p of picks) {
      const it = items[p.index];
      if (!it) continue;
      it.featured = true;
      it.featuredReason = p.reason;
    }

    const featured = items.filter(i => i.featured);
    state = { feed: items, featured, updatedAt: now, aiRanAt: lastAIRun };
    for (const fn of subscribers) {
      try {
        fn(state);
      } catch {
        /* one bad sub shouldn't kill the rest */
      }
    }
  } finally {
    rebuilding = false;
  }
}

let started = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function start(): void {
  if (started) return;
  started = true;
  // Rebuild when either upstream feed updates — no AI call here, the
  // debounce in rebuild() decides whether to actually run Claude.
  subscribeHeadlines(() => void rebuild());
  subscribeTimeline(() => void rebuild());
  subscribePolymarket(() => void rebuild());
  // Periodic forced rebuild so the AI re-ranks at least every
  // AI_REFRESH_MIN_MS even when upstream is quiet.
  refreshTimer = setInterval(() => void rebuild(true), AI_REFRESH_MIN_MS);
  // First build runs immediately so the bar/window has data ASAP.
  void rebuild(true);
}

export function stop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  started = false;
}

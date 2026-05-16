// Polymarket pull. Active events ranked by 24h trading volume — a
// stronger "importance" signal than headline counts because each dollar
// of volume represents someone willing to bet real money on the
// question's resolution. If 5M USD changed hands on "When will Bitcoin
// hit $150k?" in the last 24 hours, that question is *actually*
// dominating crypto conversation right now.
//
// Filters to a hand-picked tag allowlist (crypto, economy, geopolitics,
// AI when present) so we don't surface Eurovision or NBA odd/even
// markets in a crypto+AI podcast digest.

const POLL_INTERVAL_MS = 5 * 60_000;
const ERROR_RETRY_MS = 60_000;
// How many events to pull from upstream before tag-filtering; the top
// of Polymarket by volume is heavy on sports/entertainment so we need
// to scan deeper than the final output count.
const FETCH_LIMIT = 50;
const MAX_OUT = 12;

// Tags we care about for a crypto + AI + macro podcast audience.
// Polymarket tags every event with multiple labels — we keep anything
// matching ANY of these (OR-match, not AND).
const RELEVANT_TAGS = new Set([
  "Crypto",
  "Crypto Prices",
  "Bitcoin",
  "Ethereum",
  "Solana",
  "Stablecoins",
  "DeFi",
  "AI",
  "AI Models",
  "Tech",
  "Technology",
  "Economy",
  "Economic Policy",
  "Fed Rates",
  "Fed",
  "fomc",
  "Geopolitics",
  "World",
  "Tweet Markets",
  "Trump-Xi Summit",
]);

export type PolymarketItem = {
  /** Polymarket event slug — stable identifier. */
  id: string;
  title: string;
  url: string;
  /** 24h USD trading volume — the importance signal. */
  volume24h: number;
  /** Total liquidity sitting in the orderbook. */
  liquidity: number;
  /** Cents-of-a-dollar odds on the headline outcome (0..1) — null when
   *  the event has multiple binary sub-markets and there's no single
   *  "main" outcome. The Window renders this as eg "73% YES". */
  topOutcome: { label: string; prob: number } | null;
  /** Tag labels that matched the allowlist. Sent through so the UI can
   *  display a "tags" line if it wants. */
  tags: string[];
  /** Event resolution / end date in ms-epoch, or 0 if open-ended. */
  endsAt: number;
};

export type PolymarketState = {
  items: PolymarketItem[];
  updatedAt: number;
};

let state: PolymarketState | null = null;

type Subscriber = (state: PolymarketState) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getState(): PolymarketState | null {
  return state;
}

type GammaTag = { label?: string };
type GammaMarket = {
  question?: string;
  outcomes?: string;
  outcomePrices?: string;
};
type GammaEvent = {
  id?: string | number;
  slug?: string;
  title?: string;
  volume24hr?: number;
  liquidity?: number;
  endDate?: string;
  tags?: GammaTag[];
  markets?: GammaMarket[];
};

// Polymarket's `outcomes` / `outcomePrices` fields are *strings* of
// JSON arrays (yes, really). Parse defensively.
function parseStringArray(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// Pick the most-likely outcome to display. For two-outcome markets
// (YES/NO style) we show whichever has the higher probability. For
// multi-outcome events we just take the top one. Returns null when the
// event has multiple sub-markets (no single "headline outcome").
function pickTopOutcome(event: GammaEvent): PolymarketItem["topOutcome"] {
  const markets = event.markets ?? [];
  if (markets.length !== 1) return null;
  const m = markets[0]!;
  const outcomes = parseStringArray(m.outcomes);
  const prices = parseStringArray(m.outcomePrices).map(p => Number(p));
  if (outcomes.length === 0 || outcomes.length !== prices.length) return null;
  let bestIdx = 0;
  for (let i = 1; i < prices.length; i += 1) {
    if ((prices[i] ?? 0) > (prices[bestIdx] ?? 0)) bestIdx = i;
  }
  const label = outcomes[bestIdx] ?? "";
  const prob = prices[bestIdx] ?? 0;
  if (!Number.isFinite(prob)) return null;
  return { label, prob };
}

async function pollOnce(): Promise<void> {
  const url =
    `https://gamma-api.polymarket.com/events` +
    `?limit=${FETCH_LIMIT}&active=true&closed=false&order=volume24hr&ascending=false`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`polymarket ${res.status}`);
  const events = (await res.json()) as GammaEvent[];

  const items: PolymarketItem[] = [];
  for (const e of events) {
    const tags = (e.tags ?? []).map(t => t.label ?? "").filter(Boolean);
    const matched = tags.filter(t => RELEVANT_TAGS.has(t));
    if (matched.length === 0) continue;
    if (!e.slug || !e.title) continue;
    items.push({
      id: e.slug,
      title: e.title,
      url: `https://polymarket.com/event/${e.slug}`,
      volume24h: e.volume24hr ?? 0,
      liquidity: e.liquidity ?? 0,
      topOutcome: pickTopOutcome(e),
      tags: matched,
      endsAt: e.endDate ? new Date(e.endDate).getTime() || 0 : 0,
    });
    if (items.length >= MAX_OUT) break;
  }

  if (items.length === 0 && !state) return;
  state = { items, updatedAt: Date.now() };
  for (const fn of subscribers) {
    try {
      fn(state);
    } catch {
      /* one bad sub shouldn't kill the rest */
    }
  }
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export function start(): void {
  if (started) return;
  started = true;

  const loop = async () => {
    try {
      await pollOnce();
      pollTimer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
    } catch (err) {
      console.warn("[polymarket] poll failed", err);
      pollTimer = setTimeout(() => void loop(), ERROR_RETRY_MS);
    }
  };

  void loop();
}

export function stop(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  started = false;
}

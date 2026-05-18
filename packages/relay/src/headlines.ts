// Headlines feed. Polled on the relay, broadcast to all peers — same
// pattern as ticker/gas. Two sources, both free + no-key:
//   - Crypto: CoinDesk RSS (the canonical crypto-news feed; HN
//     Algolia's crypto query returns mostly low-engagement noise)
//   - AI: HN Algolia search filtered by AI keywords (HN's frontpage is
//     opinionated about AI so we get the genuinely-discussed stories)
//
// Poll cadence is slow (1h); headline lists don't churn fast and we'd
// rather be polite to the upstream free APIs than chase fresh-by-5min.

const POLL_INTERVAL_MS = 60 * 60_000;
const ERROR_RETRY_MS = 60_000;

// Per-source caps. The bar shows a marquee of all of these so the
// total budget is "what comfortably fits in ~60s of scroll" not "how
// much news exists upstream".
const CRYPTO_LIMIT = 12;
const AI_LIMIT = 12;

export type Headline = {
  title: string;
  url: string;
  source: string;
  /** ms-epoch when the article was published, for ordering / freshness. */
  publishedAt: number;
  kind: "crypto" | "ai";
};

export type HeadlinesState = {
  items: Headline[];
  updatedAt: number;
};

let state: HeadlinesState | null = null;

type Subscriber = (state: HeadlinesState) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getState(): HeadlinesState | null {
  return state;
}

type AlgoliaHit = {
  title?: string;
  url?: string;
  story_url?: string;
  objectID?: string;
  created_at_i?: number;
  points?: number;
};

// One HN Algolia call. `tags=story` filters out comments/polls.
// `numericFilters=points>20` skips low-engagement noise. Recency wins
// over raw points (Algolia's default ranking surfaces viral old posts).
async function fetchHN(query: string, limit: number, kind: Headline["kind"]): Promise<Headline[]> {
  const url =
    `https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(query)}` +
    `&hitsPerPage=${limit * 2}&numericFilters=points>20`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`hn-algolia ${res.status}`);
  const data = (await res.json()) as { hits?: AlgoliaHit[] };
  const rows = (data.hits ?? []).filter(r => r.title);
  rows.sort((a, b) => (b.created_at_i ?? 0) - (a.created_at_i ?? 0));
  return rows.slice(0, limit).map(r => ({
    title: r.title!,
    // Ask HN / self-posts have no external url; fall back to the
    // discussion page so the link still resolves.
    url: r.url || r.story_url || `https://news.ycombinator.com/item?id=${r.objectID}`,
    source: "Hacker News",
    publishedAt: (r.created_at_i ?? 0) * 1000,
    kind,
  }));
}

// Minimal RSS 2.0 item extractor. CoinDesk's feed is well-formed and
// stable; a real XML parser is overkill for the three fields we need.
// Returns one Headline per <item>.
function parseRssItems(xml: string): Headline[] {
  const out: Headline[] = [];
  // Each <item> stands alone — non-greedy match between item tags.
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const body = m[1] ?? "";
    const title = matchInner(body, "title");
    const link = matchInner(body, "link");
    const pub = matchInner(body, "pubDate");
    if (!title || !link) continue;
    out.push({
      title: decodeEntities(title),
      url: link.trim(),
      source: "CoinDesk",
      publishedAt: pub ? new Date(pub).getTime() || 0 : 0,
      kind: "crypto",
    });
  }
  return out;
}

function matchInner(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(xml);
  if (!m) return null;
  const raw = m[1] ?? "";
  // Strip surrounding CDATA wrapper if present.
  const stripped = raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return stripped.trim();
}

function decodeEntities(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");
}

async function fetchCrypto(): Promise<Headline[]> {
  // CoinDesk's CDN blocks default fetch UA; pass a browser UA to dodge
  // that. `redirect: follow` is on by default but CoinDesk returns 301
  // to an arc CDN, so we need redirects enabled (Node's fetch is, but
  // making it explicit here for the next reader).
  const res = await fetch("https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; slop-relay/1.0)", accept: "application/rss+xml" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`coindesk ${res.status}`);
  const xml = await res.text();
  const items = parseRssItems(xml);
  // Sort newest first; cap at CRYPTO_LIMIT.
  items.sort((a, b) => b.publishedAt - a.publishedAt);
  return items.slice(0, CRYPTO_LIMIT);
}

function fetchAI(): Promise<Headline[]> {
  return fetchHN("(AI OR LLM OR GPT OR Claude OR Anthropic OR OpenAI)", AI_LIMIT, "ai");
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

// Interleave the two feeds so a CRYPTO and an AI item alternate while
// scrolling. With unequal lengths the longer one's tail just runs out
// at the end — no padding, no duplicates.
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (i < a.length) out.push(a[i]!);
    if (i < b.length) out.push(b[i]!);
  }
  return out;
}

async function pollOnce(): Promise<void> {
  const [cryptoResult, aiResult] = await Promise.allSettled([fetchCrypto(), fetchAI()]);
  const crypto = cryptoResult.status === "fulfilled" ? cryptoResult.value : [];
  const ai = aiResult.status === "fulfilled" ? aiResult.value : [];
  if (cryptoResult.status === "rejected") console.warn("[headlines] crypto fetch failed", cryptoResult.reason);
  if (aiResult.status === "rejected") console.warn("[headlines] ai fetch failed", aiResult.reason);

  if (crypto.length === 0 && ai.length === 0 && !state) return;

  // De-dupe across the two lists by URL. The crypto query "wins" for
  // crossover stories (eg. "Anthropic acquires bitcoin miner") because
  // it goes first into the seen set — AI gets the AI-flavored leftover.
  const seen = new Set<string>();
  const interleaved = interleave(crypto, ai).filter(h => {
    if (seen.has(h.url)) return false;
    seen.add(h.url);
    return true;
  });
  state = { items: interleaved, updatedAt: Date.now() };

  for (const fn of subscribers) {
    try {
      fn(state);
    } catch {
      /* one bad sub shouldn't kill the rest */
    }
  }
}

export function start(): void {
  if (started) return;
  started = true;

  const loop = async () => {
    try {
      await pollOnce();
      pollTimer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
    } catch (err) {
      console.warn("[headlines] poll failed", err);
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

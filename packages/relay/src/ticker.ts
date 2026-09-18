// Slop ticker. Polls a small set of AI + crypto markets and broadcasts
// the result to every connected peer (same pattern as gas.ts). All
// upstream API calls happen here, on the server, so:
//   - no per-client rate-limit fights
//   - no CORS pain (Yahoo blocks browser fetches; the relay can hit it)
//   - one cache shared across the whole mesh
//
// Sources (all live, nothing hard-coded — see docs/TICKER.md):
//   - CoinGecko `/simple/price` for crypto (free, no key)
//   - Yahoo Finance `/v7/finance/quote` for stocks, one batch call behind
//     a cookie+crumb handshake. Replaced Stooq on 2026-09-18: Stooq's free
//     CSV endpoint had been answering 404 (a JS challenge page) since at
//     least 09-01, so the bar had silently shown zero stocks for weeks.
//   - DexScreener for $CLAWD (deepest Base pool)
//   - TRENDING: $cashtags mined from the Twitter home-timeline archive by
//     ops/ticker/trending-cashtags.mjs and pushed via POST
//     /v1/ticker/trending. Each symbol is resolved to a price source here
//     (CoinGecko top-500 → crypto, else a Yahoo quote → stock) and shown
//     with a 🔥. A pushed list expires after TRENDING_TTL_MS so a symbol
//     nobody talks about falls off on its own.
//
// There used to be a block of hand-typed "last funding round" valuations
// for private AI labs. Written once on 2026-05-16, never refreshed, every
// mark 7-17 months stale by September. Removed 2026-09-18: if an asset
// has no daily price source, it doesn't belong in this bar.
//
// Poll cadence is conservative (60s) — the ticker bar isn't a trading
// terminal and free APIs get cranky if you hammer them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const POLL_INTERVAL_MS = 60_000;
const ERROR_RETRY_MS = 30_000;

export type TickerItem = {
  /** Display symbol, eg. "ETH", "NVDA", "$CLAWD". */
  symbol: string;
  /** Short label shown alongside the symbol. */
  label: string;
  /** USD price. */
  price: number;
  /** 24h % change (positive = up). May be 0 when upstream omits it. */
  changePct: number;
  /** Display category — drives icon/color hints on the client.
   *  ("private" is retired on the relay side; the client still knows
   *  how to render it so old snapshots don't break.) */
  kind: "crypto" | "stock" | "private" | "meme";
  /** Click-through URL. Crypto → CoinGecko page, stocks → Yahoo
   *  Finance, CLAWD → its DexScreener page. */
  url?: string;
  /** Present when the symbol is on the bar because people are tweeting
   *  about it (see TRENDING above). `authors` = distinct accounts that
   *  used the cashtag in the mining window. */
  trending?: { authors: number; tweets: number };
};

export type TickerState = {
  items: TickerItem[];
  /** ms-epoch when this snapshot was captured. */
  updatedAt: number;
};

let state: TickerState | null = null;

type Subscriber = (state: TickerState) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getState(): TickerState | null {
  return state;
}

// CoinGecko IDs → display symbol/label. The always-on crypto set. Kept
// inline because the set is small and editing JSON for one-line
// additions isn't worth it.
const CRYPTO: Array<{ id: string; symbol: string; label: string }> = [
  { id: "ethereum", symbol: "ETH", label: "Ethereum" },
  { id: "bitcoin", symbol: "BTC", label: "Bitcoin" },
  { id: "solana", symbol: "SOL", label: "Solana" },
  { id: "chainlink", symbol: "LINK", label: "Chainlink" },
  { id: "dogecoin", symbol: "DOGE", label: "Dogecoin" },
  { id: "render-token", symbol: "RNDR", label: "Render" },
  { id: "bittensor", symbol: "TAO", label: "Bittensor" },
  { id: "fetch-ai", symbol: "FET", label: "Fetch.ai" },
];

// Always-on stocks (Yahoo symbols).
//
// Grouping (for the reader, not enforced anywhere):
//   - hyperscalers / AI labs: MSFT, GOOGL, META, AAPL, ORCL
//   - AI chips:               NVDA, AMD, AVGO, TSM, ASML
//   - AI memory/storage:      MU (HBM/DRAM proxy), SNDK (NAND/SSD)
//   - AI servers/networking:  SMCI, ANET
//   - AI cloud / pure plays:  PLTR, CRWV
//   - Data-center power+cool: VRT, CEG
//   - Adjacent EVs/oddballs:  TSLA
//
// There's no good free API for spot DRAM / NAND / HBM prices, so MU
// and SNDK stand in as proxies — they track the underlying commodity
// closely enough that "RAM is ripping" reads as "MU is ripping".
const STOCKS: Array<{ symbol: string; label: string }> = [
  { symbol: "NVDA", label: "NVIDIA" },
  { symbol: "MSFT", label: "Microsoft" },
  { symbol: "GOOGL", label: "Alphabet" },
  { symbol: "META", label: "Meta" },
  { symbol: "AMD", label: "AMD" },
  { symbol: "TSLA", label: "Tesla" },
  { symbol: "AAPL", label: "Apple" },
  { symbol: "AVGO", label: "Broadcom" },
  { symbol: "PLTR", label: "Palantir" },
  { symbol: "TSM", label: "TSMC" },
  { symbol: "MU", label: "Micron" },
  { symbol: "SNDK", label: "SanDisk" },
  { symbol: "ASML", label: "ASML" },
  { symbol: "SMCI", label: "Super Micro" },
  { symbol: "CRWV", label: "CoreWeave" },
  { symbol: "ANET", label: "Arista" },
  { symbol: "VRT", label: "Vertiv" },
  { symbol: "CEG", label: "Constellation" },
  { symbol: "ORCL", label: "Oracle" },
];

// =============================================================
// TRENDING — cashtags pushed from the Twitter archive
// =============================================================

/** How long a pushed list stays on the bar with no fresh push. The
 *  miner runs every morning; three days covers a long weekend of no
 *  shows without leaving a stale conversation up for a fortnight. */
const TRENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const TRENDING_MAX = 25;
const TRENDING_FILE = process.env.TICKER_TRENDING_FILE ?? "./.slop-data/ticker-trending.json";

export type TrendingTag = { symbol: string; tweets: number; authors: number; engagement: number };
export type TrendingInput = {
  tags: TrendingTag[];
  /** Who mined this (free text, eg "clawd-morning-update"). */
  source?: string;
  windowDays?: number;
  minAuthors?: number;
};
export type TrendingState = TrendingInput & { receivedAt: number };

let trending: TrendingState | null = null;
let trendingLoaded = false;

function loadTrending(): void {
  if (trendingLoaded) return;
  trendingLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(TRENDING_FILE, "utf8")) as Partial<TrendingState>;
    if (Array.isArray(parsed.tags) && typeof parsed.receivedAt === "number") {
      trending = { ...parsed, tags: parsed.tags as TrendingTag[], receivedAt: parsed.receivedAt };
    }
  } catch {
    /* fresh box — nothing pushed yet */
  }
}

function persistTrending(): void {
  if (!trending) return;
  try {
    mkdirSync(dirname(TRENDING_FILE), { recursive: true });
    writeFileSync(TRENDING_FILE, JSON.stringify(trending), "utf8");
  } catch (err) {
    console.warn("[ticker] trending persist failed", err);
  }
}

/** The live (unexpired) trending list, or null. */
export function getTrending(): TrendingState | null {
  loadTrending();
  if (!trending) return null;
  if (Date.now() - trending.receivedAt > TRENDING_TTL_MS) return null;
  return trending;
}

const SYMBOL_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** Replace the trending list (POST /v1/ticker/trending). Validates,
 *  persists, re-polls at once so the bar updates within a second or two,
 *  and reports which symbols found a price source. An empty `tags` array
 *  clears the list. */
export async function setTrending(
  input: unknown,
): Promise<
  | { ok: true; state: TrendingState; resolved: TickerItem[]; unresolved: string[] }
  | { ok: false; error: string }
> {
  const body = (input ?? {}) as Partial<TrendingInput>;
  if (!Array.isArray(body.tags)) return { ok: false, error: "tags must be an array" };
  const seen = new Set<string>();
  const tags: TrendingTag[] = [];
  for (const raw of body.tags) {
    const t = (raw ?? {}) as Partial<TrendingTag>;
    const symbol = typeof t.symbol === "string" ? t.symbol.trim().toUpperCase().replace(/^\$/, "") : "";
    if (!SYMBOL_RE.test(symbol)) return { ok: false, error: `bad symbol: ${JSON.stringify(t.symbol)}` };
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
    tags.push({ symbol, tweets: num(t.tweets), authors: num(t.authors), engagement: num(t.engagement) });
    if (tags.length >= TRENDING_MAX) break;
  }
  trending = {
    tags,
    source: typeof body.source === "string" ? body.source.slice(0, 80) : undefined,
    windowDays: typeof body.windowDays === "number" ? body.windowDays : undefined,
    minAuthors: typeof body.minAuthors === "number" ? body.minAuthors : undefined,
    receivedAt: Date.now(),
  };
  trendingLoaded = true;
  persistTrending();
  await pollOnce();
  const resolved = (state?.items ?? []).filter(i => i.trending);
  const got = new Set(resolved.map(i => i.symbol.replace(/^\$/, "")));
  return { ok: true, state: trending, resolved, unresolved: tags.map(t => t.symbol).filter(s => !got.has(s)) };
}

// --- CoinGecko top-500 (symbol → id) — the crypto half of trending resolution.
// Refreshed hourly (2 calls). A cashtag whose symbol appears here with a
// good market-cap rank is a coin; otherwise we try it as a stock.
type CgMarket = { id: string; symbol: string; name: string; rank: number };
let cgMarkets: Map<string, CgMarket> | null = null;
let cgMarketsAt = 0;
const CG_MARKETS_TTL_MS = 60 * 60_000;
/** Rank at or above which a symbol is a coin no matter what Yahoo says
 *  ($SOL, $NEAR, $HYPE — big coins whose tickers collide with nothing). */
const CG_RANK_SURE = 100;
/** Below this rank we don't trust a symbol match at all: $HOOD is
 *  GreenHood (#249), $META is MetaDAO (#260), $AI is Artificial Inu. */
const CG_RANK_MAX = 300;

async function cgMarketsFresh(): Promise<Map<string, CgMarket>> {
  if (cgMarkets && Date.now() - cgMarketsAt < CG_MARKETS_TTL_MS) return cgMarkets;
  const map = new Map<string, CgMarket>();
  for (const page of [1, 2]) {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc` +
      `&per_page=250&page=${page}&sparkline=false`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`coingecko markets ${res.status}`);
    const rows = (await res.json()) as Array<{ id: string; symbol: string; name: string; market_cap_rank: number | null }>;
    for (const r of rows) {
      const sym = r.symbol.toUpperCase();
      // First hit wins — pages come back in market-cap order.
      if (!map.has(sym)) map.set(sym, { id: r.id, symbol: sym, name: r.name, rank: r.market_cap_rank ?? 9999 });
    }
  }
  cgMarkets = map;
  cgMarketsAt = Date.now();
  return map;
}

// --- $CLAWD: real ERC-20 on Base. We pull the live price from DexScreener,
// which aggregates every pool the token trades in. Pick the pair with
// the deepest USD liquidity — that's the canonical "the price" the rest
// of the market arbs against; thin pools wander.
const CLAWD_ADDRESS = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";
async function fetchClawd(): Promise<TickerItem | null> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${CLAWD_ADDRESS}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  const data = (await res.json()) as {
    pairs?: Array<{
      chainId?: string;
      priceUsd?: string;
      priceChange?: { h24?: number };
      liquidity?: { usd?: number };
    }>;
  };
  const pairs = (data.pairs ?? []).filter(p => p.chainId === "base" && p.priceUsd);
  if (pairs.length === 0) return null;
  // Sort by USD liquidity descending; take the deepest pool's price.
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const best = pairs[0]!;
  const price = Number(best.priceUsd);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    symbol: "$CLAWD",
    label: "Clawd",
    price,
    changePct: best.priceChange?.h24 ?? 0,
    kind: "meme",
    url: `https://dexscreener.com/base/${CLAWD_ADDRESS}`,
  };
}

async function fetchCrypto(coins: Array<{ id: string; symbol: string; label: string }>): Promise<TickerItem[]> {
  if (coins.length === 0) return [];
  const ids = coins.map(c => c.id).join(",");
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  const data = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
  return coins
    .map(c => {
      const row = data[c.id];
      return {
        symbol: c.symbol,
        label: c.label,
        price: row?.usd ?? 0,
        changePct: row?.usd_24h_change ?? 0,
        kind: "crypto" as const,
        url: `https://www.coingecko.com/en/coins/${c.id}`,
      };
    })
    .filter(item => item.price > 0);
}

// --- Yahoo Finance quotes. The v7 batch endpoint wants a session cookie
// (any GET on fc.yahoo.com sets one) plus a matching crumb; both live
// for hours. On a 401/403 we drop the pair and the next poll re-mints.
// Unknown symbols are simply absent from the reply, which is exactly
// the "is this cashtag a stock?" test trending resolution needs.
const YAHOO_UA = "Mozilla/5.0 (X11; Linux x86_64) slop-ticker/1.0";
let yahooAuth: { cookie: string; crumb: string } | null = null;

async function yahooAuthFresh(): Promise<{ cookie: string; crumb: string }> {
  if (yahooAuth) return yahooAuth;
  const seed = await fetch("https://fc.yahoo.com", { headers: { "user-agent": YAHOO_UA }, redirect: "manual" });
  const cookie = (seed.headers.getSetCookie?.() ?? [])
    .map(c => c.split(";")[0]!)
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new Error("yahoo: no session cookie");
  const cr = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "user-agent": YAHOO_UA, cookie },
  });
  const crumb = (await cr.text()).trim();
  if (!cr.ok || !crumb || crumb.length > 40 || crumb.includes("<")) throw new Error(`yahoo: bad crumb (${cr.status})`);
  yahooAuth = { cookie, crumb };
  return yahooAuth;
}

type YahooQuote = { symbol: string; shortName: string; price: number; changePct: number; quoteType: string };

async function fetchYahooQuotes(symbols: string[]): Promise<Map<string, YahooQuote>> {
  const out = new Map<string, YahooQuote>();
  if (symbols.length === 0) return out;
  const auth = await yahooAuthFresh();
  const url =
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}` +
    `&fields=regularMarketPrice,regularMarketChangePercent,shortName,longName,quoteType&crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, { headers: { "user-agent": YAHOO_UA, cookie: auth.cookie, accept: "application/json" } });
  if (res.status === 401 || res.status === 403) {
    yahooAuth = null; // crumb expired — next poll re-mints
    throw new Error(`yahoo ${res.status} (crumb dropped)`);
  }
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const data = (await res.json()) as {
    quoteResponse?: {
      result?: Array<{
        symbol?: string;
        shortName?: string;
        longName?: string;
        quoteType?: string;
        regularMarketPrice?: number;
        regularMarketChangePercent?: number;
      }>;
    };
  };
  for (const q of data.quoteResponse?.result ?? []) {
    const price = q.regularMarketPrice;
    if (!q.symbol || typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    out.set(q.symbol.toUpperCase(), {
      symbol: q.symbol.toUpperCase(),
      shortName: (q.shortName ?? q.longName ?? q.symbol).replace(/,? (Inc\.?|Corp(oration)?\.?|Ltd\.?|plc|Co\.?)$/i, ""),
      price,
      changePct: typeof q.regularMarketChangePercent === "number" ? q.regularMarketChangePercent : 0,
      quoteType: q.quoteType ?? "",
    });
  }
  return out;
}

const STOCK_QUOTE_TYPES = new Set(["EQUITY", "ETF"]);

function stockItem(q: YahooQuote, label?: string): TickerItem {
  return {
    symbol: q.symbol,
    label: label ?? q.shortName,
    price: q.price,
    changePct: q.changePct,
    kind: "stock",
    url: `https://finance.yahoo.com/quote/${q.symbol}`,
  };
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
// Last-known CLAWD entry. DexScreener occasionally 429s; on a single
// failed poll we keep showing the previous price rather than dropping
// the headline item out of the bar entirely.
let lastClawd: TickerItem | null = null;
// Same idea for the whole stock leg: Yahoo hiccups shouldn't blank 19
// cells for a minute.
let lastStocks: TickerItem[] = [];
// …and the crypto leg: CoinGecko's free tier 429s on back-to-back calls
// (a push-triggered poll right after the timer's), which blanked eight
// cells for a minute before this existed.
let lastCrypto: TickerItem[] = [];
let polling: Promise<void> | null = null;

async function pollOnce(): Promise<void> {
  // Coalesce: a push-triggered poll landing mid-timer poll just waits
  // for it, then runs its own so the new tags are reflected.
  if (polling) await polling.catch(() => {});
  polling = pollOnceInner();
  try {
    await polling;
  } finally {
    polling = null;
  }
}

async function pollOnceInner(): Promise<void> {
  const live = getTrending();
  const trendingTags = live?.tags ?? [];
  const byTag = new Map(trendingTags.map(t => [t.symbol, t]));
  const coreCrypto = new Set(CRYPTO.map(c => c.symbol));
  const coreStock = new Set(STOCKS.map(s => s.symbol));

  // Resolution, pass 1 (before any quote call): which trending symbols are
  // definitely coins, which we'll try as stocks, which get a second look
  // as coins if Yahoo doesn't know them.
  let markets: Map<string, CgMarket> | null = null;
  if (trendingTags.length > 0) {
    try {
      markets = await cgMarketsFresh();
    } catch (err) {
      console.warn("[ticker] coingecko markets failed (trending crypto resolution degraded)", err);
      markets = cgMarkets; // stale is fine
    }
  }
  const trendingCryptoIds: Array<{ id: string; symbol: string; label: string }> = [];
  const maybeCrypto: Array<{ id: string; symbol: string; label: string }> = [];
  const stockCandidates: string[] = [];
  for (const t of trendingTags) {
    if (t.symbol === "CLAWD" || coreCrypto.has(t.symbol) || coreStock.has(t.symbol)) continue; // already on the bar
    const m = markets?.get(t.symbol);
    if (m && m.rank <= CG_RANK_SURE) {
      trendingCryptoIds.push({ id: m.id, symbol: m.symbol, label: m.name });
      continue;
    }
    stockCandidates.push(t.symbol);
    if (m && m.rank <= CG_RANK_MAX) maybeCrypto.push({ id: m.id, symbol: m.symbol, label: m.name });
  }

  // Independent failures — if one feed is briefly down we still want
  // the others to update.
  const [cryptoResult, yahooResult, clawdResult] = await Promise.allSettled([
    fetchCrypto([...CRYPTO, ...trendingCryptoIds, ...maybeCrypto]),
    fetchYahooQuotes([...STOCKS.map(s => s.symbol), ...stockCandidates]),
    fetchClawd(),
  ]);
  if (cryptoResult.status === "rejected") console.warn("[ticker] crypto fetch failed", cryptoResult.reason);
  if (yahooResult.status === "rejected") console.warn("[ticker] stocks fetch failed", yahooResult.reason);
  if (clawdResult.status === "rejected") console.warn("[ticker] clawd fetch failed", clawdResult.reason);
  if (clawdResult.status === "fulfilled" && clawdResult.value) lastClawd = clawdResult.value;

  if (cryptoResult.status === "fulfilled") lastCrypto = cryptoResult.value;
  const cryptoItems = lastCrypto;
  const cryptoBySym = new Map(cryptoItems.map(i => [i.symbol, i]));
  const quotes = yahooResult.status === "fulfilled" ? yahooResult.value : null;

  // Core lists, in their declared order.
  const core: TickerItem[] = [];
  for (const c of CRYPTO) {
    const i = cryptoBySym.get(c.symbol);
    if (i) core.push(i);
  }
  if (quotes) {
    lastStocks = STOCKS.flatMap(s => {
      const q = quotes.get(s.symbol);
      return q ? [stockItem(q, s.label)] : [];
    });
  }
  core.push(...lastStocks);

  // Resolution, pass 2: build the trending items. A core item that's also
  // trending moves up into the trending slot (shown once, with the 🔥).
  const trendingItems: TickerItem[] = [];
  const promoted = new Set<string>();
  for (const t of trendingTags) {
    const mark = { authors: t.authors, tweets: t.tweets };
    if (t.symbol === "CLAWD") {
      if (lastClawd) lastClawd = { ...lastClawd, trending: mark };
      continue;
    }
    const coreHit = core.find(i => i.symbol === t.symbol);
    if (coreHit) {
      trendingItems.push({ ...coreHit, trending: mark });
      promoted.add(t.symbol);
      continue;
    }
    const sure = trendingCryptoIds.find(c => c.symbol === t.symbol);
    if (sure) {
      const i = cryptoBySym.get(t.symbol);
      if (i) trendingItems.push({ ...i, trending: mark });
      continue;
    }
    const q = quotes?.get(t.symbol);
    if (q && STOCK_QUOTE_TYPES.has(q.quoteType)) {
      trendingItems.push({ ...stockItem(q), trending: mark });
      continue;
    }
    if (maybeCrypto.some(c => c.symbol === t.symbol)) {
      const i = cryptoBySym.get(t.symbol);
      if (i) trendingItems.push({ ...i, trending: mark });
      continue;
    }
    // Unresolved: no price source knows it (a fresh memecoin off the top
    // 300, a made-up tag, a private company). Not our problem — the bar
    // shows prices, not names.
  }
  if (lastClawd && !trendingTags.some(t => t.symbol === "CLAWD")) lastClawd = { ...lastClawd, trending: undefined };

  // If every feed failed AND we have no prior state, skip the broadcast
  // so the client keeps rendering nothing instead of an empty bar.
  if (core.length === 0 && trendingItems.length === 0 && !lastClawd && !state) return;

  const items: TickerItem[] = [
    ...(lastClawd ? [lastClawd] : []),
    ...trendingItems,
    ...core.filter(i => !promoted.has(i.symbol)),
  ];
  state = { items, updatedAt: Date.now() };

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
  loadTrending();

  const loop = async () => {
    try {
      await pollOnce();
      pollTimer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
    } catch (err) {
      console.warn("[ticker] poll failed", err);
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

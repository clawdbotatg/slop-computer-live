// Slop ticker. Polls a small set of AI + crypto markets and broadcasts
// the result to every connected peer (same pattern as gas.ts). All
// upstream API calls happen here, on the server, so:
//   - no per-client rate-limit fights
//   - no CORS pain (Yahoo / Stooq block browser fetches; the relay can
//     hit them freely)
//   - one cache shared across the whole mesh
//
// Sources:
//   - CoinGecko `/simple/price` for crypto (free, no key)
//   - Stooq `q/l` CSV for publicly-traded AI-adjacent stocks
//     (free, no key, CORS not relevant because we're server-side)
//   - Static valuations for private AI labs (OpenAI / Anthropic / etc.)
//     — these don't trade, so we ship last-known funding-round numbers
//   - $CLAWD: a synthetic comedy token that random-walks around $4.20.
//     Not real. Don't buy it. It's vibes.
//
// Poll cadence is conservative (60s) — the ticker bar isn't a trading
// terminal and free APIs get cranky if you hammer them.

const POLL_INTERVAL_MS = 60_000;
const ERROR_RETRY_MS = 30_000;

export type TickerItem = {
  /** Display symbol, eg. "ETH", "NVDA", "$CLAWD". */
  symbol: string;
  /** Short label shown alongside the symbol. */
  label: string;
  /** USD price (or implied valuation for private companies). */
  price: number;
  /** 24h % change (positive = up). May be 0 when upstream omits it. */
  changePct: number;
  /** Display category — drives icon/color hints on the client. */
  kind: "crypto" | "stock" | "private" | "meme";
  /** Optional click-through URL. Crypto → CoinGecko page, stocks →
   *  Yahoo Finance, CLAWD → its DexScreener page. Missing for private
   *  companies (no obvious destination for "Anthropic valuation"). */
  url?: string;
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

// =============================================================
// PRIVATE AI LAB VALUATIONS — REFRESH ME!
// =============================================================
// These are static "last-closed funding round" marks for private
// companies that don't trade on a public market. They appear in the
// ticker as headline valuations and they go stale fast — a new round
// closes somewhere in this list roughly every 6-8 weeks.
//
// MAINTENANCE: when editing this file, sanity-check that every
// `lastUpdated` date below is < ~90 days old. If anything is older
// than that — or the user asks for a "ticker refresh" — DO A FRESH
// RESEARCH PASS (see the `refresh_private_valuations` memory for
// the exact prompt to give a subagent) before continuing.
//
// Convention: use the LAST CLOSED round, not the in-talks number.
// The comment after each entry records *what's currently in talks*
// so you don't have to re-research if you decide to switch.
//
// LAST FULL REFRESH: 2026-05-16
// =============================================================
const PRIVATE_VALUATIONS: Array<{
  symbol: string;
  label: string;
  valuation: number;
  /** ISO date of the source-event that set this valuation. */
  lastUpdated: string;
}> = [
  // In-talks: $852B primary (Mar 2026, not yet closed)
  { symbol: "OPENAI", label: "OpenAI", valuation: 500_000_000_000, lastUpdated: "2025-10-02" },
  // In-talks: $900B at ~$30B raise (May 2026, Bloomberg/TechCrunch)
  { symbol: "ANTHRP", label: "Anthropic", valuation: 380_000_000_000, lastUpdated: "2026-02" },
  // xAI now part of SpaceX — $250B is the standalone implied leg of the
  // $1.25T SpaceX/xAI combined merger valuation (Feb 2026).
  { symbol: "XAI", label: "xAI", valuation: 250_000_000_000, lastUpdated: "2026-02-03" },
  { symbol: "DBRX", label: "Databricks", valuation: 134_000_000_000, lastUpdated: "2026-02-09" },
  // STALE — last public mark ~13 months old, refresh round expected.
  { symbol: "SSI", label: "Safe Superintelligence", valuation: 32_000_000_000, lastUpdated: "2025-04-12" },
  // In-talks: $50B (Apr 2026, not yet closed)
  { symbol: "CRSR", label: "Cursor", valuation: 29_000_000_000, lastUpdated: "2025-11-13" },
  // Meta took 49% stake in this deal — implies whole-company at ~$29B.
  { symbol: "SCALE", label: "Scale AI", valuation: 29_000_000_000, lastUpdated: "2025-06-13" },
  { symbol: "PRPLX", label: "Perplexity", valuation: 20_000_000_000, lastUpdated: "2025-09-10" },
  // €11.7B post-money @ Sept 2025 EUR/USD; recheck FX on refresh.
  { symbol: "MSTRL", label: "Mistral", valuation: 14_000_000_000, lastUpdated: "2025-09" },
  { symbol: "11LAB", label: "ElevenLabs", valuation: 11_000_000_000, lastUpdated: "2026-02-04" },
];

// CoinGecko IDs → display symbol/label. Kept inline because the set is
// small and editing JSON for one-line additions isn't worth it.
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

// Stooq tickers. The .us suffix selects the US listing; for NASDAQ /
// NYSE issues that's the only option Stooq exposes.
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
const STOCKS: Array<{ stooq: string; symbol: string; label: string }> = [
  { stooq: "nvda.us", symbol: "NVDA", label: "NVIDIA" },
  { stooq: "msft.us", symbol: "MSFT", label: "Microsoft" },
  { stooq: "googl.us", symbol: "GOOGL", label: "Alphabet" },
  { stooq: "meta.us", symbol: "META", label: "Meta" },
  { stooq: "amd.us", symbol: "AMD", label: "AMD" },
  { stooq: "tsla.us", symbol: "TSLA", label: "Tesla" },
  { stooq: "aapl.us", symbol: "AAPL", label: "Apple" },
  { stooq: "avgo.us", symbol: "AVGO", label: "Broadcom" },
  { stooq: "pltr.us", symbol: "PLTR", label: "Palantir" },
  { stooq: "tsm.us", symbol: "TSM", label: "TSMC" },
  { stooq: "mu.us", symbol: "MU", label: "Micron" },
  { stooq: "sndk.us", symbol: "SNDK", label: "SanDisk" },
  { stooq: "asml.us", symbol: "ASML", label: "ASML" },
  { stooq: "smci.us", symbol: "SMCI", label: "Super Micro" },
  { stooq: "crwv.us", symbol: "CRWV", label: "CoreWeave" },
  { stooq: "anet.us", symbol: "ANET", label: "Arista" },
  { stooq: "vrt.us", symbol: "VRT", label: "Vertiv" },
  { stooq: "ceg.us", symbol: "CEG", label: "Constellation" },
  { stooq: "orcl.us", symbol: "ORCL", label: "Oracle" },
];

// CLAWD: real ERC-20 on Base. We pull the live price from DexScreener,
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

async function fetchCrypto(): Promise<TickerItem[]> {
  const ids = CRYPTO.map(c => c.id).join(",");
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  const data = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
  return CRYPTO.map(c => {
    const row = data[c.id];
    return {
      symbol: c.symbol,
      label: c.label,
      price: row?.usd ?? 0,
      changePct: row?.usd_24h_change ?? 0,
      kind: "crypto" as const,
      url: `https://www.coingecko.com/en/coins/${c.id}`,
    };
  }).filter(item => item.price > 0);
}

// Stooq CSV columns (with our requested format):
//   Symbol,Date,Time,Open,High,Low,Close,Volume,Name
// We want Close (price) and we approximate "change vs open" as the day's
// % move, since Stooq's free endpoint doesn't ship a 24h-change column.
async function fetchStocks(): Promise<TickerItem[]> {
  // Stooq's batch syntax wants symbols joined by `+` (a literal `+` in
  // the query string, not URL-encoded). Comma-separated returns a
  // single row of N/D placeholders. Built the URL by hand to preserve
  // the `+` instead of encoding it.
  const symbols = STOCKS.map(s => s.stooq).join("+");
  const url = `https://stooq.com/q/l/?s=${symbols}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { headers: { accept: "text/csv" } });
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  // First line is header; skip it.
  const rows = lines.slice(1).map(line => line.split(","));
  const bySymbol = new Map<string, { open: number; close: number }>();
  for (const row of rows) {
    const stooqSymbol = (row[0] ?? "").toLowerCase();
    const open = Number(row[3]);
    const close = Number(row[6]);
    if (!Number.isFinite(close) || close <= 0) continue;
    bySymbol.set(stooqSymbol, { open: Number.isFinite(open) ? open : close, close });
  }
  return STOCKS.flatMap(s => {
    const row = bySymbol.get(s.stooq);
    if (!row) return [];
    const changePct = row.open > 0 ? ((row.close - row.open) / row.open) * 100 : 0;
    return [
      {
        symbol: s.symbol,
        label: s.label,
        price: row.close,
        changePct,
        kind: "stock" as const,
        url: `https://finance.yahoo.com/quote/${s.symbol}`,
      },
    ];
  });
}

function staticPrivate(): TickerItem[] {
  return PRIVATE_VALUATIONS.map(p => ({
    symbol: p.symbol,
    label: p.label,
    price: p.valuation,
    // Private valuations don't have intraday changes; leave at 0 so the
    // UI renders them in neutral gray rather than green/red.
    changePct: 0,
    kind: "private" as const,
  }));
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
// Last-known CLAWD entry. DexScreener occasionally 429s; on a single
// failed poll we keep showing the previous price rather than dropping
// the headline item out of the bar entirely.
let lastClawd: TickerItem | null = null;

async function pollOnce(): Promise<void> {
  // Independent failures — if one feed is briefly down we still want
  // the others to update.
  const [cryptoResult, stocksResult, clawdResult] = await Promise.allSettled([
    fetchCrypto(),
    fetchStocks(),
    fetchClawd(),
  ]);
  const crypto = cryptoResult.status === "fulfilled" ? cryptoResult.value : [];
  const stocks = stocksResult.status === "fulfilled" ? stocksResult.value : [];
  if (cryptoResult.status === "rejected") console.warn("[ticker] crypto fetch failed", cryptoResult.reason);
  if (stocksResult.status === "rejected") console.warn("[ticker] stocks fetch failed", stocksResult.reason);
  if (clawdResult.status === "rejected") console.warn("[ticker] clawd fetch failed", clawdResult.reason);
  if (clawdResult.status === "fulfilled" && clawdResult.value) lastClawd = clawdResult.value;

  // If every feed failed AND we have no prior state, skip the broadcast
  // so the client keeps rendering nothing instead of an empty bar.
  if (crypto.length === 0 && stocks.length === 0 && !lastClawd && !state) return;

  const items: TickerItem[] = [
    ...(lastClawd ? [lastClawd] : []),
    ...crypto,
    ...stocks,
    ...staticPrivate(),
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

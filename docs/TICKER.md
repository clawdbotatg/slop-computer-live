# The ticker bar (bottom of the desktop)

`packages/relay/src/ticker.ts` polls prices once a minute on the relay
and broadcasts one snapshot to every peer; `TickerBar.tsx` renders it.
**Every item is a live quote. Nothing in the bar is hard-coded** — that
is the rule since 2026-09-18, when a block of hand-typed private-lab
valuations (OpenAI $500B, Anthropic $380B, …) turned out to have been
written once on 2026-05-16 and never touched; every mark was 7–17 months
stale on air. If an asset has no daily price source, it does not belong
in the bar.

## What's in it, in order

| slot | source | cadence |
| --- | --- | --- |
| **$CLAWD** | DexScreener, deepest-liquidity Base pool | 60s |
| **🔥 trending** | `$CASHTAGS` mined from the Twitter home-timeline archive (below), each resolved to a live price | pushed daily, priced every 60s |
| **crypto core** | CoinGecko `/simple/price` — ETH BTC SOL LINK DOGE RNDR TAO FET | 60s |
| **stock core** | Yahoo Finance `/v7/finance/quote` — 19 AI-adjacent names (NVDA MSFT … ORCL) | 60s |

A core symbol that is also trending is shown once, in the trending slot,
with the 🔥.

## Trending cashtags — how they get there

```
heart Mac                                          prod relay
────────────────────────────────────────────       ────────────────────────────────
clawd-morning-update/data/feed-*.json  (08:02)
   │  ~1000 tweets per snapshot, morning + evening
   ▼
ops/ticker/trending-cashtags.mjs       (08:17)
   │  last 3 days, $TAG used by ≥3 DISTINCT AUTHORS,
   │  ranked authors → engagement, top 15
   ▼  POST /v1/ticker/trending  (host bearer)  ──▶  ticker.ts setTrending()
                                                       │ persist .slop-data/ticker-trending.json
                                                       │ resolve each symbol:
                                                       │   CoinGecko top-500, rank ≤100  → crypto
                                                       │   else Yahoo knows it (EQUITY/ETF) → stock
                                                       │   else CoinGecko rank ≤300       → crypto
                                                       │   else dropped (no price = not on the bar)
                                                       ▼ re-poll, broadcast, 🔥 on each
```

- **Noise gate is distinct authors, not tweet count.** One account posting
  `$CASHCAT` eleven times is one author; `$ZEC` from fifteen accounts is a
  conversation. `--min-authors` (default 3) is the knob.
- **Resolution order matters.** Symbol matching on CoinGecko alone is a
  trap: `$HOOD` is GreenHood (#249), `$META` is MetaDAO (#260), `$NVDA` is
  a Robinhood tokenized stock, `$AI` is Artificial Inu. Big coins (rank
  ≤100) win outright; everything else is tried as a stock first.
- **TTL.** A pushed list expires after 3 days (`TRENDING_TTL_MS`) with no
  fresh push, so a symbol nobody mentions falls off by itself. Pushing
  `{ "tags": [] }` clears it immediately.
- **Skipped on purpose:** stables (`USDC`, `USDT`, `DAI`…) sit at $1.00 and
  `$AI`/`$GM` are words. The list is `SKIP` in the miner.
- Stablecoins aside, the miner does not know what a symbol is — the relay
  decides. `--dry-run` prints the mined table without pushing.

### Running it

```bash
node ops/ticker/trending-cashtags.mjs --dry-run           # see the table
node ops/ticker/trending-cashtags.mjs                     # mine + push
node ops/ticker/trending-cashtags.mjs --days 7 --top 20   # wider window
launchctl kickstart -k gui/$(id -u)/com.clawd.slop-ticker-trending   # the scheduled job, now
```

Auth: `SLOP_TOKEN` env if set, else the showtime scheduler's token pool
(`~/clawd/clawd-scheduler/lib/relay-token.mjs`, probed the same way
`showtime-arm` does — never trusted by name). The scheduled job is
`ops/ticker/com.clawd.slop-ticker-trending.plist` (08:17 daily, heart
Mac); log at `~/Library/Logs/slop-ticker-trending.log`.

Inspect what the relay currently holds:
`GET /v1/ticker/trending` (any authed session) → `{ trending, onBar }`.

## Stocks: Yahoo, not Stooq

Stooq's free CSV endpoint (`/q/l/?s=…&e=csv`) started answering a 404 /
JS-challenge page some time before 2026-09-01 (the journal doesn't reach
further back). The relay logged `stocks fetch failed Error: stooq 404`
once a minute for weeks and the bar silently showed **zero stocks** — no
alert, because a failed leg just yields an empty list. Replaced
2026-09-18 with Yahoo's batch quote endpoint: one GET on `fc.yahoo.com`
for a session cookie, `/v1/test/getcrumb` for the matching crumb, then
`/v7/finance/quote?symbols=A,B,C&crumb=…` for everything in one call.
It returns a true `regularMarketChangePercent` (Stooq only gave
close-vs-open) and omits unknown symbols, which doubles as the
"is this cashtag a stock?" test. A 401/403 drops the crumb; the next
poll re-mints. Browser fetches to Yahoo are CORS-blocked — this only
works server-side.

**If the bar has no stocks again:** `journalctl -u slop-relay | grep
'\[ticker\]'` on prod. Both the crypto and stock legs keep their
last-known items through a single failed poll, so one bad minute never
blanks the bar; a leg that's been dead for hours shows as repeating
warnings there.

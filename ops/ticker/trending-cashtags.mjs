#!/usr/bin/env node
// Trending cashtags → the slop ticker bar.
//
// Mines the raw Twitter home-timeline archive that clawd-morning-update
// already pays for (one ~1000-tweet snapshot per morning + evening, on
// the heart Mac) for $CASHTAGS people are actually talking about, and
// pushes the winners to the relay (POST /v1/ticker/trending). The relay
// resolves each symbol to a live price (CoinGecko top-500 → crypto,
// otherwise a stock quote) and shows them in the bottom bar with a 🔥.
// Nothing here is a price and nothing is hard-coded: a tag nobody
// mentions for a few days falls off the bar on its own (relay TTL).
//
// Noise gate = DISTINCT AUTHORS, not tweet count. One shill posting
// $CASHCAT eleven times is one author; $ZEC from fifteen accounts is a
// conversation. Default: ≥3 authors within the last 3 days.
//
//   node ops/ticker/trending-cashtags.mjs            # mine + push
//   node ops/ticker/trending-cashtags.mjs --dry-run  # mine, print, no push
//   node ops/ticker/trending-cashtags.mjs --days 7 --min-authors 4 --top 20
//
// Env:
//   MORNING_UPDATE_DATA  dir of feed-*.json  (default ~/clawd-harness/projects/clawd-morning-update/data)
//   SLOP_RELAY           relay origin        (default https://live.slop.computer)
//   SLOP_TOKEN           a host bearer; if unset, the scheduler's token
//                        pool (~/clawd/clawd-scheduler/lib/relay-token.mjs)
//                        is probed the same way showtime-arm does it.
//
// Scheduled by ops/ticker/com.clawd.slop-ticker-trending.plist (08:17
// local, after the 08:02 feed lands). Safe to run by hand any time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const DRY = args.includes("--dry-run");
const DAYS = Number(flag("days", 3));
const MIN_AUTHORS = Number(flag("min-authors", 3));
const TOP = Number(flag("top", 15));
const DATA_DIR =
  process.env.MORNING_UPDATE_DATA ||
  path.join(os.homedir(), "clawd-harness/projects/clawd-morning-update/data");
const RELAY = (process.env.SLOP_RELAY || "https://live.slop.computer").replace(/\/$/, "");
const TOKEN_LIB =
  process.env.RELAY_TOKEN_LIB || path.join(os.homedir(), "clawd/clawd-scheduler/lib/relay-token.mjs");

// Things that are technically cashtags but never worth a slot: stables sit
// at $1.00 and "$AI" is a word, not an asset.
const SKIP = new Set(["USD", "USDC", "USDT", "DAI", "USDE", "USDS", "AI", "GM", "GN"]);
// `$` glued to a word, not preceded by a word char or `.` (so "US$100" and
// "1.5$" don't count), 2-10 chars, letters first.
const CASHTAG = /(?<![\w.])\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

function feedFiles() {
  if (!fs.existsSync(DATA_DIR)) throw new Error(`no data dir: ${DATA_DIR}`);
  const cutoff = Date.now() - DAYS * 86_400_000;
  return fs
    .readdirSync(DATA_DIR)
    .filter(f => /^feed(-eve)?-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => ({ f, day: f.match(/(\d{4}-\d{2}-\d{2})/)[1] }))
    .filter(({ day }) => new Date(`${day}T23:59:59Z`).getTime() >= cutoff)
    .map(({ f }) => path.join(DATA_DIR, f))
    .sort();
}

function mine(files) {
  const seen = new Set();
  const tags = new Map(); // SYM → { tweets, authors:Set, engagement, sample }
  let tweetCount = 0;
  for (const file of files) {
    let tweets;
    try {
      tweets = JSON.parse(fs.readFileSync(file, "utf8")).tweets ?? [];
    } catch (err) {
      console.warn(`skip ${path.basename(file)}: ${err.message}`);
      continue;
    }
    for (const t of tweets) {
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      tweetCount++;
      const found = new Set();
      for (const m of String(t.text ?? "").matchAll(CASHTAG)) found.add(m[1].toUpperCase());
      for (const sym of found) {
        if (SKIP.has(sym)) continue;
        const row = tags.get(sym) ?? { symbol: sym, tweets: 0, authors: new Set(), engagement: 0, sample: "" };
        row.tweets++;
        row.authors.add(t.author);
        row.engagement += (t.likes ?? 0) + 2 * (t.rts ?? 0) + (t.replies ?? 0);
        if (!row.sample) row.sample = `@${t.author}: ${String(t.text).replace(/\s+/g, " ").slice(0, 90)}`;
        tags.set(sym, row);
      }
    }
  }
  const ranked = [...tags.values()]
    .filter(r => r.authors.size >= MIN_AUTHORS)
    .sort((a, b) => b.authors.size - a.authors.size || b.engagement - a.engagement)
    .slice(0, TOP)
    .map(r => ({ symbol: r.symbol, tweets: r.tweets, authors: r.authors.size, engagement: r.engagement, sample: r.sample }));
  return { ranked, tweetCount, distinct: tags.size };
}

async function pickToken() {
  if (process.env.SLOP_TOKEN) return process.env.SLOP_TOKEN;
  if (!fs.existsSync(TOKEN_LIB)) throw new Error(`no SLOP_TOKEN and no token lib at ${TOKEN_LIB}`);
  const lib = await import(TOKEN_LIB);
  const picked = await lib.pickFanoutToken({ log: m => console.log(`  ${m}`) });
  if (!picked) throw new Error("no live relay token in the scheduler pool");
  return picked.token;
}

async function push(tags) {
  const token = await pickToken();
  const res = await fetch(`${RELAY}/v1/ticker/trending`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      source: "clawd-morning-update",
      windowDays: DAYS,
      minAuthors: MIN_AUTHORS,
      tags: tags.map(({ symbol, tweets, authors, engagement }) => ({ symbol, tweets, authors, engagement })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`relay ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

const files = feedFiles();
const { ranked, tweetCount, distinct } = mine(files);
console.log(
  `${files.length} snapshots, ${tweetCount} unique tweets, ${distinct} distinct cashtags, ` +
    `${ranked.length} with ≥${MIN_AUTHORS} authors in the last ${DAYS}d`,
);
console.log(`${"tag".padEnd(9)}${"authors".padStart(8)}${"tweets".padStart(7)}${"engage".padStart(8)}  sample`);
for (const r of ranked) {
  console.log(
    `$${r.symbol.padEnd(8)}${String(r.authors).padStart(8)}${String(r.tweets).padStart(7)}${String(r.engagement).padStart(8)}  ${r.sample}`,
  );
}
if (DRY) {
  console.log("--dry-run: not pushing");
} else if (ranked.length === 0) {
  console.log("nothing crossed the author threshold; leaving the relay's current list alone");
} else {
  const out = await push(ranked);
  console.log(`pushed ${ranked.length} tags → relay resolved:`);
  for (const r of out.resolved ?? []) console.log(`  $${r.symbol.padEnd(8)} ${r.kind.padEnd(7)} ${r.label}`);
  for (const r of out.unresolved ?? []) console.log(`  $${r.padEnd(8)} (no price source — dropped)`);
}

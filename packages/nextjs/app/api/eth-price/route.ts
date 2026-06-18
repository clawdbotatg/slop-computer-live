import { NextResponse } from "next/server";

// ETH→USD spot price for the UI (buy-ins, pots, balances, tips show a USD value
// next to the ETH one). Server-side so the browser never hits a third-party
// price API directly and one cache is shared across all peers.
//
// Source: Coinbase's keyless spot endpoint. We just integrated Coinbase Onramp,
// so this keeps the price provider consistent. Cached ~60s in module scope —
// price moves slowly relative to how often these labels render.

let cache: { usd: number; at: number } | null = null;
const TTL_MS = 60_000;

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    return NextResponse.json({ usd: cache.usd, cached: true });
  }

  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { cache: "no-store" });
    if (!res.ok) {
      // Serve a stale price rather than nothing if we have one.
      if (cache) return NextResponse.json({ usd: cache.usd, stale: true });
      return NextResponse.json({ error: "price-upstream", status: res.status }, { status: 502 });
    }
    const j = (await res.json()) as { data?: { amount?: string } };
    const usd = Number(j.data?.amount);
    if (!isFinite(usd) || usd <= 0) {
      if (cache) return NextResponse.json({ usd: cache.usd, stale: true });
      return NextResponse.json({ error: "price-parse" }, { status: 502 });
    }
    cache = { usd, at: now };
    return NextResponse.json({ usd });
  } catch (err) {
    if (cache) return NextResponse.json({ usd: cache.usd, stale: true });
    return NextResponse.json({ error: "fetch-failed", detail: String(err).slice(0, 200) }, { status: 502 });
  }
}

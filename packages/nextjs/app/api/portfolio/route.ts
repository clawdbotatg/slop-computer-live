import { NextResponse } from "next/server";

// Server-side Zerion proxy — keeps ZERION_API_KEY off the browser and
// shares one rate limit across all peers. Lifted from
// clawd-talk-to-your-wallet's portfolio route, simplified to just the
// two endpoints the wallet window cares about (simple positions +
// per-chain summary).
//
// Auth: Zerion uses HTTP Basic with the key as username and a blank
// password. The `Buffer.from(\`${key}:\`).toString("base64")` dance
// matches their docs exactly.

const ZERION_KEY = process.env.ZERION_API_KEY || "";

type ZerionPosition = {
  id: string;
  attributes?: {
    value?: number | null;
    quantity?: { float?: number };
    position_type?: string;
    fungible_info?: {
      name?: string;
      symbol?: string;
      icon?: { url?: string };
      implementations?: { chain_id?: string; address?: string | null; decimals?: number }[];
    };
    flags?: { displayable?: boolean };
    protocol?: string | null;
    price?: number | null;
  };
  relationships?: { chain?: { data?: { id?: string } } };
};

type Position = {
  blockchain: string;
  tokenName: string;
  tokenSymbol: string;
  positionType: string;
  protocol: string | null;
  balance: number;
  balanceUsd: number;
  pricePerToken: number | null;
  tokenDecimals: number | null;
  contractAddress: string | null;
  thumbnail: string | null;
};

function normalize(p: ZerionPosition): Position | null {
  const a = p.attributes ?? {};
  const fi = a.fungible_info ?? {};
  const impl = fi.implementations?.[0];
  if (a.flags && a.flags.displayable === false) return null;
  return {
    blockchain: p.relationships?.chain?.data?.id ?? "unknown",
    tokenName: fi.name ?? "Unknown",
    tokenSymbol: fi.symbol ?? "?",
    positionType: a.position_type ?? "wallet",
    protocol: a.protocol ?? null,
    balance: a.quantity?.float ?? 0,
    balanceUsd: a.value ?? 0,
    pricePerToken: a.price ?? null,
    tokenDecimals: impl?.decimals ?? null,
    contractAddress: impl?.address ?? null,
    thumbnail: fi.icon?.url ?? null,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = (url.searchParams.get("address") ?? "").trim().toLowerCase();
  if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "bad-address" }, { status: 400 });
  }
  if (!ZERION_KEY) {
    return NextResponse.json({ error: "no-zerion-key", message: "Set ZERION_API_KEY on the server." }, { status: 503 });
  }

  const auth = Buffer.from(`${ZERION_KEY}:`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, accept: "application/json" };

  const positionsUrl = `https://api.zerion.io/v1/wallets/${address}/positions/?filter[positions]=only_simple&currency=usd&sort=-value&page[size]=100`;
  const summaryUrl = `https://api.zerion.io/v1/wallets/${address}/portfolio?currency=usd`;

  try {
    const [pRes, sRes] = await Promise.all([
      fetch(positionsUrl, { headers, cache: "no-store" }),
      fetch(summaryUrl, { headers, cache: "no-store" }),
    ]);
    if (!pRes.ok) {
      return NextResponse.json({ error: "zerion-positions-failed", status: pRes.status }, { status: 502 });
    }

    const pJson = (await pRes.json()) as { data?: ZerionPosition[] };
    const positions = (pJson.data ?? []).map(normalize).filter((p): p is Position => p !== null);

    let totalUsd = 0;
    let change1d: { absolute: number; percent: number } | null = null;
    let byChain: Record<string, number> = {};
    if (sRes.ok) {
      const sJson = (await sRes.json()) as {
        data?: {
          attributes?: {
            total?: { positions?: number };
            changes?: { absolute_1d?: number; percent_1d?: number };
            positions_distribution_by_chain?: Record<string, number>;
          };
        };
      };
      const attr = sJson.data?.attributes ?? {};
      totalUsd = attr.total?.positions ?? 0;
      if (attr.changes && (attr.changes.absolute_1d != null || attr.changes.percent_1d != null)) {
        change1d = {
          absolute: attr.changes.absolute_1d ?? 0,
          percent: attr.changes.percent_1d ?? 0,
        };
      }
      byChain = attr.positions_distribution_by_chain ?? {};
    }
    if (totalUsd === 0) totalUsd = positions.reduce((s, p) => s + p.balanceUsd, 0);

    return NextResponse.json({ ok: true, address, totalUsd, change1d, byChain, positions });
  } catch (err) {
    return NextResponse.json({ error: "fetch-failed", detail: String(err).slice(0, 200) }, { status: 502 });
  }
}

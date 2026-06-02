import { NextResponse } from "next/server";
import { createPublicClient, http, zeroHash } from "viem";
import { mainnet } from "viem/chains";

// What's currently live on slop.computer, by slug. The QR app calls this
// to seed its default URL — point the phone at the screen and you land on
// the actual live episode's `/<slug>` page, not on whatever room the host
// happens to be in on live.slop.computer.
//
// Source of truth is the on-chain SlopComputer.liveEpisode() view on
// mainnet. The struct is all-zeros when nothing is live; we detect that
// by checking the bytes32 `id` field. Cached in-memory for a few seconds
// so a roomful of peers refreshing their QR windows doesn't multiply into
// an Alchemy fan-out.

const CONTRACT_ADDRESS = "0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886" as const;
const CACHE_TTL_MS = 10_000;

const liveEpisodeAbi = [
  {
    type: "function",
    name: "liveEpisode",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id", type: "bytes32" },
          { name: "name", type: "string" },
          { name: "slug", type: "string" },
          { name: "liveSlug", type: "string" },
          { name: "manifest", type: "string" },
          { name: "contractAddr", type: "address" },
          { name: "datetime", type: "uint256" },
          { name: "addedAt", type: "uint256" },
          { name: "nextId", type: "bytes32" },
        ],
      },
    ],
  },
] as const;

let cache: { at: number; slug: string | null } | null = null;

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ slug: cache.slug }, { headers: { "cache-control": "public, max-age=10" } });
  }

  const key = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  if (!key) {
    return NextResponse.json({ slug: null, error: "no-alchemy-key" }, { status: 500 });
  }

  try {
    const client = createPublicClient({
      chain: mainnet,
      transport: http(`https://eth-mainnet.g.alchemy.com/v2/${key}`),
    });
    const ep = await client.readContract({
      address: CONTRACT_ADDRESS,
      abi: liveEpisodeAbi,
      functionName: "liveEpisode",
    });
    const slug = ep.id === zeroHash ? null : ep.slug || null;
    cache = { at: now, slug };
    return NextResponse.json({ slug }, { headers: { "cache-control": "public, max-age=10" } });
  } catch (err) {
    return NextResponse.json({ slug: null, error: (err as Error).message }, { status: 502 });
  }
}

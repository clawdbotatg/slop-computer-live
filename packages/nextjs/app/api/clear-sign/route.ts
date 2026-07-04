// POST /api/clear-sign
//
// Body: { chainId, to, data, value?, calls? }
//   - single call:  { chainId, to, data, value }
//   - batch:        { chainId, calls: [{ target, value, data }, ...] }
//
// Returns the ERC-7730 DisplayModel (or BatchDisplayModel) plus an ERC-8213
// `calldataDigest` the UI can show as a byte-level fallback when no descriptor
// resolves. All heavy lifting (registry fetch, on-chain reads) is here so the
// browser just renders.
import { NextResponse } from "next/server";
import { buildTrustedTokens, externalDataProvider, format, formatEip5792Batch, getRegistryIndex } from "./lib";
import type { GitHubResolverOptions } from "@ethereum-sourcify/clear-signing";
import { type Hex, keccak256 } from "viem";

export const runtime = "nodejs";

type Call = { target: string; value?: string; data?: string };
type Body = { chainId?: number; to?: string; data?: string; value?: string; calls?: Call[] };

const toBig = (v?: string) => {
  try {
    return v ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
};

const digestOf = (data?: string): string | null => {
  if (!data || !data.startsWith("0x") || data.length < 10) return null;
  try {
    return keccak256(data as Hex);
  } catch {
    return null;
  }
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const chainId = Number(body.chainId);
  if (!chainId) return NextResponse.json({ ok: false, error: "missing chainId" }, { status: 400 });

  const isBatch = Array.isArray(body.calls) && body.calls.length > 0;
  const targets = isBatch ? body.calls!.map(c => c.target).filter(Boolean) : body.to ? [body.to] : [];

  try {
    const [index, trustedTokens] = await Promise.all([getRegistryIndex(), buildTrustedTokens(chainId, targets)]);
    const opts = {
      externalDataProvider,
      descriptorResolverOptions: { type: "github", index, trustedTokens } as GitHubResolverOptions,
    };

    if (isBatch) {
      const calls = body.calls!.map(c => ({ to: c.target, data: c.data ?? "0x", value: toBig(c.value) }));
      const model = await formatEip5792Batch({ chainId, calls }, opts);
      return NextResponse.json({ ok: true, batch: true, model, digests: calls.map(c => digestOf(c.data)) });
    }

    if (!body.to || !body.data) return NextResponse.json({ ok: false, error: "missing to/data" }, { status: 400 });
    const model = await format({ chainId, to: body.to, data: body.data, value: toBig(body.value) }, opts);
    return NextResponse.json({ ok: true, batch: false, model, digest: digestOf(body.data) });
  } catch (err) {
    // Never fail the signing card because clear-signing had a hiccup — return
    // the digest so the UI can still show the byte-level fallback.
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[clear-sign] format error:", message);
    return NextResponse.json({ ok: false, error: message, digest: digestOf(body.data) }, { status: 200 });
  }
}

// `/tip` support. A tip is a plain ETH transfer from a viewer's OWN wallet
// to the room multisig (the opposite direction from the wallet-chat intent
// engine, which builds multisig-authored proposals). The relay's only jobs
// are (1) an AI fallback that parses fuzzy phrasing into {amountEth, chainId}
// when the client's cheap regex can't, and (2) formatting the celebratory
// chat line. The actual send + wallet popup is all client-side (wagmi).

import { bankrChat } from "./bankr-llm.js";

// The chains a tip can target — mirrors packages/nextjs/scaffold.config.ts
// (targetNetworks: [base, mainnet, gnosis]). The multisig's CREATE2 address
// is identical on every chain, so a tip lands at the same address regardless.
export const TIP_CHAIN_LABELS: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  100: "Gnosis",
};

export type TipParseResult = { ok: true; amountEth: string; chainId: number } | { ok: false; error: string };

// Upper bound so a fat-fingered / malicious parse can't surface a wallet
// popup asking for an absurd amount. Tips are meant to be small.
const MAX_TIP_ETH = 100;

const SYSTEM_PROMPT = [
  "You parse a crypto TIP request into JSON. The user is tipping the room's shared wallet with native ETH.",
  "Supported chains: Base (chainId 8453), Ethereum mainnet (chainId 1), Gnosis (chainId 100).",
  'Return ONLY compact JSON, no markdown: {"amountEth":"<decimal>","chainId":<number>} OR {"error":"<short reason>"}.',
  "Rules:",
  "- amountEth is a plain decimal string of ETH, e.g. \"0.001\". The token is always native ETH.",
  "- If no chain is named, use chainId 8453 (Base).",
  '- If the amount is in USD/dollars, or is missing/unclear, return {"error":"specify an ETH amount, e.g. /tip 0.001 base eth"}.',
  "- Never invent an amount. JSON only.",
].join("\n");

function extractJson(text: string): unknown {
  // Bankr usually returns bare JSON, but tolerate ```json fences / stray prose.
  const fenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** AI fallback for fuzzy phrasing the client regex couldn't parse. Cheap
 *  single-shot Bankr call. Never throws — returns a structured error the
 *  caller surfaces to the user. */
export async function parseTipIntent(text: string): Promise<TipParseResult> {
  const res = await bankrChat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text.slice(0, 200) },
    ],
    { maxTokens: 80, temperature: 0 },
  );
  if (!res.ok) return { ok: false, error: "tip parser unavailable — try `/tip 0.001 base eth`" };

  const parsed = extractJson(res.text) as { amountEth?: unknown; chainId?: unknown; error?: unknown } | null;
  if (!parsed) return { ok: false, error: "couldn't read that — try `/tip 0.001 base eth`" };
  if (typeof parsed.error === "string" && parsed.error) return { ok: false, error: parsed.error };

  const chainId = typeof parsed.chainId === "number" ? parsed.chainId : NaN;
  if (!TIP_CHAIN_LABELS[chainId]) return { ok: false, error: "unsupported chain — try base, ethereum, or gnosis" };

  const amountEth = String(parsed.amountEth ?? "").trim();
  const amount = Number(amountEth);
  if (!/^[0-9]*\.?[0-9]+$/.test(amountEth) || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "couldn't read the amount — try `/tip 0.001 base eth`" };
  }
  if (amount > MAX_TIP_ETH) return { ok: false, error: `that's a lot — tips are capped at ${MAX_TIP_ETH} ETH` };

  return { ok: true, amountEth, chainId };
}

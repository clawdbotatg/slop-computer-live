// Plain-English transaction summarizer. Hands tx-data + target to
// Claude and gets back a structured JSON card we render next to the
// signature dialog with token pills + <Address> cards. Used by the
// wallet UI so signers know what they're about to approve without
// staring at raw calldata.
//
// The returned string is a JSON object (see TxSummaryCard schema in
// the prompt below) — the client parses it; if parsing fails it
// renders the raw string as plain text. Falls back to a calldata-only
// plain-text string when ANTHROPIC_API_KEY is unset or the request
// fails — so local dev without a key still surfaces something useful.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

export type SummarizeCall = {
  target: string;
  value: string;
  data: string;
};

export type SummarizeArgs = {
  chainId: number;
  multisigAddress: string;
  target: string;
  value: string; // decimal wei
  data: string; // 0x-prefixed calldata
  // When set + non-empty, this is a batched tx — the summarizer renders
  // a multi-call paragraph and ignores top-level target/value/data.
  calls?: SummarizeCall[];
};

function fallbackSummary(args: SummarizeArgs): string {
  if (args.calls && args.calls.length > 0) {
    return `Batched tx: ${args.calls.length} call${args.calls.length === 1 ? "" : "s"} via execBatchTransaction. (Set ANTHROPIC_API_KEY on the relay for an AI summary.)`;
  }
  const sel = args.data.length >= 10 ? args.data.slice(0, 10) : "0x";
  const targetShort = `${args.target.slice(0, 10)}…${args.target.slice(-4)}`;
  const valueWei = args.value === "0" ? "no value" : `${args.value} wei`;
  return `Calls selector ${sel} on ${targetShort} with ${valueWei}. (Set ANTHROPIC_API_KEY on the relay for an AI summary.)`;
}

// Strip ``` fences, leading "json" tags, and any prose before the
// first `{`. The model is told to emit pure JSON but occasionally
// wraps it — be lenient.
function extractJson(text: string): string {
  const t = text.trim();
  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const fenceBody = fenceMatch?.[1];
  if (fenceBody) return fenceBody.trim();
  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return t.slice(firstBrace, lastBrace + 1);
  return t;
}

// We don't need to use the parsed shape on the relay — the client
// is the one that consumes it. But validating that we got valid
// JSON with the right shape lets us flag bad model output instead
// of silently shipping garbage to every peer.
function looksLikeSummaryCard(s: string): boolean {
  try {
    const o = JSON.parse(s);
    return (
      o &&
      typeof o === "object" &&
      typeof o.headline === "string" &&
      Array.isArray(o.inputs) &&
      Array.isArray(o.outputs)
    );
  } catch {
    return false;
  }
}

// LLMs hallucinate the EIP-55 case bits on addresses they generate —
// they'll happily emit `0x34Aa3F…` when the real checksum is `0x34aA3F…`.
// viem's getAddress() then throws and the client renders "Invalid address".
// Lowercasing every 40-hex string in the card sidesteps it: viem accepts
// all-lowercase and rebuilds the correct checksum at display time.
function normalizeCardAddresses(s: string): string {
  return s.replace(/0x[a-fA-F0-9]{40}/g, m => m.toLowerCase());
}

export async function summarizeTransaction(args: SummarizeArgs): Promise<string> {
  if (!ANTHROPIC_API_KEY) return fallbackSummary(args);

  const isBatch = args.calls && args.calls.length > 0;
  const txBlock = isBatch
    ? `BATCH of ${args.calls!.length} calls (executed atomically via execBatchTransaction):
${args
  .calls!.map(
    (c, i) => `  ${i + 1}. target=${c.target}  value=${c.value} wei  data=${c.data.slice(0, 138)}${c.data.length > 138 ? "…" : ""}`,
  )
  .join("\n")}`
    : `Target:   ${args.target}
Value:    ${args.value} wei
Calldata: ${args.data}`;

  const prompt = `A multisig wallet on chain ${args.chainId} is about to send a transaction.
The signer is a caveman — explain it in as few words as possible.

Multisig: ${args.multisigAddress}

${txBlock}

Decode the calldata. Recognize common selectors: ERC-20 (transfer / transferFrom / approve),
ERC-721 / ERC-1155, Uniswap V2/V3/V4 (incl. UniversalRouter \`execute\` with commands 0x10/0x00 = V4_SWAP),
Seaport, ENS, Safe, LI.FI, common bridges.

Respond with ONE JSON object — no prose, no markdown fences, no preamble. Schema:

{
  "headline": "Swap ETH for USDC",        // 2–6 words, plain English. NO selectors, NO hex, NO wei. "Swap ETH for USDC", "Send 100 USDC", "Approve Uniswap to spend USDC", "Mint 1 NFT".
  "kind": "swap" | "send" | "approve" | "mint" | "deploy" | "call",
  "inputs":  [{ "symbol": "ETH",  "amount": "0.00005", "address": null }],   // tokens leaving the multisig. Use "ETH" for native. amount is a human-readable decimal string (NOT wei).
  "outputs": [{ "symbol": "USDC", "amount": "~1.68",   "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],  // tokens arriving. Use "~" prefix for slippage-tolerant min-out values.
  "to": null,                                                                 // recipient address for a plain send/transfer; null otherwise.
  "contract": { "address": "0xfdf6...fbc7", "label": "Uniswap Universal Router" }  // the target contract + a friendly label, or null if unknown.
}

Rules:
- Amounts are human-readable decimals (use the token's decimals, e.g. 6 for USDC, 18 for ETH/most ERC-20s). NEVER include wei.
- For a swap, "inputs" is what leaves the multisig and "outputs" is what arrives.
- For a plain transfer/send, "inputs" is what leaves; "outputs" is empty; "to" is the recipient.
- For an approve, "inputs" and "outputs" are empty; "contract" is the token; the headline says e.g. "Approve Uniswap to spend USDC".
- Never invent token symbols. If a token address is unfamiliar, use \`"symbol": "Token ABCD"\` where ABCD is the last 4 hex of the address.
- If you can't decode the call at all: headline "Unknown call", kind "call", empty inputs/outputs, contract set to the target with label "Unknown".
- Addresses MUST be the full 0x-prefixed 40-char hex (no truncation, no ellipsis).
- Output the JSON object and nothing else. No code fences. No leading or trailing text.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `(AI summary failed: ${res.status}) ${fallbackSummary(args)} — ${text.slice(0, 120)}`;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const raw = (json.content ?? [])
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join("\n")
      .trim();
    if (!raw) return fallbackSummary(args);
    const candidate = extractJson(raw);
    if (looksLikeSummaryCard(candidate)) return normalizeCardAddresses(candidate);
    // Model returned prose despite instructions — ship it raw; the
    // client falls back to plain-text rendering. Still scrub address
    // case so any inline 0x… in the prose renders cleanly.
    return normalizeCardAddresses(raw);
  } catch (err) {
    return `(AI summary error: ${String(err).slice(0, 100)}) ${fallbackSummary(args)}`;
  }
}

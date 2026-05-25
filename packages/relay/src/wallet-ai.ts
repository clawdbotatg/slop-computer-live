// Plain-English transaction summarizer. Hands tx-data + target to
// Claude and gets back a short human sentence we display next to the
// signature dialog. Used by the wallet UI so signers know what they're
// about to approve without staring at raw calldata.
//
// Falls back to a calldata-only summary when ANTHROPIC_API_KEY is unset
// (or the request fails) — that way local dev without a key still
// surfaces *something* useful, just not the model-generated paragraph.

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

export async function summarizeTransaction(args: SummarizeArgs): Promise<string> {
  if (!ANTHROPIC_API_KEY) return fallbackSummary(args);

  const isBatch = args.calls && args.calls.length > 0;
  const prompt = isBatch
    ? `A multisig wallet on chain ${args.chainId} is being asked to execute a BATCH of transactions atomically via execBatchTransaction. Decode and explain it in plain English.

Multisig: ${args.multisigAddress}

Calls (${args.calls!.length}):
${args
  .calls!.map(
    (c, i) => `  ${i + 1}. target=${c.target}  value=${c.value} wei  data=${c.data.slice(0, 138)}${c.data.length > 138 ? "…" : ""}`,
  )
  .join("\n")}

Write 1–4 short sentences. Cover what each call does at a high level (e.g. "send 0.5 ETH to 0xabc…, transfer 100 USDC to 0xabc…, transfer 50 DAI to 0xabc…"). If they're all transfers to the same recipient, say so. Be concrete and terse. Recognize common ERC-20/721/1155 selectors (transfer, transferFrom, approve, safeTransferFrom).`
    : `A multisig wallet on chain ${args.chainId} is being asked to send a transaction. Decode and explain it in plain English.

Multisig: ${args.multisigAddress}
Target:    ${args.target}
Value:     ${args.value} wei
Calldata:  ${args.data}

Write 1–3 short sentences. Cover:
- What function is being called (recognize common ERC-20/721/1155, Uniswap, Seaport, ENS, Safe, etc. selectors)
- Who/what the recipient/contract is, if it's a well-known one
- Any token amounts or addresses being moved

Be concrete and terse. Don't hedge. If the selector is unknown, say "calls function <selector> on <contract>" — don't guess wildly.`;

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
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `(AI summary failed: ${res.status}) ${fallbackSummary(args)} — ${text.slice(0, 120)}`;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const out = (json.content ?? [])
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join("\n")
      .trim();
    return out || fallbackSummary(args);
  } catch (err) {
    return `(AI summary error: ${String(err).slice(0, 100)}) ${fallbackSummary(args)}`;
  }
}

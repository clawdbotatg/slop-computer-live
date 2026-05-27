// Plain-English transaction summarizer. Hands tx-data + target to
// Claude and gets back a structured JSON card we render next to the
// signature dialog with token chips + <Address> cards. Used by the
// wallet UI so signers know what they're about to approve without
// staring at raw calldata.
//
// The returned string is a JSON object (see TxSummaryCard schema in
// the prompt below) — the client parses it; if parsing fails it
// renders the raw string as plain text. Falls back to a calldata-only
// plain-text string when ANTHROPIC_API_KEY is unset or the request
// fails — so local dev without a key still surfaces something useful.
//
// Token flow is GROUND TRUTH from on-chain simulation, not an AI guess.
// We `eth_simulateV1` the call(s) as the multisig (from=multisig), decode
// the synthesized Transfer logs into net asset changes, and build the
// card's input/output chips from those — real contract addresses, exact
// amounts, real icons. The AI only writes the headline / kind / contract
// label / recipient. When simulation is unavailable (revert, an `approve`
// that moves nothing, or a non-Alchemy chain like Gnosis) we fall back to
// the AI-decoded chips, which are themselves hardened by resolving every
// address in the calldata against TOKEN_ADDRESSES + Zerion and a
// symbol-match backstop.

import { formatUnits } from "viem";
import { simulateTransfers, type SimTransfer } from "./wallet-data.js";
import { NATIVE_ADDRESS, resolveTokenByAddress, type ResolvedToken } from "./wallet-tokens.js";

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

// LLMs hallucinate the EIP-55 case bits on addresses they generate —
// they'll happily emit `0x34Aa3F…` when the real checksum is `0x34aA3F…`.
// viem's getAddress() then throws and the client renders "Invalid address".
// Lowercasing every 40-hex string in the card sidesteps it: viem accepts
// all-lowercase and rebuilds the correct checksum at display time.
function normalizeCardAddresses(s: string): string {
  return s.replace(/0x[a-fA-F0-9]{40}/g, m => m.toLowerCase());
}

// Pull every distinct address out of a piece of calldata + the target
// slot. Addresses inside ABI-encoded calldata are NOT `0x`-prefixed —
// they're 20-byte values left-padded to 32 bytes (24 zero hex chars +
// 40 address hex chars). The earlier `/0x[a-fA-F0-9]{40}/g` regex only
// caught the literal `0x` prefix at the very start of the calldata,
// matching one bogus address (selector + first arg slot) and missing
// every real token/recipient. This pass scans for the padded form
// instead. The 0x0…0 placeholder is filtered out — it's the native
// sentinel and the summarizer adds it back unconditionally.
function extractAddressesFromCalls(
  target: string,
  data: string,
  calls: SummarizeCall[] | undefined,
): string[] {
  const set = new Set<string>();
  const ZERO40 = "0".repeat(40);
  const pushAddress = (a: string) => {
    if (!a) return;
    const lower = a.toLowerCase();
    if (lower === `0x${ZERO40}`) return;
    if (/^0x[a-f0-9]{40}$/i.test(lower)) set.add(lower);
  };
  // The top-level target (and per-call target in a batch) are clean
  // 0x-prefixed 40-hex strings — push them directly.
  pushAddress(target);
  if (calls) for (const c of calls) pushAddress(c.target);

  const scanCalldata = (s: string) => {
    if (!s) return;
    const hex = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
    // ABI words are 32 bytes = 64 hex chars. Walk every 64-char window
    // that's all hex and ends in a 40-hex address with 24 leading zeros.
    // Using a global regex with no capture groups, then sliding via
    // matchAll keeps this O(n).
    const re = /0{24}[0-9a-f]{40}/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(hex)) !== null) {
      pushAddress("0x" + m[0].slice(24).toLowerCase());
    }
  };
  scanCalldata(data);
  if (calls) for (const c of calls) scanCalldata(c.data);

  return Array.from(set);
}

// Zerion slug used in the "chain" field on each TxSummaryAsset we emit.
// Mirrors the mapping used elsewhere in the wallet UI so the client's
// TokenAvatar can pick the right chain badge from CHAIN_ICONS.
const CHAIN_SLUG_BY_ID: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum",
  10: "optimism",
  137: "polygon",
  100: "xdai",
};

// Schema enforced on the client. Mirrored loosely here so the post-
// processor knows what to walk. Loose typing — we don't trust the AI
// output, we just probe for the fields we care about.
type AssetFromAI = {
  symbol?: string;
  amount?: string;
  address?: string | null;
  chain?: string | null;
  thumbnail?: string | null;
  decimals?: number | null;
};

type CardFromAI = {
  headline?: string;
  kind?: string;
  inputs?: AssetFromAI[];
  outputs?: AssetFromAI[];
  to?: string | null;
  contract?: { address?: string; label?: string } | null;
};

// Apply a resolved-token table on top of the AI's response. For any
// asset that has an `address` field, look it up in the resolved map and
// overwrite the symbol/name/thumbnail/decimals/chain from the canonical
// source. This is what kills the CLAWD→UNI hallucination: the AI can
// emit whatever it wants, but if it emitted the correct address we'll
// fix the symbol downstream.
function applyResolvedTokensToCard(
  card: CardFromAI,
  resolved: Map<string, ResolvedToken>,
  chainId: number,
): CardFromAI {
  const chainSlug = CHAIN_SLUG_BY_ID[chainId] ?? null;
  // Build a symbol → ResolvedToken index from the same set. The AI
  // sometimes emits the token's MAINNET address instead of the
  // chain-correct one (USDC mainnet 0xA0b8…EB48 in calldata that's
  // actually doing a swap to Base USDC 0x8335…2913). Address match
  // misses → no thumbnail. The symbol-match fallback rescues that
  // case by using whichever USDC the relay actually pre-resolved from
  // the calldata.
  const bySymbol = new Map<string, ResolvedToken>();
  for (const r of resolved.values()) {
    const k = r.symbol.toUpperCase();
    if (!bySymbol.has(k)) bySymbol.set(k, r);
  }

  const fixAsset = (a: AssetFromAI): AssetFromAI => {
    if (!a || typeof a !== "object") return a;
    // Treat a null/missing address as native — look it up under the
    // 0x0…0 sentinel which the summarizer pre-resolved. Preserve the
    // null in the output so the client's "ETH on Base" rendering
    // continues to read `address: null` as the native sentinel.
    const rawAddr = typeof a.address === "string" ? a.address.toLowerCase() : null;
    const lookupAddr = rawAddr ?? NATIVE_ADDRESS;
    let r = resolved.get(lookupAddr) ?? null;
    if (!r && typeof a.symbol === "string") {
      // Address whiff — try the symbol map. This is what catches the AI
      // emitting the wrong-chain address but the right symbol.
      r = bySymbol.get(a.symbol.toUpperCase()) ?? null;
    }
    if (!r) return { ...a, address: rawAddr, chain: a.chain ?? chainSlug };
    return {
      ...a,
      // Prefer the canonical address from our resolver over whatever the
      // AI emitted (which may have been the wrong chain's USDC).
      address: r.address,
      symbol: r.symbol,
      chain: chainSlug,
      thumbnail: r.thumbnail,
      decimals: r.decimals,
    };
  };
  return {
    ...card,
    inputs: Array.isArray(card.inputs) ? card.inputs.map(fixAsset) : [],
    outputs: Array.isArray(card.outputs) ? card.outputs.map(fixAsset) : [],
  };
}

function looksLikeSummaryCard(card: unknown): boolean {
  if (!card || typeof card !== "object") return false;
  const o = card as { headline?: unknown; inputs?: unknown; outputs?: unknown };
  return typeof o.headline === "string" && Array.isArray(o.inputs) && Array.isArray(o.outputs);
}

// Drop trailing zeros from a formatUnits result ("1.500000" → "1.5",
// "2.0" → "2") so chips read cleanly.
function trimAmount(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

type SimChips = { inputs: AssetFromAI[]; outputs: AssetFromAI[] };

// Turn raw simulated Transfer logs into the card's input/output chips,
// netting per token relative to the multisig (out = left the wallet,
// in = arrived). Each chip's symbol/decimals/icon comes from the token
// resolver keyed on the REAL contract address that moved — so there's no
// AI guess anywhere in the token flow. Returns null when nothing the
// multisig owns actually moved (e.g. an approve), so the caller can fall
// back to the AI-decoded chips.
async function buildSimChips(
  transfers: SimTransfer[],
  multisig: string,
  chainId: number,
): Promise<SimChips | null> {
  const ms = multisig.toLowerCase();
  const net = new Map<string, bigint>(); // token → net raw units (positive = into multisig)
  const nftIn = new Map<string, number>();
  const nftOut = new Map<string, number>();
  for (const t of transfers) {
    const isOut = t.from === ms;
    const isIn = t.to === ms;
    if (!isOut && !isIn) continue; // routing hop that doesn't touch the multisig
    if (t.isNft) {
      if (isIn) nftIn.set(t.token, (nftIn.get(t.token) ?? 0) + 1);
      if (isOut) nftOut.set(t.token, (nftOut.get(t.token) ?? 0) + 1);
      continue;
    }
    let cur = net.get(t.token) ?? 0n;
    if (isIn) cur += t.rawAmount;
    if (isOut) cur -= t.rawAmount;
    net.set(t.token, cur);
  }

  const chainSlug = CHAIN_SLUG_BY_ID[chainId] ?? null;
  const inputs: AssetFromAI[] = [];
  const outputs: AssetFromAI[] = [];

  for (const [token, n] of net.entries()) {
    if (n === 0n) continue;
    const isNative = token === "native";
    const addr = isNative ? NATIVE_ADDRESS : token;
    const r = await resolveTokenByAddress(chainId, addr);
    const decimals = r?.decimals ?? 18;
    const magnitude = n < 0n ? -n : n;
    const chip: AssetFromAI = {
      symbol: r?.symbol ?? `Token ${addr.slice(-4)}`,
      amount: trimAmount(formatUnits(magnitude, decimals)),
      address: isNative ? null : addr,
      chain: chainSlug,
      thumbnail: r?.thumbnail ?? null,
      decimals,
    };
    (n < 0n ? inputs : outputs).push(chip);
  }

  const pushNft = async (token: string, count: number, into: AssetFromAI[]) => {
    const r = await resolveTokenByAddress(chainId, token);
    into.push({
      symbol: r?.symbol ?? `NFT ${token.slice(-4)}`,
      amount: String(count),
      address: token,
      chain: chainSlug,
      thumbnail: r?.thumbnail ?? null,
    });
  };
  for (const [token, count] of nftOut.entries()) await pushNft(token, count, inputs);
  for (const [token, count] of nftIn.entries()) await pushNft(token, count, outputs);

  if (inputs.length === 0 && outputs.length === 0) return null;
  return { inputs, outputs };
}

export async function summarizeTransaction(args: SummarizeArgs): Promise<string> {
  if (!ANTHROPIC_API_KEY) return fallbackSummary(args);

  // ── Pre-resolve every address we can see in the calldata. This is the
  //    core fix for "swap to CLAWD shows UNI": the AI now sees the
  //    canonical (address, symbol) pairs in its prompt and can't drift.
  //    NATIVE_ADDRESS is always included so null-address assets in the
  //    response (the AI emits `"address": null` for ETH) still pick up
  //    a proper symbol + Zerion icon at apply time.
  const addresses = Array.from(
    new Set([...extractAddressesFromCalls(args.target, args.data, args.calls), NATIVE_ADDRESS]),
  );
  const resolved = new Map<string, ResolvedToken>();
  await Promise.all(
    addresses.map(async addr => {
      const r = await resolveTokenByAddress(args.chainId, addr);
      if (r) resolved.set(addr, r);
    }),
  );

  // ── Ground truth: simulate the call(s) as the multisig and read the
  //    REAL transfers. These become the card's chips; the AI only writes
  //    prose. Empty/reverted/unsupported-chain → simChips stays null and
  //    we fall back to the AI-decoded chips below.
  const simCalls =
    args.calls && args.calls.length > 0
      ? args.calls.map(c => ({ to: c.target, data: c.data, value: c.value }))
      : [{ to: args.target, data: args.data, value: args.value }];
  let simChips: SimChips | null = null;
  try {
    const sim = await simulateTransfers({ from: args.multisigAddress, calls: simCalls, chainId: args.chainId });
    if (sim.reverted) {
      // A reverting call — or a batch where a later call reverts (sim runs
      // them non-atomically, so earlier transfers survive) — would render
      // confident "ground truth" chips for a tx that won't actually
      // execute. Drop them and let the AI-decoded chips stand instead.
      console.warn(`[wallet-ai] simulation reverted on chain ${args.chainId}; using AI-decoded chips`);
    } else if (sim.transfers.length > 0) {
      simChips = await buildSimChips(sim.transfers, args.multisigAddress, args.chainId);
    } else if (sim.error) {
      console.warn(`[wallet-ai] simulation unavailable on chain ${args.chainId} (${sim.error}); using AI-decoded chips`);
    }
  } catch (e) {
    console.warn(`[wallet-ai] simulation threw on chain ${args.chainId}: ${e instanceof Error ? e.message : String(e)}; using AI-decoded chips`);
  }

  const simBlock = simChips
    ? `\nSimulated asset changes (GROUND TRUTH — these tokens actually move when this tx executes; your headline MUST match this flow):
  leaving:  ${simChips.inputs.map(a => `${a.amount} ${a.symbol}`).join(", ") || "(nothing)"}
  arriving: ${simChips.outputs.map(a => `${a.amount} ${a.symbol}`).join(", ") || "(nothing)"}\n`
    : "";

  const knownTokensBlock =
    resolved.size > 0
      ? `\nKnown tokens at addresses in this calldata (CANONICAL — use these symbols, do NOT invent others):
${Array.from(resolved.values())
  .map(r => `  ${r.address} → ${r.symbol} (${r.name}, ${r.decimals} decimals)`)
  .join("\n")}\n`
      : "";

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
${simBlock}${knownTokensBlock}
Decode the calldata to identify the function being called. You may recognize standard selectors:
ERC-20 (transfer / transferFrom / approve), ERC-721 / ERC-1155, Uniswap V2/V3/V4 (incl. UniversalRouter
\`execute\` with commands 0x10/0x00 = V4_SWAP), Seaport, ENS, Safe.

CRITICAL — do NOT guess the contract's protocol, product, or category (bridge, DEX, staking, lending,
"Across", "Uniswap", "SpokePool", etc.) from a function NAME alone. Functions like depositETH / deposit /
stake / send are generic and used by countless unrelated contracts. ONLY name a protocol if the contract
ADDRESS appears in the "Known tokens" block above. For an UNFAMILIAR contract address, describe the
LITERAL action only — the decoded function plus the simulated asset flow — e.g. "Deposit 0.00025 ETH" or
"Call depositETH", NEVER "Bridge ETH". Set its contract label to the bare function name (e.g. "depositETH()")
or null. Inventing a protocol identity is the single worst thing you can do here.

Respond with ONE JSON object — no prose, no markdown fences, no preamble. Schema:

{
  "headline": "Swap ETH for CLAWD",                                                          // 2–6 words, plain English. NO selectors, NO hex, NO wei. Examples: "Swap ETH for USDC", "Send 100 USDC", "Deposit 0.5 ETH", "Approve Uniswap to spend USDC", "Call depositETH".
  "kind": "swap" | "send" | "approve" | "mint" | "deploy" | "call",
  "inputs":  [{ "symbol": "ETH",   "amount": "0.00005", "address": null }],                  // tokens leaving the multisig. Use "ETH" for native. amount is human-readable.
  "outputs": [{ "symbol": "CLAWD", "amount": "~1.68",   "address": "0x...full 40 hex..." }], // tokens arriving. "~" prefix = slippage-tolerant min-out.
  "to": null,                                                                                 // recipient address for a plain send/transfer; null otherwise.
  "contract": { "address": "0x...", "label": "Uniswap Universal Router" }                     // target contract + label. Label a protocol ONLY for a KNOWN address; for an unknown contract use the bare function name (e.g. "depositETH()") or null.
}

Rules:
- Amounts are human-readable decimals (use the token's decimals, e.g. 6 for USDC, 18 for ETH/most ERC-20s). NEVER include wei.
- ALWAYS include the token's contract \`address\` (full 40-hex, lowercase OK) on every non-native input/output. The client uses it to render the token icon + chain badge from the canonical registry. For native ETH use \`"address": null\`.
- If a token address appears in the "Known tokens" block above, USE THAT EXACT SYMBOL. Do not substitute a similar-sounding symbol.
- For a swap, "inputs" is what leaves the multisig and "outputs" is what arrives.
- For a plain transfer/send, "inputs" is what leaves; "outputs" is empty; "to" is the recipient.
- For an approve, "inputs" and "outputs" are empty; "contract" is the token; the headline says e.g. "Approve Uniswap to spend USDC".
- If a token address is unfamiliar AND not in the Known tokens block, use \`"symbol": "Token ABCD"\` where ABCD is the last 4 hex of the address — never guess.
- For a call to an UNFAMILIAR contract (target not in the Known tokens block): headline = the literal decoded action sized by the simulated flow (e.g. "Deposit 0.00025 ETH", "Call depositETH"), kind "call", contract label = the bare function name or null. Do NOT describe it as a bridge/swap/stake/deposit-into-<protocol> — you do not know what the contract does.
- If you can't decode the calldata at all: headline "Unknown call", kind "call", empty inputs/outputs, contract set to the target with label "Unknown".
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
        max_tokens: 700,
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
    let parsed: CardFromAI | null = null;
    try {
      parsed = JSON.parse(normalizeCardAddresses(candidate)) as CardFromAI;
    } catch {
      parsed = null;
    }
    if (parsed && looksLikeSummaryCard(parsed)) {
      const fixed = applyResolvedTokensToCard(parsed, resolved, args.chainId);
      // Ground-truth override: when simulation produced real chips, they
      // win over whatever the AI emitted. The AI's headline / kind /
      // contract / to are kept — only the token flow is replaced.
      if (simChips) {
        fixed.inputs = simChips.inputs;
        fixed.outputs = simChips.outputs;
      }
      return JSON.stringify(fixed);
    }
    // Model returned prose despite instructions — ship it raw; the
    // client falls back to plain-text rendering. Still scrub address
    // case so any inline 0x… in the prose renders cleanly.
    return normalizeCardAddresses(raw);
  } catch (err) {
    return `(AI summary error: ${String(err).slice(0, 100)}) ${fallbackSummary(args)}`;
  }
}

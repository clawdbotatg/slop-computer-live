// "Talk to your wallet" debug trace.
//
// The wallet AI runs an agentic loop (wallet-intent.ts) that today throws away
// everything except the final chat/transaction answer. When a proposed tx
// reverts or "simulation failed", we have no record of WHAT the model decided
// or WHY — only the polished bubble it showed the user. This module captures
// the full loop, one JSON line per turn, so a human (or Claude) can read back
// exactly what happened: every tool call + args, every raw tool result (so the
// LI.FI quote, the built calldata, and the simulation's actual error survive),
// the model's reasoning text, and the final parsed intent.
//
// It's a DEBUG sink, not a product feature — write-only, never broadcast, never
// rendered in the UI. Lives under the gitignored .slop-data/ so it's local to
// each box (read it on prod with `ssh slopcomputer` + tail the JSONL).
//
// Toggle: WALLET_AI_DEBUG=0 disables it. Location: WALLET_AI_DEBUG_DIR
// (default ./.slop-data/wallet-ai-debug). One file per UTC day so it rotates
// on its own and never grows unbounded into a single file.

import { appendFileSync, mkdirSync } from "node:fs";

const ENABLED = process.env.WALLET_AI_DEBUG !== "0";
const DEBUG_DIR = process.env.WALLET_AI_DEBUG_DIR || "./.slop-data/wallet-ai-debug";

// Tool results can be large (a full portfolio dump, a verbose LI.FI route).
// Keep the signal — the calldata, the sim verdict, the error — but cap each
// blob so one fat turn can't bloat the log. 8 KB is comfortably past the
// useful part of any single tool result we emit.
const MAX_RESULT_CHARS = 8000;

export type WalletDebugToolCall = {
  name: string;
  // Parsed args the model passed (or the raw string if it wasn't valid JSON).
  args: unknown;
  // The tool's return value, JSON-stringified then truncated. Null if the
  // tool threw before returning (the error lands in `error`).
  result: string | null;
  error?: string;
  // Wall-clock ms the tool took — flags a slow Alchemy/LI.FI call.
  ms?: number;
};

export type WalletDebugStep = {
  // 0-based iteration of the agentic loop.
  step: number;
  // The model's natural-language text for this step (its "thinking" / the
  // final JSON answer on the last step). Empty when it only called tools.
  text: string;
  toolCalls: WalletDebugToolCall[];
};

export type WalletDebugRecord = {
  ts: string;
  address: string;
  chainId: number;
  model: string;
  // The user's actual request for this turn.
  userMessage: string;
  // How many prior turns were replayed as context (not the content — that's
  // visible in wallet-chat.json — just the depth, to spot context starvation).
  historyDepth: number;
  steps: WalletDebugStep[];
  // The final answer we returned to the user, as the typed IntentResult. For a
  // transaction this carries the exact to/data/value/chainId that gets signed —
  // the single most useful field when something reverts.
  result: unknown;
  // Set when the loop itself threw (LLM gateway error, etc.).
  error?: string;
  // Total wall-clock for the whole turn.
  durationMs: number;
};

function clip(s: string): string {
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `…[+${s.length - MAX_RESULT_CHARS} chars]` : s;
}

/** Serialize a tool's return value for the log, surviving BigInt and cycles. */
export function serializeResult(value: unknown): string {
  try {
    return clip(
      JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? String(value),
    );
  } catch {
    return clip(String(value));
  }
}

/** Append one turn's full trace. Best-effort: a logging failure must never
 *  break a wallet turn, so everything is swallowed. */
export function writeWalletDebug(record: WalletDebugRecord): void {
  if (!ENABLED) return;
  try {
    const day = record.ts.slice(0, 10); // YYYY-MM-DD from the ISO stamp
    mkdirSync(DEBUG_DIR, { recursive: true });
    appendFileSync(
      `${DEBUG_DIR}/${day}.jsonl`,
      JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n",
    );
  } catch {
    /* debug logging is never allowed to break a turn */
  }
}

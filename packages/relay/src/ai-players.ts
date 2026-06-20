// Registry of server-side AI chess opponents.
//
// Each entry describes an OpenAI-compatible chat-completions endpoint.
// The actual API key is read from the env var named here — keys live
// in the relay's .env (gitignored) and are NEVER returned by the
// /v1/ai-players endpoint or included in any broadcast.
//
// To add a player: append an entry below. To take one offline: leave
// the entry but unset its env var (the registry filter hides any
// player whose key isn't present).

export type AIPlayerConfig = {
  /** Stable id, kebab-case. The chess game stores this player as
   *  ownerKey = `ai:${id}`. Poker sponsors append a per-seat nonce
   *  (`ai:${id}#${nonce}`) so several seats can run the same model;
   *  getAIPlayer strips that suffix before lookup. Don't change after
   *  games have been played or history rows will orphan. */
  id: string;
  /** Display label shown in the lobby dropdown. */
  label: string;
  /** Base URL of the OpenAI-compatible API (no trailing slash). The
   *  relay POSTs to `${baseURL}/chat/completions`. */
  baseURL: string;
  /** Model name as the provider expects it. */
  model: string;
  /** Name of the env var that holds the bearer token for this provider. */
  envVar: string;
  /** How the provider expects the key. "bearer" = standard
   *  OpenAI-style `Authorization: Bearer <key>`. "x-api-key" =
   *  Cloudflare/Bankr-style `X-API-Key: <key>`. Defaults to bearer
   *  since the vast majority of OpenAI-compatible endpoints want that. */
  authStyle?: "bearer" | "x-api-key";
  /** Optional extra system-prompt fragment, appended to the standard
   *  chess instructions. Useful for "play aggressively" personas. */
  systemPromptExtra?: string;
  /** Hard cap on tokens per move response. We only need ~5 chars but
   *  some models pad with reasoning. 256 is plenty. */
  maxTokens?: number;
  /** For reasoning models: how hard to think. Sent as the OpenAI-standard
   *  `reasoning_effort` field, but ONLY by the poker mover (chess wants full
   *  reasoning for stronger play). "low" roughly halves a reasoning model's
   *  latency at poker — where deep deliberation buys little — without changing
   *  the decision. Non-reasoning models / providers ignore it. Verified on
   *  Venice (minimax-m3: 31s→12s) and Bankr (kimi-k2.6: empty→clean answer). */
  reasoningEffort?: "low" | "minimal";
  /** Measured average decision latency in ms — surfaced in the poker sponsor
   *  dropdown (sorted fastest-first) so the pick is informed. Benchmarked
   *  2026-06 over 6 varied poker spots (with this entry's reasoningEffort
   *  applied, so it reflects real play). Re-measure if a provider changes. */
  avgMs?: number;
  /** Rough estimated API cost to play ONE hand, in USD — surfaced in the
   *  sponsor dropdown so the operator (who pays the LLM bill) can weigh it.
   *  Estimate = measured avg tokens/decision × this gateway's per-token price
   *  × ~3 decisions/hand (benchmarked 2026-06). Order-of-magnitude, not exact:
   *  real cost swings with how many streets a hand reaches + prompt caching. */
  costPerHandUsd?: number;
};

// IMPORTANT: when you add a real provider here, update this list AND
// add the matching key to packages/relay/.env. Code-only entries with
// no key set are silently hidden — clients won't see them in the lobby.
//
// All Bankr entries route through their OpenClaw LLM gateway
// (https://llm.bankr.bot/v1) — OpenAI-compatible response shape with
// an X-API-Key header. Full catalog + pricing:
//   curl https://llm.bankr.bot/v1/models -H "X-API-Key: $BANKR_API_KEY"
//
// Curated for *watchable* chess on a live stream — speed matters as
// much as strength when an audience is waiting on every move.
//
// Two tiers, both chosen for chess specifically (not general bench scores):
//
//   ⚡ FAST  — non-reasoning models. 1–4s/move, weaker but lively games.
//             Default pick for casual / podcast rounds.
//   🧠 SMART — reasoning models. 5–20s/move, stronger but glacial.
//             Save for "serious matches" the audience is actually
//             watching the chess of, not just the desktop around it.
//
// The 🤖 from earlier rosters was upgraded to 🧠 / ⚡ so users can
// see the trade-off in the dropdown without opening a doc.
//
// Curation is research-driven (chess-LLM benchmarks: LLM CHESS / Kaggle
// Game Arena / dubesor). The dominant variable is REASONING: reasoning
// models win ~45% vs ~0.7% for non-reasoning ones, which mostly lose by
// emitting ILLEGAL moves, not by bad strategy. Family strength at chess
// (best→worst): OpenAI GPT-5 reasoning ≳ Grok 4 > Gemini Pro > DeepSeek
// (volatile) > Claude (only with thinking) > Kimi / GLM / MiniMax / Qwen
// (weak / no track record). So the 🧠 tier leans on those top families;
// the ⚡ tier keeps small fast models purely for lively, low-stakes games.
//
// Rotated out:
//   - Kimi K2.6 — the WORST model at the Kaggle chess tournament (lost
//     every game in under 8 moves, misplacing pieces). Dropped entirely.
//   - MiniMax M2.7 / M2.7 highspeed — chronically resigned 1–4 moves in
//   - Venice Uncensored — chatty roleplay model, terrible at chess
//   - Qwen 3 235B Thinking (Venice) — 20s on opening moves, replaced
//     with the Instruct (non-thinking) variant of the same family
const AI_PLAYERS: AIPlayerConfig[] = [
  // ---- Bankr — ⚡ fast non-reasoning ------------------------------
  // Smoke-tested for actual move latency (a "fast" name in the catalog
  // doesn't guarantee fast inference — Gemini 3 Flash takes 7s, Grok
  // 4.1 Fast secretly reasons for 150 tokens, GPT 5-mini hides 128
  // reasoning tokens). The four below all came back in <1s with zero
  // reasoning tokens.
  {
    id: "bankr-claude-haiku-4.5",
    label: "Claude Haiku 4.5 (Bankr) ⚡",
    baseURL: "https://llm.bankr.bot/v1",
    model: "claude-haiku-4.5",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
    avgMs: 2000,
    costPerHandUsd: 0.00037,
  },
  {
    id: "bankr-gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite (Bankr) ⚡",
    baseURL: "https://llm.bankr.bot/v1",
    model: "gemini-3.1-flash-lite",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
    avgMs: 1900,
    costPerHandUsd: 7e-05,
  },
  // GPT 5.4-nano — PULLED for poker: fast + cheap but plays terribly (shoves
  // all-in on the first decision). Too small/non-reasoning to grasp pot odds.
  // ---- Bankr — 🧠 flagship reasoners ------------------------------
  // Ordered by chess-playing track record of the family (strongest first).
  // GPT-5 reasoning and Grok 4 went 1st/2nd at the Kaggle chess arena;
  // Gemini Pro is top-3; Opus is strong but only with its reasoning on;
  // DeepSeek is a capable-but-volatile wildcard (early collapses seen).
  // GPT 5.5 — PULLED for poker: by far the priciest (~$1.90/100 hands) for no
  // edge over the cheaper ~5s reasoners. Gone for now.
  {
    id: "bankr-grok-4.3",
    label: "Grok 4.3 (Bankr) 🧠",
    baseURL: "https://llm.bankr.bot/v1",
    model: "grok-4.3",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
    avgMs: 5100,
    costPerHandUsd: 0.00465,
  },
  {
    id: "bankr-gemini-3.1-pro",
    label: "Gemini 3.1 Pro (Bankr) 🧠",
    baseURL: "https://llm.bankr.bot/v1",
    model: "gemini-3.1-pro",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
    avgMs: 5100,
    costPerHandUsd: 0.00059,
  },
  // DeepSeek V4 Pro — a heavy reasoner. At baseline it blew the 2048 token cap
  // and returned EMPTY content (auto-folds); low effort makes it answer, but
  // it's still the slowest in the lineup (~30s). Re-added with the dropdown
  // surfacing its speed so it's an informed pick.
  {
    id: "bankr-deepseek-v4-pro",
    label: "DeepSeek V4 Pro (Bankr) 🧠",
    baseURL: "https://llm.bankr.bot/v1",
    model: "deepseek-v4-pro",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
    reasoningEffort: "low",
    avgMs: 28400,
    costPerHandUsd: 0.00165,
  },
  // GLM 5.2 — z.ai's frontier reasoner, a full generation past the
  // GLM 4.7 (Venice) we also run. Reasoning-capable: smoke-tested at
  // ~20s/move with ~110 reasoning tokens, returns a clean UCI move in
  // `content`. 🧠 tier — slow but coherent. GLM's family chess track
  // record is thin (see header note), so watch its early games.
  {
    id: "bankr-glm-5.2",
    label: "GLM 5.2 (Bankr) 🧠",
    baseURL: "https://llm.bankr.bot/v1",
    model: "glm-5.2",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
    avgMs: 7200,
    costPerHandUsd: 0.00331,
  },
  // Kimi K2.6 — PULLED (again) for poker. It's secretly a heavy reasoner
  // (~1800 reasoning tokens), routinely hit the 2048 token cap and returned
  // EMPTY content; even throttled to low effort it was the slowest of the
  // fast-tier and stalled the table. Also the WORST performer at the Kaggle
  // chess arena (lost every game in under 8 moves). Gone for now.
  // Claude Opus 4.8 (Bankr + Venice) and Claude Sonnet 4.6 (Venice) PULLED
  // by request to keep the poker lineup lean.
  // ---- Venice — non-Claude picks ----------------------------------
  // Qwen 3 235B Instruct is the non-thinking sibling of the
  // glacially-slow Qwen 3 Thinking we just rotated out.
  // GLM 4.7 (Venice) — PULLED for poker: slow (~17s/move) AND pricey
  // (~$0.83/100 hands). Gone for now.
  {
    id: "venice-qwen3-instruct",
    label: "Qwen 3 235B Instruct (Venice) ⚡",
    baseURL: "https://api.venice.ai/api/v1",
    model: "qwen3-235b-a22b-instruct-2507",
    envVar: "VENICE_API_KEY",
    avgMs: 1300,
    costPerHandUsd: 0.00055,
  },
  // MiniMax M3 — PULLED for poker. The slowest reasoner in the lineup
  // (~31s/decision; ~12s even throttled to low effort), it stalled the table
  // on a live stream. The M2.x line also had a weak chess track record. Gone
  // for now; revisit if Venice ships a faster variant.
];

const PREFIX = "ai:";

/** Public-facing entry — apiKey + envVar omitted. Safe for /v1
 *  responses + WS broadcasts. */
export type PublicAIPlayer = {
  id: string;
  label: string;
  ownerKey: string;
  model: string;
  /** Measured average decision latency (ms); the poker dropdown shows it and
   *  sorts fastest-first. Undefined if not benchmarked. */
  avgMs?: number;
  /** Rough estimated API cost to play one hand, USD (see AIPlayerConfig). */
  costPerHandUsd?: number;
};

export function listAvailableAIPlayers(): PublicAIPlayer[] {
  return AI_PLAYERS.filter(p => !!process.env[p.envVar]).map(p => ({
    id: p.id,
    label: p.label,
    ownerKey: `${PREFIX}${p.id}`,
    model: p.model,
    avgMs: p.avgMs,
    costPerHandUsd: p.costPerHandUsd,
  }));
}

export function isAIKey(ownerKey: string | null | undefined): boolean {
  return typeof ownerKey === "string" && ownerKey.startsWith(PREFIX);
}

/** Resolve an ownerKey (e.g. "ai:bankr-minimax-m2.7") to its config +
 *  live API key. Returns null if the key isn't an AI, the id is
 *  unknown, or the env var is unset (key was rotated out). */
export function getAIPlayer(ownerKey: string): (AIPlayerConfig & { apiKey: string }) | null {
  if (!isAIKey(ownerKey)) return null;
  // Poker seats carry a per-seat nonce ("ai:<id>#<nonce>") so multiple seats
  // can run the same model — strip it to recover the config id. Chess keys
  // ("ai:<id>") have no suffix, so this is a no-op for them.
  const id = ownerKey.slice(PREFIX.length).split("#", 1)[0]!.toLowerCase();
  const cfg = AI_PLAYERS.find(p => p.id === id);
  if (!cfg) return null;
  const apiKey = process.env[cfg.envVar];
  if (!apiKey) return null;
  return { ...cfg, apiKey };
}

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
   *  ownerKey = `ai:${id}`. Don't change after games have been played
   *  or history rows will orphan. */
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
// Curated for chess: prefer reasoning models that have shown they can
// stay through 30+ moves without coughing up unparseable nonsense.
// MiniMax M2.7 was dropped — chronically resigned 1-4 moves in.
const AI_PLAYERS: AIPlayerConfig[] = [
  // ---- Bankr — flagship reasoners ---------------------------------
  {
    id: "bankr-claude-opus-4.7",
    label: "Claude Opus 4.7 🤖",
    baseURL: "https://llm.bankr.bot/v1",
    model: "claude-opus-4.7",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
  },
  {
    id: "bankr-gpt-5.5",
    label: "GPT 5.5 🤖",
    baseURL: "https://llm.bankr.bot/v1",
    model: "gpt-5.5",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
  },
  {
    id: "bankr-gemini-3.1-pro",
    label: "Gemini 3.1 Pro 🤖",
    baseURL: "https://llm.bankr.bot/v1",
    model: "gemini-3.1-pro",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
  },
  {
    id: "bankr-grok-4.20",
    label: "Grok 4.20 🤖",
    baseURL: "https://llm.bankr.bot/v1",
    model: "grok-4.20",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
  },
  // ---- Bankr — already-proven Ruy-Lopez-grade ---------------------
  {
    id: "bankr-kimi-k2.6",
    label: "Kimi K2.6 🤖",
    baseURL: "https://llm.bankr.bot/v1",
    model: "kimi-k2.6",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
  },
  {
    id: "bankr-deepseek-v4-pro",
    label: "DeepSeek V4 Pro 🤖",
    baseURL: "https://llm.bankr.bot/v1",
    model: "deepseek-v4-pro",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
  },
  // ---- Bankr — cheap & quick (good for lots of test games) --------
  {
    id: "bankr-gpt-5-mini",
    label: "GPT 5-mini 🤖",
    baseURL: "https://llm.bankr.bot/v1",
    model: "gpt-5-mini",
    envVar: "BANKR_API_KEY",
    authStyle: "x-api-key",
  },
  // ---- Venice — different lab + can be unhinged --------------------
  {
    id: "venice-uncensored",
    label: "Venice Uncensored 🤖",
    baseURL: "https://api.venice.ai/api/v1",
    model: "venice-uncensored",
    envVar: "VENICE_API_KEY",
  },
];

const PREFIX = "ai:";

/** Public-facing entry — apiKey + envVar omitted. Safe for /v1
 *  responses + WS broadcasts. */
export type PublicAIPlayer = {
  id: string;
  label: string;
  ownerKey: string;
  model: string;
};

export function listAvailableAIPlayers(): PublicAIPlayer[] {
  return AI_PLAYERS.filter(p => !!process.env[p.envVar]).map(p => ({
    id: p.id,
    label: p.label,
    ownerKey: `${PREFIX}${p.id}`,
    model: p.model,
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
  const id = ownerKey.slice(PREFIX.length);
  const cfg = AI_PLAYERS.find(p => p.id === id);
  if (!cfg) return null;
  const apiKey = process.env[cfg.envVar];
  if (!apiKey) return null;
  return { ...cfg, apiKey };
}

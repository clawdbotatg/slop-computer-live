// Shared client for the Bankr LLM gateway (https://llm.bankr.bot/v1), an
// OpenAI-compatible chat-completions proxy that routes Claude / GPT / etc.
// and bills through Bankr/CLAWD instead of a raw Anthropic key.
//
// Used by the relay's web-search-FREE AI calls — the TLDR summarizer and
// the wallet TX summarizer. Calls that need Anthropic's server-side
// `web_search` tool (glossary-ai, guest-research) deliberately stay on the
// direct Anthropic API: the gateway is OpenAI chat-completions shape and
// exposes no web-search tool, so routing them here would silently kill
// their lookups.
//
// Falls back gracefully (ok:false) when BANKR_LLM_API_KEY is unset so local
// dev without a key still surfaces something useful in each caller.

const BANKR_LLM_API_KEY = process.env.BANKR_LLM_API_KEY ?? "";
const BANKR_LLM_BASE_URL = (process.env.BANKR_LLM_BASE_URL ?? "https://llm.bankr.bot/v1").replace(/\/+$/, "");
const BANKR_LLM_MODEL = process.env.BANKR_LLM_MODEL ?? "claude-sonnet-4.6";

export function hasBankrLlm(): boolean {
  return Boolean(BANKR_LLM_API_KEY);
}

export type BankrMessage = { role: "system" | "user" | "assistant"; content: string };

export type BankrChatOpts = {
  /** Override the gateway model id (e.g. "claude-opus-4.6"). Defaults to
   *  BANKR_LLM_MODEL / claude-sonnet-4.6. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Abort the request after this many ms (default 30s). */
  timeoutMs?: number;
};

export type BankrChatResult = { ok: true; text: string } | { ok: false; error: string };

/** Single-shot chat completion against the Bankr gateway. Returns the
 *  assistant's text (trimmed) on success, or a structured error the caller
 *  can fold into its own fallback. Never throws. */
export async function bankrChat(messages: BankrMessage[], opts: BankrChatOpts = {}): Promise<BankrChatResult> {
  if (!BANKR_LLM_API_KEY) return { ok: false, error: "no-key" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(`${BANKR_LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${BANKR_LLM_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? BANKR_LLM_MODEL,
        max_tokens: opts.maxTokens ?? 1024,
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `${res.status} ${text.slice(0, 160)}` };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim() ?? "";
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

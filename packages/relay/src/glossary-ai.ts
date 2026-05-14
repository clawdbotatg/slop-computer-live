// Short-form term definer for the Glossary app. Takes a term (word /
// phrase / acronym) and asks Claude for a TLDR sentence. Lives next to
// wallet-ai.ts because they share the same Anthropic plumbing — both
// fall back to a useful-but-dumb response when ANTHROPIC_API_KEY isn't
// set so local dev keeps working.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

const FALLBACK_PREFIX = "no AI key set — ";

function fallbackTldr(term: string): string {
  return `${FALLBACK_PREFIX}${term} (set ANTHROPIC_API_KEY on the relay for an AI-written TLDR).`;
}

export type DefineContext = {
  /** Optional disambiguation hint from the user (e.g. "AI agents", "EVM"). */
  hint?: string;
  /** Other terms already in the glossary — used to prime the model toward
   *  the same domain as the rest of the glossary, so once you have a few
   *  AI terms or a few crypto terms in, new entries pick the right
   *  meaning automatically. */
  existingTerms?: string[];
};

export async function defineTerm(term: string, ctx: DefineContext = {}): Promise<string> {
  const trimmed = term.trim();
  if (!trimmed) return "(empty term)";
  if (!ANTHROPIC_API_KEY) return fallbackTldr(trimmed);

  const hint = ctx.hint?.trim() ?? "";
  const others = (ctx.existingTerms ?? [])
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => s.toLowerCase() !== trimmed.toLowerCase())
    .slice(0, 30);

  // The glossary lives inside a podcast/live-discussion product about AI
  // agents, LLM tooling, and developer tools — with crypto/web3 crossover
  // when those topics intersect with AI. Web search is enabled so the
  // model can look up jargon coined in the last year or two (new agents,
  // libraries, frameworks) that's likely past its training cutoff.
  const prompt = `This glossary is for live discussions about AI: agents, LLMs, MCP, tool use, evals, RAG, developer tooling — with occasional crypto / web3 crossover (on-chain agents, agent payments, MEV when it touches AI). Assume an AI-flavored domain by default; only treat the term as crypto-specific if it's an obvious crypto primitive (ERC, EIP, Seaport, Uniswap, etc.).

If you don't recognize the term, or if it's likely very new (a tool, library, agent framework, paper, or piece of jargon from the last year or two), USE WEB SEARCH to look it up. New things drift fast — don't guess from training data alone.

Term: ${trimmed}
${hint ? `Context (user-provided hint): ${hint}` : ""}
${others.length ? `Other terms already in this glossary (use to infer the domain): ${others.join(", ")}` : ""}

OUTPUT FORMAT: Exactly one short sentence (max 30 words) defining the term. Start directly with the definition — do NOT include "I'll search for...", "Based on the search results...", "According to...", or any other preamble. No quotes around the term. No alternatives. No hedging.`.trim();

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
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
        // Server-side web search — the model decides when to invoke it
        // and we get the post-search text back inline. Capped at 2
        // searches per term so a single definition stays under ~$0.02.
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `(AI definition failed: ${res.status}) ${text.slice(0, 120)}`;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    // Take only text blocks that come AFTER the last web_search_tool_result
    // (or all text blocks if no search ran). This skips the model's
    // pre-search "let me look that up" chatter and keeps the final
    // definition clean.
    const blocks = json.content ?? [];
    let lastSearchIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.type === "web_search_tool_result") {
        lastSearchIdx = i;
        break;
      }
    }
    const out = blocks
      .slice(lastSearchIdx + 1)
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join(" ")
      .replace(/^(based on (the )?(search )?results?[,:]?\s*|according to [^,]+,\s*)/i, "")
      .trim();
    return out || fallbackTldr(trimmed);
  } catch (err) {
    return `(AI definition error: ${String(err).slice(0, 100)})`;
  }
}

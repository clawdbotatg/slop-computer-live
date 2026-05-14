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

export async function defineTerm(term: string): Promise<string> {
  const trimmed = term.trim();
  if (!trimmed) return "(empty term)";
  if (!ANTHROPIC_API_KEY) return fallbackTldr(trimmed);

  const prompt = `Define this term in ONE short sentence (max 25 words). The audience is technical but unfamiliar with this specific term. No preamble, no quotes around the term, just the definition.

Term: ${trimmed}

If the term looks crypto/blockchain-adjacent (EIP, ERC, protocol names, tooling), assume that context. If it's ambiguous, pick the most likely meaning and define that — don't list alternatives.`;

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
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `(AI definition failed: ${res.status}) ${text.slice(0, 120)}`;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const out = (json.content ?? [])
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join("\n")
      .trim();
    return out || fallbackTldr(trimmed);
  } catch (err) {
    return `(AI definition error: ${String(err).slice(0, 100)})`;
  }
}

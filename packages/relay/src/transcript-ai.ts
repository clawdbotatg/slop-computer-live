// "Catch me up" summarizer for the Transcript app's TLDR button. Takes
// the recent transcript segments and asks Claude for a few punchy lines
// covering what a newcomer missed. Routes through the Bankr LLM gateway
// (bankr-llm.ts) — no web search needed, so it bills through Bankr instead
// of a raw Anthropic key. Falls back to a useful-but-dumb response when
// BANKR_LLM_API_KEY isn't set so local dev keeps working.

import { bankrChat, hasBankrLlm } from "./bankr-llm.js";

// Cap how much transcript we feed the model. The relay keeps a 500-row
// ring; even a busy room rarely needs more than the last chunk to give a
// useful "what you missed". Bounding the prompt keeps each TLDR cheap and
// fast (this fires on a button click, people are waiting on it).
const MAX_SEGMENTS = 150;
const MAX_PROMPT_CHARS = 12000;

export type TldrSegment = {
  handle: string | null;
  text: string;
  kind?: string;
};

function fallbackTldr(): string {
  return "no AI key set — set BANKR_LLM_API_KEY on the relay for an AI-written TLDR.";
}

export type TldrResult = {
  summary: string;
  /** How many transcript rows the model actually saw, after the cap. Drives
   *  the panel's honest "based on N lines" hint. */
  used: number;
};

export async function summarizeTranscript(segments: TldrSegment[]): Promise<TldrResult> {
  // Cap to the last MAX_SEGMENTS rows. `used` reports the real number that
  // reached the model so the UI doesn't claim it summarized 500 lines when
  // it only saw the last 150.
  const recent = segments.slice(-MAX_SEGMENTS);
  const used = recent.length;
  const transcript = recent
    .map(s => {
      // Action rows (file/chess/wallet/etc.) bake the actor into `.text`, so
      // they get no speaker prefix; speech rows get "handle: ".
      const who = s.kind && s.kind !== "speech" ? "" : `${s.handle ?? "someone"}: `;
      return `${who}${s.text}`;
    })
    .join("\n")
    .slice(-MAX_PROMPT_CHARS);

  if (!transcript.trim()) {
    return { summary: "Nothing's been said yet — the transcript is empty so far.", used };
  }
  if (!hasBankrLlm()) return { summary: fallbackTldr(), used };

  const prompt = `You are catching up a viewer who just walked into a live show / call. Below is the recent transcript (speech + a few narrated room actions like file uploads or chess moves).

Write a TLDR of what they missed: 3–5 short, punchy bullet points, each on its own line starting with "• ". Cover the main topics, decisions, jokes, or moments — the stuff that matters to feel caught up. Be specific and concrete (names, what was actually said), not vague ("they talked about stuff"). Present tense or recent past. No preamble, no "here's the summary", no closing line — just the bullets.

TRANSCRIPT:
${transcript}`.trim();

  const res = await bankrChat([{ role: "user", content: prompt }], { maxTokens: 600 });
  if (!res.ok) {
    return { summary: `(AI TLDR failed: ${res.error})`, used };
  }
  return { summary: res.text || fallbackTldr(), used };
}

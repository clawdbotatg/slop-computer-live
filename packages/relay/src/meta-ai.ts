// Episode-meta generator. Takes the transcript (and optionally chat) from a
// just-finalized show and asks Claude for { title, oneLiner, description,
// topics, chapters }. Output is folded into the manifest so the per-episode
// page on slop.computer can render real metadata instead of "Untitled".
//
// Plumbing mirrors glossary-ai.ts: direct fetch to Anthropic, no SDK,
// graceful fallback to `null` when ANTHROPIC_API_KEY is unset so local
// dev finalizes still work.
//
// Cost: one Opus call per finalize. A 2hr show with dense transcript is
// ~500KB of input + ~3KB out = pennies. Worth the quality.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

type TranscriptLine = {
  ts: number;
  handle: string | null;
  address: string | null;
  text: string;
};

type ChatLine = {
  ts: number;
  handle: string | null;
  address: string | null;
  text: string;
};

export type EpisodeChapter = {
  /** Seconds from the start of the recording. */
  tStart: number;
  title: string;
};

export type EpisodeMeta = {
  title: string;
  oneLiner: string;
  description: string;
  topics: string[];
  chapters: EpisodeChapter[];
  generatedBy: string;
  generatedAt: number;
};

function parseJsonl<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as T);
    } catch {
      /* skip */
    }
  }
  return out;
}

function shortHandle(line: { handle: string | null; address: string | null }): string {
  if (line.handle) return line.handle;
  if (line.address) return line.address.slice(0, 6) + "…" + line.address.slice(-4);
  return "anon";
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Build the Claude prompt: a transcript view with `[HH:MM:SS] handle: text`
 * lines (so the model can pick chapter break points by looking at when the
 * topic shifts), plus a small chat sample for audience vibe. Anchored on
 * the earliest transcript timestamp = t=0 of the recording, which is a
 * close-enough proxy for show-start.
 */
function buildPrompt(opts: {
  transcript: TranscriptLine[];
  chat: ChatLine[];
}): { prompt: string; durationSec: number } {
  const t0 = opts.transcript[0]?.ts ?? Date.now();
  const transcriptLines = opts.transcript
    .map(l => {
      const dt = Math.max(0, (l.ts - t0) / 1000);
      return `[${formatTime(dt)}] ${shortHandle(l)}: ${l.text}`;
    })
    .join("\n");

  const lastTs = opts.transcript[opts.transcript.length - 1]?.ts ?? t0;
  const durationSec = Math.max(0, (lastTs - t0) / 1000);

  // Chat is sampled, not exhaustive — we only want it as a vibe signal,
  // not a second transcript. Take ~30 lines spread across the show.
  const chatSample: string[] = [];
  if (opts.chat.length) {
    const step = Math.max(1, Math.ceil(opts.chat.length / 30));
    for (let i = 0; i < opts.chat.length; i += step) {
      const c = opts.chat[i]!;
      const dt = Math.max(0, (c.ts - t0) / 1000);
      chatSample.push(`[${formatTime(dt)}] ${shortHandle(c)}: ${c.text}`);
    }
  }

  const prompt = `You are writing metadata for an episode of a live podcast/show about AI agents, LLM tooling, developer tools, and occasional crypto/web3 crossover (on-chain agents, agent payments). The transcript below is auto-generated from in-browser speech-to-text — there will be transcription errors; infer charitably.

TRANSCRIPT (speakers are wallet handles / ENS names; timestamps are [H:MM:SS] from the start of the recording):
${transcriptLines}
${chatSample.length ? `\nAUDIENCE CHAT SAMPLE (for vibe / highlight signal — not exhaustive):\n${chatSample.join("\n")}` : ""}

TOTAL DURATION: ${formatTime(durationSec)}

Produce a JSON object with EXACTLY these fields:
- "title": Short, punchy episode title. Max 60 chars. No clickbait, no all-caps, no emoji. Reference the actual topic of the show, not the medium.
- "oneLiner": One sentence (max 140 chars) you'd put under the title on a podcast index page. Specific and concrete — name the actual things discussed.
- "description": 2-4 short paragraphs (~150 words total). Plain prose, no bullet lists, no headers. Mention the speakers by their handles. Describe what was actually covered.
- "topics": Array of 3-7 short topic tags (lowercase, kebab-case or single words, like "agent-payments", "mcp", "evals"). Use what was actually discussed, not generic terms.
- "chapters": Array of 4-10 chapter markers spanning the show. Each has "tStart" (seconds from start, integer) and "title" (short, max 50 chars). Pick real topic shifts, not arbitrary time intervals. First chapter should have tStart 0.

OUTPUT ONLY THE JSON. No preamble, no markdown fences, no trailing commentary. Start with { and end with }.`;

  return { prompt, durationSec };
}

function isEpisodeMetaShape(x: unknown): x is Omit<EpisodeMeta, "generatedBy" | "generatedAt"> {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.title !== "string") return false;
  if (typeof o.oneLiner !== "string") return false;
  if (typeof o.description !== "string") return false;
  if (!Array.isArray(o.topics) || !o.topics.every(t => typeof t === "string")) return false;
  if (!Array.isArray(o.chapters)) return false;
  for (const c of o.chapters as unknown[]) {
    if (!c || typeof c !== "object") return false;
    const ch = c as Record<string, unknown>;
    if (typeof ch.tStart !== "number") return false;
    if (typeof ch.title !== "string") return false;
  }
  return true;
}

/**
 * Generate episode metadata from raw transcript + chat JSONL strings.
 * Returns null on any failure (missing key, API error, malformed JSON) —
 * caller treats meta as optional so a flaky AI call never blocks finalize.
 */
export async function generateEpisodeMeta(opts: {
  transcriptJsonl: string;
  chatJsonl?: string;
}): Promise<EpisodeMeta | null> {
  if (!ANTHROPIC_API_KEY) return null;

  const transcript = parseJsonl<TranscriptLine>(opts.transcriptJsonl);
  if (transcript.length < 3) return null; // not enough to summarize meaningfully

  const chat = opts.chatJsonl ? parseJsonl<ChatLine>(opts.chatJsonl) : [];
  const { prompt } = buildPrompt({ transcript, chat });

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
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.error("[meta-ai] anthropic", res.status, text.slice(0, 200));
      return null;
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const raw = (json.content ?? [])
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join("")
      .trim();
    // The model occasionally wraps in ```json fences despite instructions.
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[meta-ai] JSON parse failed:", String(err).slice(0, 200));
      return null;
    }
    if (!isEpisodeMetaShape(parsed)) {
      // eslint-disable-next-line no-console
      console.error("[meta-ai] unexpected shape", JSON.stringify(parsed).slice(0, 200));
      return null;
    }
    return {
      ...parsed,
      generatedBy: MODEL,
      generatedAt: Date.now(),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[meta-ai] fetch error", String(err).slice(0, 200));
    return null;
  }
}

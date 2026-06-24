// Episode-meta generator. Takes the transcript (and optionally chat) from a
// just-finalized show and asks Claude for { title, oneLiner, description,
// topics, chapters }. Output is folded into the manifest so the per-episode
// page on slop.computer can render real metadata instead of "Untitled".
//
// Two providers, tried in order:
//   1) Bankr's OpenClaw gateway (https://llm.bankr.bot/v1) — same gateway
//      already used by ai-players.ts / ai-mover.ts. OpenAI-compatible shape
//      with an X-API-Key header. Preferred because billing / observability /
//      key rotation already live there.
//   2) Direct Anthropic /v1/messages — fallback for local dev (where only
//      ANTHROPIC_API_KEY is typically set) so finalize still works without
//      pointing at the bankr gateway.
//
// If neither key is set, the call returns null and finalizeRecording ships
// a manifest without `meta`. Best-effort: an AI hiccup never tanks finalize.
//
// Cost: one Opus call per finalize. A 2hr dense show is ~500KB in + ~3KB
// out = pennies either way. Worth the quality.

const BANKR_API_KEY = process.env.BANKR_API_KEY ?? "";
const BANKR_MODEL = process.env.BANKR_META_MODEL ?? "claude-opus-4.7";
const BANKR_URL = "https://llm.bankr.bot/v1/chat/completions";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

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
  /**
   * Seconds into the VOD where playback auto-starts on first load, so viewers
   * skip the pre-episode countdown. Literal seek position (e.g. 155 = 00:02:35).
   * Human-authored via /admin/set-start — NOT produced by the AI pass; it's
   * carried through regenerate/finalize via the manifest spread. Omitted/0 →
   * play from the start.
   */
  startSeconds?: number;
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
/** Authoritative, host-supplied context that the speech-to-text transcript can't
 *  be trusted for: the slug, who actually joined, and the pre-show research
 *  dossier. All optional — every field is best-effort and skipped when absent. */
export type EpisodeContext = {
  /** Host-chosen room slug, e.g. "fucory". Usually encodes the guest's name or
   *  the central topic — the single most reliable spelling we have. */
  slug?: string;
  /** Host's room label (may equal the slug). */
  roomName?: string;
  /** Resolved roster of everyone who joined. Only `handle`-bearing entries are
   *  listed; null-handle peers (SIWE/passkey with no chosen name) are skipped. */
  participants?: {
    address: string | null;
    anonId: string | null;
    handle: string | null;
    role: "host" | "guest";
  }[];
  /** Pre-assembled guest-research dossier text (name, socials, deep research
   *  prose) — packed with correctly-spelled proper nouns. Built by the caller
   *  so this module stays decoupled from the research types. */
  research?: string;
};

/** Render the EPISODE CONTEXT preamble that grounds the model in authoritative
 *  spellings before it reads the error-prone transcript. Returns "" when there's
 *  nothing to say, so the prompt is unchanged for context-less finalizes. */
function buildContextBlock(ctx: EpisodeContext | undefined): string {
  if (!ctx) return "";
  const sections: string[] = [];
  if (ctx.slug) sections.push(`EPISODE SLUG (host-chosen — usually encodes the guest's name or the central topic): "${ctx.slug}"`);
  if (ctx.roomName && ctx.roomName !== ctx.slug) sections.push(`ROOM NAME: "${ctx.roomName}"`);

  const handles: string[] = [];
  const seen = new Set<string>();
  for (const p of ctx.participants ?? []) {
    if (!p.handle || seen.has(p.handle)) continue;
    seen.add(p.handle);
    handles.push(`- ${p.handle} (${p.role})`);
  }
  if (handles.length) {
    sections.push(
      `KNOWN SPEAKERS (authoritative real handles of people who joined; the transcript's speech-to-text often mangles these):\n${handles.join("\n")}`,
    );
  }

  const research = ctx.research?.trim();
  if (research) {
    sections.push(
      `GUEST RESEARCH (host's pre-show dossier — names, projects, and links here are correctly spelled; prefer these spellings over the transcript for any proper noun):\n${research}`,
    );
  }

  if (!sections.length) return "";
  return `EPISODE CONTEXT (authoritative — use these spellings, not the transcript's, when a name or proper noun in the transcript looks like a phonetic garble of something below; do NOT invent names that aren't supported here):\n\n${sections.join("\n\n")}\n\n`;
}

function buildPrompt(opts: {
  transcript: TranscriptLine[];
  chat: ChatLine[];
  /** Wall-clock ms of the video recording start. When known (parsed from the
   *  recording filename) we anchor t=0 here instead of the first transcript
   *  segment, so chapter times line up with the video player's clock rather
   *  than with a pre-show mic-check captured hours earlier. */
  originMs?: number;
  /** Wall-clock ms of the recording end (file mtime) — gives the true video
   *  duration for the cap, independent of trailing post-show chatter. */
  endMs?: number;
  /** Authoritative non-transcript context (slug, roster, research dossier). */
  context?: EpisodeContext;
}): { prompt: string; durationSec: number; t0: number } {
  const t0 = opts.originMs ?? opts.transcript[0]?.ts ?? Date.now();
  const transcriptLines = opts.transcript
    .map(l => {
      const dt = Math.max(0, (l.ts - t0) / 1000);
      return `[${formatTime(dt)}] ${shortHandle(l)}: ${l.text}`;
    })
    .join("\n");

  const lastTs = opts.transcript[opts.transcript.length - 1]?.ts ?? t0;
  const durationSec = opts.endMs != null ? Math.max(0, (opts.endMs - t0) / 1000) : Math.max(0, (lastTs - t0) / 1000);

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

  const contextBlock = buildContextBlock(opts.context);

  const prompt = `You are writing metadata for an episode of a live podcast/show about AI agents, LLM tooling, developer tools, and occasional crypto/web3 crossover (on-chain agents, agent payments). The transcript below is auto-generated from in-browser speech-to-text — there will be transcription errors, especially in names and other proper nouns; infer charitably and correct them against the EPISODE CONTEXT below.

${contextBlock}TRANSCRIPT (speakers are wallet handles / ENS names; timestamps are [H:MM:SS] from the start of the recording):
${transcriptLines}
${chatSample.length ? `\nAUDIENCE CHAT SAMPLE (for vibe / highlight signal — not exhaustive):\n${chatSample.join("\n")}` : ""}

TOTAL DURATION: ${formatTime(durationSec)}

Produce a JSON object with EXACTLY these fields:
- "title": Short, punchy episode title. Max 60 chars. No clickbait, no all-caps, no emoji. Reference the actual topic of the show, not the medium.
- "oneLiner": One sentence (max 140 chars) you'd put under the title on a podcast index page. Specific and concrete — name the actual things discussed.
- "description": 2-4 short paragraphs (~150 words total). Plain prose, no bullet lists, no headers. Mention the speakers by their handles. Describe what was actually covered.
- "topics": Array of 3-7 short topic tags (lowercase, kebab-case or single words, like "agent-payments", "mcp", "evals"). Use what was actually discussed, not generic terms.
- "chapters": Array of 4-10 chapter markers at real topic shifts (not arbitrary time intervals). Each has "title" (short, max 50 chars) and "quote": a verbatim snippet of 6-12 words copied EXACTLY from the transcript line where that topic begins. Copy the words exactly as written above — do NOT paraphrase, do NOT fix transcription errors, and do NOT include the leading [H:MM:SS] timestamp or the speaker handle. Pick a quote that is distinctive (avoid generic filler like "yeah so I think"). The first chapter must mark the very start, quoting the first substantive line of the show. Do NOT output any timestamps — the times are computed from your quotes, so the quote must be findable in the transcript above.

OUTPUT ONLY THE JSON. No preamble, no markdown fences, no trailing commentary. Start with { and end with }.`;

  return { prompt, durationSec, t0 };
}

/** Raw model output: chapters carry a transcript `quote`, not a timestamp.
 *  {@link resolveChapters} turns each quote into a real `tStart`. */
type RawMeta = {
  title: string;
  oneLiner: string;
  description: string;
  topics: string[];
  chapters: { title: string; quote: string }[];
};

function isRawMetaShape(x: unknown): x is RawMeta {
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
    if (typeof ch.title !== "string") return false;
    if (typeof ch.quote !== "string") return false;
  }
  return true;
}

/**
 * Turn the model's chapter *quotes* into real timestamps. Each raw chapter
 * carries a verbatim snippet from the transcript line where the topic begins;
 * we find that line and use ITS server-stamped `ts`. This is the whole point of
 * the design: a chapter time is the time of an actual spoken line, not the
 * model's estimate. Earlier we asked the model for `tStart` directly and it
 * hallucinated values past the end of the show (e.g. `2:18:00` on a 1:00:24
 * recording). A quote that can't be located is DROPPED, never faked — so the
 * worst case is fewer chapters, never wrong ones. Output is sorted, deduped,
 * range-clamped to the real duration, and the first marker is pinned to 0.
 */
function resolveChapters(
  raw: { title: string; quote: string }[],
  transcript: TranscriptLine[],
  t0: number,
  durationSec: number,
): EpisodeChapter[] {
  // Lowercase, strip punctuation, collapse whitespace — so a quote matches the
  // transcript line despite casing/punctuation differences in the STT output.
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const segs = transcript.map(l => ({ ts: l.ts, n: norm(l.text) }));

  // Locate the transcript segment a quote came from, return its absolute ts.
  const matchTs = (quote: string): number | null => {
    const q = norm(quote);
    if (q.length < 4) return null;
    // 1) Exact normalized substring — the common case when the model copies.
    //    If the phrase appears in more than one segment it isn't distinctive
    //    enough to anchor a time, so drop it rather than guess the wrong one.
    const exact = segs.filter(s => s.n.includes(q));
    if (exact.length === 1) return exact[0]!.ts;
    if (exact.length > 1) return null;
    // 2) STT garbles/drops words, so fall back to best word-overlap. Require a
    //    strong majority of the quote's words in one segment, otherwise we'd
    //    anchor to an unrelated line that merely shares a common word.
    const qWords = q.split(" ").filter(w => w.length > 2);
    if (qWords.length < 3) return null;
    let best: { ts: number; score: number } | null = null;
    for (const s of segs) {
      const sw = new Set(s.n.split(" "));
      const score = qWords.filter(w => sw.has(w)).length / qWords.length;
      if (!best || score > best.score) best = { ts: s.ts, score };
    }
    return best && best.score >= 0.7 ? best.ts : null;
  };

  // 2s of slack past the transcript end: the final segment can land a hair
  // before the true end of the video, and a legit closing chapter is fine.
  const cap = Math.floor(durationSec) + 2;
  const seen = new Set<number>();
  const resolved = raw
    .map(ch => {
      const ts = matchTs(ch.quote);
      if (ts == null) return null;
      return { tStart: Math.max(0, Math.floor((ts - t0) / 1000)), title: ch.title };
    })
    .filter((c): c is EpisodeChapter => c !== null)
    .filter(c => c.tStart <= cap)
    .sort((a, b) => a.tStart - b.tStart)
    .filter(c => (seen.has(c.tStart) ? false : (seen.add(c.tStart), true)));
  if (resolved.length && resolved[0]!.tStart !== 0) resolved[0]!.tStart = 0;
  return resolved;
}

// Pull a clean JSON string out of the model's raw text. The instruction says
// "OUTPUT ONLY THE JSON" but Opus occasionally still wraps it in ```json
// fences or prefixes a sentence — strip both.
function extractJsonText(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/** Bankr OpenClaw gateway — OpenAI /chat/completions shape, X-API-Key auth. */
async function callBankr(prompt: string): Promise<{ text: string; model: string } | null> {
  if (!BANKR_API_KEY) return null;
  try {
    const res = await fetch(BANKR_URL, {
      method: "POST",
      headers: {
        "x-api-key": BANKR_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: BANKR_MODEL,
        max_tokens: 4096,
        // Slight temperature so titles aren't bone-dry; description is the
        // long form anyway and benefits from a little voice.
        temperature: 0.4,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.error("[meta-ai] bankr", res.status, text.slice(0, 200));
      return null;
    }
    const data = (await res.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }> }
      | null;
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return { text, model: `bankr:${BANKR_MODEL}` };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[meta-ai] bankr fetch error", String(err).slice(0, 200));
    return null;
  }
}

/** Direct Anthropic /v1/messages — used as a fallback if Bankr isn't
 *  configured or returns nothing. */
async function callAnthropic(prompt: string): Promise<{ text: string; model: string } | null> {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
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
    const text = (json.content ?? [])
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join("")
      .trim();
    if (!text) return null;
    return { text, model: `anthropic:${ANTHROPIC_MODEL}` };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[meta-ai] anthropic fetch error", String(err).slice(0, 200));
    return null;
  }
}

/**
 * Generate episode metadata from raw transcript + chat JSONL strings.
 * Returns null on any failure (no keys, API error, malformed JSON) —
 * caller treats meta as optional so a flaky AI call never blocks finalize.
 */
export async function generateEpisodeMeta(opts: {
  transcriptJsonl: string;
  chatJsonl?: string;
  /** Wall-clock ms the video recording started / ended (from the recording
   *  filename and its mtime). When provided, the transcript + chat are trimmed
   *  to this window and t=0 is anchored to the recording start. This is what
   *  keeps chapter times aligned to the video: the on-disk transcript also
   *  accumulates pre-show mic-checks and post-show chatter that would otherwise
   *  anchor t0 hours early and push every chapter past the end of the video. */
  videoStartMs?: number;
  videoEndMs?: number;
  /** Host-chosen room slug — usually the most reliable spelling of the guest's
   *  name or the central topic. */
  slug?: string;
  /** Host's room label. */
  roomName?: string;
  /** Resolved participant roster (handle-bearing entries are listed in the prompt). */
  participants?: EpisodeContext["participants"];
  /** Pre-assembled guest-research dossier text (correctly-spelled proper nouns). */
  research?: string;
}): Promise<EpisodeMeta | null> {
  if (!BANKR_API_KEY && !ANTHROPIC_API_KEY) return null;

  let transcript = parseJsonl<TranscriptLine>(opts.transcriptJsonl);
  let chat = opts.chatJsonl ? parseJsonl<ChatLine>(opts.chatJsonl) : [];

  // Trim to the actual recording window when we know it. 5s of grace at each
  // edge so a line that straddles the boundary isn't lost.
  const { videoStartMs, videoEndMs } = opts;
  if (videoStartMs != null && videoEndMs != null && videoEndMs > videoStartMs) {
    const lo = videoStartMs - 5000;
    const hi = videoEndMs + 5000;
    const inWindow = <T extends { ts: number }>(x: T) => x.ts >= lo && x.ts <= hi;
    transcript = transcript.filter(inWindow);
    chat = chat.filter(inWindow);
  }

  if (transcript.length < 3) return null; // not enough to summarize meaningfully

  const { prompt, durationSec, t0 } = buildPrompt({
    transcript,
    chat,
    originMs: videoStartMs,
    endMs: videoEndMs,
    context: {
      slug: opts.slug,
      roomName: opts.roomName,
      participants: opts.participants,
      research: opts.research,
    },
  });

  // Prefer Bankr; fall back to direct Anthropic if it's not configured or
  // the call fails. The fallback matters for local dev where typically only
  // ANTHROPIC_API_KEY is set.
  const result = (await callBankr(prompt)) ?? (await callAnthropic(prompt));
  if (!result) return null;

  const stripped = extractJsonText(result.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[meta-ai] JSON parse failed:", String(err).slice(0, 200));
    return null;
  }
  if (!isRawMetaShape(parsed)) {
    // eslint-disable-next-line no-console
    console.error("[meta-ai] unexpected shape", JSON.stringify(parsed).slice(0, 200));
    return null;
  }
  return {
    title: parsed.title,
    oneLiner: parsed.oneLiner,
    description: parsed.description,
    topics: parsed.topics,
    chapters: resolveChapters(parsed.chapters, transcript, t0, durationSec),
    generatedBy: result.model,
    generatedAt: Date.now(),
  };
}

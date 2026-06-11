// Guest research — pre-show prep for whoever's about to be on the mic.
// Hands a name + socials to Claude and gets back:
//   • a "socials desc" — hype episode-preview blurb in the SlopComputer
//     voice (no tools), grounded in the researched dossier. Shown first.
//   • vanilla model knowledge (no tools — just what training data has)
//   • a researched description + recent-tweets summary + interview
//     questions (Claude with web_search tool, grounded additionally in
//     the room's corpus docs — host-pasted articles/tweets/notes from
//     research-corpus.ts, tiled into the prompt)
//   • raw sources (tweets + research links) so the host can scan them
//
// The vanilla + researched calls run in parallel; the socials desc runs
// after so it can ground itself in the research. Each stage is
// independent and fault-tolerant: if one fails the others still return.
// The endpoint folds them together into a single ResearchResult.
//
// Requires ANTHROPIC_API_KEY on the relay; without it we return a
// stubbed response that tells the user what to set.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const MODEL = process.env.ANTHROPIC_RESEARCH_MODEL ?? "claude-opus-4-7";

export type Socials = {
  twitter?: string;
  github?: string;
  linkedin?: string;
  website?: string;
  other?: string;
};

export type ResearchQuery = {
  name: string;
  socials: Socials;
  /** Free-form extra context the host knows about the guest. */
  notes?: string;
};

/** A corpus doc as the AI sees it — just name + body. The relay maps
 *  room.researchCorpus.list() down to this before each call. */
export type CorpusInput = {
  name: string;
  text: string;
};

export type TweetSnippet = {
  text: string;
  url?: string;
  date?: string;
};

export type ResearchSource = {
  title: string;
  url: string;
  snippet?: string;
};

export type ResearchResult = {
  query: ResearchQuery;
  /** Hype/promo "socials desc" — an episode preview blurb in the
   *  SlopComputer voice, grounded in the researched dossier. Shown first. */
  socialsDesc: string;
  vanilla: string;
  researched: string;
  questions: string[];
  tweets: TweetSnippet[];
  sources: ResearchSource[];
  /** Names + sizes of the corpus docs that were tiled into the research
   *  prompt, so the dossier shows what host context grounded it. */
  corpusDocs: { name: string; chars: number }[];
  /** Per-stage errors so the UI can show what failed without hiding partial results. */
  errors: { socialsDesc?: string; vanilla?: string; researched?: string };
};

// `includeNotes` is false for the vanilla pass: the vanilla call must
// reflect ONLY the model's training-data knowledge, never regurgitate
// the host's own notes back at us padded with "based on what you said".
function describeQuery(q: ResearchQuery, includeNotes = true): string {
  const lines: string[] = [`Name: ${q.name}`];
  if (q.socials.twitter) lines.push(`Twitter / X: ${q.socials.twitter}`);
  if (q.socials.github) lines.push(`GitHub: ${q.socials.github}`);
  if (q.socials.linkedin) lines.push(`LinkedIn: ${q.socials.linkedin}`);
  if (q.socials.website) lines.push(`Website: ${q.socials.website}`);
  if (q.socials.other) lines.push(`Other: ${q.socials.other}`);
  if (includeNotes && q.notes) lines.push(`Host notes: ${q.notes}`);
  return lines.join("\n");
}

// Tile every corpus doc into one prompt section. `maxTotalChars`
// budgets the combined body text — the deep dossier can afford more
// context than the fast lookup. Docs past the budget are named but
// their bodies omitted, so the model at least knows they exist.
// The vanilla pass NEVER sees this (same rule as host notes — it must
// reflect training data only).
function corpusContextBlock(docs: CorpusInput[], maxTotalChars: number): string {
  const nonEmpty = docs.filter(d => d.text.trim());
  if (nonEmpty.length === 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (const d of nonEmpty) {
    const name = d.name.trim() || "untitled";
    const remaining = maxTotalChars - used;
    if (remaining <= 0) {
      parts.push(`--- ${name} — content omitted (context budget exhausted) ---`);
      continue;
    }
    const body = d.text.trim().slice(0, remaining);
    used += body.length;
    parts.push(`--- ${name} ---\n${body}`);
  }
  return `\n\nThe host also collected these source documents about the guest (pasted tweets, article text, notes — verbatim, may be messy). Treat them as host-provided context that SUPPLEMENTS your own research — still run your own searches, and prefer fresher information when they conflict:\n\n${parts.join("\n\n")}`;
}

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicContentBlock = AnthropicTextBlock | { type: string; [k: string]: unknown };
type AnthropicResponse = {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  error?: { message?: string };
};

function extractText(json: AnthropicResponse): string {
  return (json.content ?? [])
    .filter((c): c is AnthropicTextBlock => c.type === "text" && typeof (c as AnthropicTextBlock).text === "string")
    .map(c => c.text)
    .join("\n")
    .trim();
}

async function callAnthropic(body: Record<string, unknown>): Promise<AnthropicResponse> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as AnthropicResponse;
}

// The show's identity, in its own words. Fed verbatim into the socials
// blurb so the promo copy stays on-voice instead of drifting into
// generic podcast-announcement mush.
const SLOP_ETHOS = `SlopComputer is an onchain podcast for technical humans building with AI: the cypherpunks, the sloperators, the forward deployed context goblins. Join the psychosis to build our way out of the permanent underclass.`;

// Socials desc — no tools. A hype "episode preview" blurb the host can
// drop straight onto X to announce the guest. Grounded in the researched
// dossier (passed in) so the copy references real, specific things about
// the guest rather than hallucinating. If research failed we still
// produce something off the model's own knowledge + the form fields.
async function socialsDescription(q: ResearchQuery, researchedContext: string): Promise<string> {
  const ctx = researchedContext.trim()
    ? `\n\nHere's what research turned up about the guest — ground the copy in these real, specific facts:\n${researchedContext.trim()}`
    : "";
  const prompt = `You're writing a short social blurb for an upcoming SlopComputer episode featuring this guest — the "socials desc" that goes out on X/Farcaster.

The show, in its own voice:
${SLOP_ETHOS}

Guest:
${describeQuery(q)}${ctx}

Write the blurb. It must:
- lightly introduce THIS specific guest: who they are and what makes them genuinely interesting, in combination with the SlopComputer frame above.
- read like in-the-know hype copy, not a Wikipedia bio — energetic, a little unhinged, but real.
- do NOT speculate or promise what the conversation will cover, what they'll "dig into," or what the audience will "learn." Just set up the person and why they fit the show.

Output rules — follow exactly: ONE short paragraph (2–4 sentences). No headings, no bullet lists, no preamble like "Here's the preview:". No hashtags unless one genuinely earns its place. Just the copy.`;
  const json = await callAnthropic({
    model: MODEL,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });
  return extractText(json) || "(model returned empty response)";
}

// Vanilla pass — no tools. We want a baseline of "what does the model
// already know about this person from its training data?" so the host
// can spot stale facts vs. fresh research.
async function vanillaKnowledge(q: ResearchQuery): Promise<string> {
  const prompt = `Based ONLY on your training data (NOT host notes, NOT speculation, NOT inference from handles), what do you know about this person?

${describeQuery(q, false)}

Output rules — follow exactly:
- If you do not have reliable training-data knowledge of this specific person, respond with EXACTLY this one sentence and NOTHING ELSE: "I don't have knowledge of them in my training data."
- If you do have knowledge, respond with 1–3 short prose paragraphs of what you actually know. No bullets, no headings, no preamble like "Based on my training data…", no closing summary, no caveats about recommending the host ask them directly. Just the facts.
- Never combine the two modes. Never say "I don't have reliable info BUT…". You either know them or you don't.`;
  const json = await callAnthropic({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });
  return extractText(json) || "(model returned empty response)";
}

// Researched pass — web_search tool enabled. Claude does multiple
// searches, reads tweets, and emits XML-style tags we extract with
// per-tag regex. We *chose* tags over JSON because:
//   • Prose with raw newlines in JSON strings breaks JSON.parse.
//     Tagged sections survive any text content as long as the tag
//     names themselves don't appear inside the prose.
//   • Web-search runs interleave model narration ("let me search for…")
//     between tool calls — that prose ends up in the response. With
//     per-tag extractors, leading narration just gets ignored.
//   • If the response truncates mid-output (max_tokens hit), already-
//     emitted tags are still recoverable; with a single JSON object
//     you lose everything.
async function researchedReport(
  q: ResearchQuery,
  corpusContext: string,
): Promise<{
  researched: string;
  questions: string[];
  tweets: TweetSnippet[];
  sources: ResearchSource[];
}> {
  const twitterHandle = (q.socials.twitter ?? "").replace(/^@/, "").trim();
  const twitterHint = twitterHandle
    ? `Their Twitter/X handle is @${twitterHandle}. Search "@${twitterHandle}", "${twitterHandle} twitter", and "site:twitter.com ${twitterHandle}" or "site:x.com ${twitterHandle}". Pull out 5–15 actual recent tweets if you can find them.`
    : `No Twitter handle was provided — try to discover one if possible, otherwise focus on other sources.`;

  const prompt = `You're prepping a podcast/show host for an interview with this guest. Research them on the public web and return a dossier.

Guest:
${describeQuery(q)}${corpusContext}

${twitterHint}

Also search for:
- recent talks, podcast appearances, blog posts, GitHub activity (if a handle was given)
- news mentions in the last 6–12 months
- what they're currently working on or excited about

When done, emit ONLY the following XML-style tags. No JSON, no code fences, no preamble, no summary. Just the tags. Plain text inside tags is fine (newlines OK). Never invent URLs, handles, or quotes — omit a tag if you don't have real content for it.

<researched>
2–4 paragraphs of prose describing who they are, what they're known for, what they're working on right now, and their general vibe / interests. Cite specific recent things. No bullet lists.
</researched>

<questions>
1. First question
2. Second question
…
8–10 questions total. Slow-pitch, conversation-starting, things THIS guest would clearly enjoy talking about based on their recent tweets / posts / work. Specific to them, not generic.
</questions>

<tweet date="YYYY-MM-DD" url="https://x.com/handle/status/123">
Verbatim tweet text. Multiple <tweet> tags are fine — emit 5–15 if you found them.
</tweet>

<source url="https://…" title="Page title">
1-line takeaway. One <source> tag per cited page.
</source>

Final reminder: emit nothing outside these tags. Don't wrap them in markdown or code fences. Don't summarize after.`;

  const json = await callAnthropic({
    model: MODEL,
    max_tokens: 8000,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 12,
      },
    ],
    messages: [{ role: "user", content: prompt }],
  });

  const text = extractText(json);
  return parseDossierTags(text);
}

// Lowercased attribute lookup. Models sometimes emit Title="…" or URL="…"
// — fold both cases so we don't lose data over capitalization.
function attr(attrs: string, key: string): string | undefined {
  const re = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`, "i");
  const m = attrs.match(re);
  const val = m?.[1]?.trim();
  return val ? val : undefined;
}

// Split a <questions> block into individual questions. Accepts either
// "1. text" / "1) text" numbered list or one-per-line plain text.
function splitQuestions(block: string): string[] {
  const lines = block
    .split(/\n+/)
    .map(l => l.replace(/^\s*(?:\d+\s*[.)\-:]\s*|[-*]\s+)/, "").trim())
    .filter(l => l.length > 0);
  return lines;
}

function parseDossierTags(text: string): {
  researched: string;
  questions: string[];
  tweets: TweetSnippet[];
  sources: ResearchSource[];
} {
  const researched = (text.match(/<researched>([\s\S]*?)<\/researched>/i)?.[1] ?? "").trim();
  const questionsBlock = (text.match(/<questions>([\s\S]*?)<\/questions>/i)?.[1] ?? "").trim();
  const questions = questionsBlock ? splitQuestions(questionsBlock) : [];

  const tweets: TweetSnippet[] = [];
  const tweetRe = /<tweet\b([^>]*)>([\s\S]*?)<\/tweet>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tweetRe.exec(text))) {
    const attrs = tm[1] ?? "";
    const body = (tm[2] ?? "").trim();
    if (!body) continue;
    tweets.push({
      text: body,
      url: attr(attrs, "url"),
      date: attr(attrs, "date"),
    });
  }

  const sources: ResearchSource[] = [];
  const sourceRe = /<source\b([^>]*)>([\s\S]*?)<\/source>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = sourceRe.exec(text))) {
    const attrs = sm[1] ?? "";
    const url = attr(attrs, "url") ?? "";
    const title = attr(attrs, "title") ?? "";
    if (!url || !title) continue;
    const snippet = (sm[2] ?? "").trim();
    sources.push({ url, title, snippet: snippet || undefined });
  }

  // If the model emitted no recognizable tags at all, surface the raw
  // text in the researched section so the host at least sees what the
  // model said rather than an empty UI.
  if (!researched && questions.length === 0 && tweets.length === 0 && sources.length === 0) {
    return { researched: text.trim() || "(no research output)", questions: [], tweets: [], sources: [] };
  }

  return { researched, questions, tweets, sources };
}

// Pulls the first ```json … ``` block out of the model's reply.
// Falls back to the first bare {…} if the model forgot the fence.
// Used by lookupGuest below — the dossier call uses XML tags instead.
function parseJsonBlock(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  if (!candidate) return null;
  // Find the outermost balanced { … }.
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type LookupResult = {
  name: string;
  socials: Socials;
  /** 1–2 sentence identity sketch the host can verify before deeper research. */
  notes: string;
  /** Set when ANTHROPIC_API_KEY is missing or the call failed. */
  error?: string;
};

// Quick "who is this?" pass. The host types a name OR an @handle into
// one box, and we get back a best-guess identity card to prefill the
// full form. Single Claude call with web_search — keeps it fast so the
// pre-show flow is snappy. The deep research call runs separately
// later, after the host has had a chance to edit the prefill.
// Corpus docs (if the host pasted any) are tiled in with a small
// budget — pasted material usually pins down identity faster than a
// web search can.
export async function lookupGuest(query: string, corpus: CorpusInput[] = []): Promise<LookupResult> {
  const trimmed = query.trim();
  if (!trimmed) return { name: "", socials: {}, notes: "", error: "empty-query" };
  if (!ANTHROPIC_API_KEY) {
    return {
      name: "",
      socials: {},
      notes: "",
      error: "ANTHROPIC_API_KEY not set on the relay — add it to packages/relay/.env to enable lookup.",
    };
  }

  const prompt = `A show host typed this into a "who's our next guest?" box. Figure out who they mean and pull together their public socials.

Input: "${trimmed}"${corpusContextBlock(corpus, 8_000)}

It might be a full name, a single name, a Twitter/X handle (with or without @), a GitHub handle, or a URL. Use web search to disambiguate. If multiple public people match, pick the most likely well-known one and say which one you picked in "notes".

Return EXACTLY ONE fenced \`\`\`json … \`\`\` code block (no prose before or after) matching this schema:

{
  "name": "best guess of their full name — empty string if you genuinely cannot resolve",
  "twitter":  "@handle (KEEP the @ prefix), or empty string if unknown",
  "github":   "github username (no @), or empty string",
  "linkedin": "full linkedin URL, or empty string",
  "website":  "their personal site URL, or empty string",
  "other":    "any other notable handle/profile (farcaster, warpcast, mirror, telegram, etc.), or empty string",
  "notes":    "1–2 sentences telling the host who you think this is so they can verify before deeper research"
}

Never invent handles. If you're not sure a handle is correct, leave it empty.`;

  try {
    const json = await callAnthropic({
      model: MODEL,
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractText(json);
    const parsed = parseJsonBlock(text);
    if (!parsed) {
      return { name: "", socials: {}, notes: text.slice(0, 300), error: "could-not-parse-model-output" };
    }
    const str = (k: string): string | undefined => {
      const v = parsed[k];
      if (typeof v !== "string") return undefined;
      const t = v.trim();
      return t ? t : undefined;
    };
    return {
      name: str("name") ?? "",
      socials: {
        twitter: str("twitter"),
        github: str("github"),
        linkedin: str("linkedin"),
        website: str("website"),
        other: str("other"),
      },
      notes: str("notes") ?? "",
    };
  } catch (err) {
    return { name: "", socials: {}, notes: "", error: String(err).slice(0, 400) };
  }
}

export async function researchGuest(q: ResearchQuery, corpus: CorpusInput[] = []): Promise<ResearchResult> {
  // Summarized (name + size, never the bodies) into the result so the
  // dossier can show what host context the research was grounded in.
  const corpusDocs = corpus.filter(d => d.text.trim()).map(d => ({ name: d.name.trim() || "untitled", chars: d.text.trim().length }));

  if (!ANTHROPIC_API_KEY) {
    const missing = "ANTHROPIC_API_KEY not set on the relay — add it to packages/relay/.env to enable AI research.";
    return {
      query: q,
      socialsDesc: "",
      vanilla: "",
      researched: "",
      questions: [],
      tweets: [],
      sources: [],
      corpusDocs,
      errors: { socialsDesc: missing, vanilla: missing, researched: missing },
    };
  }

  const [vanillaR, researchedR] = await Promise.allSettled([
    vanillaKnowledge(q),
    researchedReport(q, corpusContextBlock(corpus, 24_000)),
  ]);

  const result: ResearchResult = {
    query: q,
    socialsDesc: "",
    vanilla: "",
    researched: "",
    questions: [],
    tweets: [],
    sources: [],
    corpusDocs,
    errors: {},
  };

  if (vanillaR.status === "fulfilled") result.vanilla = vanillaR.value;
  else result.errors.vanilla = String(vanillaR.reason).slice(0, 400);

  if (researchedR.status === "fulfilled") {
    result.researched = researchedR.value.researched;
    result.questions = researchedR.value.questions;
    result.tweets = researchedR.value.tweets;
    result.sources = researchedR.value.sources;
  } else {
    result.errors.researched = String(researchedR.reason).slice(0, 400);
  }

  // Socials desc runs last so it can ground its hype copy in whatever the
  // researched dossier turned up. It's no-tools and fast; the small added
  // latency buys promo copy that references real, specific facts instead
  // of inventing them. Falls back to model knowledge if research failed.
  try {
    result.socialsDesc = await socialsDescription(q, result.researched);
  } catch (err) {
    result.errors.socialsDesc = String(err).slice(0, 400);
  }

  return result;
}

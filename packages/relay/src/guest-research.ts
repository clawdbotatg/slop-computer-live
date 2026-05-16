// Guest research — pre-show prep for whoever's about to be on the mic.
// Hands a name + socials to Claude and gets back:
//   • vanilla model knowledge (no tools — just what training data has)
//   • a researched description + recent-tweets summary + interview
//     questions (Claude with web_search tool)
//   • raw sources (tweets + research links) so the host can scan them
//
// Two Claude calls run in parallel. Each one is independent and
// fault-tolerant: if one fails the other still returns. The endpoint
// folds them together into a single ResearchResult.
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
  vanilla: string;
  researched: string;
  questions: string[];
  tweets: TweetSnippet[];
  sources: ResearchSource[];
  /** Per-stage errors so the UI can show what failed without hiding partial results. */
  errors: { vanilla?: string; researched?: string };
};

function describeQuery(q: ResearchQuery): string {
  const lines: string[] = [`Name: ${q.name}`];
  if (q.socials.twitter) lines.push(`Twitter / X: ${q.socials.twitter}`);
  if (q.socials.github) lines.push(`GitHub: ${q.socials.github}`);
  if (q.socials.linkedin) lines.push(`LinkedIn: ${q.socials.linkedin}`);
  if (q.socials.website) lines.push(`Website: ${q.socials.website}`);
  if (q.socials.other) lines.push(`Other: ${q.socials.other}`);
  if (q.notes) lines.push(`Host notes: ${q.notes}`);
  return lines.join("\n");
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

// Vanilla pass — no tools. We want a baseline of "what does the model
// already know about this person from its training data?" so the host
// can spot stale facts vs. fresh research.
async function vanillaKnowledge(q: ResearchQuery): Promise<string> {
  const prompt = `You're prepping the host for an interview. Based ONLY on your training data (do NOT make anything up, do NOT speculate), describe what you know about this person:

${describeQuery(q)}

Rules:
- 2–5 short paragraphs.
- If you don't recognize them or only weakly recognize them, SAY SO plainly in one line (e.g. "I don't have reliable information about this person in my training data.").
- Don't hedge with weasel words. Either you know it or you don't.
- No bullet lists, no headings. Prose.`;
  const json = await callAnthropic({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });
  return extractText(json) || "(model returned empty response)";
}

// Researched pass — web_search tool enabled. Claude does multiple
// searches, reads tweets, and returns structured JSON. We parse the
// JSON out of the final text block.
async function researchedReport(q: ResearchQuery): Promise<{
  researched: string;
  questions: string[];
  tweets: TweetSnippet[];
  sources: ResearchSource[];
}> {
  const twitterHandle = (q.socials.twitter ?? "").replace(/^@/, "").trim();
  const twitterHint = twitterHandle
    ? `Their Twitter/X handle is @${twitterHandle}. Search "@${twitterHandle}", "${twitterHandle} twitter", and "site:twitter.com ${twitterHandle}" or "site:x.com ${twitterHandle}". Pull out 5–15 actual recent tweets if you can find them.`
    : `No Twitter handle was provided — try to discover one if possible, otherwise focus on other sources.`;

  const prompt = `You're prepping a podcast/show host for an interview with this guest. Research them on the public web and return a JSON report.

Guest:
${describeQuery(q)}

${twitterHint}

Also search for:
- recent talks, podcast appearances, blog posts, GitHub activity (if a handle was given)
- news mentions in the last 6–12 months
- what they're currently working on or excited about

When you're done researching, respond with EXACTLY ONE fenced \`\`\`json … \`\`\` code block (no prose before or after) matching this schema:

{
  "researched": "2–4 paragraphs of prose describing who they are, what they're known for, what they're working on right now, and their general vibe / interests. Cite specific recent things. No bullet lists.",
  "questions": [
    "8 to 10 interview questions — slow-pitch, conversation-starting, things THIS person would clearly enjoy talking about based on what they've recently tweeted / posted / built. Make them specific to this guest, not generic."
  ],
  "tweets": [
    { "text": "verbatim tweet text", "url": "https://x.com/handle/status/...", "date": "YYYY-MM-DD or approximate" }
  ],
  "sources": [
    { "title": "page title", "url": "https://…", "snippet": "1-line takeaway" }
  ]
}

If you can't find tweets, return an empty array — don't invent them. Same for sources. Never fabricate URLs or quotes.`;

  const json = await callAnthropic({
    model: MODEL,
    max_tokens: 4096,
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
  const parsed = parseJsonBlock(text);
  if (!parsed) {
    return {
      researched: text || "(no research output)",
      questions: [],
      tweets: [],
      sources: [],
    };
  }
  return {
    researched: typeof parsed.researched === "string" ? parsed.researched : "",
    questions: Array.isArray(parsed.questions) ? parsed.questions.filter((x: unknown): x is string => typeof x === "string") : [],
    tweets: Array.isArray(parsed.tweets) ? parsed.tweets.filter(isTweetSnippet) : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources.filter(isResearchSource) : [],
  };
}

function isTweetSnippet(x: unknown): x is TweetSnippet {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return typeof t.text === "string" && t.text.length > 0;
}

function isResearchSource(x: unknown): x is ResearchSource {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return typeof s.title === "string" && typeof s.url === "string";
}

// Pulls the first ```json … ``` block out of the model's reply.
// Falls back to the first bare {…} if the model forgot the fence.
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
export async function lookupGuest(query: string): Promise<LookupResult> {
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

Input: "${trimmed}"

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

export async function researchGuest(q: ResearchQuery): Promise<ResearchResult> {
  if (!ANTHROPIC_API_KEY) {
    return {
      query: q,
      vanilla: "",
      researched: "",
      questions: [],
      tweets: [],
      sources: [],
      errors: {
        vanilla: "ANTHROPIC_API_KEY not set on the relay — add it to packages/relay/.env to enable AI research.",
        researched: "ANTHROPIC_API_KEY not set on the relay — add it to packages/relay/.env to enable AI research.",
      },
    };
  }

  const [vanillaR, researchedR] = await Promise.allSettled([vanillaKnowledge(q), researchedReport(q)]);

  const result: ResearchResult = {
    query: q,
    vanilla: "",
    researched: "",
    questions: [],
    tweets: [],
    sources: [],
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

  return result;
}

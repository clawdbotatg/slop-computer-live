import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Per-episode TLDR — the tweet Austin posts after each episode (3-5 bullet
// lessons for sloperators). Keyed by the on-chain episode slug, NOT the relay
// room slug. Host pastes it in the admin page; the episode page and
// episodes.json read it from here so nothing needs a setManifest tx. Whenever
// a manifest is re-pinned for another reason (regenerate / set-start) the
// stored TLDR is folded into `meta.tldr` so the on-chain record catches up.
//
// Same persistence shape as glossary: JSON snapshot on disk, in-memory cache.

const TLDR_FILE = process.env.EPISODE_TLDR_FILE ?? "./.slop-data/episode-tldr.json";
const MAX_TEXT_LEN = 2000;
const MAX_URL_LEN = 300;

export type EpisodeTldr = {
  /** The tweet body, verbatim (bullets and all). */
  text: string;
  /** Link to the posted tweet. May be empty if not posted yet. */
  url: string;
  updatedTs: number;
  /** Host address that saved it. */
  address: string | null;
};

let items: Record<string, EpisodeTldr> = {};
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(TLDR_FILE, "utf8")) as { items?: unknown };
    if (parsed.items && typeof parsed.items === "object") items = parsed.items as Record<string, EpisodeTldr>;
  } catch {
    /* fresh */
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(TLDR_FILE), { recursive: true });
    writeFileSync(TLDR_FILE, JSON.stringify({ items }), "utf8");
  } catch {
    /* in-memory state still served */
  }
}

const cleanSlug = (slug: string): string => slug.trim().toLowerCase();

export function getEpisodeTldr(slug: string): EpisodeTldr | null {
  load();
  return items[cleanSlug(slug)] ?? null;
}

export function listEpisodeTldrs(): Record<string, EpisodeTldr> {
  load();
  return { ...items };
}

/** Save (or, with empty text, clear) an episode's TLDR. Returns the stored row or null when cleared. */
export function setEpisodeTldr(opts: {
  slug: string;
  text: string;
  url: string;
  address: string | null;
}): EpisodeTldr | null {
  load();
  const slug = cleanSlug(opts.slug);
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error("bad slug");
  const text = opts.text.replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT_LEN);
  const url = opts.url.trim().slice(0, MAX_URL_LEN);
  if (url && !/^https?:\/\//.test(url)) throw new Error("url must start with http(s)://");
  if (!text) {
    delete items[slug];
    persist();
    return null;
  }
  const row: EpisodeTldr = { text, url, updatedTs: Date.now(), address: opts.address };
  items[slug] = row;
  persist();
  return row;
}

/** The subset that gets folded into a manifest's `meta.tldr` (no author). */
export function tldrForManifest(slug: string | undefined): { text: string; url: string; updatedTs: number } | null {
  if (!slug) return null;
  const row = getEpisodeTldr(slug);
  return row ? { text: row.text, url: row.url, updatedTs: row.updatedTs } : null;
}

/** Pull the tweet body off a status URL so the host only pastes the link.
 *  fxtwitter first (plain text, expanded URLs, no auth), then X's official
 *  oEmbed (HTML we strip). Throws when neither answers. */
export async function fetchTweetText(url: string): Promise<string> {
  const m = url.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
  if (!m) throw new Error("not a tweet url (expected x.com/<user>/status/<id>)");
  const id = m[1];
  const timeout = (ms: number) => AbortSignal.timeout(ms);

  try {
    const r = await fetch(`https://api.fxtwitter.com/status/${id}`, { signal: timeout(8000) });
    if (r.ok) {
      const j = (await r.json()) as { tweet?: { text?: string } };
      const t = j.tweet?.text?.trim();
      if (t) return t;
    }
  } catch {
    /* fall through */
  }

  const r = await fetch(
    `https://publish.x.com/oembed?omit_script=1&url=${encodeURIComponent(`https://x.com/i/status/${id}`)}`,
    { signal: timeout(8000) },
  );
  if (!r.ok) throw new Error(`could not fetch tweet (${r.status})`);
  const j = (await r.json()) as { html?: string };
  const p = j.html?.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1];
  if (!p) throw new Error("tweet fetch returned no text");
  const text = p
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
  if (!text) throw new Error("tweet fetch returned no text");
  return text;
}

import { createHmac, randomBytes } from "node:crypto";
import { config } from "./config.js";

// Twitter home-timeline poll, broadcast to every peer (same pattern as
// ticker / headlines). Reads the authenticated user's reverse-chrono
// timeline via Twitter API v2 with OAuth 1.0a User Context — that's
// the only auth flavor that endpoint accepts.
//
// We pull the last 100 tweets, filter to the recent window, rank by
// engagement (likes + retweets×2 + replies) so the "loudest" tweets of
// the past few hours float to the top, and broadcast a trimmed list to
// the client. The TimelineBar marquee renders them as scrolling chips.
//
// Twitter API reads are metered/billed and the per-tweet cost adds
// up fast, so there is *no* scheduled auto-poll — the bar stays empty
// until the host clicks the TIMELINE badge right before going live,
// which fires `refreshNow()`. `start()` is still called at boot but
// only wires subscribers; nothing crawls until a manual refresh.

// Min spacing between manual refreshes — protects against double-clicks
// or accidental button-mashing turning into a burst of paginated reads.
const MANUAL_REFRESH_MIN_MS = 60_000;

// Wide window so accounts that post once a day still get a fair shot
// at appearing. The mega-accounts (Saylor, Cointelegraph, news orgs)
// post hourly so they'd always win a small window; widening to 48h
// gives slower-but-more-interesting accounts time to put up *one*
// tweet that can compete.
const RECENT_WINDOW_HOURS = 48;
const MAX_OUT = 50;

export type TimelineItem = {
  id: string;
  text: string;
  authorUsername: string;
  authorName: string;
  authorVerified: boolean;
  /** Author follower count — used by the relay ranker to normalize
   *  engagement (so a 200-like tweet from a 50K-follower account can
   *  beat a 400-like tweet from a 4M-follower account). */
  authorFollowers: number;
  likes: number;
  retweets: number;
  replies: number;
  createdAt: number;
  url: string;
};

export type TimelineState = {
  items: TimelineItem[];
  updatedAt: number;
};

let state: TimelineState | null = null;

// Research focus — set by `/v1/guest-research` when the host enters a
// Twitter handle in the Research app. Tweets from this handle get
// pulled in alongside the algorithmic home-timeline picks and scored
// high so they reliably appear in the bar. Expires after the TTL so a
// week-old research session doesn't permanently bias the feed.
const RESEARCH_FOCUS_TTL_MS = 4 * 60 * 60 * 1000;
let researchFocus: { handle: string; until: number } | null = null;

/** Called by the relay's /v1/guest-research handler whenever a host
 *  submits a research query with a Twitter handle. Replaces any prior
 *  focus; pass an empty string to clear. */
export function setResearchFocus(handle: string): void {
  const clean = handle.replace(/^@/, "").trim();
  if (!clean) {
    researchFocus = null;
    return;
  }
  researchFocus = { handle: clean, until: Date.now() + RESEARCH_FOCUS_TTL_MS };
}

type Subscriber = (state: TimelineState) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getState(): TimelineState | null {
  return state;
}

// RFC 3986 percent-encoding. JS's encodeURIComponent leaves `!*'()`
// unencoded, but Twitter's OAuth 1.0a base string requires them
// encoded — so we manually re-encode those after encodeURIComponent.
function pctEnc(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// OAuth 1.0a Authorization header builder. Spec: RFC 5849. Sketch:
//   1. Gather all oauth_* params + query params into one map
//   2. Build the signature base string: METHOD&URL&sorted-encoded-params
//   3. HMAC-SHA1 with key = `consumerSecret&accessTokenSecret`
//   4. The signature goes into the oauth_* params (but NOT the query)
//   5. The Authorization header is `OAuth oauth_k="v", ...`
function buildOAuthHeader(method: string, url: string, queryParams: Record<string, string>): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.twitterConsumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.twitterAccessToken,
    oauth_version: "1.0",
  };

  // Combine query params + oauth_* params, percent-encode each k=v,
  // sort alphabetically by the encoded key, then join with `&`. This
  // is the "parameter string" half of the signature base.
  const allParams = { ...queryParams, ...oauthParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map(k => `${pctEnc(k)}=${pctEnc(allParams[k]!)}`)
    .join("&");

  const baseString = [method.toUpperCase(), pctEnc(url), pctEnc(paramString)].join("&");
  const signingKey = `${pctEnc(config.twitterConsumerSecret)}&${pctEnc(config.twitterAccessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  // Header includes only oauth_* params + the freshly computed
  // oauth_signature. Query params live in the URL itself.
  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const headerStr = Object.keys(headerParams)
    .sort()
    .map(k => `${pctEnc(k)}="${pctEnc(headerParams[k]!)}"`)
    .join(", ");
  return `OAuth ${headerStr}`;
}

// Twitter v2 response shape — only the fields we actually use.
type V2User = {
  id: string;
  username?: string;
  name?: string;
  verified?: boolean;
  public_metrics?: { followers_count?: number };
};
type V2Tweet = {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
    impression_count?: number;
  };
  referenced_tweets?: Array<{ type: string; id: string }>;
};
type V2Response = {
  data?: V2Tweet[];
  includes?: { users?: V2User[] };
  meta?: { next_token?: string };
};

// Pages to walk per refresh. 100 tweets/page × 3 pages = 300 tweets
// in the pool. Trimmed from 8 → 3 to cut per-refresh API cost; on a
// firehose-tier feed 300 still covers a few hours and the host-only
// manual-refresh model (no scheduled crawls) means we'd rather pay
// less per click than chase slow-posting accounts on every refresh.
const MAX_PAGES = 3;

async function fetchTimeline(): Promise<TimelineItem[]> {
  const userId = config.twitterUserId;
  if (!userId || !config.twitterConsumerKey) {
    throw new Error("twitter creds missing");
  }
  const base = `https://api.twitter.com/2/users/${userId}/timelines/reverse_chronological`;

  const cutoff = Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000;
  const tweets: V2Tweet[] = [];
  const users = new Map<string, V2User>();
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const queryParams: Record<string, string> = {
      max_results: "100",
      "tweet.fields": "created_at,public_metrics,referenced_tweets,author_id",
      expansions: "author_id",
      "user.fields": "username,name,verified,public_metrics",
      // Drop pure retweets at the API level. Reason: retweets carry
      // the metrics of the *underlying* tweet, so an RT of a viral
      // post would always outrank a thoughtful original from someone
      // the user actually follows. (Replies are still included —
      // they're often the most interesting "live" content.)
      exclude: "retweets",
    };
    if (nextToken) queryParams.pagination_token = nextToken;
    // Build the URL exactly as we sign it — same encoding both sides.
    const qs = Object.keys(queryParams)
      .sort()
      .map(k => `${pctEnc(k)}=${pctEnc(queryParams[k]!)}`)
      .join("&");
    const url = `${base}?${qs}`;
    const auth = buildOAuthHeader("GET", base, queryParams);

    const res = await fetch(url, { headers: { Authorization: auth, accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`twitter ${res.status} ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as V2Response;
    const pageTweets = data.data ?? [];
    tweets.push(...pageTweets);
    for (const u of data.includes?.users ?? []) users.set(u.id, u);

    // Stop early if this page already crosses the cutoff — there's no
    // point fetching another page of older tweets. Last item on the
    // page is the oldest (reverse-chrono order).
    const lastInPage = pageTweets[pageTweets.length - 1];
    const lastTs = lastInPage?.created_at ? Date.parse(lastInPage.created_at) : Number.MAX_SAFE_INTEGER;
    if (lastTs < cutoff) break;
    nextToken = data.meta?.next_token;
    if (!nextToken) break;
  }

  const enriched: TimelineItem[] = [];
  for (const t of tweets) {
    const createdAt = t.created_at ? Date.parse(t.created_at) : 0;
    if (!createdAt || createdAt < cutoff) continue;
    // Belt-and-suspenders retweet filter — the `exclude=retweets`
    // query parameter sometimes slips RTs through (Twitter caches the
    // unfiltered list at the edge), so we also drop anything with a
    // referenced_tweets entry of type "retweeted" or a text body that
    // starts with "RT @". Reason: RTs carry the metrics of the
    // *underlying* viral tweet and would always outrank original
    // posts from accounts the user actually follows.
    const isRetweet =
      (t.referenced_tweets ?? []).some(r => r.type === "retweeted") || /^RT @/.test(t.text);
    if (isRetweet) continue;
    const user = t.author_id ? users.get(t.author_id) : undefined;
    const username = user?.username ?? "unknown";
    enriched.push({
      id: t.id,
      // Strip the t.co URL tail Twitter appends to many tweets — it
      // adds visual noise without information.
      text: t.text.replace(/\s+https:\/\/t\.co\/\S+$/, "").trim(),
      authorUsername: username,
      authorName: user?.name ?? username,
      authorVerified: user?.verified ?? false,
      authorFollowers: user?.public_metrics?.followers_count ?? 0,
      likes: t.public_metrics?.like_count ?? 0,
      retweets: t.public_metrics?.retweet_count ?? 0,
      replies: t.public_metrics?.reply_count ?? 0,
      createdAt,
      url: `https://x.com/${username}/status/${t.id}`,
    });
  }

  // Research focus — if the host has filled in a Twitter handle in
  // the Research app within the last 4 hours, pull that account's
  // recent tweets in as additional candidates. They're added to the
  // pool before dedup so the host sees what their upcoming guest is
  // saying right now, regardless of whether the guest is "loud
  // enough" to surface from the algorithmic pool.
  let focusedUsername: string | null = null;
  if (researchFocus && Date.now() < researchFocus.until) {
    focusedUsername = researchFocus.handle.toLowerCase();
    try {
      const focused = await fetchUserTweets(researchFocus.handle);
      enriched.push(...focused);
    } catch (err) {
      console.warn(`[timeline] research-focus fetch failed for @${researchFocus.handle}`, err);
    }
  }

  // Hybrid engagement score: raw engagement × small-account boost.
  // The boost is `max(1, 7 - log10(followers))`, which means:
  //   - 10M+ follower account → boost 1× (raw engagement wins)
  //   - 1M follower account   → boost 1×
  //   - 100K follower         → boost ~2×
  //   - 10K follower          → boost ~3×
  //   - 1K follower           → boost ~4×
  // This lets a thoughtful tweet from a niche-but-good account beat
  // raw-engagement leaders without making the timeline a flood of
  // tiny accounts (the multiplicative form means a 1-like tweet from
  // a 1K-follower account still scores 4, which won't beat anything
  // real — so signal has to be there too).
  const score = (t: TimelineItem): number => {
    const raw = t.likes + t.retweets * 2 + t.replies;
    // Bumped threshold from 7 → 8: a 1M-follower account (politicians,
    // mid-tier media orgs) now gets a ~2× boost-against penalty (i.e.
    // it scores as if it had half its engagement), while truly small
    // accounts (<10K) score 4-5× higher. This pushes back on
    // VP-Vance-grade accounts dominating an indie/builder feed.
    const boost = Math.max(1, 8 - Math.log10(t.authorFollowers + 1));
    // Research-focus boost: tweets from the handle the host is
    // researching right now jump to the front of the line. Big enough
    // multiplier that they outrank any organic candidate but ordered
    // among themselves by their own engagement (so the focused
    // account's *best* tweet shows first if dedupe didn't already
    // pick it).
    const focusBoost = focusedUsername && t.authorUsername.toLowerCase() === focusedUsername ? 1_000_000 : 0;
    return raw * boost + focusBoost;
  };
  // Best tweet per author — keep only the top-scoring tweet from each
  // account so the bar shows 25 different voices instead of one
  // hyper-active account taking five slots.
  const byAuthor = new Map<string, TimelineItem>();
  for (const t of enriched) {
    const existing = byAuthor.get(t.authorUsername);
    if (!existing || score(t) > score(existing)) byAuthor.set(t.authorUsername, t);
  }
  const deduped = [...byAuthor.values()];
  deduped.sort((a, b) => score(b) - score(a));
  return deduped.slice(0, MAX_OUT);
}

// Pull recent original tweets from a single handle. Uses the
// `/2/tweets/search/recent` endpoint (180 req/15min on User Context,
// way more generous than the home-timeline budget) with a `from:`
// filter. Used to interlace a research-focused guest's tweets into
// the bar so the host always sees what they're saying right now.
async function fetchUserTweets(username: string): Promise<TimelineItem[]> {
  const base = "https://api.twitter.com/2/tweets/search/recent";
  const queryParams: Record<string, string> = {
    // `-is:retweet` matches Twitter's exclude-retweets behavior on
    // home_timeline so the two feeds use the same filter shape.
    query: `from:${username} -is:retweet`,
    max_results: "10",
    "tweet.fields": "created_at,public_metrics,referenced_tweets,author_id",
    expansions: "author_id",
    "user.fields": "username,name,verified,public_metrics",
  };
  const qs = Object.keys(queryParams)
    .sort()
    .map(k => `${pctEnc(k)}=${pctEnc(queryParams[k]!)}`)
    .join("&");
  const url = `${base}?${qs}`;
  const auth = buildOAuthHeader("GET", base, queryParams);
  const res = await fetch(url, { headers: { Authorization: auth, accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`twitter search ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as V2Response;
  const tweets = data.data ?? [];
  const users = new Map<string, V2User>((data.includes?.users ?? []).map(u => [u.id, u]));
  const cutoff = Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000;
  const out: TimelineItem[] = [];
  for (const t of tweets) {
    const createdAt = t.created_at ? Date.parse(t.created_at) : 0;
    if (!createdAt || createdAt < cutoff) continue;
    const user = t.author_id ? users.get(t.author_id) : undefined;
    const handle = user?.username ?? username;
    out.push({
      id: t.id,
      text: t.text.replace(/\s+https:\/\/t\.co\/\S+$/, "").trim(),
      authorUsername: handle,
      authorName: user?.name ?? handle,
      authorVerified: user?.verified ?? false,
      authorFollowers: user?.public_metrics?.followers_count ?? 0,
      likes: t.public_metrics?.like_count ?? 0,
      retweets: t.public_metrics?.retweet_count ?? 0,
      replies: t.public_metrics?.reply_count ?? 0,
      createdAt,
      url: `https://x.com/${handle}/status/${t.id}`,
    });
  }
  return out;
}

let started = false;
let lastManualRefreshAt = 0;
let inflightRefresh: Promise<TimelineState | null> | null = null;

async function pollOnce(): Promise<void> {
  const items = await fetchTimeline();
  if (items.length === 0 && !state) return;
  state = { items, updatedAt: Date.now() };
  for (const fn of subscribers) {
    try {
      fn(state);
    } catch {
      /* one bad sub shouldn't kill the rest */
    }
  }
}

/** Manual refresh triggered by the host clicking the TIMELINE badge.
 *  Coalesces concurrent callers onto the same in-flight fetch, and
 *  rate-limits to one refresh per MANUAL_REFRESH_MIN_MS so accidental
 *  button-mashing doesn't burst paginated reads. This is the *only*
 *  path that hits Twitter — there is no scheduled auto-poll. */
export async function refreshNow(): Promise<
  { ok: true; state: TimelineState | null } | { ok: false; reason: "rate-limited" | "no-creds"; retryAfterMs?: number }
> {
  if (!config.twitterUserId || !config.twitterConsumerKey) {
    return { ok: false, reason: "no-creds" };
  }
  if (inflightRefresh) {
    const next = await inflightRefresh;
    return { ok: true, state: next };
  }
  const now = Date.now();
  const elapsed = now - lastManualRefreshAt;
  if (lastManualRefreshAt && elapsed < MANUAL_REFRESH_MIN_MS) {
    return { ok: false, reason: "rate-limited", retryAfterMs: MANUAL_REFRESH_MIN_MS - elapsed };
  }
  lastManualRefreshAt = now;
  inflightRefresh = (async () => {
    try {
      await pollOnce();
      return state;
    } finally {
      inflightRefresh = null;
    }
  })();
  return { ok: true, state: await inflightRefresh };
}

export function start(): void {
  if (started) return;
  started = true;

  if (!config.twitterUserId || !config.twitterConsumerKey) {
    console.warn("[timeline] twitter creds missing — manual refresh will no-op");
    return;
  }
}

export function stop(): void {
  started = false;
}

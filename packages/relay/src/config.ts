import "dotenv/config";

const env = (key: string, fallback?: string): string => {
  const v = process.env[key];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    return "";
  }
  return v;
};

const adminAddrs = env("ADMIN_ADDRESSES", "")
  .split(",")
  .map(a => a.trim().toLowerCase())
  .filter(a => /^0x[a-f0-9]{40}$/.test(a));

const corsOrigins = env("CORS_ORIGINS", "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const isProd = process.env.NODE_ENV === "production";

// Fail closed on the session secret. This value is the HMAC key for
// room-access cookies (room-auth.ts) AND the @fastify/cookie signing
// secret (index.ts). The dev fallback below is public in this repo — if
// the relay boots in production with it, anyone could compute
// signRoomCookie(slug, "dev-secret-change-me") and forge a valid cookie
// for any room, bypassing every password gate (WS /signal, all ?slug=
// v1 routes, and the /auth/anon + /auth/godmode invite checks). Refuse
// to start rather than silently run wide open. Mirrors siwe.ts's
// ALCHEMY_API_KEY guard. Generate one with `openssl rand -hex 32`.
const DEV_SESSION_SECRET = "dev-secret-change-me";
const sessionSecret = env("SIWE_SESSION_SECRET", DEV_SESSION_SECRET);
if (isProd && sessionSecret === DEV_SESSION_SECRET) {
  throw new Error(
    "SIWE_SESSION_SECRET is unset (or set to the public dev fallback) while " +
      "NODE_ENV=production — refusing to start. This secret signs room-access " +
      "cookies; the fallback is public in the repo, so anyone could forge a " +
      "valid cookie for any room. Set a strong random value (`openssl rand -hex 32`).",
  );
}

// Wildcard CORS + credentials is a credential-theft vector: @fastify/cors
// resolves origin:true by *reflecting* the caller's origin and emitting
// Access-Control-Allow-Credentials: true, so any website could make
// authenticated requests with a visitor's cookies. We genuinely need
// credentials (cross-origin cookies from slop.computer), so the safe move
// is to refuse "*" in production rather than silently pair it with creds.
if (isProd && corsOrigins.includes("*")) {
  throw new Error(
    'CORS_ORIGINS includes "*" while NODE_ENV=production — refusing to start. ' +
      "A wildcard origin combined with credentialed requests lets any site make " +
      "authenticated calls using a visitor's cookies. List explicit origins instead.",
  );
}

export const config = {
  port: Number(env("PORT", "8081")),
  host: env("HOST", "0.0.0.0"),
  corsOrigins,
  adminAddresses: adminAddrs,
  adminDomain: env("ADMIN_DOMAIN", "localhost:3000"),
  guestPassword: env("GUEST_PASSWORD", ""),
  // Optional "god mode" password — anyone joining with
  //   ?godMode=<this password>
  // AND a valid room cookie gets a passive spectator session: no
  // wallet/passkey required, no entry in the guest list, no cursor
  // or click broadcasts, can't publish or chat. Intended for the
  // streaming machine that captures the live show.
  godPassword: env("GOD_MODE_PASSWORD", ""),
  // Optional "mobile mode" password — same shape as godPassword, but
  // unlocks a portrait clip-friendly stage instead of the full desktop
  // (see ops/PLAN-mobile-mode.md). Mobile sessions are also spectators
  // (no publish, hidden from guest list) so they can't accidentally
  // broadcast cam/mic/screen during a recording. Kept distinct from
  // godPassword so a mobile clip link doesn't also grant god caps
  // (audio bus, server-STT, god viewport).
  mobilePassword: env("MOBILE_MODE_PASSWORD", ""),
  sessionSecret,
  sessionTTLSeconds: Number(env("SESSION_TTL_SECONDS", "86400")),
  alchemyApiKey: env("ALCHEMY_API_KEY", ""),
  mediamtxRtmpIngress: env("MEDIAMTX_RTMP_INGRESS_URL", "rtmp://localhost:1935"),
  mediamtxPublishUser: env("MEDIAMTX_PUBLISH_USER", "live"),
  mediamtxPublishPass: env("MEDIAMTX_PUBLISH_PASS", ""),
  hlsUrl: env("HLS_URL", "https://media.slop.computer/hls/live/index.m3u8"),
  // Directory MediaMTX writes recordings into (matches recordPath root in
  // deploy/mediamtx.yml). /admin/finalize scans `<recordingsDir>/live/` and
  // grabs the newest file.
  recordingsDir: env("RECORDINGS_DIR", "/home/ubuntu/recordings"),
  // Path to a clawd-clipper checkout on this box. When set, /admin/generate-clips
  // spawns it (`tsx src/index.ts <slug> --vertical --publish`) to cut the 9:16
  // clips + tweets, pin them to bgipfs, and produce an updated manifest CID.
  // Unset → the route 501s (clips stay a local/manual flow).
  clipperDir: env("CLIPPER_DIR", ""),
  // Local kubo daemon (systemd `ipfs.service`). /admin/finalize POSTs the
  // recording to /api/v0/add and streams the {Bytes, Hash} response back
  // to the host UI as a real progress bar.
  ipfsApiUrl: env("IPFS_API_URL", "http://127.0.0.1:5001"),
  // Public HTTP gateway for serving pinned blobs (BGIPFS in prod). When
  // set, /files/:id 302-redirects to `${gateway}/${cid}?filename=…` for
  // entries that have a CID — keeps the prod box's outbound bandwidth
  // off the hot path. Unset → always serve from local storage.
  ipfsPublicGateway: env("IPFS_PUBLIC_GATEWAY", "https://media.slop.computer/ipfs"),
  turnSecret: env("TURN_SECRET", ""),
  turnHost: env("TURN_HOST", ""),
  turnTtlSeconds: Number(env("TURN_TTL_SECONDS", "3600")),
  jamendoClientId: env("JAMENDO_CLIENT_ID", ""),
  jamendoClientSecret: env("JAMENDO_CLIENT_SECRET", ""),
  // Twitter OAuth 1.0a (User Context auth — required for
  // timelines/reverse_chronological). Used by the "Timeline" ticker
  // bar; missing creds → the timeline poll skips and the bar stays in
  // a loading state.
  twitterUserId: env("TWITTER_USER_ID", ""),
  twitterConsumerKey: env("TWITTER_CONSUMER_KEY", ""),
  twitterConsumerSecret: env("TWITTER_CONSUMER_SECRET", ""),
  twitterAccessToken: env("TWITTER_ACCESS_TOKEN", ""),
  twitterAccessTokenSecret: env("TWITTER_ACCESS_TOKEN_SECRET", ""),
  openAiApiKey: env("OPENAI_API_KEY", ""),
  // --- AI wallet (ported from slop-computer-ai-wallet) -------------------
  // The conversational wallet's LLM runs through Bankr's OpenAI-compatible
  // gateway (llm.bankr.bot). `aiWalletLlmKey` is the bearer token for it.
  // Zerion powers portfolio + activity; LI.FI powers swap/bridge routing.
  // Missing keys degrade gracefully — the wallet chat surfaces a clear
  // "not configured" message rather than crashing.
  aiWalletLlmKey: env("SLOP_COMPUTER_AI_WALLET", ""),
  aiWalletLlmBaseUrl: env("AI_WALLET_LLM_BASE_URL", "https://llm.bankr.bot/v1"),
  aiWalletLlmModel: env("AI_WALLET_LLM_MODEL", "claude-opus-4.7"),
  zerionApiKey: env("ZERION_API_KEY", ""),
  lifiApiKey: env("LIFI_API_KEY", ""),
};

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

export const config = {
  port: Number(env("PORT", "8081")),
  host: env("HOST", "0.0.0.0"),
  corsOrigins,
  adminAddresses: adminAddrs,
  adminDomain: env("ADMIN_DOMAIN", "localhost:3000"),
  guestPassword: env("GUEST_PASSWORD", ""),
  sessionSecret: env("SIWE_SESSION_SECRET", "dev-secret-change-me"),
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
  // Local kubo daemon (systemd `ipfs.service`). /admin/finalize POSTs the
  // recording to /api/v0/add and streams the {Bytes, Hash} response back
  // to the host UI as a real progress bar.
  ipfsApiUrl: env("IPFS_API_URL", "http://127.0.0.1:5001"),
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
};

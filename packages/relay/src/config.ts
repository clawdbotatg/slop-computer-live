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
  turnSecret: env("TURN_SECRET", ""),
  turnHost: env("TURN_HOST", ""),
  turnTtlSeconds: Number(env("TURN_TTL_SECONDS", "3600")),
  jamendoClientId: env("JAMENDO_CLIENT_ID", ""),
  jamendoClientSecret: env("JAMENDO_CLIENT_SECRET", ""),
};

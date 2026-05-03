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
  port: Number(env("PORT", "8080")),
  host: env("HOST", "0.0.0.0"),
  corsOrigins,
  adminAddresses: adminAddrs,
  adminDomain: env("ADMIN_DOMAIN", "localhost:3000"),
  guestPassword: env("GUEST_PASSWORD", ""),
  sessionSecret: env("SIWE_SESSION_SECRET", "dev-secret-change-me"),
  sessionTTLSeconds: Number(env("SESSION_TTL_SECONDS", "86400")),
  alchemyApiKey: env("ALCHEMY_API_KEY", ""),
  mediamtxRtmpIngress: env("MEDIAMTX_RTMP_INGRESS_URL", "rtmp://localhost:1935/live"),
};

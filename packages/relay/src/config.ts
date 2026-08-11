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
  // Optional static bearer for UNATTENDED show automation (the showtime-arm
  // launchd job that flips fanouts on/off around a broadcast). Session tokens
  // all expire (7 days), which is exactly wrong for a cron job — the 2026-08-10
  // show armed with an expired-scope token and the fanouts 401'd at T-3min.
  // Deliberately NARROW: accepted ONLY by the /admin/fanouts/* routes (see
  // requireHostOrAutomation), never by wallet/room/session admin surfaces.
  automationToken: env("AUTOMATION_TOKEN", ""),
  sessionSecret,
  // 7 days — matches AGENT_TOKEN_TTL_MS in sessions.ts so a host's login
  // session always outlives the skill/agent tokens it mints. A 1-day default
  // here was the "skill token expired mid-session" footgun: the host's cookie
  // died a day into a multi-day live session (and silently reverted to 1 day
  // on any box missing the SESSION_TTL_SECONDS override), so they could no
  // longer re-mint and had to hand the agent a fresh link. Keep these in lockstep.
  sessionTTLSeconds: Number(env("SESSION_TTL_SECONDS", "604800")),
  // God-mode (spectator) sessions get a deliberately SHORT TTL — 1 day by
  // default, vs the 7-day normal session above. A spectator cookie is the
  // OBS/capture box's pass; it confers an invisible, no-wallet, viewport-
  // broadcasting session. If a regular operator ever opens a `?godMode=…`
  // link on their everyday browser profile, the leftover cookie silently
  // keeps them in god mode on every later visit (no JoinCard, no wallet,
  // pink broadcast bounds tracking their resolution) until it expires.
  // A 1-day TTL bounds that footgun to a day instead of a week. The
  // capture box re-opens its god link every show anyway, so a daily
  // re-auth costs it nothing.
  godSessionTTLSeconds: Number(env("GOD_SESSION_TTL_SECONDS", "86400")),
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
  aiWalletLlmModel: env("AI_WALLET_LLM_MODEL", "claude-opus-4.8"),
  zerionApiKey: env("ZERION_API_KEY", ""),
  lifiApiKey: env("LIFI_API_KEY", ""),
  // --- Personal-wallet deployer / facilitator (docs/PASSKEY-WALLET.md) -----
  // The fixed address that broadcasts every passkey personal-wallet's
  // createMultisig (baked into the CREATE2 address — never change it) and, in
  // Phase 2, broadcasts + sponsors gas for their txs. The key is a hot wallet:
  // gitignored, never committed. Empty until Phase 2 wires the facilitator.
  personalWalletDeployer: env("PERSONAL_WALLET_DEPLOYER", ""),
  personalWalletDeployerKey: env("PERSONAL_WALLET_DEPLOYER_KEY", ""),
  // Fallback co-signer for a passkey personal wallet when its room has no
  // Bank multisig. Ideally a platform multisig; empty → falls back to the
  // deployer address itself (a hot EOA — replace with a real multisig).
  personalWalletPlatformCosigner: env("PERSONAL_WALLET_PLATFORM_COSIGNER", ""),
  // Per-tx value ceiling (wei) for the facilitator's sponsored exec endpoint —
  // a passkey wallet can't move more than this in a single sponsored tx. Caps
  // blast radius if a key/sig is ever abused; tune up for higher-stakes games.
  // Default 0.05 ETH — comfortably above a poker/chess buy-in, well below a
  // drain. See docs/PASSKEY-WALLET.md §7.1.
  personalWalletMaxSpendWei: env("PERSONAL_WALLET_MAX_SPEND_WEI", "50000000000000000"),
  // --- Privacy Wallet (Railgun via kohaku-cli; docs/PRIVACY-WALLET.md) -------
  // ⚠️ CUSTODIAL: while funds are in the privacy wallet the BOX holds the
  // keys (kohaku seed + master password live in relay env / on disk, never
  // in git). Mainnet, small amounts only — hence the caps below.
  // `kohakuCliDir` = a kohaku-cli checkout the relay spawns via `npx tsx`
  // (external tool, like ffmpeg for fanout). Empty → the whole feature 503s.
  kohakuCliDir: env("KOHAKU_CLI_DIR", ""),
  // Box-default mainnet RPC for kohaku ops + the shared pool sync. BuidlGuidl
  // (community nodes) by default — privacy-friendlier than a commercial
  // endpoint for a privacy app. Users can override per-user in the app's
  // settings (stored relay-side, validated; see kohakuSetRpc).
  kohakuRpcUrl: env("KOHAKU_RPC_URL", "https://mainnet.rpc.buidlguidl.com"),
  // kohaku-cli --dataDir (wallet keystore + rg-storage.json). Empty → the
  // CLI's default (~/.kohaku-cli).
  kohakuDataDir: env("KOHAKU_DATA_DIR", ""),
  kohakuWalletName: env("KOHAKU_WALLET", "slop"),
  // Master password for the kohaku wallet keystore. Passed to the CLI as a
  // 0600 password FILE (never on argv — argv is visible in `ps`).
  kohakuWalletPassword: env("KOHAKU_WALLET_PASSWORD", ""),
  // Per-user deposit ceiling: the watcher refuses to auto-shield a deposit
  // above this (funds sit at the deposit address for manual handling).
  // Default 0.05 ETH, matching personalWalletMaxSpendWei's posture.
  kohakuMaxDepositWei: env("KOHAKU_MAX_DEPOSIT_WEI", "50000000000000000"),
  // Per-op cap on the send endpoint (the dangerous op). Default 0.05 ETH.
  kohakuMaxSendWei: env("KOHAKU_MAX_SEND_WEI", "50000000000000000"),
  // Soak window: how long the anonymity progress bar runs after shielding.
  kohakuSoakHours: Number(env("KOHAKU_SOAK_HOURS", "4")),
  // --- Apple Pay → personal-wallet on-ramp (Coinbase Onramp; docs §13) -------
  // A CDP Secret API key used to mint single-use Coinbase Onramp session tokens
  // server-side (required since 2025-07-31). The key never touches the browser —
  // only the resulting one-time onramp URL does. `cdpApiKeyId` is the key UUID;
  // `cdpApiKeySecret` is its base64-encoded 64-byte Ed25519 secret. Both from
  // portal.cdp.coinbase.com → gitignored, never committed. Empty → /onramp/session 503s.
  cdpApiKeyId: env("CDP_API_KEY_ID", ""),
  cdpApiKeySecret: env("CDP_API_KEY_SECRET", ""),
};

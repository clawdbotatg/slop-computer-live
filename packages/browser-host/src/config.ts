import "dotenv/config";

const env = (key: string, fallback?: string): string => {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback ?? "";
  return v;
};

const corsOrigins = env("CORS_ORIGINS", "http://localhost:3000,http://localhost:3001")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

export const config = {
  port: Number(env("PORT", "8090")),
  host: env("HOST", "0.0.0.0"),
  corsOrigins,
  // Address whose balance / nonce the dapp should see. Defaults to vitalik.eth.
  impersonatedAddress: env(
    "IMPERSONATED_ADDRESS",
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  ),
  chainId: Number(env("CHAIN_ID", "1")),
  // Upstream RPC — we keep the API key server-side and proxy from /__slop_rpc.
  // Falls back to a public Cloudflare gateway only if Alchemy isn't configured;
  // production runs should always set ALCHEMY_API_KEY.
  alchemyApiKey: env("ALCHEMY_API_KEY", ""),
  rpcUrl: env("RPC_URL", ""),
  viewport: {
    width: Number(env("VIEWPORT_WIDTH", "1280")),
    height: Number(env("VIEWPORT_HEIGHT", "800")),
  },
  screencast: {
    quality: Number(env("SCREENCAST_QUALITY", "60")),
    everyNthFrame: Number(env("SCREENCAST_EVERY_NTH_FRAME", "1")),
    maxWidth: Number(env("SCREENCAST_MAX_WIDTH", "1280")),
    maxHeight: Number(env("SCREENCAST_MAX_HEIGHT", "800")),
  },
  // Where to forward captured calldata. The browser-host POSTs to this URL
  // so the relay can broadcast over its tx_request channel. Optional —
  // unset means "don't forward, just log".
  relayTxBroadcastUrl: env("RELAY_TX_BROADCAST_URL", ""),
  relayTxBroadcastSecret: env("RELAY_TX_BROADCAST_SECRET", ""),
};

export const upstreamRpcUrl = (): string => {
  if (config.rpcUrl) return config.rpcUrl;
  if (config.alchemyApiKey) {
    const subdomain = config.chainId === 1
      ? "eth-mainnet"
      : config.chainId === 8453
        ? "base-mainnet"
        : config.chainId === 11155111
          ? "eth-sepolia"
          : "eth-mainnet";
    return `https://${subdomain}.g.alchemy.com/v2/${config.alchemyApiKey}`;
  }
  // Last-resort public fallback. Per the user's RPC rule we should never
  // ship without an Alchemy key, but local dev with no key gets a working
  // (slow, rate-limited) endpoint instead of a hard crash.
  return "https://cloudflare-eth.com";
};

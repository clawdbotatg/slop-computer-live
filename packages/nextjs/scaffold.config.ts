import { mainnet as mainnetBase } from "viem/chains";
import type { Chain } from "viem/chains";

export type ScaffoldConfig = {
  targetNetworks: readonly Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  rpcOverrides?: Record<number, string>;
  walletConnectProjectId: string;
  burnerWalletMode: "localNetworksOnly" | "allNetworks" | "disabled";
};

const BG_MAINNET_RPC = "https://mainnet.rpc.buidlguidl.com";

// Patched mainnet: viem ships chains.mainnet with eth.merkle.io as the public RPC,
// which gets used by any code path that reads chain.rpcUrls directly (ENS,
// AddressQRCodeModal, etc.) — bypassing wagmi's transport rpcOverrides. Patch the
// chain definition itself so every path resolves to the BuidlGuidl RPC.
export const mainnet = {
  ...mainnetBase,
  rpcUrls: {
    default: { http: [BG_MAINNET_RPC] },
    public: { http: [BG_MAINNET_RPC] },
  },
} as const satisfies Chain;

const scaffoldConfig = {
  // The networks on which your DApp is live
  targetNetworks: [mainnet],

  // The interval at which your front-end polls the RPC servers for new data
  // it has no effect if you only target the local network (default is 4000)
  pollingInterval: 30000,

  // Optional Alchemy API key. Empty by default — mainnet traffic is served by the
  // BuidlGuidl RPC override below, so misconfiguration fails loudly instead of
  // silently falling back to a shared demo key.
  alchemyApiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "",

  // If you want to use a different RPC for a specific network, you can add it here.
  // The key is the chain ID, and the value is the HTTP RPC URL
  rpcOverrides: {
    [mainnet.id]: BG_MAINNET_RPC,
  },

  // This is ours WalletConnect's default project ID.
  // You can get your own at https://cloud.walletconnect.com
  // It's recommended to store it in an env variable:
  // .env.local for local testing, and in the Vercel/system env config for live apps.
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64",

  // Configure Burner Wallet visibility:
  // - "localOnly": only show when all target networks are local (hardhat/anvil)
  // - "allNetworks": show on any configured target networks
  // - "disabled": completely disable
  burnerWalletMode: "localNetworksOnly",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;

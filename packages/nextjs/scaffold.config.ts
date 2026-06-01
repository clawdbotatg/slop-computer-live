import {
  arbitrum as arbitrumBase,
  base as baseBase,
  gnosis as gnosisBase,
  mainnet as mainnetBase,
  optimism as optimismBase,
  polygon as polygonBase,
} from "viem/chains";
import type { Chain } from "viem/chains";

export type ScaffoldConfig = {
  targetNetworks: readonly Chain[];
  pollingInterval: number;
  alchemyApiKey: string;
  rpcOverrides?: Record<number, string>;
  walletConnectProjectId: string;
  burnerWalletMode: "localNetworksOnly" | "allNetworks" | "disabled";
};

const ALCHEMY_MAINNET_RPC = `https://eth-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? ""}`;
const ALCHEMY_BASE_RPC = `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? ""}`;
const ALCHEMY_GNOSIS_RPC = `https://gnosis-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? ""}`;
const ALCHEMY_ARBITRUM_RPC = `https://arb-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? ""}`;
const ALCHEMY_OPTIMISM_RPC = `https://opt-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? ""}`;
const ALCHEMY_POLYGON_RPC = `https://polygon-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? ""}`;

// Patched mainnet: viem ships chains.mainnet with eth.merkle.io as the public RPC,
// which gets used by any code path that reads chain.rpcUrls directly (ENS,
// AddressQRCodeModal, etc.) — bypassing wagmi's transport rpcOverrides. Patch the
// chain definition itself so every path resolves to Alchemy.
export const mainnet = {
  ...mainnetBase,
  rpcUrls: {
    default: { http: [ALCHEMY_MAINNET_RPC] },
    public: { http: [ALCHEMY_MAINNET_RPC] },
  },
} as const satisfies Chain;

// Same RPC-patching for Base so every code path that reads chain.rpcUrls
// directly lands on Alchemy instead of the public mainnet.base.org endpoint.
export const base = {
  ...baseBase,
  rpcUrls: {
    default: { http: [ALCHEMY_BASE_RPC] },
    public: { http: [ALCHEMY_BASE_RPC] },
  },
} as const satisfies Chain;

export const gnosis = {
  ...gnosisBase,
  rpcUrls: {
    default: { http: [ALCHEMY_GNOSIS_RPC] },
    public: { http: [ALCHEMY_GNOSIS_RPC] },
  },
} as const satisfies Chain;

// Same RPC-patching for the three chains the multisig factory was just
// deployed to (Arbitrum, Optimism, Polygon). Same factory address as
// every other chain — see contracts/multisig.ts.
export const arbitrum = {
  ...arbitrumBase,
  rpcUrls: {
    default: { http: [ALCHEMY_ARBITRUM_RPC] },
    public: { http: [ALCHEMY_ARBITRUM_RPC] },
  },
} as const satisfies Chain;

export const optimism = {
  ...optimismBase,
  rpcUrls: {
    default: { http: [ALCHEMY_OPTIMISM_RPC] },
    public: { http: [ALCHEMY_OPTIMISM_RPC] },
  },
} as const satisfies Chain;

export const polygon = {
  ...polygonBase,
  rpcUrls: {
    default: { http: [ALCHEMY_POLYGON_RPC] },
    public: { http: [ALCHEMY_POLYGON_RPC] },
  },
} as const satisfies Chain;

const scaffoldConfig = {
  // Base first — wallet deploys + multisig txs cost pennies vs. dollars.
  // Mainnet stays in the list so ENS resolution and the existing Frontpage
  // contract calls (which live on mainnet) keep working. Gnosis is the
  // third supported chain — the multisig factory is deployed at the same
  // address there.
  targetNetworks: [base, mainnet, gnosis, arbitrum, optimism, polygon],

  // The interval at which your front-end polls the RPC servers for new data
  // it has no effect if you only target the local network (default is 4000)
  pollingInterval: 30000,

  // Alchemy API key — required. If unset, the patched RPC URLs end with
  // `/v2/` and fail loudly rather than silently falling back.
  alchemyApiKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "",

  // If you want to use a different RPC for a specific network, you can add it here.
  // The key is the chain ID, and the value is the HTTP RPC URL
  rpcOverrides: {
    [mainnet.id]: ALCHEMY_MAINNET_RPC,
    [base.id]: ALCHEMY_BASE_RPC,
    [gnosis.id]: ALCHEMY_GNOSIS_RPC,
    [arbitrum.id]: ALCHEMY_ARBITRUM_RPC,
    [optimism.id]: ALCHEMY_OPTIMISM_RPC,
    [polygon.id]: ALCHEMY_POLYGON_RPC,
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

import { config } from "./config.js";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// Server-side deploy of a passkey's personal ("single-player") wallet — a slop
// Multisig deployed counterfactually as a 1-of-2 of [passkey, coSigner] at
// threshold 1. The relay holds the deployer/facilitator hot key so a
// passkey-only user (no EOA, no ETH) can get the contract deployed + pay gas.
// See docs/PASSKEY-WALLET.md. The frontend derivation lives in
// packages/nextjs/utils/personalWallet.ts — keep the salt formula in sync.

const FACTORY_ADDRESS = "0xfcdEe21865b60C2700C23Cd946316CEdA0F215B5" as const;

// Salt namespace — MUST match utils/personalWallet.ts PERSONAL_WALLET_SALT_PREFIX.
const SALT_PREFIX = "slop-personal-v1:";

// Minimal factory ABI — just the two functions we call.
const FACTORY_ABI = [
  {
    type: "function",
    name: "getMultisigAddress",
    stateMutability: "view",
    inputs: [
      { name: "deployer", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "createMultisig",
    stateMutability: "nonpayable",
    inputs: [
      { name: "accounts", type: "address[]" },
      { name: "passkeyQxs", type: "bytes32[]" },
      { name: "passkeyQys", type: "bytes32[]" },
      { name: "credentialIdHashes", type: "bytes32[]" },
      { name: "threshold", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const isHex32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/** keccak256(qx ‖ qy)[-20:] — the raw passkey address (matches passkey.ts and
 *  utils/multisig.ts passkeyAddressFromCoords). */
export function passkeyAddressFromCoords(qx: Hex, qy: Hex): Address {
  return getAddress("0x" + keccak256((qx + qy.slice(2)) as Hex).slice(-40));
}

/** Deterministic CREATE2 salt for a passkey's personal wallet. */
export function personalWalletSalt(passkeyAddress: Address): Hex {
  return keccak256(stringToBytes(SALT_PREFIX + passkeyAddress.toLowerCase()));
}

function baseRpcUrl(): string | null {
  if (!config.alchemyApiKey) return null;
  return `https://base-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`;
}

export type DeployResult =
  | { ok: true; address: Address; txHash: Hex | null; alreadyDeployed: boolean }
  | { ok: false; error: string };

// In-flight guard so two near-simultaneous requests for the same wallet don't
// both broadcast a createMultisig (the second would revert, wasting gas).
const inFlight = new Set<string>();

export type DeployInput = {
  qx: Hex;
  qy: Hex;
  credentialIdHash: Hex;
  /** Second signer (room multisig, else platform fallback). */
  coSigner: Address;
};

export function isPersonalWalletDeployConfigured(): boolean {
  return !!config.personalWalletDeployerKey && !!config.alchemyApiKey;
}

/** Deploy (or no-op if already deployed) a passkey's 1-of-2 personal wallet on
 *  Base, paying gas from the deployer hot wallet. Idempotent. */
export async function deployPersonalWallet(input: DeployInput): Promise<DeployResult> {
  const rpc = baseRpcUrl();
  const pk = config.personalWalletDeployerKey;
  if (!pk || !rpc) return { ok: false, error: "deployer-not-configured" };
  if (!isHex32(input.qx) || !isHex32(input.qy) || !isHex32(input.credentialIdHash)) {
    return { ok: false, error: "bad-passkey-fields" };
  }
  if (!isAddress(input.coSigner)) return { ok: false, error: "bad-cosigner" };

  const account = privateKeyToAccount(pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex));
  const chain = {
    ...base,
    rpcUrls: { default: { http: [rpc] }, public: { http: [rpc] } },
  } as const;
  const pub = createPublicClient({ chain, transport: http(rpc) });

  const passkeyAddress = passkeyAddressFromCoords(input.qx, input.qy);
  const salt = personalWalletSalt(passkeyAddress);

  const predicted = (await pub.readContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "getMultisigAddress",
    args: [account.address, salt],
  })) as Address;

  // Already deployed? No-op (receiving works pre-deploy; this just makes it
  // executable). Cheap idempotency that also defends against double-clicks.
  const existing = await pub.getBytecode({ address: predicted });
  if (existing && existing !== "0x") {
    return { ok: true, address: predicted, txHash: null, alreadyDeployed: true };
  }

  const key = predicted.toLowerCase();
  if (inFlight.has(key)) return { ok: false, error: "deploy-in-progress" };
  inFlight.add(key);
  try {
    const wallet = createWalletClient({ account, chain, transport: http(rpc) });
    // simulate first so a bad config fails cheaply with a clear revert reason.
    const { request } = await pub.simulateContract({
      account,
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: "createMultisig",
      args: [[input.coSigner], [input.qx], [input.qy], [input.credentialIdHash], 1n, salt],
    });
    const txHash = await wallet.writeContract(request);
    await pub.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    return { ok: true, address: predicted, txHash, alreadyDeployed: false };
  } catch (err) {
    const msg = (err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message ?? "deploy-failed";
    return { ok: false, error: msg.split("\n")[0] ?? "deploy-failed" };
  } finally {
    inFlight.delete(key);
  }
}

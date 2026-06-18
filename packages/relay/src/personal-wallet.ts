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

// Minimal Multisig ABI — just execTransaction, for the facilitator's sponsored
// send. The contract recomputes the exec hash from (chainId, this, nonce,
// deadline, target, value, keccak(data)) and verifies every signature against
// its signer set internally, so a bad/forged signature reverts here — the
// facilitator can't be tricked into moving funds without a valid passkey sig.
const MULTISIG_ABI = [
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "deadline", type: "uint256" },
      {
        name: "signatures",
        type: "tuple[]",
        components: [
          { name: "sigType", type: "uint8" },
          { name: "signer", type: "address" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "result", type: "bytes" }],
  },
] as const;

const isHex32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);

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

// ── Facilitator: sponsored exec (docs/PASSKEY-WALLET.md §7) ───────────────────
//
// A passkey user has no EOA and no ETH to pay gas, so the relay broadcasts their
// already-signed `Multisig.execTransaction` from the deployer hot wallet and
// eats the gas (fractions of a cent on Base). The personal wallet itself holds
// the ETH being SENT; the facilitator only fronts the OUTER-tx gas.
//
// Trust model: two independent gates.
//   1. On-chain — the Multisig verifies the passkey signature over the exec
//      hash; a forged/replayed sig reverts (caught cheaply by simulate below).
//   2. Off-chain — the caller proves (via the auth session) that `multisig` is
//      THEIR OWN personal wallet (see the route's integrity check), so the
//      facilitator never broadcasts execs for someone else's wallet.

export type ExecInput = {
  multisig: Address;
  target: Address;
  value: bigint;
  data: Hex;
  deadline: bigint;
  signatures: { sigType: number; signer: Address; data: Hex }[];
};

export type ExecResult = { ok: true; txHash: Hex } | { ok: false; error: string };

export function isPersonalWalletExecConfigured(): boolean {
  return isPersonalWalletDeployConfigured();
}

/** The deployer (facilitator) hot-wallet address — the CREATE2 deployer baked
 *  into every personal-wallet address. Null until the key is configured. */
export function facilitatorAddress(): Address | null {
  const pk = config.personalWalletDeployerKey;
  if (!pk) return null;
  return privateKeyToAccount(pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex)).address;
}

/** Predict a passkey's personal-wallet address on Base (deployer baked in).
 *  Mirrors deployPersonalWallet's derivation so the route can verify a caller
 *  is acting on their OWN wallet. Returns null if unconfigured / unreadable. */
export async function personalWalletAddressFor(passkeyAddress: Address): Promise<Address | null> {
  const rpc = baseRpcUrl();
  const facilitator = facilitatorAddress();
  if (!rpc || !facilitator) return null;
  try {
    const pub = createPublicClient({ chain: base, transport: http(rpc) });
    const salt = personalWalletSalt(passkeyAddress);
    return (await pub.readContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: "getMultisigAddress",
      args: [facilitator, salt],
    })) as Address;
  } catch {
    return null;
  }
}

// One-at-a-time per wallet: serialize a wallet's sponsored sends so two
// near-simultaneous execs don't reuse the same on-chain nonce (the second would
// revert on a stale exec hash, wasting gas). Keyed by lowercased multisig addr.
const execInFlight = new Set<string>();

/** Broadcast a passkey wallet's signed `execTransaction` from the facilitator
 *  hot wallet, paying gas. Validates the value cap, simulates (so a bad sig or
 *  revert fails cheaply without a broadcast), then sends. Returns the broadcast
 *  tx hash — the caller (frontend) waits for the receipt itself. Base-only. */
export async function execPersonalWalletTx(input: ExecInput): Promise<ExecResult> {
  const rpc = baseRpcUrl();
  const pk = config.personalWalletDeployerKey;
  if (!pk || !rpc) return { ok: false, error: "facilitator-not-configured" };
  if (!isAddress(input.multisig) || !isAddress(input.target)) return { ok: false, error: "bad-address" };
  if (!isHex(input.data)) return { ok: false, error: "bad-data" };
  if (input.value < 0n) return { ok: false, error: "bad-value" };

  const maxSpend = BigInt(config.personalWalletMaxSpendWei || "0");
  if (maxSpend > 0n && input.value > maxSpend) return { ok: false, error: "value-exceeds-cap" };

  if (!Array.isArray(input.signatures) || input.signatures.length === 0) {
    return { ok: false, error: "no-signatures" };
  }
  for (const s of input.signatures) {
    if (!isAddress(s.signer) || !isHex(s.data) || (s.sigType !== 0 && s.sigType !== 1)) {
      return { ok: false, error: "bad-signature" };
    }
  }

  const key = input.multisig.toLowerCase();
  if (execInFlight.has(key)) return { ok: false, error: "exec-in-progress" };
  execInFlight.add(key);
  try {
    const account = privateKeyToAccount(pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex));
    const chain = { ...base, rpcUrls: { default: { http: [rpc] }, public: { http: [rpc] } } } as const;
    const pub = createPublicClient({ chain, transport: http(rpc) });

    // execTransaction needs code at the wallet — receiving works pre-deploy, but
    // spending does not. Surface a clear error the UI can turn into "deploy first".
    const code = await pub.getBytecode({ address: input.multisig });
    if (!code || code === "0x") return { ok: false, error: "wallet-not-deployed" };

    const sigs = input.signatures.map(s => ({
      sigType: s.sigType,
      signer: s.signer as Address,
      data: s.data,
    }));
    const args = [input.target, input.value, input.data, input.deadline, sigs] as const;

    // Simulate first: a bad/expired signature or a reverting inner call fails
    // here for free, before we spend a single wei of the facilitator's gas.
    const { request } = await pub.simulateContract({
      account,
      address: input.multisig,
      abi: MULTISIG_ABI,
      functionName: "execTransaction",
      args: args as never,
    });
    const wallet = createWalletClient({ account, chain, transport: http(rpc) });
    const txHash = await wallet.writeContract(request);
    return { ok: true, txHash };
  } catch (err) {
    const msg =
      (err as { shortMessage?: string; message?: string }).shortMessage ?? (err as Error).message ?? "exec-failed";
    return { ok: false, error: msg.split("\n")[0] ?? "exec-failed" };
  } finally {
    execInFlight.delete(key);
  }
}

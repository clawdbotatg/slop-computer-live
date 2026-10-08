import { config } from "./config.js";
import { type Address, type Hex, getAddress, isAddress, keccak256 } from "viem";
import { deploySafeOn, deployerAddress, execSafeTx, isSafeRelayConfigured, toSafeSignatures } from "./safe-relay.js";
import { type SafeTx, PERSONAL_SALT_NONCE, isSafeOperation, personalSafe, totalValue } from "./safe.js";

// A passkey's personal ("single-player") wallet is a Safe on Base: owners
// [passkey signer contract, platform cosigner], threshold 1 (ops/PLAN-safe.md
// phase 5). The relay's hot key deploys it and pays gas for its sends, so a
// passkey-only user (no EOA, no ETH) can spend. The address depends only on
// the passkey + the fixed cosigner — the frontend derives the same one in
// packages/nextjs/utils/personalWallet.ts (NEXT_PUBLIC_PERSONAL_WALLET_DEPLOYER
// must equal personalCosigner() below).

const BASE = 8453;

const isHex32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/** keccak256(qx ‖ qy)[-20:] — the raw passkey address (the session identity). */
export function passkeyAddressFromCoords(qx: Hex, qy: Hex): Address {
  return getAddress("0x" + keccak256((qx + qy.slice(2)) as Hex).slice(-40));
}

/** The fixed second owner. Changing it moves every personal wallet address. */
export function personalCosigner(): Address | null {
  const a = config.personalWalletPlatformCosigner || config.personalWalletDeployer || deployerAddress();
  return a && isAddress(a) ? getAddress(a) : null;
}

export function isPersonalWalletDeployConfigured(): boolean {
  return isSafeRelayConfigured() && !!personalCosigner();
}

/** The personal Safe address for a passkey, or null if unconfigured / bad key. */
export function personalWalletAddressFor(qx: Hex, qy: Hex): Address | null {
  const cosigner = personalCosigner();
  if (!cosigner || !isHex32(qx) || !isHex32(qy)) return null;
  return personalSafe(qx, qy, cosigner).address;
}

export type DeployResult =
  | { ok: true; address: Address; txHash: Hex | null; alreadyDeployed: boolean }
  | { ok: false; error: string };

const inFlight = new Set<string>();

/** Deploy (or no-op) a passkey's personal Safe + its signer contract on Base. Idempotent. */
export async function deployPersonalWallet(input: { qx: Hex; qy: Hex }): Promise<DeployResult> {
  const cosigner = personalCosigner();
  if (!isPersonalWalletDeployConfigured() || !cosigner) return { ok: false, error: "deployer-not-configured" };
  if (!isHex32(input.qx) || !isHex32(input.qy)) return { ok: false, error: "bad-passkey-fields" };
  const p = personalSafe(input.qx, input.qy, cosigner);
  const key = p.address.toLowerCase();
  if (inFlight.has(key)) return { ok: false, error: "deploy-in-progress" };
  inFlight.add(key);
  try {
    const r = await deploySafeOn(BASE, {
      owners: p.owners,
      threshold: 1,
      saltNonce: PERSONAL_SALT_NONCE,
      passkeys: [{ qx: input.qx, qy: input.qy }],
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, address: p.address, txHash: r.txHash, alreadyDeployed: r.txHash === null };
  } finally {
    inFlight.delete(key);
  }
}

// ── Facilitator: sponsored exec ───────────────────────────────────────────────
// Two gates: the Safe verifies the passkey signature on-chain (a bad one fails
// in estimateGas, before broadcast), and the route checks the caller's session
// passkey derives to this wallet. Plus a per-tx value cap.

export type ExecInput = {
  qx: Hex;
  qy: Hex;
  tx: SafeTx;
  signatures: { sigType: number; signer: string; data: string }[];
};

export type ExecResult = { ok: true; txHash: Hex } | { ok: false; error: string };

const execInFlight = new Set<string>();

/** Broadcast a personal Safe's signed tx from the facilitator on Base, paying gas. Deploys first if needed. */
export async function execPersonalWalletTx(input: ExecInput): Promise<ExecResult> {
  const cosigner = personalCosigner();
  if (!isPersonalWalletDeployConfigured() || !cosigner) return { ok: false, error: "facilitator-not-configured" };
  if (!isHex32(input.qx) || !isHex32(input.qy)) return { ok: false, error: "bad-passkey-fields" };
  if (!isSafeOperation(input.tx)) return { ok: false, error: "delegatecall-blocked" };
  let value: bigint;
  try {
    value = totalValue(input.tx);
  } catch {
    return { ok: false, error: "bad-batch" };
  }
  const maxSpend = BigInt(config.personalWalletMaxSpendWei || "0");
  if (maxSpend > 0n && value > maxSpend) return { ok: false, error: "value-exceeds-cap" };
  if (!Array.isArray(input.signatures) || input.signatures.length === 0) return { ok: false, error: "no-signatures" };
  for (const s of input.signatures) {
    if (!isAddress(s.signer) || !/^0x[0-9a-fA-F]*$/.test(s.data) || (s.sigType !== 0 && s.sigType !== 1)) {
      return { ok: false, error: "bad-signature" };
    }
  }
  const p = personalSafe(input.qx, input.qy, cosigner);
  const key = p.address.toLowerCase();
  if (execInFlight.has(key)) return { ok: false, error: "exec-in-progress" };
  execInFlight.add(key);
  try {
    const d = await deployPersonalWallet({ qx: input.qx, qy: input.qy });
    if (!d.ok) return { ok: false, error: d.error };
    // Threshold 1: the passkey owner's signature is the one that counts.
    const mine = input.signatures.filter(s => s.signer.toLowerCase() === p.owner.toLowerCase());
    if (mine.length === 0) return { ok: false, error: "no-passkey-signature" };
    return await execSafeTx(BASE, p.address, input.tx, toSafeSignatures(mine.slice(0, 1)), [
      { qx: input.qx, qy: input.qy },
    ]);
  } finally {
    execInFlight.delete(key);
  }
}

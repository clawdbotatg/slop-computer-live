import { config } from "./config.js";
import { alchemyUrl } from "./wallet-data.js";
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  type SafeTx,
  type Sig,
  MULTICALL3,
  deployBundle,
  deployPasskeyOwnerCall,
  encodeSignatures,
  execData,
  initializer,
  isSafeOperation,
  multicall3Abi,
  passkeyOwner,
  safeAbi,
  safeAddress,
  safeTxHash,
  toSafeTx,
} from "./safe.js";

// Relay side of ops/PLAN-safe.md: we pay to deploy room Safes and passkey
// signer contracts, and to execute fully-signed Safe txs. The deployer is
// the same hot key as personal wallets (PERSONAL_WALLET_DEPLOYER_KEY).
// The Safe itself checks every signature, so a bad request costs at most
// a failed simulate — never a broadcast.

/** A room's Safe goes on all of these at creation (trap 4: the address only matches with the original owners). */
export const SAFE_CHAINS = [1, 8453, 10, 42161, 137, 100, 4663] as const;

export type PasskeyKey = { qx: Hex; qy: Hex };

export function isSafeRelayConfigured(): boolean {
  return !!config.personalWalletDeployerKey && !!config.alchemyApiKey;
}

function account() {
  const pk = config.personalWalletDeployerKey;
  return privateKeyToAccount(pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex));
}

const clients = new Map<number, { pub: PublicClient; wallet: WalletClient }>();
function clientsFor(chainId: number) {
  let c = clients.get(chainId);
  if (!c) {
    // SAFE_RPC_<chainId> points a chain at a local fork (ops/probes/safe-relay-fork.mjs).
    const rpc = process.env[`SAFE_RPC_${chainId}`] || alchemyUrl(chainId);
    const chain = defineChain({
      id: chainId,
      name: String(chainId),
      nativeCurrency: { name: "native", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });
    c = {
      pub: createPublicClient({ chain, transport: http(rpc) }) as PublicClient,
      wallet: createWalletClient({ account: account(), chain, transport: http(rpc) }),
    };
    clients.set(chainId, c);
  }
  return c;
}

// One send at a time per chain: concurrent sends from the same key would
// pick the same nonce and one would be dropped.
const sendQueue = new Map<number, Promise<unknown>>();
function serial<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
  const prev = sendQueue.get(chainId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  sendQueue.set(
    chainId,
    next.catch(() => undefined),
  );
  return next;
}

async function hasCode(chainId: number, addr: Address): Promise<boolean> {
  const code = await clientsFor(chainId).pub.getCode({ address: addr });
  return !!code && code !== "0x";
}

const errText = (err: unknown) =>
  ((err as { shortMessage?: string }).shortMessage ?? (err as Error).message ?? "failed").split("\n")[0]!;

/** Send `data` to `to` from the deployer, wait for it, throw on revert. */
async function sendAndWait(chainId: number, to: Address, data: Hex): Promise<Hex> {
  const { pub, wallet } = clientsFor(chainId);
  const acct = account();
  return serial(chainId, async () => {
    // estimateGas doubles as the simulate: a revert fails here for free.
    const gas = await pub.estimateGas({ account: acct, to, data });
    const hash = await wallet.sendTransaction({
      account: acct,
      chain: wallet.chain,
      to,
      data,
      gas: (gas * 12n) / 10n,
    });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") throw new Error(`reverted (${hash})`);
    return hash;
  });
}

// ---------------------------------------------------------------- deploy

export type SafeSpec = {
  owners: Address[]; // every owner address — passkey owners as their signer-proxy address
  threshold: number;
  saltNonce: bigint;
  passkeys: PasskeyKey[]; // keys behind the passkey owners, so we can create their signers
};

export type ChainResult = { chainId: number; ok: true; txHash: Hex | null } | { chainId: number; ok: false; error: string };

export function validateSpec(s: SafeSpec): string | null {
  if (s.owners.length === 0 || s.owners.length > 20) return "owners-count";
  if (!s.owners.every(o => isAddress(o))) return "bad-owner";
  if (!Number.isInteger(s.threshold) || s.threshold < 1 || s.threshold > s.owners.length) return "bad-threshold";
  const owners = new Set(s.owners.map(o => o.toLowerCase()));
  if (owners.size !== s.owners.length) return "duplicate-owner";
  for (const k of s.passkeys) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(k.qx) || !/^0x[0-9a-fA-F]{64}$/.test(k.qy)) return "bad-passkey";
    if (!owners.has(passkeyOwner(k.qx, k.qy).toLowerCase())) return "passkey-not-owner";
  }
  return null;
}

export function predictSafe(s: SafeSpec): Address {
  return safeAddress(initializer(s.owners, s.threshold), s.saltNonce);
}

/** Deploy the Safe (and its passkey signers) on one chain. Already there → ok with no hash. */
export async function deploySafeOn(chainId: number, s: SafeSpec): Promise<ChainResult> {
  try {
    const init = initializer(s.owners, s.threshold);
    const safe = safeAddress(init, s.saltNonce);
    if (await hasCode(chainId, safe)) {
      // The Safe exists, but a signer may not (e.g. an owner added later).
      await ensureSignersOn(chainId, s.passkeys);
      return { chainId, ok: true, txHash: null };
    }
    const bundle = deployBundle(
      s.passkeys.map(k => ({ x: k.qx, y: k.qy })),
      init,
      s.saltNonce,
    );
    const txHash = await sendAndWait(chainId, bundle.to, bundle.data);
    if (!(await hasCode(chainId, safe))) return { chainId, ok: false, error: "no-code-after-deploy" };
    return { chainId, ok: true, txHash };
  } catch (err) {
    return { chainId, ok: false, error: errText(err) };
  }
}

/** Create any missing passkey signer contracts on one chain, in one tx. */
export async function ensureSignersOn(chainId: number, keys: PasskeyKey[]): Promise<Hex | null> {
  const missing: PasskeyKey[] = [];
  for (const k of keys) if (!(await hasCode(chainId, passkeyOwner(k.qx, k.qy)))) missing.push(k);
  if (missing.length === 0) return null;
  const calls = missing.map(k => deployPasskeyOwnerCall(k.qx, k.qy));
  const data = encodeFunctionData({
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [calls.map(c => ({ target: c.to, allowFailure: true, callData: c.data }))],
  });
  return sendAndWait(chainId, MULTICALL3, data);
}

// ---------------------------------------------------------------- exec

export type StoredSig = { signer: string; sigType: number; data: string };

/** Stored queue signatures → Safe signature bytes. sigType 0 = EOA (65 bytes), 1 = passkey/contract. */
export function toSafeSignatures(sigs: StoredSig[]): Hex {
  const out: Sig[] = sigs.map(s => ({
    signer: getAddress(s.signer),
    data: s.data as Hex,
    kind: s.sigType === 1 ? "contract" : "ecdsa",
  }));
  return encodeSignatures(out);
}

export async function safeNonce(chainId: number, safe: Address): Promise<bigint> {
  return clientsFor(chainId).pub.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }) as Promise<bigint>;
}

export async function safeOwners(chainId: number, safe: Address): Promise<Address[]> {
  return clientsFor(chainId).pub.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "getOwners",
  }) as Promise<Address[]>;
}

/** Broadcast a fully-signed SafeTx from the deployer. Returns once mined. */
export async function execSafeTx(
  chainId: number,
  safe: Address,
  tx: SafeTx,
  signatures: Hex,
  passkeys: PasskeyKey[],
): Promise<{ ok: true; txHash: Hex } | { ok: false; error: string }> {
  if (!isSafeOperation(tx)) return { ok: false, error: "delegatecall-blocked" };
  try {
    if (!(await hasCode(chainId, safe))) return { ok: false, error: "safe-not-deployed" };
    await ensureSignersOn(chainId, passkeys);
    const txHash = await sendAndWait(chainId, safe, execData(tx, signatures));
    return { ok: true, txHash };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

export function deployerAddress(): Address | null {
  return config.personalWalletDeployerKey ? account().address : null;
}

// ---------------------------------------------------------------- queue checks

type ProposeMsg = { target?: unknown; value?: unknown; data?: unknown; nonce?: unknown; execHash?: unknown; operation?: unknown };

/**
 * A Bank proposal on a Safe: target/value/data/operation/nonce are the exact
 * SafeTx. Re-derive the hash (so signers sign what's shown), refuse foreign
 * delegatecalls (trap 2), and make sure a batch's `calls` are what's inside.
 */
export function checkSafePropose(
  msg: ProposeMsg,
  safe: string,
  chainId: number,
  calls?: { target: string; value: string; data: string }[],
): { ok: true; operation: 0 | 1; tx: SafeTx } | { ok: false; error: string } {
  if (msg.operation !== 0 && msg.operation !== 1) return { ok: false, error: "bad_operation" };
  let tx: SafeTx;
  try {
    tx = {
      to: getAddress(String(msg.target)),
      value: BigInt(String(msg.value)),
      data: String(msg.data) as Hex,
      operation: msg.operation,
      nonce: BigInt(String(msg.nonce)),
    };
  } catch {
    return { ok: false, error: "bad_propose" };
  }
  if (!isSafeOperation(tx)) return { ok: false, error: "delegatecall_blocked" };
  if (calls && calls.length > 0) {
    let packed: SafeTx;
    try {
      packed = toSafeTx(
        calls.map(c => ({ to: getAddress(c.target), value: BigInt(c.value), data: c.data as Hex })),
        tx.nonce,
      );
    } catch {
      return { ok: false, error: "bad_calls" };
    }
    if (packed.to !== tx.to || packed.data.toLowerCase() !== tx.data.toLowerCase() || packed.operation !== tx.operation) {
      return { ok: false, error: "calls_mismatch" };
    }
  }
  if (safeTxHash(chainId, getAddress(safe), tx).toLowerCase() !== String(msg.execHash).toLowerCase()) {
    return { ok: false, error: "hash_mismatch" };
  }
  return { ok: true, operation: tx.operation, tx };
}

/**
 * Most proposers (ENS, shared browser, AI, wagers) just say "do these calls".
 * For a Safe room the relay picks the nonce and computes the hash, so no
 * client has to know Safe. Nonce = next free one after the pending queue, so
 * proposals line up instead of racing; an identical pending proposal is reused.
 */
export async function fillSafeProposal(
  safe: string,
  pending: { chainId: number; multisigAddress: string; status: string; operation?: 0 | 1; nonce: string; target: string; value: string; data: string }[],
  msg: { chainId?: unknown; target?: unknown; value?: unknown; data?: unknown; calls?: unknown },
  fallbackChainId: number,
): Promise<{ ok: true; fields: Record<string, unknown> } | { ok: false; error: string }> {
  const chainId = typeof msg.chainId === "number" ? msg.chainId : fallbackChainId;
  let calls: { to: Address; value: bigint; data: Hex }[];
  try {
    calls =
      Array.isArray(msg.calls) && msg.calls.length > 0
        ? (msg.calls as { target: string; value: string; data: string }[])
            .slice(0, 50)
            .map(c => ({ to: getAddress(c.target), value: BigInt(c.value), data: (c.data || "0x") as Hex }))
        : [{ to: getAddress(String(msg.target)), value: BigInt(String(msg.value ?? "0")), data: (String(msg.data ?? "0x") || "0x") as Hex }];
  } catch {
    return { ok: false, error: "bad_propose" };
  }
  const safeAddr = getAddress(safe);
  const mine = pending.filter(
    t => t.status === "pending" && t.operation !== undefined && t.chainId === chainId && t.multisigAddress === safe.toLowerCase(),
  );
  let nonce: bigint;
  try {
    nonce = await safeNonce(chainId, safeAddr);
  } catch {
    return { ok: false, error: "safe_not_deployed_on_chain" };
  }
  const probe = toSafeTx(calls, 0n);
  const same = mine.find(
    t => getAddress(t.target) === probe.to && BigInt(t.value) === probe.value && t.data.toLowerCase() === probe.data.toLowerCase(),
  );
  if (same && BigInt(same.nonce) >= nonce) nonce = BigInt(same.nonce);
  else for (const t of mine) if (BigInt(t.nonce) >= nonce) nonce = BigInt(t.nonce) + 1n;
  const tx = toSafeTx(calls, nonce);
  return {
    ok: true,
    fields: {
      chainId,
      target: tx.to,
      value: tx.value.toString(),
      data: tx.data,
      operation: tx.operation,
      nonce: nonce.toString(),
      deadline: "0",
      execHash: safeTxHash(chainId, safeAddr, tx),
    },
  };
}

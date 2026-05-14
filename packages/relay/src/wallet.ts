import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Per-episode multisig state — a "session wallet" — plus the queue of
// pending transactions for it. Persists to JSON on disk so a relay
// restart doesn't lose the wallet address or in-flight signatures.
//
// Model: there is one `current` multisig. Starting a new episode
// archives `current` into `history` and lets the UI offer a fresh
// deploy. The pending tx queue is reset on episode change (executed
// txs persist as a small audit trail).

const WALLET_FILE = process.env.WALLET_FILE ?? "./.slop-data/wallet.json";
const MAX_HISTORY = 50;
const MAX_TXS = 100;

export type WalletSignerType = "eoa" | "passkey";

export type WalletSigner = {
  address: string; // 0x-lowercased 20-byte address
  label: string; // ENS / handle / short-addr for display
  signerType: WalletSignerType;
};

export type WalletRecord = {
  id: string;
  address: string; // 0x-lowercased
  chainId: number;
  deployer: string;
  salt: string; // 0x-prefixed bytes32
  signers: WalletSigner[];
  threshold: number;
  txHash: string | null; // deploy tx (null until tx confirmed)
  createdAt: number;
  label: string; // human-readable, e.g. "Episode 12"
};

export type WalletTxSignature = {
  signer: string; // 0x-lowercased 20-byte
  sigType: 0 | 1; // 0 = EOA, 1 = passkey
  data: string; // 0x-prefixed
  receivedAt: number;
};

export type WalletTxStatus = "pending" | "executing" | "executed" | "failed" | "expired" | "cancelled";

export type WalletTx = {
  id: string;
  multisigAddress: string; // lowercased
  chainId: number;
  from: string | null; // proposer address (lowercased) or null
  fromLabel: string | null; // proposer display label
  source: "browser" | "manual";
  browserId: string | null;
  target: string; // 0x-lowercased
  value: string; // decimal string of bigint
  data: string; // 0x-prefixed calldata
  deadline: string; // decimal string of bigint
  nonce: string; // decimal string at proposal time (matches multisig.nonce())
  execHash: string; // 0x-prefixed
  summary: string | null; // AI-generated plain-English summary
  signatures: WalletTxSignature[];
  status: WalletTxStatus;
  txHash: string | null; // execution tx hash
  createdAt: number;
  updatedAt: number;
};

type WalletState = {
  current: WalletRecord | null;
  history: WalletRecord[];
  txs: WalletTx[];
};

let state: WalletState = { current: null, history: [], txs: [] };
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(WALLET_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<WalletState>;
    state = {
      current: parsed.current ?? null,
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, MAX_HISTORY) : [],
      txs: Array.isArray(parsed.txs) ? parsed.txs.slice(0, MAX_TXS) : [],
    };
  } catch {
    /* fresh */
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(WALLET_FILE), { recursive: true });
    writeFileSync(WALLET_FILE, JSON.stringify(state), "utf8");
  } catch {
    /* disk write failure — in-memory state still served */
  }
}

type Subscriber = (s: WalletState) => void;
const subscribers = new Set<Subscriber>();
function emit(): void {
  for (const fn of subscribers) {
    try {
      fn(state);
    } catch {
      /* ignore */
    }
  }
}
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function snapshot(): WalletState {
  load();
  return { current: state.current, history: [...state.history], txs: [...state.txs] };
}

export function getCurrent(): WalletRecord | null {
  load();
  return state.current;
}

export function listTxs(): WalletTx[] {
  load();
  return [...state.txs];
}

export function findTx(id: string): WalletTx | null {
  load();
  return state.txs.find(t => t.id === id) ?? null;
}

export function setCurrent(rec: WalletRecord): void {
  load();
  if (state.current && state.current.address.toLowerCase() !== rec.address.toLowerCase()) {
    state.history.unshift(state.current);
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    // Reset pending tx queue — but keep executed ones from the prior
    // wallet around as a small audit trail.
    state.txs = state.txs.filter(t => t.status === "executed");
  }
  state.current = rec;
  persist();
  emit();
}

export function archiveCurrent(): void {
  load();
  if (!state.current) return;
  state.history.unshift(state.current);
  state.current = null;
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  state.txs = state.txs.filter(t => t.status === "executed");
  persist();
  emit();
}

export type ProposeTxInput = {
  multisigAddress: string;
  chainId: number;
  from: string | null;
  fromLabel: string | null;
  source: WalletTx["source"];
  browserId: string | null;
  target: string;
  value: string;
  data: string;
  deadline: string;
  nonce: string;
  execHash: string;
};

export function proposeTx(input: ProposeTxInput): WalletTx {
  load();
  const now = Date.now();
  const tx: WalletTx = {
    id: randomBytes(8).toString("hex"),
    multisigAddress: input.multisigAddress.toLowerCase(),
    chainId: input.chainId,
    from: input.from ? input.from.toLowerCase() : null,
    fromLabel: input.fromLabel,
    source: input.source,
    browserId: input.browserId,
    target: input.target.toLowerCase(),
    value: input.value,
    data: input.data,
    deadline: input.deadline,
    nonce: input.nonce,
    execHash: input.execHash.toLowerCase(),
    summary: null,
    signatures: [],
    status: "pending",
    txHash: null,
    createdAt: now,
    updatedAt: now,
  };
  state.txs.unshift(tx);
  if (state.txs.length > MAX_TXS) state.txs.length = MAX_TXS;
  persist();
  emit();
  return tx;
}

export function addSignature(id: string, sig: WalletTxSignature): WalletTx | null {
  load();
  const tx = state.txs.find(t => t.id === id);
  if (!tx) return null;
  if (tx.status !== "pending") return tx;
  // Replace any existing signature from the same signer (re-sign overwrites).
  tx.signatures = tx.signatures.filter(s => s.signer.toLowerCase() !== sig.signer.toLowerCase());
  tx.signatures.push({ ...sig, signer: sig.signer.toLowerCase() });
  tx.updatedAt = Date.now();
  persist();
  emit();
  return tx;
}

export function setTxStatus(id: string, status: WalletTxStatus, txHash: string | null = null): WalletTx | null {
  load();
  const tx = state.txs.find(t => t.id === id);
  if (!tx) return null;
  tx.status = status;
  if (txHash) tx.txHash = txHash;
  tx.updatedAt = Date.now();
  persist();
  emit();
  return tx;
}

export function setTxSummary(id: string, summary: string): WalletTx | null {
  load();
  const tx = state.txs.find(t => t.id === id);
  if (!tx) return null;
  tx.summary = summary;
  tx.updatedAt = Date.now();
  persist();
  emit();
  return tx;
}

export function removeTx(id: string): boolean {
  load();
  const idx = state.txs.findIndex(t => t.id === id);
  if (idx < 0) return false;
  state.txs.splice(idx, 1);
  persist();
  emit();
  return true;
}

// Nuke everything: current wallet, history, all txs. Used by the admin
// panel's "Reset session wallet" button to start an episode from scratch
// without having to ssh in and delete `.slop-data/wallet.json` by hand.
export function wipeAll(): void {
  load();
  state = { current: null, history: [], txs: [] };
  persist();
  emit();
}

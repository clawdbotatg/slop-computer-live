import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room session wallet: a multisig deployed for the episode plus
// the pending tx queue against it. Persists to JSON so a relay restart
// doesn't lose the wallet address or in-flight signatures.
//
// Model: there is one `current` multisig per room. Starting a new
// episode archives `current` into `history` and lets the UI offer a
// fresh deploy. The pending tx queue is reset on episode change
// (executed txs persist as a small audit trail).

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

type WalletStateData = {
  current: WalletRecord | null;
  history: WalletRecord[];
  txs: WalletTx[];
};

type Subscriber = (s: WalletStateData) => void;

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

export class WalletState {
  private state: WalletStateData = { current: null, history: [], txs: [] };
  private loaded = false;
  private subscribers = new Set<Subscriber>();

  constructor(
    private readonly filePath: string,
    private readonly legacyPath: string | null = null,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.readFrom(this.filePath)) return;
    if (this.legacyPath) this.readFrom(this.legacyPath);
  }

  private readFrom(path: string): boolean {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as Partial<WalletStateData>;
      this.state = {
        current: parsed.current ?? null,
        history: Array.isArray(parsed.history) ? parsed.history.slice(0, MAX_HISTORY) : [],
        txs: Array.isArray(parsed.txs) ? parsed.txs.slice(0, MAX_TXS) : [],
      };
      return true;
    } catch {
      return false;
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify(this.state));
    } catch {
      /* disk write failure — in-memory state still served */
    }
  }

  private emit(): void {
    for (const fn of this.subscribers) {
      try {
        fn(this.state);
      } catch {
        /* one bad sub shouldn't kill the rest */
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  snapshot(): WalletStateData {
    this.load();
    return { current: this.state.current, history: [...this.state.history], txs: [...this.state.txs] };
  }

  getCurrent(): WalletRecord | null {
    this.load();
    return this.state.current;
  }

  listTxs(): WalletTx[] {
    this.load();
    return [...this.state.txs];
  }

  findTx(id: string): WalletTx | null {
    this.load();
    return this.state.txs.find(t => t.id === id) ?? null;
  }

  setCurrent(rec: WalletRecord): void {
    this.load();
    if (this.state.current && this.state.current.address.toLowerCase() !== rec.address.toLowerCase()) {
      this.state.history.unshift(this.state.current);
      if (this.state.history.length > MAX_HISTORY) this.state.history.length = MAX_HISTORY;
      // Reset pending tx queue — but keep executed ones from the prior
      // wallet around as a small audit trail.
      this.state.txs = this.state.txs.filter(t => t.status === "executed");
    }
    this.state.current = rec;
    this.persist();
    this.emit();
  }

  archiveCurrent(): void {
    this.load();
    if (!this.state.current) return;
    this.state.history.unshift(this.state.current);
    this.state.current = null;
    if (this.state.history.length > MAX_HISTORY) this.state.history.length = MAX_HISTORY;
    this.state.txs = this.state.txs.filter(t => t.status === "executed");
    this.persist();
    this.emit();
  }

  proposeTx(input: ProposeTxInput): WalletTx {
    this.load();
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
    this.state.txs.unshift(tx);
    if (this.state.txs.length > MAX_TXS) this.state.txs.length = MAX_TXS;
    this.persist();
    this.emit();
    return tx;
  }

  addSignature(id: string, sig: WalletTxSignature): WalletTx | null {
    this.load();
    const tx = this.state.txs.find(t => t.id === id);
    if (!tx) return null;
    if (tx.status !== "pending") return tx;
    // Replace any existing signature from the same signer (re-sign overwrites).
    tx.signatures = tx.signatures.filter(s => s.signer.toLowerCase() !== sig.signer.toLowerCase());
    tx.signatures.push({ ...sig, signer: sig.signer.toLowerCase() });
    tx.updatedAt = Date.now();
    this.persist();
    this.emit();
    return tx;
  }

  setTxStatus(id: string, status: WalletTxStatus, txHash: string | null = null): WalletTx | null {
    this.load();
    const tx = this.state.txs.find(t => t.id === id);
    if (!tx) return null;
    tx.status = status;
    if (txHash) tx.txHash = txHash;
    tx.updatedAt = Date.now();
    this.persist();
    this.emit();
    return tx;
  }

  setTxSummary(id: string, summary: string): WalletTx | null {
    this.load();
    const tx = this.state.txs.find(t => t.id === id);
    if (!tx) return null;
    tx.summary = summary;
    tx.updatedAt = Date.now();
    this.persist();
    this.emit();
    return tx;
  }

  removeTx(id: string): boolean {
    this.load();
    const idx = this.state.txs.findIndex(t => t.id === id);
    if (idx < 0) return false;
    this.state.txs.splice(idx, 1);
    this.persist();
    this.emit();
    return true;
  }

  // Nuke everything: current wallet, history, all txs. Used by the admin
  // panel's "Reset session wallet" button to start an episode from
  // scratch without having to ssh in and delete the JSON by hand.
  wipeAll(): void {
    this.load();
    this.state = { current: null, history: [], txs: [] };
    this.persist();
    this.emit();
  }
}

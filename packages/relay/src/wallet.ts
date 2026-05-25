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
  // P-256 public key + credential-id hash. Populated for passkey
  // signers so the multisig contract can verify their WebAuthn
  // assertions: `address` is just `keccak256(qx||qy)[-20:]`, the
  // contract stores qx/qy/credentialIdHash on-chain and we mirror them
  // here so any peer who wants to ask "is this exec hash signable by
  // signer X?" has the data they need. Undefined for EOA signers.
  qx?: string;
  qy?: string;
  credentialIdHash?: string;
};

// The multisig's CREATE2 address is the same on every chain (factory at
// the same address; deterministic from deployer+salt). A WalletRecord is
// therefore one logical wallet, with N deployment entries — one per
// chain it's been created on. Funding the address before deploying
// works fine; you just can't execute txs on a chain until createMultisig
// runs there.
export type WalletDeployment = {
  txHash: string | null; // deploy tx hash (null until receipt lands)
  deployedAt: number; // unix ms when the record was created
};

export type WalletRecord = {
  id: string;
  address: string; // 0x-lowercased — identical across chains
  deployer: string;
  salt: string; // 0x-prefixed bytes32
  signers: WalletSigner[];
  threshold: number;
  deployments: Record<number, WalletDeployment>; // keyed by chainId
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

// Collaborative pre-deploy form state — replicated to every peer so
// hosts + guests see the same selected signers / threshold / label as
// they're being edited. Cleared once `current` is set (a wallet has
// actually deployed). Anyone can update; only the host can submit the
// deploy itself.
export type WalletDraft = {
  // Lowercased address → selected. Includes peer addresses + custom-
  // typed addresses; the candidate list itself is derived from mesh
  // peers locally on each client so we don't replicate that.
  selected: Record<string, boolean>;
  threshold: number;
  label: string;
  // Addresses manually typed in via AddSignerRow that aren't otherwise
  // connected as peers. Display labels travel with them.
  customSigners: { address: string; label: string }[];
};

type WalletStateData = {
  current: WalletRecord | null;
  history: WalletRecord[];
  txs: WalletTx[];
  draft: WalletDraft | null;
};

// One-shot translation from the pre-multi-chain record shape
// `{chainId, txHash}` into the new `deployments` map. Old records on
// disk are rewritten lazily the first time they're loaded; new writes
// always use the new shape.
function migrateRecord(rec: unknown): WalletRecord | null {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Partial<WalletRecord> & { chainId?: number; txHash?: string | null };
  if (typeof r.address !== "string") return null;
  if (r.deployments && typeof r.deployments === "object") {
    // Already in the new shape — coerce numeric keys (JSON makes them strings).
    const normalized: Record<number, WalletDeployment> = {};
    for (const [k, v] of Object.entries(r.deployments)) {
      const chainId = Number(k);
      if (!Number.isFinite(chainId)) continue;
      if (!v || typeof v !== "object") continue;
      const dep = v as Partial<WalletDeployment>;
      normalized[chainId] = {
        txHash: typeof dep.txHash === "string" ? dep.txHash : null,
        deployedAt: typeof dep.deployedAt === "number" ? dep.deployedAt : (r.createdAt ?? Date.now()),
      };
    }
    return { ...(r as WalletRecord), deployments: normalized };
  }
  // Legacy: single-chain record.
  if (typeof r.chainId !== "number") return null;
  const deployments: Record<number, WalletDeployment> = {
    [r.chainId]: {
      txHash: typeof r.txHash === "string" ? r.txHash : null,
      deployedAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
    },
  };
  const next: WalletRecord = {
    id: r.id ?? Math.random().toString(36).slice(2),
    address: r.address,
    deployer: r.deployer ?? "",
    salt: r.salt ?? "",
    signers: Array.isArray(r.signers) ? r.signers : [],
    threshold: typeof r.threshold === "number" ? r.threshold : 1,
    deployments,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
    label: typeof r.label === "string" ? r.label : "",
  };
  return next;
}

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
  private state: WalletStateData = { current: null, history: [], txs: [], draft: null };
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
        current: migrateRecord(parsed.current ?? null),
        history: Array.isArray(parsed.history)
          ? (parsed.history.slice(0, MAX_HISTORY).map(migrateRecord).filter(Boolean) as WalletRecord[])
          : [],
        txs: Array.isArray(parsed.txs) ? parsed.txs.slice(0, MAX_TXS) : [],
        draft: parsed.draft && typeof parsed.draft === "object" ? (parsed.draft as WalletDraft) : null,
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
    return {
      current: this.state.current,
      history: [...this.state.history],
      txs: [...this.state.txs],
      draft: this.state.draft,
    };
  }

  getCurrent(): WalletRecord | null {
    this.load();
    return this.state.current;
  }

  getDraft(): WalletDraft | null {
    this.load();
    return this.state.draft;
  }

  // Replace the entire draft. Pass null to clear (e.g. after deploy).
  // We replace rather than merge — clients send full snapshots, which
  // is simpler and avoids field-by-field merge races between peers.
  setDraft(draft: WalletDraft | null): void {
    this.load();
    this.state.draft = draft;
    this.persist();
    this.emit();
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
    // Once a wallet is deployed, the draft is consumed — clear it so
    // a future "new episode" starts from a fresh form, not the prior
    // session's selections.
    this.state.draft = null;
    this.persist();
    this.emit();
  }

  // Record a deployment of the current wallet on an additional chain.
  // The address is deterministic from (deployer, salt) so we don't take
  // it as a parameter — it must equal `current.address`. No-op if there
  // is no current wallet, or if a deployment for that chain already
  // exists with a tx hash (we don't clobber prior records).
  addDeployment(chainId: number, txHash: string | null): WalletRecord | null {
    this.load();
    if (!this.state.current) return null;
    const existing = this.state.current.deployments[chainId];
    if (existing && existing.txHash) return this.state.current;
    this.state.current = {
      ...this.state.current,
      deployments: {
        ...this.state.current.deployments,
        [chainId]: { txHash, deployedAt: Date.now() },
      },
    };
    this.persist();
    this.emit();
    return this.state.current;
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
    this.state = { current: null, history: [], txs: [], draft: null };
    this.persist();
    this.emit();
  }
}

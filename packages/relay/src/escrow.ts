// Generic money escrow for live.slop.computer games.
//
// One escrow session per room, backed by the room multisig. It's a
// pooled-balance account book: players deposit ETH (the relay verifies
// each deposit on-chain before crediting it), a server-authoritative
// game redistributes balances, and the balances are paid back out
// through the multisig. The escrow knows NOTHING about any specific
// game — chess, pong, poker all drive it through the same surface.
// Game-specific logic (who the players are, when to settle, how the
// payout splits) lives in the game module; the money lives here.
//
// The model is a per-player ledger, not winner-takes-pot — that's the
// shape poker needs (chips flow hand by hand, players rebuy, each cashes
// out their own stack). Winner-takes-pot (chess, pong) is just the
// degenerate case: lock the balances, redistribute once, settle. See
// ops/PLAN-poker.md for how poker extends this (applyDeltas per hand +
// per-account withdraw on cash-out).
//
// Invariant: Σ balanceWei ≤ Σ depositedWei ≤ on-chain multisig balance.
// `settle()` refuses to pay out more than was escrowed, so a buggy game
// can never propose a payout the escrow can't cover.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

export type EscrowStatus =
  | "open" // collecting required buy-ins
  | "locked" // all required deposits in; the game owns play now
  | "settling" // a payout plan is proposed + executing
  | "settled" // payouts executed; session closed
  | "cancelled"; // aborted with nothing escrowed

export type EscrowDeposit = {
  txHash: string;
  /** Total wei this account has deposited (grows on rebuy). */
  amountWei: string;
  confirmedAt: number;
};

export type EscrowAccount = {
  /** Lowercased address — must be able to fund AND sign the payout. */
  key: string;
  label: string;
  /** Game-defined role/seat, e.g. "white"/"black" for chess, seat index
   *  for poker. Purely for the game's UI; the escrow ignores it. */
  role: string;
  /** Buy-in this account must deposit to count as funded. */
  requiredWei: string;
  /** Total verified deposits (accumulates across rebuys). */
  depositedWei: string;
  /** Current withdrawable balance. Starts == depositedWei; a game
   *  redistributes it via applyDeltas (poker) or leaves it untouched and
   *  settles directly off deposits (chess). */
  balanceWei: string;
  deposit: EscrowDeposit | null;
};

/** One leg of a settlement: pay `amountWei` to `to`. A single-payout
 *  settlement executes as Multisig.execTransaction; multiple legs as
 *  execBatchTransaction (the batch IS the splitter — recipients are
 *  EOAs, so no splitter contract is needed). */
export type EscrowPayout = { to: string; amountWei: string };

export type EscrowSession = {
  id: string;
  /** Which game owns this session: "chess" | "pong" | "poker" | … The
   *  relay uses it to route settle hooks; the client to pick a UI. */
  game: string;
  chainId: number;
  /** Escrow address — the room multisig, lowercased. */
  multisig: string;
  status: EscrowStatus;
  accounts: EscrowAccount[];
  /** The settlement plan, set when the game settles. */
  payouts: EscrowPayout[] | null;
  payoutTxId: string | null;
  payoutTxHash: string | null;
  settledAt: number | null;
  /** Game-specific blob (chess: { outcome, winner, buyinWei }). */
  meta: Record<string, unknown>;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type OpenEscrowArgs = {
  game: string;
  chainId: number;
  multisig: string;
  accounts: { key: string; label: string; role: string; requiredWei: string }[];
  meta?: Record<string, unknown>;
  createdBy: string;
};

type EscrowResult = { ok: true; session: EscrowSession } | { ok: false; error: string };

function isAddress(v: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(v);
}

function isWei(v: string): boolean {
  if (!/^\d+$/.test(v)) return false;
  try {
    return BigInt(v) >= 0n;
  } catch {
    return false;
  }
}

function isTerminal(status: EscrowStatus): boolean {
  return status === "settled" || status === "cancelled";
}

export class EscrowState {
  private current: EscrowSession | null = null;
  private loaded = false;
  private saveQueued = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { current?: EscrowSession | null };
      if (parsed.current && typeof parsed.current === "object") this.current = parsed.current;
    } catch {
      /* cold start — no session */
    }
  }

  private scheduleSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      try {
        writeFileAtomic(this.filePath, JSON.stringify({ current: this.current }));
      } catch (err) {
        console.error("[escrow] failed to persist:", err);
      }
    });
  }

  private touch(): EscrowSession {
    if (!this.current) throw new Error("no escrow session");
    this.current.updatedAt = Date.now();
    this.scheduleSave();
    return this.current;
  }

  get(): EscrowSession | null {
    this.load();
    return this.current;
  }

  accountOf(key: string): EscrowAccount | null {
    this.load();
    if (!this.current) return null;
    const k = key.toLowerCase();
    return this.current.accounts.find(a => a.key === k) ?? null;
  }

  /** Open a new escrow session. Rejects if one is live (anything not yet
   *  settled/cancelled). Every account must be a distinct address. */
  open(args: OpenEscrowArgs): EscrowResult {
    this.load();
    if (this.current && !isTerminal(this.current.status)) {
      return { ok: false, error: "escrow_already_active" };
    }
    const multisig = args.multisig.toLowerCase();
    if (!isAddress(multisig)) return { ok: false, error: "bad_multisig" };
    if (!args.accounts || args.accounts.length < 1) return { ok: false, error: "no_accounts" };
    const keys = new Set<string>();
    const accounts: EscrowAccount[] = [];
    for (const a of args.accounts) {
      const key = a.key.toLowerCase();
      if (!isAddress(key)) return { ok: false, error: "accounts_must_be_addresses" };
      if (keys.has(key)) return { ok: false, error: "duplicate_account" };
      keys.add(key);
      if (!isWei(a.requiredWei) || BigInt(a.requiredWei) <= 0n) return { ok: false, error: "bad_buyin" };
      accounts.push({
        key,
        label: a.label || key,
        role: a.role,
        requiredWei: a.requiredWei,
        depositedWei: "0",
        balanceWei: "0",
        deposit: null,
      });
    }
    const now = Date.now();
    this.current = {
      id: randomBytes(6).toString("hex"),
      game: args.game,
      chainId: args.chainId,
      multisig,
      status: "open",
      accounts,
      payouts: null,
      payoutTxId: null,
      payoutTxHash: null,
      settledAt: null,
      meta: args.meta ?? {},
      createdBy: args.createdBy.toLowerCase(),
      createdAt: now,
      updatedAt: now,
    };
    this.scheduleSave();
    return { ok: true, session: this.current };
  }

  /** Credit a deposit the relay has ALREADY verified on-chain. Adds to
   *  both depositedWei (audit) and balanceWei (withdrawable). Accumulates
   *  on rebuy. Flips to `locked` once every account has met its buy-in. */
  recordDeposit(key: string, deposit: { txHash: string; amountWei: string }): EscrowResult {
    this.load();
    if (!this.current) return { ok: false, error: "no_escrow" };
    if (this.current.status !== "open") return { ok: false, error: "not_open" };
    const acct = this.accountOf(key);
    if (!acct) return { ok: false, error: "not_a_participant" };
    if (!isWei(deposit.amountWei)) return { ok: false, error: "bad_amount" };
    acct.depositedWei = (BigInt(acct.depositedWei) + BigInt(deposit.amountWei)).toString();
    acct.balanceWei = (BigInt(acct.balanceWei) + BigInt(deposit.amountWei)).toString();
    acct.deposit = { txHash: deposit.txHash, amountWei: acct.depositedWei, confirmedAt: Date.now() };
    if (this.allFunded()) this.current.status = "locked";
    return { ok: true, session: this.touch() };
  }

  allFunded(): boolean {
    this.load();
    if (!this.current) return false;
    return this.current.accounts.every(a => BigInt(a.depositedWei) >= BigInt(a.requiredWei));
  }

  /** Redistribute balances among accounts (zero-sum). The poker hook: a
   *  hand result is a set of deltas that sum to zero and never drive any
   *  balance negative. Chess doesn't use this — it settles straight off
   *  deposits — but it's the core of the per-player ledger model. */
  applyDeltas(deltas: { key: string; deltaWei: string }[]): EscrowResult {
    this.load();
    if (!this.current) return { ok: false, error: "no_escrow" };
    if (this.current.status !== "locked") return { ok: false, error: "not_locked" };
    let sum = 0n;
    const resolved: { acct: EscrowAccount; next: bigint }[] = [];
    for (const d of deltas) {
      const acct = this.accountOf(d.key);
      if (!acct) return { ok: false, error: "not_a_participant" };
      let delta: bigint;
      try {
        delta = BigInt(d.deltaWei);
      } catch {
        return { ok: false, error: "bad_delta" };
      }
      const next = BigInt(acct.balanceWei) + delta;
      if (next < 0n) return { ok: false, error: "balance_underflow" };
      sum += delta;
      resolved.push({ acct, next });
    }
    if (sum !== 0n) return { ok: false, error: "deltas_not_zero_sum" };
    for (const { acct, next } of resolved) acct.balanceWei = next.toString();
    return { ok: true, session: this.touch() };
  }

  /** Set the settlement plan. Validates every recipient is a participant
   *  and the total doesn't exceed what's escrowed (the solvency
   *  invariant). Status → settling; the game/UI then proposes a matching
   *  multisig tx, which `payoutMatches` adopts + watches. */
  settle(payouts: EscrowPayout[], meta?: Record<string, unknown>): EscrowResult {
    this.load();
    if (!this.current) return { ok: false, error: "no_escrow" };
    if (this.current.status !== "open" && this.current.status !== "locked") {
      return { ok: false, error: "not_settleable" };
    }
    if (!payouts || payouts.length === 0) return { ok: false, error: "no_payouts" };
    const keys = new Set(this.current.accounts.map(a => a.key));
    const totalDeposited = this.current.accounts.reduce((s, a) => s + BigInt(a.depositedWei), 0n);
    let totalPayout = 0n;
    for (const p of payouts) {
      const to = p.to.toLowerCase();
      if (!keys.has(to)) return { ok: false, error: "payout_to_non_participant" };
      if (!isWei(p.amountWei) || BigInt(p.amountWei) <= 0n) return { ok: false, error: "bad_payout_amount" };
      totalPayout += BigInt(p.amountWei);
    }
    if (totalPayout > totalDeposited) return { ok: false, error: "payout_exceeds_escrow" };
    this.current.status = "settling";
    this.current.payouts = payouts.map(p => ({ to: p.to.toLowerCase(), amountWei: p.amountWei }));
    if (meta) this.current.meta = { ...this.current.meta, ...meta };
    return { ok: true, session: this.touch() };
  }

  /** Does a proposed multisig tx execute the settlement plan exactly?
   *  Single payout → execTransaction(to, amount); multiple → batch with
   *  one call per payout and no extra calls. Used to auto-adopt a payout
   *  proposal (and to reject anything that doesn't match the plan). */
  payoutTxMatches(tx: { target: string; value: string; calls?: { target: string; value: string }[] }): boolean {
    this.load();
    const payouts = this.current?.payouts;
    if (!payouts || payouts.length === 0) return false;
    if (payouts.length === 1) {
      const p = payouts[0]!;
      return tx.target.toLowerCase() === p.to && tx.value === p.amountWei;
    }
    const calls = tx.calls ?? [];
    if (calls.length !== payouts.length) return false;
    // Greedy match each payout to a distinct call by (to, amount).
    const used = new Set<number>();
    for (const p of payouts) {
      const idx = calls.findIndex((c, i) => !used.has(i) && c.target.toLowerCase() === p.to && c.value === p.amountWei);
      if (idx < 0) return false;
      used.add(idx);
    }
    return true;
  }

  linkPayout(txId: string): EscrowResult {
    this.load();
    if (!this.current) return { ok: false, error: "no_escrow" };
    if (this.current.status !== "settling") return { ok: false, error: "not_settling" };
    this.current.payoutTxId = txId;
    return { ok: true, session: this.touch() };
  }

  isPayoutTx(txId: string): boolean {
    this.load();
    return !!this.current && this.current.payoutTxId === txId;
  }

  markSettled(txHash: string | null): EscrowResult {
    this.load();
    if (!this.current) return { ok: false, error: "no_escrow" };
    if (this.current.status !== "settling") return { ok: false, error: "not_settling" };
    this.current.status = "settled";
    this.current.payoutTxHash = txHash;
    this.current.settledAt = Date.now();
    return { ok: true, session: this.touch() };
  }

  /** Abort. Nothing escrowed → cancelled. Otherwise compute a refund
   *  plan (return each funder's deposit) and move to settling — the
   *  caller proposes the matching refund batch. */
  cancel(): { ok: true; session: EscrowSession; needsRefund: boolean } | { ok: false; error: string } {
    this.load();
    if (!this.current) return { ok: false, error: "no_escrow" };
    if (this.current.status !== "open" && this.current.status !== "locked") {
      return { ok: false, error: "not_cancellable" };
    }
    const funded = this.current.accounts.filter(a => BigInt(a.depositedWei) > 0n);
    if (funded.length === 0) {
      this.current.status = "cancelled";
      return { ok: true, session: this.touch(), needsRefund: false };
    }
    const res = this.settle(
      funded.map(a => ({ to: a.key, amountWei: a.depositedWei })),
      { settleKind: "refund" },
    );
    if (!res.ok) return res;
    return { ok: true, session: res.session, needsRefund: true };
  }

  /** Wipe the session so the lobby reopens (after settled/cancelled, or a
   *  host force-clear). */
  clear(): { ok: true } {
    this.load();
    this.current = null;
    this.scheduleSave();
    return { ok: true };
  }
}

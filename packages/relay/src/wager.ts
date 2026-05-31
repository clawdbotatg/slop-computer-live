// Per-room "money chess": an ETH wager escrowed in the room multisig.
//
// The relay owns the wager's truth the same way it owns chess: a single
// state machine per room, persisted to disk, broadcast to peers as a
// fresh snapshot. Clients never settle anything by claim — every
// transition is gated by something the relay can verify itself:
//
//   funding   — both players known; we wait for each buy-in to land in
//               escrow. A deposit is only counted once the relay has
//               read it back on-chain (from == player, to == multisig,
//               value >= buy-in, mined). A client cannot fake "funded".
//   armed     — both buy-ins confirmed; ready to start the chess game.
//   playing   — chess game is live (whiteKey/blackKey mirror the wager).
//   settling  — chess ended; the winner is derived from the chess
//               result, not asserted by a client. Awaiting the payout
//               multisig tx to be proposed + executed.
//   settled   — the payout tx executed on-chain (detected via the
//               existing WalletTx status lifecycle).
//   refunding — aborted after at least one deposit landed; a refund
//               batch has been proposed to return buy-ins.
//   cancelled — aborted before any deposit landed; nothing to refund.
//
// The escrow is the room's own multisig (cooperative model): releasing
// the pot needs the multisig's normal threshold of signatures, so in a
// 2-of-2 room the loser signs their own payout. That's intentional for
// friendly/streamed games. The relay never holds a key.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ChessGameStatus } from "./chess.js";
import { writeFileAtomic } from "./fs-atomic.js";

export type WagerStatus =
  | "funding"
  | "armed"
  | "playing"
  | "settling"
  | "settled"
  | "refunding"
  | "cancelled";

export type WagerSide = "white" | "black";

/** A confirmed buy-in deposit, as the relay read it back on-chain. */
export type WagerDeposit = {
  txHash: string;
  /** Wei actually sent, per the on-chain tx (>= buy-in). */
  amountWei: string;
  confirmedAt: number;
};

export type Wager = {
  id: string;
  status: WagerStatus;
  chainId: number;
  /** Escrow address — the room multisig, lowercased. Both buy-ins are
   *  sent here and the pot is paid out from here. */
  multisig: string;
  /** Buy-in each player must deposit, decimal wei. Pot == buyinWei * 2. */
  buyinWei: string;
  // Players. Both MUST be real addresses (EOAs that can fund + sign):
  // whiteKey === the white player's lowercased address, likewise black.
  whiteKey: string;
  whiteLabel: string;
  blackKey: string;
  blackLabel: string;
  whiteDeposit: WagerDeposit | null;
  blackDeposit: WagerDeposit | null;
  // Settlement (null until the chess game ends):
  /** The chess status that closed the game. */
  outcome: ChessGameStatus | null;
  /** Derived from `outcome`: who the pot goes to (or a refunded draw). */
  winner: WagerSide | "draw" | null;
  /** Links the payout proposal to a WalletTx so we can watch it execute. */
  payoutTxId: string | null;
  payoutTxHash: string | null;
  settledAt: number | null;
  /** ownerKey of whoever proposed the wager. */
  proposedBy: string;
  createdAt: number;
  updatedAt: number;
};

export type ProposeWagerArgs = {
  chainId: number;
  multisig: string;
  buyinWei: string;
  whiteKey: string;
  whiteLabel: string;
  blackKey: string;
  blackLabel: string;
  proposedBy: string;
};

type WagerResult = { ok: true; wager: Wager } | { ok: false; error: string };

/** Map a finished chess status onto the wager's payout outcome. Returns
 *  null while the game is still active. Exported so the client renders
 *  the same verdict the relay settles on. */
export function winnerFromChessStatus(status: ChessGameStatus): WagerSide | "draw" | null {
  switch (status) {
    case "white_won":
    case "black_resigned":
      return "white";
    case "black_won":
    case "white_resigned":
      return "black";
    case "draw_stalemate":
    case "draw_threefold":
    case "draw_insufficient":
    case "draw_other":
      return "draw";
    case "active":
    default:
      return null;
  }
}

/** Validate a decimal wei string is a positive integer. */
function isPositiveWei(v: string): boolean {
  if (!/^\d+$/.test(v)) return false;
  try {
    return BigInt(v) > 0n;
  } catch {
    return false;
  }
}

export class WagerState {
  private current: Wager | null = null;
  private loaded = false;
  private saveQueued = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { current?: Wager | null };
      if (parsed.current && typeof parsed.current === "object") {
        this.current = parsed.current;
      }
    } catch {
      /* cold start — no wager */
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
        console.error("[wager] failed to persist:", err);
      }
    });
  }

  private touch(): Wager {
    if (!this.current) throw new Error("no wager");
    this.current.updatedAt = Date.now();
    this.scheduleSave();
    return this.current;
  }

  get(): Wager | null {
    this.load();
    return this.current;
  }

  /** Open a new wager. Rejects if one is already live (anything that
   *  isn't a finished settled/cancelled wager the lobby has moved past).
   *  The two players must be distinct addresses. */
  propose(args: ProposeWagerArgs): WagerResult {
    this.load();
    if (this.current && !isTerminal(this.current.status)) {
      return { ok: false, error: "wager_already_active" };
    }
    const white = args.whiteKey.toLowerCase();
    const black = args.blackKey.toLowerCase();
    const multisig = args.multisig.toLowerCase();
    if (!isAddress(white) || !isAddress(black)) return { ok: false, error: "players_must_be_addresses" };
    if (white === black) return { ok: false, error: "players_must_differ" };
    if (!isAddress(multisig)) return { ok: false, error: "bad_multisig" };
    if (!isPositiveWei(args.buyinWei)) return { ok: false, error: "bad_buyin" };
    const now = Date.now();
    this.current = {
      id: randomBytes(6).toString("hex"),
      status: "funding",
      chainId: args.chainId,
      multisig,
      buyinWei: args.buyinWei,
      whiteKey: white,
      whiteLabel: args.whiteLabel || white,
      blackKey: black,
      blackLabel: args.blackLabel || black,
      whiteDeposit: null,
      blackDeposit: null,
      outcome: null,
      winner: null,
      payoutTxId: null,
      payoutTxHash: null,
      settledAt: null,
      proposedBy: args.proposedBy.toLowerCase(),
      createdAt: now,
      updatedAt: now,
    };
    this.scheduleSave();
    return { ok: true, wager: this.current };
  }

  /** Which side an address plays, if any. */
  sideOf(addr: string): WagerSide | null {
    this.load();
    if (!this.current) return null;
    const a = addr.toLowerCase();
    if (a === this.current.whiteKey) return "white";
    if (a === this.current.blackKey) return "black";
    return null;
  }

  /** Record a buy-in deposit the relay has ALREADY verified on-chain.
   *  Idempotent per side. Flips to `armed` once both are in. */
  recordDeposit(side: WagerSide, deposit: WagerDeposit): WagerResult {
    this.load();
    if (!this.current) return { ok: false, error: "no_wager" };
    if (this.current.status !== "funding") return { ok: false, error: "not_funding" };
    if (side === "white") this.current.whiteDeposit = deposit;
    else this.current.blackDeposit = deposit;
    if (this.current.whiteDeposit && this.current.blackDeposit) {
      this.current.status = "armed";
    }
    return { ok: true, wager: this.touch() };
  }

  /** Move armed → playing. The caller is responsible for actually
   *  creating the chess game with the matching white/black keys. */
  start(): WagerResult {
    this.load();
    if (!this.current) return { ok: false, error: "no_wager" };
    if (this.current.status !== "armed") return { ok: false, error: "not_armed" };
    this.current.status = "playing";
    return { ok: true, wager: this.touch() };
  }

  /** Settle a playing wager from the chess result. Derives the winner.
   *  No-op (returns the wager) if the game didn't actually end. */
  settle(outcome: ChessGameStatus): WagerResult {
    this.load();
    if (!this.current) return { ok: false, error: "no_wager" };
    if (this.current.status !== "playing") return { ok: false, error: "not_playing" };
    const winner = winnerFromChessStatus(outcome);
    if (!winner) return { ok: false, error: "game_not_over" };
    this.current.status = "settling";
    this.current.outcome = outcome;
    this.current.winner = winner;
    return { ok: true, wager: this.touch() };
  }

  /** Link the payout (or refund) WalletTx so we can watch it execute. */
  linkPayout(txId: string): WagerResult {
    this.load();
    if (!this.current) return { ok: false, error: "no_wager" };
    if (this.current.status !== "settling" && this.current.status !== "refunding") {
      return { ok: false, error: "not_settling" };
    }
    this.current.payoutTxId = txId;
    return { ok: true, wager: this.touch() };
  }

  /** Mark the wager settled once its linked payout tx executed. */
  markSettled(txHash: string | null): WagerResult {
    this.load();
    if (!this.current) return { ok: false, error: "no_wager" };
    if (this.current.status !== "settling" && this.current.status !== "refunding") {
      return { ok: false, error: "not_settling" };
    }
    this.current.status = "settled";
    this.current.payoutTxHash = txHash;
    this.current.settledAt = Date.now();
    return { ok: true, wager: this.touch() };
  }

  /** Is `txId` the payout we're watching? */
  isPayoutTx(txId: string): boolean {
    this.load();
    return !!this.current && this.current.payoutTxId === txId;
  }

  /** Abort. Before any deposit → cancelled (nothing escrowed). After a
   *  deposit → refunding (caller proposes the refund batch + links it). */
  cancel(): { ok: true; wager: Wager; needsRefund: boolean } | { ok: false; error: string } {
    this.load();
    if (!this.current) return { ok: false, error: "no_wager" };
    if (this.current.status !== "funding" && this.current.status !== "armed") {
      return { ok: false, error: "not_cancellable" };
    }
    const funded = !!this.current.whiteDeposit || !!this.current.blackDeposit;
    this.current.status = funded ? "refunding" : "cancelled";
    return { ok: true, wager: this.touch(), needsRefund: funded };
  }

  /** Wipe the wager so the lobby reopens (after settled/cancelled, or a
   *  host force-clear). */
  clear(): { ok: true } {
    this.load();
    this.current = null;
    this.scheduleSave();
    return { ok: true };
  }
}

function isTerminal(status: WagerStatus): boolean {
  return status === "settled" || status === "cancelled";
}

function isAddress(v: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(v);
}

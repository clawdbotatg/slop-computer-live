// Per-room server-authoritative No-Limit Texas Hold'em engine.
//
// Mirrors ChessState's contract: the relay owns the truth, validates
// every action here, and broadcasts a fresh snapshot. The crucial
// difference from chess is imperfect information — hole cards are dealt
// into engine state but NEVER placed in the public snapshot. index.ts
// broadcasts publicView() to everyone and pushes privateFor(key) to each
// seat's own socket(s). See ops/PLAN-poker.md.
//
// All money in the engine is integer **chips**. The chip↔wei mapping
// (chipValueWei) lives in the escrow meta, not here — the engine is a
// pure, deterministic chip machine so it can be unit-tested with no money
// and no sockets (poker.test.ts). It conserves chips: Σ stacks is
// invariant across a hand, so the per-seat deltas it emits are zero-sum,
// exactly what EscrowState.applyDeltas requires.
//
// Card privacy + persistence + a version counter (for long-poll waiters)
// round out the surface, same as chess.

import { randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Card, type HandEval, bestOf, describeHand, evaluate7, makeDeck } from "./poker-eval.js";
import { writeFileAtomic } from "./fs-atomic.js";

export const MAX_SEATS = 8;

/** How long the seat to act has before the relay auto-acts for them
 *  (check if free, else fold). Keeps one disconnected/AFK player from
 *  stalling the table — and stranding the pot. */
export const TURN_TIMEOUT_MS = 60_000;

/** After a contested showdown, hold the table for this long before the
 *  next hand can be dealt, so everyone can see the revealed hands + who
 *  won. Enforced server-side (startHand rejects early) and surfaced to the
 *  UI as a countdown. Fold-wins (no reveal) skip the pause. */
export const SHOWDOWN_PAUSE_MS = 5_000;

/** When everyone's all-in, the board is run out one street at a time with
 *  this gap between cards, for suspense, instead of dumping the whole board
 *  at once. The relay's poker ticker advances it. */
export const RUNOUT_STEP_MS = 1_200;

export type SeatStatus =
  | "active" // in the hand, can still act
  | "folded" // out of this hand
  | "allin" // committed all chips, no further action
  | "out"; // seated but not in this hand (busted to 0, or sitting out)

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown" | "idle";

export type Seat = {
  /** Physical seat around the felt (0..MAX_SEATS-1). Cosmetic — UI
   *  placement only; gameplay order uses the seats-array index (seats are
   *  kept sorted by seatIdx, so the two agree among occupied seats). */
  seatIdx: number;
  /** Stable identity (ownerKey: lowercased address/handle), like chess. */
  key: string;
  label: string;
  /** Chips behind. */
  stack: number;
  /** Chips committed THIS street (resets each street). */
  committed: number;
  /** Chips committed THIS hand total — drives side pots. */
  handCommitted: number;
  /** Stack at the moment the current hand started — for zero-sum deltas. */
  startStack: number;
  status: SeatStatus;
  /** Hole cards. Private: stripped from publicView, sent via privateFor. */
  hole: [Card, Card] | null;
  /** Has acted since the last full raise this street (blind option aware). */
  hasActed: boolean;
};

export type Pot = { amountChips: number; eligible: number[] };

export type ShowdownEntry = {
  seat: number;
  hole: [Card, Card];
  /** Natural-language hand, e.g. "Kings full of queens". */
  hand: string;
  /** The best 5 cards that make the hand (for highlighting). */
  cards: Card[];
  /** True if this seat won (any part of) the pot. */
  won: boolean;
};

export type PokerActionKind = "fold" | "check" | "call" | "bet" | "raise";

export type ActArgs = { action: PokerActionKind; toChips?: number };

export type HandResult = {
  handId: string;
  /** Net chip delta per seat (final stack − start stack). Zero-sum. */
  deltas: { key: string; deltaChips: number }[];
  showdown: ShowdownEntry[];
  endedAt: number;
};

export type PokerGame = {
  handId: string | null;
  seats: Seat[];
  button: number; // seat index of the dealer button
  smallBlind: number; // current (escalated) small blind
  bigBlind: number; // current (escalated) big blind
  // Blind schedule: blinds = base × 2^level, level advances every
  // blindIntervalMs after the first hand (blindClockStart). intervalMs = 0
  // means fixed blinds (a pure cash game).
  baseSmallBlind: number;
  baseBigBlind: number;
  blindIntervalMs: number;
  blindClockStart: number | null;
  blindLevel: number;
  board: Card[];
  pots: Pot[];
  street: Street;
  currentBet: number; // highest `committed` this street
  minRaise: number; // minimum legal raise increment
  actor: number; // seat to act, or -1 if none
  status: "idle" | "running" | "complete";
  /** Cards exposed at showdown (folded muck stays hidden). */
  showdown: ShowdownEntry[];
  startedAt: number | null;
  /** Date.now() when the current actor started thinking (UI clock). */
  actorSince: number;
  /** Date.now() a contested showdown finished (null otherwise) — gates the
   *  post-showdown pause before the next hand. */
  handEndedAt: number | null;
  /** True while an all-in board is being run out one street at a time. */
  runningOut: boolean;
  /** Date.now() of the last run-out step (relay paces the next off this). */
  runoutStepAt: number;
  /** Tournament finishing order: keys in the order they busted (earliest
   *  out first = worst place). The lone survivor isn't listed — they're
   *  1st. The relay reads this to split the prize pool by place. */
  eliminatedOrder: string[];
  lastResult: HandResult | null;
};

export type ActOutcome = { ok: true; ended: boolean } | { ok: false; error: string };

type Waiter = { wake: () => void; cleanup: () => void };

// --- pure helpers (exported for unit tests) ---------------------------

/** Layered side-pot construction from each seat's total hand contribution.
 *  Folded seats' chips stay as dead money in the pots they reached, but
 *  they're never eligible to win. Adjacent layers with identical eligible
 *  sets are merged for a tidy pot list. */
export function buildPots(seats: Seat[]): Pot[] {
  const contrib = seats.map((s, i) => ({ i, amt: s.handCommitted, folded: s.status === "folded" }));
  const levels = [...new Set(contrib.filter(c => c.amt > 0).map(c => c.amt))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const lvl of levels) {
    const delta = lvl - prev;
    const contributors = contrib.filter(c => c.amt >= lvl);
    const amount = delta * contributors.length;
    const eligible = contributors.filter(c => !c.folded).map(c => c.i);
    if (amount > 0) {
      const last = pots[pots.length - 1];
      if (last && sameSet(last.eligible, eligible)) last.amountChips += amount;
      else pots.push({ amountChips: amount, eligible });
    }
    prev = lvl;
  }
  return pots;
}

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every(x => s.has(x));
}

/** Blind size at a given level: base blinds doubled once per level. Level
 *  is capped so the multiplier can't overflow a safe integer on a very
 *  long session. */
export function blindsAtLevel(baseSmallBlind: number, baseBigBlind: number, level: number): { sb: number; bb: number } {
  const capped = Math.max(0, Math.min(level, 20));
  const mult = 2 ** capped;
  return { sb: baseSmallBlind * mult, bb: baseBigBlind * mult };
}

export class PokerState {
  private game: PokerGame;
  private deck: Card[] = [];
  private loaded = false;
  private saveQueued = false;
  private version = 0;
  private waiters: Waiter[] = [];

  constructor(
    private readonly filePath: string,
    private readonly smallBlind = 1,
    private readonly bigBlind = 2,
  ) {
    this.game = this.emptyGame();
  }

  private emptyGame(): PokerGame {
    return {
      handId: null,
      seats: [],
      button: -1,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      baseSmallBlind: this.smallBlind,
      baseBigBlind: this.bigBlind,
      blindIntervalMs: 0,
      blindClockStart: null,
      blindLevel: 0,
      board: [],
      pots: [],
      street: "idle",
      currentBet: 0,
      minRaise: this.bigBlind,
      actor: -1,
      status: "idle",
      showdown: [],
      startedAt: null,
      actorSince: 0,
      handEndedAt: null,
      runningOut: false,
      runoutStepAt: 0,
      eliminatedOrder: [],
      lastResult: null,
    };
  }

  // --- version / long-poll plumbing (mirrors ChessState) -------------

  getVersion(): number {
    this.load();
    return this.version;
  }
  pushWaiter(entry: Waiter): void {
    this.waiters.push(entry);
  }
  removeWaiter(entry: Waiter): void {
    const idx = this.waiters.indexOf(entry);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }
  bumpVersion(): void {
    this.version++;
    const woke = this.waiters.splice(0);
    for (const w of woke) {
      try { w.cleanup(); } catch { /* ignore */ }
      try { w.wake(); } catch { /* ignore */ }
    }
  }

  // --- persistence ---------------------------------------------------

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { game?: PokerGame; deck?: Card[] };
      if (parsed.game && typeof parsed.game === "object") this.game = parsed.game;
      if (Array.isArray(parsed.deck)) this.deck = parsed.deck;
    } catch {
      /* cold start */
    }
  }

  private scheduleSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      try {
        writeFileAtomic(this.filePath, JSON.stringify({ game: this.game, deck: this.deck }));
      } catch (err) {
        console.error("[poker] failed to persist:", err);
      }
    });
  }

  // --- roster --------------------------------------------------------

  getGame(): PokerGame {
    this.load();
    return this.game;
  }

  /** Seat a player with a starting chip stack. Only allowed between hands
   *  (idle/complete). Rejects a taken seat or a duplicate key. */
  sit(seatIdx: number, key: string, label: string, stackChips: number): { ok: true } | { ok: false; error: string } {
    this.load();
    if (this.game.status === "running") return { ok: false, error: "hand_in_progress" };
    if (seatIdx < 0 || seatIdx >= MAX_SEATS) return { ok: false, error: "bad_seat" };
    const k = key.toLowerCase();
    if (this.game.seats.some(s => s.key === k)) return { ok: false, error: "already_seated" };
    if (this.game.seats.some(s => s.seatIdx === seatIdx)) return { ok: false, error: "seat_taken" };
    if (stackChips <= 0) return { ok: false, error: "bad_stack" };
    const seat: Seat = {
      seatIdx,
      key: k,
      label: label || k,
      stack: stackChips,
      committed: 0,
      handCommitted: 0,
      startStack: stackChips,
      status: "out",
      hole: null,
      hasActed: false,
    };
    this.game.seats.push(seat);
    // Keep the array ordered by physical seat so array-index rotation
    // matches clockwise table order.
    this.game.seats.sort((a, b) => a.seatIdx - b.seatIdx);
    this.touch();
    return { ok: true };
  }

  /** Add chips to a seated player (rebuy / top-up). Between hands only. */
  topUp(key: string, addChips: number): { ok: true } | { ok: false; error: string } {
    this.load();
    if (this.game.status === "running") return { ok: false, error: "hand_in_progress" };
    const seat = this.seatOf(key);
    if (!seat) return { ok: false, error: "not_seated" };
    if (addChips <= 0) return { ok: false, error: "bad_amount" };
    seat.stack += addChips;
    this.touch();
    return { ok: true };
  }

  /** Remove a player from the table (between hands). */
  leave(key: string): { ok: true } | { ok: false; error: string } {
    this.load();
    if (this.game.status === "running") return { ok: false, error: "hand_in_progress" };
    const before = this.game.seats.length;
    this.game.seats = this.game.seats.filter(s => s.key !== key.toLowerCase());
    if (this.game.seats.length === before) return { ok: false, error: "not_seated" };
    this.touch();
    return { ok: true };
  }

  private seatOf(key: string): Seat | null {
    const k = key.toLowerCase();
    return this.game.seats.find(s => s.key === k) ?? null;
  }

  private seatIdxByKey(key: string): number {
    const k = key.toLowerCase();
    return this.game.seats.findIndex(s => s.key === k);
  }

  // --- hand lifecycle ------------------------------------------------

  /** Deal a new hand. Needs ≥2 seats with chips. Rotates the button,
   *  posts blinds, deals hole cards, opens preflop betting.
   *
   *  `deckOverride` is a TEST-ONLY seam: pass 52 cards in **deal order**
   *  (index 0 dealt first) to make a hand deterministic. Production always
   *  calls with no argument → a crypto-shuffled deck. */
  startHand(deckOverride?: Card[]): { ok: true } | { ok: false; error: string } {
    this.load();
    if (this.game.status === "running") return { ok: false, error: "hand_in_progress" };
    // Hold for the post-showdown pause so everyone can see the cards.
    if (this.game.handEndedAt !== null && Date.now() - this.game.handEndedAt < SHOWDOWN_PAUSE_MS) {
      return { ok: false, error: "showdown_pause" };
    }
    const playing = this.game.seats.filter(s => s.stack > 0);
    if (playing.length < 2) return { ok: false, error: "need_two_players" };
    this.game.handEndedAt = null;
    this.game.runningOut = false;

    // Reset per-hand seat state.
    for (const s of this.game.seats) {
      s.committed = 0;
      s.handCommitted = 0;
      s.hole = null;
      s.hasActed = false;
      s.startStack = s.stack;
      s.status = s.stack > 0 ? "active" : "out";
    }
    this.game.board = [];
    this.game.pots = [];
    this.game.showdown = [];
    this.game.currentBet = 0;
    this.game.minRaise = this.game.bigBlind;
    this.game.street = "preflop";
    this.game.status = "running";
    this.game.handId = randomBytes(6).toString("hex");
    this.game.startedAt = Date.now();
    this.game.lastResult = null;

    // Advance the blind level by elapsed play time. The clock starts on the
    // first hand so the buy-in window never consumes blind levels.
    const now = this.game.startedAt;
    if (this.game.blindClockStart === null) this.game.blindClockStart = now;
    this.game.blindLevel =
      this.game.blindIntervalMs > 0 ? Math.floor((now - this.game.blindClockStart) / this.game.blindIntervalMs) : 0;
    const blinds = blindsAtLevel(this.game.baseSmallBlind, this.game.baseBigBlind, this.game.blindLevel);
    this.game.smallBlind = blinds.sb;
    this.game.bigBlind = blinds.bb;

    // Button advances to the next seat that's in the hand.
    this.game.button = this.nextInHand(this.game.button);

    // Shuffle a fresh deck (or use a test-supplied order). pop() draws
    // from the end, so a deal-order override is reversed.
    this.deck = deckOverride && deckOverride.length === 52 ? deckOverride.slice().reverse() : shuffle(makeDeck());

    const order = this.actingOrderFrom(this.game.button); // clockwise from button
    const inHand = order.filter(i => this.game.seats[i]!.status === "active");

    // Blinds. Heads-up: button is SB. 3+: SB = left of button, BB next.
    let sbIdx: number;
    let bbIdx: number;
    if (inHand.length === 2) {
      sbIdx = this.game.button;
      bbIdx = this.nextInHand(this.game.button);
    } else {
      sbIdx = this.nextInHand(this.game.button);
      bbIdx = this.nextInHand(sbIdx);
    }
    this.postBlind(sbIdx, this.game.smallBlind);
    this.postBlind(bbIdx, this.game.bigBlind);
    this.game.currentBet = this.game.bigBlind;
    this.game.minRaise = this.game.bigBlind;
    // Blinds are forced, not voluntary actions: the BB keeps its option.
    for (const s of this.game.seats) s.hasActed = false;

    // Deal two hole cards to each in-hand seat (standard one-at-a-time).
    for (const i of inHand) this.game.seats[i]!.hole = [this.deck.pop()!, this.deck.pop()!];

    // First to act preflop: left of BB (3+), or the button/SB (heads-up).
    this.game.actor = inHand.length === 2 ? sbIdx : this.nextInHand(bbIdx);
    // If the first actor is already all-in from the blind, advance.
    this.game.actor = this.firstToAct(this.game.actor);
    this.game.actorSince = Date.now();

    // Everyone all-in from the blinds (tiny stacks) → run the board out.
    if (this.isRunOut()) this.beginRunout();
    this.touch();
    return { ok: true };
  }

  private postBlind(idx: number, amount: number): void {
    const seat = this.game.seats[idx]!;
    const pay = Math.min(amount, seat.stack);
    seat.stack -= pay;
    seat.committed += pay;
    seat.handCommitted += pay;
    if (seat.stack === 0) seat.status = "allin";
  }

  // --- action --------------------------------------------------------

  act(callerKey: string, args: ActArgs): ActOutcome {
    this.load();
    if (this.game.status !== "running") return { ok: false, error: "no_hand" };
    const idx = this.seatIdxByKey(callerKey);
    if (idx < 0) return { ok: false, error: "not_seated" };
    if (idx !== this.game.actor) return { ok: false, error: "not_your_turn" };
    const seat = this.game.seats[idx]!;
    if (seat.status !== "active") return { ok: false, error: "cannot_act" };

    const toCall = this.game.currentBet - seat.committed;
    switch (args.action) {
      case "fold": {
        seat.status = "folded";
        seat.hasActed = true;
        break;
      }
      case "check": {
        if (toCall > 0) return { ok: false, error: "cannot_check" };
        seat.hasActed = true;
        break;
      }
      case "call": {
        if (toCall <= 0) return { ok: false, error: "nothing_to_call" };
        const pay = Math.min(toCall, seat.stack);
        this.commit(seat, pay);
        seat.hasActed = true;
        break;
      }
      case "bet":
      case "raise": {
        const to = args.toChips ?? 0;
        const res = this.applyRaise(seat, to);
        if (!res.ok) return res;
        break;
      }
      default:
        return { ok: false, error: "bad_action" };
    }

    return this.afterAction();
  }

  /** Force the timed-out actor's default action: check if it's free, else
   *  fold. Returns the outcome, or null if no hand is running or the actor
   *  can't act. The relay's turn-clock watchdog calls this. */
  autoAct(): ActOutcome | null {
    this.load();
    if (this.game.status !== "running" || this.game.actor < 0) return null;
    const seat = this.game.seats[this.game.actor];
    if (!seat || seat.status !== "active") return null;
    const toCall = this.game.currentBet - seat.committed;
    return this.act(seat.key, { action: toCall > 0 ? "fold" : "check" });
  }

  private commit(seat: Seat, chips: number): void {
    seat.stack -= chips;
    seat.committed += chips;
    seat.handCommitted += chips;
    if (seat.stack === 0) seat.status = "allin";
  }

  private applyRaise(seat: Seat, toChips: number): ActOutcome {
    const maxTo = seat.committed + seat.stack; // all-in ceiling for this seat
    if (toChips <= this.game.currentBet) return { ok: false, error: "raise_too_small" };
    if (toChips > maxTo) return { ok: false, error: "insufficient_chips" };
    const isAllIn = toChips === maxTo;
    const raiseBy = toChips - this.game.currentBet;
    const fullRaise = raiseBy >= this.game.minRaise;
    if (!fullRaise && !isAllIn) return { ok: false, error: "below_min_raise" };

    this.commit(seat, toChips - seat.committed);
    if (fullRaise) {
      this.game.minRaise = raiseBy;
      // A full raise reopens the action: everyone else must respond.
      for (const s of this.game.seats) if (s.status === "active" && s !== seat) s.hasActed = false;
    }
    this.game.currentBet = toChips;
    seat.hasActed = true;
    return { ok: true, ended: false };
  }

  /** Advance after a legal action: maybe close the street, deal the next
   *  one, fast-forward all-in run-outs, or end the hand. */
  private afterAction(): ActOutcome {
    // Hand ends immediately if only one non-folded seat remains.
    const live = this.game.seats.filter(s => s.status === "active" || s.status === "allin");
    if (live.length === 1) {
      this.endHand();
      return { ok: true, ended: true };
    }

    if (this.bettingClosed()) {
      this.closeStreet();
      if (this.game.status === "complete") return { ok: true, ended: true };
      // No more betting possible (everyone all-in) → run the board out one
      // street at a time. closeStreet already dealt the next street; the
      // relay paces the rest. endHand fires when the run-out reaches river.
      if (this.isRunOut()) this.beginRunout();
    } else {
      this.game.actor = this.nextActor(this.game.actor);
      this.game.actorSince = Date.now();
    }
    return { ok: true, ended: this.game.status === "complete" };
  }

  private bettingClosed(): boolean {
    const actives = this.game.seats.filter(s => s.status === "active");
    if (actives.length === 0) return true;
    return actives.every(s => s.hasActed && s.committed === this.game.currentBet);
  }

  /** Move chips committed this street into pots, then either deal the next
   *  street or go to showdown. If ≤1 seat can still act, fast-forward the
   *  remaining board and settle. */
  private closeStreet(): void {
    // Collect this street's commitments into the pot structure.
    for (const s of this.game.seats) s.committed = 0;
    this.game.pots = buildPots(this.game.seats);
    this.game.currentBet = 0;
    this.game.minRaise = this.game.bigBlind;
    for (const s of this.game.seats) if (s.status === "active") s.hasActed = false;

    const next: Record<Street, Street> = {
      preflop: "flop",
      flop: "turn",
      turn: "river",
      river: "showdown",
      showdown: "showdown",
      idle: "idle",
    };
    this.game.street = next[this.game.street];
    if (this.game.street === "showdown") {
      this.endHand();
      return;
    }
    this.dealBoard(this.game.street);

    // First to act post-flop: first in-hand seat clockwise from the button.
    const first = this.firstToAct(this.nextInHand(this.game.button));
    this.game.actor = first;
    this.game.actorSince = Date.now();
  }

  private dealBoard(street: Street): void {
    if (street === "flop") {
      this.deck.pop(); // burn
      this.game.board.push(this.deck.pop()!, this.deck.pop()!, this.deck.pop()!);
    } else if (street === "turn" || street === "river") {
      this.deck.pop(); // burn
      this.game.board.push(this.deck.pop()!);
    }
  }

  /** True when no further betting is possible (≤1 player can act and no one
   *  owes a call) but ≥2 are still contesting an unfinished board — i.e. an
   *  all-in run-out is due. */
  private isRunOut(): boolean {
    if (this.game.status !== "running" || this.game.street === "showdown") return false;
    const canAct = this.game.seats.filter(s => s.status === "active");
    if (canAct.length > 1) return false; // real betting still possible
    if (canAct.some(s => s.committed < this.game.currentBet)) return false; // someone still owes
    const contenders = this.game.seats.filter(s => s.status === "active" || s.status === "allin").length;
    return contenders >= 2;
  }

  private beginRunout(): void {
    this.game.runningOut = true;
    this.game.runoutStepAt = Date.now();
    this.game.actor = -1;
  }

  /** Reveal the next board street of an all-in run-out (or resolve the
   *  showdown if the river is already out). The relay calls this on a timer
   *  so the board comes out one card at a time. No-op unless runningOut. */
  advanceRunout(): { ok: boolean; ended: boolean } {
    this.load();
    if (this.game.status !== "running" || !this.game.runningOut) {
      return { ok: false, ended: this.game.status === "complete" };
    }
    // No betting in a run-out: fold any commitments into the pots.
    for (const s of this.game.seats) s.committed = 0;
    this.game.pots = buildPots(this.game.seats);
    this.game.currentBet = 0;
    const order: Street[] = ["preflop", "flop", "turn", "river", "showdown"];
    const next = order[order.indexOf(this.game.street) + 1]!;
    if (next === "showdown") {
      this.endHand();
      this.game.runningOut = false;
      this.scheduleSave();
      return { ok: true, ended: true };
    }
    this.game.street = next;
    this.dealBoard(next);
    this.game.runoutStepAt = Date.now();
    this.scheduleSave();
    return { ok: true, ended: false };
  }

  /** Run an in-progress all-in board out to showdown synchronously. The
   *  relay reveals it slowly via advanceRunout; this is the all-at-once
   *  path for unit tests (and a safety fallback). */
  finishRunout(): void {
    let guard = 0;
    while (this.game.runningOut && guard++ < 8) this.advanceRunout();
  }

  /** Resolve the hand: build final pots, award each pot to its best
   *  eligible hand (splitting ties), compute zero-sum deltas, expose
   *  showdown hands (only those that reached a contested showdown). */
  private endHand(): void {
    for (const s of this.game.seats) s.committed = 0;
    this.game.pots = buildPots(this.game.seats);

    const contenders = this.game.seats
      .map((s, i) => ({ i, s }))
      .filter(x => x.s.status === "active" || x.s.status === "allin");

    const showdownEntries: ShowdownEntry[] = [];
    if (contenders.length === 1) {
      // Uncontested: the last seat takes every pot, cards stay mucked.
      const winner = contenders[0]!.i;
      for (const pot of this.game.pots) this.game.seats[winner]!.stack += pot.amountChips;
    } else {
      // Contested showdown. Award each pot independently, tracking every
      // seat that won any part of a pot.
      const overallWinners = new Set<number>();
      for (const pot of this.game.pots) {
        const eligible = pot.eligible.filter(i => {
          const st = this.game.seats[i]!.status;
          return st === "active" || st === "allin";
        });
        if (eligible.length === 0) continue;
        const hands = eligible.map(i => ({
          seat: i,
          cards: [...this.game.seats[i]!.hole!, ...this.game.board] as Card[],
        }));
        const winners = bestOf(hands);
        this.awardSplit(pot.amountChips, winners);
        for (const w of winners) overallWinners.add(w);
      }
      // Reveal contenders' hands (showdown is public; folded muck isn't),
      // each with a readable description, its best 5 cards, and won flag.
      for (const c of contenders) {
        const ev: HandEval = evaluate7([...c.s.hole!, ...this.game.board]);
        showdownEntries.push({
          seat: c.i,
          hole: c.s.hole!,
          hand: describeHand(ev),
          cards: ev.cards,
          won: overallWinners.has(c.i),
        });
      }
    }

    this.game.showdown = showdownEntries;
    this.game.street = "showdown";
    this.game.status = "complete";
    this.game.actor = -1;
    // Only a contested reveal needs the "look at the cards" pause.
    this.game.handEndedAt = showdownEntries.length > 0 ? Date.now() : null;

    const deltas = this.game.seats.map(s => ({ key: s.key, deltaChips: s.stack - s.startStack }));
    this.game.lastResult = {
      handId: this.game.handId!,
      deltas,
      showdown: showdownEntries,
      endedAt: Date.now(),
    };
    // Record tournament eliminations: a seat that played this hand and is
    // now at 0 has busted. If several bust together, the shorter starting
    // stack finishes lower (standard rule), so append in that order.
    const justBusted = this.game.seats
      .filter(s => s.stack === 0 && s.startStack > 0 && !this.game.eliminatedOrder.includes(s.key))
      .sort((a, b) => a.startStack - b.startStack);
    for (const s of justBusted) this.game.eliminatedOrder.push(s.key);

    // Mark busted seats out so they're skipped next hand.
    for (const s of this.game.seats) if (s.stack === 0) s.status = "out";
  }

  /** Split `amount` chips among winners. Odd chips go to the earliest
   *  winner clockwise from the button (standard "odd chip" rule). */
  private awardSplit(amount: number, winners: number[]): void {
    if (winners.length === 0) return;
    const base = Math.floor(amount / winners.length);
    let remainder = amount - base * winners.length;
    for (const w of winners) this.game.seats[w]!.stack += base;
    // Distribute odd chips starting left of the button.
    const ordered = this.actingOrderFrom(this.nextInHand(this.game.button)).filter(i => winners.includes(i));
    for (const i of ordered) {
      if (remainder <= 0) break;
      this.game.seats[i]!.stack += 1;
      remainder--;
    }
  }

  /** Clear the table back to idle (host force-clear / between sessions). */
  reset(): void {
    this.load();
    const seats = this.game.seats;
    this.game = this.emptyGame();
    // Keep seated players (with their stacks) for a fresh session.
    this.game.seats = seats.map(s => ({ ...s, committed: 0, handCommitted: 0, hole: null, hasActed: false, status: "out" }));
    this.touch();
  }

  /** Wipe the table entirely — no seats. Used when (re)opening a fresh
   *  session from a funded escrow. */
  clearTable(): void {
    this.load();
    this.game = this.emptyGame();
    this.deck = [];
    this.touch();
  }

  /** Set fixed blinds (no escalation). Between hands only. */
  setBlinds(smallBlind: number, bigBlind: number): { ok: true } | { ok: false; error: string } {
    return this.setBlindSchedule(smallBlind, bigBlind, 0);
  }

  /** Set the blind schedule: base blinds + how often they double. A
   *  positive intervalMs escalates (blinds × 2 each level); 0 keeps them
   *  fixed. The level clock starts on the first hand, not here, so the
   *  buy-in window doesn't burn blind levels. Between hands only. */
  setBlindSchedule(smallBlind: number, bigBlind: number, intervalMs: number): { ok: true } | { ok: false; error: string } {
    this.load();
    if (this.game.status === "running") return { ok: false, error: "hand_in_progress" };
    if (smallBlind <= 0 || bigBlind < smallBlind) return { ok: false, error: "bad_blinds" };
    this.game.baseSmallBlind = smallBlind;
    this.game.baseBigBlind = bigBlind;
    this.game.blindIntervalMs = Math.max(0, Math.floor(intervalMs));
    this.game.blindClockStart = null;
    this.game.blindLevel = 0;
    this.game.smallBlind = smallBlind;
    this.game.bigBlind = bigBlind;
    this.game.minRaise = bigBlind;
    this.touch();
    return { ok: true };
  }

  // --- seat ordering helpers ----------------------------------------

  /** Clockwise seat order (by index in the seats array) starting AT
   *  `start`. Pure rotation; doesn't filter by status. */
  private actingOrderFrom(start: number): number[] {
    const n = this.game.seats.length;
    if (n === 0) return [];
    const s = ((start % n) + n) % n;
    return Array.from({ length: n }, (_, k) => (s + k) % n);
  }

  /** Next seat index (after `from`) whose status is in the hand
   *  (active/allin). Used to rotate the button. */
  private nextInHand(from: number): number {
    const n = this.game.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n;
      const st = this.game.seats[i]!.status;
      if (st === "active" || st === "allin") return i;
    }
    // Fallback: any seat with chips (used at button rotation pre-deal).
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n;
      if (this.game.seats[i]!.stack > 0) return i;
    }
    return (((from + 1) % n) + n) % n;
  }

  /** Next seat (after `from`) that is `active` (can still act). */
  private nextActor(from: number): number {
    const n = this.game.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n;
      if (this.game.seats[i]!.status === "active") return i;
    }
    return from;
  }

  /** First seat from `start` (inclusive) that is active. */
  private firstToAct(start: number): number {
    const n = this.game.seats.length;
    for (let k = 0; k < n; k++) {
      const i = (((start + k) % n) + n) % n;
      if (this.game.seats[i]!.status === "active") return i;
    }
    return -1;
  }

  // --- views ---------------------------------------------------------

  /** Tournament standings, best first. Survivors (still have chips) come
   *  first ranked by stack, then eliminated players in reverse bust order
   *  (last out finished higher). `place` is 1-based. Provisional while the
   *  tournament runs; final once one player remains. The relay reads this
   *  to split the prize pool by finishing place. */
  standings(): { key: string; label: string; place: number; stack: number; out: boolean }[] {
    const byKey = new Map(this.game.seats.map(s => [s.key, s] as const));
    const alive = this.game.seats.filter(s => s.stack > 0).sort((a, b) => b.stack - a.stack);
    const eliminated = [...this.game.eliminatedOrder]
      .reverse()
      .map(k => byKey.get(k))
      .filter((s): s is Seat => !!s);
    return [...alive, ...eliminated].map((s, i) => ({
      key: s.key,
      label: s.label,
      place: i + 1,
      stack: s.stack,
      out: s.stack === 0,
    }));
  }

  /** Public snapshot: hole cards stripped (except revealed showdown
   *  hands). Safe to broadcast to everyone, including spectators. */
  publicView(): unknown {
    this.load();
    const g = this.game;
    const revealed = new Map(g.showdown.map(e => [e.seat, e.hole] as const));
    return {
      handId: g.handId,
      button: g.button,
      smallBlind: g.smallBlind,
      bigBlind: g.bigBlind,
      blindLevel: g.blindLevel,
      blindIntervalMs: g.blindIntervalMs,
      // When the blinds next double (drives the client's level countdown).
      // Null when blinds are fixed or the clock hasn't started.
      nextBlindAt:
        g.blindIntervalMs > 0 && g.blindClockStart !== null
          ? g.blindClockStart + (g.blindLevel + 1) * g.blindIntervalMs
          : null,
      board: g.board,
      pots: g.pots,
      potTotal: g.pots.reduce((n, p) => n + p.amountChips, 0),
      street: g.street,
      currentBet: g.currentBet,
      minRaise: g.minRaise,
      actor: g.actor,
      status: g.status,
      showdown: g.showdown,
      startedAt: g.startedAt,
      actorSince: g.actorSince,
      // When the current actor will be auto-acted if idle (drives the
      // client's turn countdown). Null when no one is on the clock.
      actorDeadline: g.status === "running" && g.actor >= 0 ? g.actorSince + TURN_TIMEOUT_MS : null,
      // When the next hand can be dealt (post-showdown pause). Null unless
      // we're holding on a contested showdown.
      nextHandAt: g.handEndedAt !== null ? g.handEndedAt + SHOWDOWN_PAUSE_MS : null,
      runningOut: g.runningOut,
      // Players with chips left, and the finishing order so far (best first).
      playersLeft: g.seats.filter(s => s.stack > 0).length,
      standings: this.standings(),
      seats: g.seats.map((s, i) => ({
        seat: s.seatIdx,
        idx: i,
        key: s.key,
        label: s.label,
        stack: s.stack,
        committed: s.committed,
        status: s.status,
        hasCards: s.hole !== null && (s.status === "active" || s.status === "allin"),
        hole: revealed.get(i) ?? null,
      })),
    };
  }

  /** The private hole-card frame for one player — sent only over that
   *  player's own socket(s). */
  privateFor(key: string): { handId: string | null; hole: [Card, Card] | null } {
    this.load();
    const seat = this.seatOf(key);
    return { handId: this.game.handId, hole: seat?.hole ?? null };
  }

  private touch(): void {
    this.scheduleSave();
  }
}

/** Cryptographically-seeded Fisher–Yates shuffle. */
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

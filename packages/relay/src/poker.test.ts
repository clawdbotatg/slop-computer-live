// Engine tests. Run: yarn tsx --test src/poker.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type Card, makeDeck } from "./poker-eval.js";
import { PokerState, type Seat, buildPots } from "./poker.js";

// A throwaway file path — PokerState persists, but in tests we just point
// each instance at a unique tmp path it never reads back.
let n = 0;
function table(sb = 1, bb = 2): PokerState {
  return new PokerState(`/tmp/poker-test-${process.pid}-${n++}.json`, sb, bb);
}

/** Build a 52-card deal-order deck that gives each in-hand seat (in seats-
 *  array order) the supplied hole cards and lays the supplied board, with
 *  burns and the rest of the deck filled from the remainder. */
function deckFor(holes: Card[][], board: Card[]): Card[] {
  const slots: (Card | null)[] = new Array(52).fill(null);
  let p = 0;
  for (const h of holes) {
    slots[p++] = h[0]!;
    slots[p++] = h[1]!;
  }
  p++; // burn before flop
  for (const c of board.slice(0, 3)) slots[p++] = c;
  p++; // burn before turn
  if (board[3]) slots[p++] = board[3];
  p++; // burn before river
  if (board[4]) slots[p++] = board[4];
  const used = new Set(slots.filter(Boolean) as Card[]);
  const rest = makeDeck().filter(c => !used.has(c));
  let r = 0;
  for (let i = 0; i < 52; i++) if (!slots[i]) slots[i] = rest[r++]!;
  return slots as Card[];
}

function sumDeltas(t: PokerState): number {
  return t.getGame().lastResult!.deltas.reduce((s, d) => s + d.deltaChips, 0);
}

// --- side-pot math (pure) ---------------------------------------------

test("buildPots: equal contributions = one main pot", () => {
  const seats = [
    seat("a", 100, "active"),
    seat("b", 100, "active"),
  ];
  seats[0]!.handCommitted = 50;
  seats[1]!.handCommitted = 50;
  const pots = buildPots(seats);
  assert.equal(pots.length, 1);
  assert.equal(pots[0]!.amountChips, 100);
  assert.deepEqual(pots[0]!.eligible.sort(), [0, 1]);
});

test("buildPots: short all-in creates a side pot", () => {
  const seats = [seat("a", 0, "allin"), seat("b", 0, "allin"), seat("c", 0, "allin")];
  seats[0]!.handCommitted = 50; // short stack
  seats[1]!.handCommitted = 100;
  seats[2]!.handCommitted = 100;
  const pots = buildPots(seats);
  assert.equal(pots.length, 2);
  assert.equal(pots[0]!.amountChips, 150); // main: 50*3, all eligible
  assert.deepEqual(pots[0]!.eligible.sort(), [0, 1, 2]);
  assert.equal(pots[1]!.amountChips, 100); // side: 50*2, only b & c
  assert.deepEqual(pots[1]!.eligible.sort(), [1, 2]);
});

test("buildPots: folded chips are dead money, not eligible", () => {
  const seats = [seat("a", 0, "folded"), seat("b", 100, "active"), seat("c", 100, "active")];
  seats[0]!.handCommitted = 20;
  seats[1]!.handCommitted = 20;
  seats[2]!.handCommitted = 20;
  const pots = buildPots(seats);
  assert.equal(pots.length, 1);
  assert.equal(pots[0]!.amountChips, 60);
  assert.deepEqual(pots[0]!.eligible.sort(), [1, 2]); // a folded
});

// --- full hands -------------------------------------------------------

test("heads-up all-in preflop: best hand wins the pot, zero-sum", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  // seats array order: [alice(seat0), bob(seat1)]. alice = button = SB.
  const deck = deckFor(
    [["Ah", "As"], ["Kh", "Ks"]],
    ["2c", "7d", "9h", "Js", "4c"], // bricks: aces hold
  );
  assert.equal(t.startHand(deck).ok, true);
  // alice (button/SB) acts first preflop: shove.
  assert.equal(t.act("alice", { action: "raise", toChips: 100 }).ok, true);
  const out = t.act("bob", { action: "call" });
  assert.equal(out.ok, true);
  const g = t.getGame();
  assert.equal(g.status, "complete");
  const alice = g.seats.find(s => s.key === "alice")!;
  const bob = g.seats.find(s => s.key === "bob")!;
  assert.equal(alice.stack, 200);
  assert.equal(bob.stack, 0);
  assert.equal(sumDeltas(t), 0);
});

test("three-way all-in builds a side pot the short stack can't win", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 50); // short stack, button
  t.sit(1, "bob", "Bob", 100);
  t.sit(2, "carol", "Carol", 100);
  const deck = deckFor(
    [["Ah", "As"], ["Kh", "Ks"], ["Qh", "Qs"]],
    ["2c", "7d", "9h", "Js", "4c"],
  );
  assert.equal(t.startHand(deck).ok, true);
  // 3-handed: button=alice(SB? no) — SB=bob, BB=carol; first to act = alice.
  assert.equal(t.act("alice", { action: "raise", toChips: 50 }).ok, true); // all-in 50
  assert.equal(t.act("bob", { action: "raise", toChips: 100 }).ok, true); // all-in 100
  assert.equal(t.act("carol", { action: "call" }).ok, true); // calls 100
  const g = t.getGame();
  assert.equal(g.status, "complete");
  const get = (k: string) => g.seats.find(s => s.key === k)!;
  // Main pot 150 → alice (AA). Side pot 100 → bob (KK) over carol (QQ).
  assert.equal(get("alice").stack, 150);
  assert.equal(get("bob").stack, 100);
  assert.equal(get("carol").stack, 0);
  assert.equal(sumDeltas(t), 0);
});

test("split pot chops evenly (board plays)", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  // Both hold rags; the board is a made straight that plays for both.
  const deck = deckFor(
    [["2c", "3d"], ["2h", "3s"]],
    ["As", "Kd", "Qh", "Jc", "Td"], // Broadway on board → chop
  );
  assert.equal(t.startHand(deck).ok, true);
  assert.equal(t.act("alice", { action: "raise", toChips: 100 }).ok, true);
  assert.equal(t.act("bob", { action: "call" }).ok, true);
  const g = t.getGame();
  assert.equal(g.seats.find(s => s.key === "alice")!.stack, 100);
  assert.equal(g.seats.find(s => s.key === "bob")!.stack, 100);
  assert.equal(sumDeltas(t), 0);
});

test("heads-up SB fold gives BB the blind, no showdown", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  assert.equal(t.startHand(deckFor([["Ah", "As"], ["Kh", "Ks"]], ["2c", "7d", "9h", "Js", "4c"])).ok, true);
  // alice = button/SB acts first; folding hands the pot to bob.
  const out = t.act("alice", { action: "fold" });
  assert.equal(out.ok, true);
  const g = t.getGame();
  assert.equal(g.status, "complete");
  assert.equal(g.showdown.length, 0); // mucked, no reveal
  assert.equal(g.seats.find(s => s.key === "alice")!.stack, 99);
  assert.equal(g.seats.find(s => s.key === "bob")!.stack, 101);
  assert.equal(sumDeltas(t), 0);
});

test("checked-down multiway hand reaches river and resolves", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  t.sit(2, "carol", "Carol", 100);
  const deck = deckFor(
    [["Ah", "Ad"], ["Kh", "Kd"], ["Qh", "Qd"]],
    ["2c", "7d", "9h", "Js", "4c"],
  );
  assert.equal(t.startHand(deck).ok, true);
  // Preflop: alice (UTG/button) calls, bob (SB) calls, carol (BB) checks option.
  assert.equal(t.act("alice", { action: "call" }).ok, true); // calls BB (2)
  assert.equal(t.act("bob", { action: "call" }).ok, true); // SB completes
  assert.equal(t.act("carol", { action: "check" }).ok, true); // BB option
  let g = t.getGame();
  assert.equal(g.street, "flop");
  // Each post-flop street: SB-first, everyone checks.
  for (const street of ["flop", "turn", "river"]) {
    assert.equal(t.getGame().street, street);
    assert.equal(t.act("bob", { action: "check" }).ok, true);
    assert.equal(t.act("carol", { action: "check" }).ok, true);
    assert.equal(t.act("alice", { action: "check" }).ok, true);
  }
  g = t.getGame();
  assert.equal(g.status, "complete");
  assert.equal(g.seats.find(s => s.key === "alice")!.stack, 104); // contributes 2, wins the 6-chip pot → net +4
  assert.equal(sumDeltas(t), 0);
});

// --- rules / validation ----------------------------------------------

test("raise below the minimum is rejected", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  t.startHand(makeDeck());
  // currentBet=2 (BB), minRaise=2 → smallest legal raise-to is 4.
  assert.equal(t.act("alice", { action: "raise", toChips: 3 }).ok, false);
  assert.equal(t.act("alice", { action: "raise", toChips: 4 }).ok, true);
});

test("acting out of turn is rejected", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  t.startHand(makeDeck());
  // alice is first to act heads-up; bob can't jump in.
  assert.equal(t.act("bob", { action: "call" }).ok, false);
});

test("checking while facing a bet is rejected", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  t.startHand(makeDeck());
  // alice faces the BB; can't check.
  assert.equal(t.act("alice", { action: "check" }).ok, false);
});

test("button rotates between hands", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  t.startHand(makeDeck());
  const b1 = t.getGame().button;
  // End the hand fast: SB folds.
  t.act("alice", { action: "fold" });
  t.startHand(makeDeck());
  const b2 = t.getGame().button;
  assert.notEqual(b1, b2);
});

test("autoAct folds the timed-out actor when facing a bet", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  t.startHand(makeDeck());
  // alice (button/SB) faces the BB; an idle timeout folds her → bob wins.
  const out = t.autoAct();
  assert.ok(out && out.ok);
  const g = t.getGame();
  assert.equal(g.status, "complete");
  assert.equal(g.seats.find(s => s.key === "bob")!.stack, 101);
});

test("autoAct returns null when no hand is running", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  assert.equal(t.autoAct(), null);
});

test("cannot start a hand with one player", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  assert.equal(t.startHand().ok, false);
});

test("publicView hides hole cards; privateFor reveals own", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  t.startHand(makeDeck());
  const view = t.publicView() as { seats: { key: string; hole: unknown; hasCards: boolean }[] };
  for (const s of view.seats) {
    assert.equal(s.hole, null); // never leak hole cards pre-showdown
    assert.equal(s.hasCards, true);
  }
  const priv = t.privateFor("alice");
  assert.ok(Array.isArray(priv.hole) && priv.hole.length === 2);
});

// --- helpers ----------------------------------------------------------

function seat(key: string, stack: number, status: Seat["status"]): Seat {
  return {
    seatIdx: 0,
    key,
    label: key,
    stack,
    committed: 0,
    handCommitted: 0,
    startStack: stack,
    status,
    hole: null,
    hasActed: false,
  };
}

// Engine tests. Run: yarn tsx --test src/poker.test.ts
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { type Card, makeDeck } from "./poker-eval.js";
import { PokerState, type Seat, blindsAtLevel, buildPots } from "./poker.js";

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
  t.finishRunout(); // all-in: deal the board out to showdown
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
  t.finishRunout(); // all-in: deal the board out to showdown
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
  t.finishRunout(); // all-in: deal the board out to showdown
  const g = t.getGame();
  assert.equal(g.seats.find(s => s.key === "alice")!.stack, 100);
  assert.equal(g.seats.find(s => s.key === "bob")!.stack, 100);
  assert.equal(sumDeltas(t), 0);
  // Both shown hands are flagged as winners (a chop), with a description.
  assert.equal(g.showdown.length, 2);
  assert.ok(g.showdown.every(s => s.won));
  assert.ok(g.showdown.every(s => typeof s.hand === "string" && s.hand.length > 0));
});

test("contested showdown marks the winner + describes the hand", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  const deck = deckFor([["Ah", "As"], ["Kh", "Ks"]], ["2c", "7d", "9h", "Js", "4c"]);
  assert.equal(t.startHand(deck).ok, true);
  assert.equal(t.act("alice", { action: "raise", toChips: 100 }).ok, true);
  assert.equal(t.act("bob", { action: "call" }).ok, true);
  t.finishRunout(); // all-in: deal the board out to showdown
  const g = t.getGame();
  const alice = g.showdown.find(s => g.seats[s.seat]!.key === "alice")!;
  const bob = g.showdown.find(s => g.seats[s.seat]!.key === "bob")!;
  assert.equal(alice.won, true); // pair of aces
  assert.equal(bob.won, false);
  assert.equal(alice.hand, "Pair of aces");
  assert.equal(alice.cards.length, 5);
});

test("contested showdown blocks the next hand until the pause elapses", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  // A chop leaves both with chips so a re-deal is otherwise possible.
  const deck = deckFor([["2c", "3d"], ["2h", "3s"]], ["As", "Kd", "Qh", "Jc", "Td"]);
  assert.equal(t.startHand(deck).ok, true);
  assert.equal(t.act("alice", { action: "raise", toChips: 100 }).ok, true);
  assert.equal(t.act("bob", { action: "call" }).ok, true);
  t.finishRunout(); // all-in: deal the board out to showdown
  // Immediately after a contested showdown → blocked.
  const tooSoon = t.startHand(makeDeck());
  assert.equal(tooSoon.ok, false);
  assert.equal((tooSoon as { error: string }).error, "showdown_pause");
  const pub = t.publicView() as { nextHandAt: number | null };
  assert.ok(typeof pub.nextHandAt === "number"); // countdown exposed to the UI
});

test("all-in board runs out one street at a time", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  const deck = deckFor([["Ah", "As"], ["Kh", "Ks"]], ["2c", "7d", "9h", "Js", "4c"]);
  assert.equal(t.startHand(deck).ok, true);
  assert.equal(t.act("alice", { action: "raise", toChips: 100 }).ok, true);
  assert.equal(t.act("bob", { action: "call" }).ok, true);
  // After the all-in the hand is NOT instantly resolved — it's running out.
  let g = t.getGame();
  assert.equal(g.runningOut, true);
  assert.equal(g.status, "running");
  assert.equal(g.board.length, 3); // flop is shown, turn/river still to come
  assert.equal(t.advanceRunout().ended, false);
  assert.equal(t.getGame().board.length, 4); // turn
  assert.equal(t.advanceRunout().ended, false);
  assert.equal(t.getGame().board.length, 5); // river
  assert.equal(t.advanceRunout().ended, true); // showdown
  g = t.getGame();
  assert.equal(g.status, "complete");
  assert.equal(g.runningOut, false);
  assert.equal(g.seats.find(s => s.key === "alice")!.stack, 200);
  assert.equal(sumDeltas(t), 0);
});

test("loads a legacy persisted game without the new fields (no crash)", () => {
  // A game persisted by an older build — no eliminatedOrder, no blind
  // schedule. Loading + publicView/standings must backfill, not throw.
  const path = `/tmp/poker-legacy-${process.pid}-${n++}.json`;
  writeFileSync(
    path,
    JSON.stringify({
      game: {
        handId: null,
        seats: [],
        button: -1,
        smallBlind: 1,
        bigBlind: 2,
        board: [],
        pots: [],
        street: "idle",
        currentBet: 0,
        minRaise: 2,
        actor: -1,
        status: "idle",
        showdown: [],
        startedAt: null,
        actorSince: 0,
        lastResult: null,
      },
    }),
  );
  const t = new PokerState(path, 1, 2);
  assert.doesNotThrow(() => t.publicView());
  assert.deepEqual(t.standings(), []);
  assert.deepEqual(t.getGame().eliminatedOrder, []);
});

test("busting a player records tournament finishing order", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  const deck = deckFor([["Ah", "As"], ["Kh", "Ks"]], ["2c", "7d", "9h", "Js", "4c"]);
  assert.equal(t.startHand(deck).ok, true);
  assert.equal(t.act("alice", { action: "raise", toChips: 100 }).ok, true);
  assert.equal(t.act("bob", { action: "call" }).ok, true);
  t.finishRunout();
  assert.deepEqual(t.getGame().eliminatedOrder, ["bob"]); // bob busted
  const s = t.standings();
  assert.equal(s[0]!.key, "alice");
  assert.equal(s[0]!.place, 1);
  assert.equal(s[1]!.key, "bob");
  assert.equal(s[1]!.place, 2);
  assert.equal(s[1]!.out, true);
});

test("fold-win has no showdown pause (re-deal immediately)", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  assert.equal(t.startHand(makeDeck()).ok, true);
  assert.equal(t.act("alice", { action: "fold" }).ok, true); // uncontested
  assert.equal(t.startHand(makeDeck()).ok, true); // no pause
});

test("showCards reveals the winner's hole after a fold-win", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  // alice = button/SB folds heads-up; bob wins uncontested, cards mucked.
  assert.equal(t.startHand(deckFor([["Ah", "As"], ["Kh", "Ks"]], [])).ok, true);
  assert.equal(t.act("alice", { action: "fold" }).ok, true);

  type Pub = { nextHandAt: number | null; seats: { key: string; hole: string[] | null }[] };
  const before = t.publicView() as Pub;
  assert.equal(before.seats.find(s => s.key === "bob")!.hole, null); // not yet shown
  assert.equal(before.nextHandAt, null); // fold-win: no pause

  // A spectator / non-seated key can't reveal someone's cards.
  assert.equal(t.showCards("mallory").ok, false);
  // The winner shows; idempotent on repeat.
  assert.equal(t.showCards("bob").ok, true);
  assert.equal(t.showCards("bob").ok, true);

  const after = t.publicView() as Pub;
  assert.deepEqual(after.seats.find(s => s.key === "bob")!.hole, ["Kh", "Ks"]);
  assert.equal(after.seats.find(s => s.key === "alice")!.hole, null); // alice didn't show
  assert.notEqual(after.nextHandAt, null); // showing started the viewing pause
});

test("showCards is rejected while a hand is running", () => {
  const t = table();
  t.sit(0, "alice", "Alice", 100);
  t.sit(1, "bob", "Bob", 100);
  assert.equal(t.startHand(makeDeck()).ok, true);
  assert.equal(t.showCards("alice").ok, false); // hand still live
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

test("blindsAtLevel doubles per level (capped)", () => {
  assert.deepEqual(blindsAtLevel(5, 10, 0), { sb: 5, bb: 10 });
  assert.deepEqual(blindsAtLevel(5, 10, 1), { sb: 10, bb: 20 });
  assert.deepEqual(blindsAtLevel(5, 10, 3), { sb: 40, bb: 80 });
});

test("setBlindSchedule keeps level 0 blinds on the first hand", () => {
  const t = table();
  t.setBlindSchedule(5, 10, 60_000); // double every minute
  t.sit(0, "alice", "Alice", 1000);
  t.sit(1, "bob", "Bob", 1000);
  t.startHand(makeDeck());
  const g = t.getGame();
  // First hand starts the clock → level 0 → base blinds.
  assert.equal(g.blindLevel, 0);
  assert.equal(g.smallBlind, 5);
  assert.equal(g.bigBlind, 10);
});

test("fixed blinds (interval 0) never escalate", () => {
  const t = table();
  t.setBlindSchedule(5, 10, 0);
  t.sit(0, "alice", "Alice", 1000);
  t.sit(1, "bob", "Bob", 1000);
  t.startHand(makeDeck());
  assert.equal(t.getGame().blindLevel, 0);
  assert.equal(t.getGame().bigBlind, 10);
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

// --- bet increment (whole small-blind units, no fractions) ------------

test("raise must be a whole small-blind multiple; fractions rejected", () => {
  const t = table(10, 20);
  t.sit(0, "alice", "Alice", 1000); // button / SB
  t.sit(1, "bob", "Bob", 1000); // BB
  const deck = deckFor([["Ah", "As"], ["Kh", "Ks"]], ["2c", "7d", "9h", "Js", "4c"]);
  assert.equal(t.startHand(deck).ok, true);
  // currentBet = BB = 20. alice acts first heads-up.
  const frac = t.act("alice", { action: "raise", toChips: 30.5 });
  assert.equal(frac.ok, false);
  assert.equal((frac as { error: string }).error, "bad_amount");
  const offStep = t.act("alice", { action: "raise", toChips: 45 }); // not a multiple of 10
  assert.equal(offStep.ok, false);
  assert.equal((offStep as { error: string }).error, "bad_increment");
  // A clean small-blind multiple that clears the min-raise is fine.
  assert.equal(t.act("alice", { action: "raise", toChips: 40 }).ok, true);
});

test("all-in is exempt from the small-blind increment rule", () => {
  const t = table(10, 20);
  t.sit(0, "alice", "Alice", 995); // odd stack → all-in target isn't a multiple of 10
  t.sit(1, "bob", "Bob", 1000);
  const deck = deckFor([["Ah", "As"], ["Kh", "Ks"]], ["2c", "7d", "9h", "Js", "4c"]);
  assert.equal(t.startHand(deck).ok, true);
  // alice posted SB 10 → maxTo = 995, not a multiple of 10, but a shove is legal.
  assert.equal(t.act("alice", { action: "raise", toChips: 995 }).ok, true);
});

test("action log: records each voluntary action with think time (blinds excluded)", () => {
  const t = table(10, 20);
  t.sit(0, "a", "A", 1000);
  t.sit(1, "b", "B", 1000);
  t.startHand();
  // Heads-up: the button/SB acts first preflop and owes the blind difference.
  const sb = t.getGame().seats[t.getGame().actor]!;
  assert.equal(t.act(sb.key, { action: "call" }).ok, true);
  const bb = t.getGame().seats[t.getGame().actor]!;
  assert.equal(t.act(bb.key, { action: "check" }).ok, true);

  const log = t.getGame().actions;
  assert.equal(log.length, 2); // forced blinds are NOT logged — only decisions
  assert.equal(log[0]!.kind, "call");
  assert.equal(log[0]!.amount, 10); // SB completed from 10 → 20
  assert.equal(log[1]!.kind, "check");
  assert.equal(log[1]!.street, "preflop");
  assert.ok(log.every(a => typeof a.thinkMs === "number" && a.thinkMs >= 0));
});

test("action log: resets at the start of each hand", () => {
  const t = table(10, 20);
  t.sit(0, "a", "A", 1000);
  t.sit(1, "b", "B", 1000);
  t.startHand();
  const sb = t.getGame().seats[t.getGame().actor]!;
  t.act(sb.key, { action: "fold" }); // heads-up fold ends the hand immediately
  assert.equal(t.getGame().actions.length, 1);
  assert.equal(t.getGame().status, "complete");
  t.startHand(); // next hand
  assert.equal(t.getGame().actions.length, 0);
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

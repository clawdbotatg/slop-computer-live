// Poker AI mover tests. Run: yarn tsx --test src/poker-mover.test.ts
// Focus: the pure decision helpers — computeOptions (legal menu from engine
// state) and parseAction (model text → a legal ActArgs, clamped). The network
// loop itself isn't unit-tested (it just wires these to a fetch + act).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PokerState } from "./poker.js";
import { computeOptions, parseAction } from "./poker-mover.js";

let n = 0;
const table = () => new PokerState(`/tmp/poker-mover-test-${process.pid}-${n++}.json`, 10, 20);

/** A heads-up hand mid-preflop: two 1000-chip stacks, blinds 10/20. The actor
 *  (small blind, to act first heads-up) owes 10 to call. */
function headsUp(): PokerState {
  const t = table();
  t.sit(0, "ai:bankr-claude-haiku-4.5#deadbe", "Bot", 1000);
  t.sit(1, "0x" + "2".repeat(40), "Human", 1000);
  const started = t.startHand();
  assert.equal(started.ok, true);
  return t;
}

test("computeOptions: SB preflop owes the blind difference and can raise", () => {
  const t = headsUp();
  const g = t.getGame();
  const opts = computeOptions(g);
  // currentBet is the big blind (20); SB has committed 10 → owes 10.
  assert.equal(opts.toCall, 10);
  assert.equal(opts.canCheck, false);
  assert.equal(opts.callAmount, 10);
  assert.equal(opts.canRaise, true);
  // Min legal raise-to is currentBet + minRaise (20 + 20 = 40), SB-aligned.
  assert.equal(opts.minRaiseTo, 40);
  // All-in ceiling = committed 10 + remaining stack 990 (the blind already
  // left the stack when it was posted).
  assert.equal(opts.maxTo, 1000);
});

test("parseAction: bare tokens map to the right actions", () => {
  const t = headsUp();
  const g = t.getGame();
  const opts = computeOptions(g);
  assert.deepEqual(parseAction("FOLD", g, opts), { action: "fold" });
  assert.deepEqual(parseAction("CALL", g, opts), { action: "call" });
  // CHECK is illegal when there's something to call → null.
  assert.equal(parseAction("CHECK", g, opts), null);
  // ALLIN shoves to the ceiling (preflop ⇒ a raise).
  assert.deepEqual(parseAction("ALLIN", g, opts), { action: "raise", toChips: 1000 });
});

test("parseAction: raise amounts are clamped to a legal, SB-aligned target", () => {
  const t = headsUp();
  const g = t.getGame();
  const opts = computeOptions(g);
  // A clean legal raise passes through.
  assert.deepEqual(parseAction("RAISE 100", g, opts), { action: "raise", toChips: 100 });
  // Below the minimum is bumped up to minRaiseTo.
  assert.deepEqual(parseAction("RAISE 25", g, opts), { action: "raise", toChips: 40 });
  // A non-SB-multiple is snapped to the grid.
  assert.deepEqual(parseAction("raise to 103 chips", g, opts), { action: "raise", toChips: 100 });
  // Above the ceiling becomes an all-in.
  assert.deepEqual(parseAction("RAISE 99999", g, opts), { action: "raise", toChips: 1000 });
  // The clamped target is one the engine actually accepts.
  const parsed = parseAction("RAISE 25", g, opts)!;
  assert.equal(t.act(g.seats[g.actor]!.key, parsed).ok, true);
});

test("parseAction: reasoning chatter — the LAST action keyword wins", () => {
  const t = headsUp();
  const g = t.getGame();
  const opts = computeOptions(g);
  const raw = "I could CALL here, but my hand is strong. Let me RAISE 60 instead.";
  assert.deepEqual(parseAction(raw, g, opts), { action: "raise", toChips: 60 });
});

test("parseAction: returns null when no action keyword is present", () => {
  const t = headsUp();
  const g = t.getGame();
  const opts = computeOptions(g);
  assert.equal(parseAction("hmm, let me think about this position", g, opts), null);
});

// Evaluator tests. Run: yarn tsx --test src/poker-eval.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HandCategory, compareEval, evaluate5, evaluate7, bestOf, makeDeck } from "./poker-eval.js";

test("deck is 52 unique cards", () => {
  const d = makeDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
});

test("categories are detected", () => {
  assert.equal(evaluate5(["As", "Ks", "Qs", "Js", "Ts"]).category, HandCategory.StraightFlush);
  assert.equal(evaluate5(["Ac", "Ad", "Ah", "As", "Kd"]).category, HandCategory.Quads);
  assert.equal(evaluate5(["Ac", "Ad", "Ah", "Kc", "Kd"]).category, HandCategory.FullHouse);
  assert.equal(evaluate5(["2s", "5s", "9s", "Js", "Ks"]).category, HandCategory.Flush);
  assert.equal(evaluate5(["2c", "3d", "4h", "5s", "6d"]).category, HandCategory.Straight);
  assert.equal(evaluate5(["Ac", "Ad", "Ah", "Kc", "Qd"]).category, HandCategory.Trips);
  assert.equal(evaluate5(["Ac", "Ad", "Kh", "Kc", "Qd"]).category, HandCategory.TwoPair);
  assert.equal(evaluate5(["Ac", "Ad", "Kh", "Qc", "Jd"]).category, HandCategory.Pair);
  assert.equal(evaluate5(["Ac", "Jd", "9h", "5c", "3d"]).category, HandCategory.HighCard);
});

test("wheel straight is a 5-high straight", () => {
  const ev = evaluate5(["Ac", "2d", "3h", "4s", "5d"]);
  assert.equal(ev.category, HandCategory.Straight);
  assert.equal(ev.tiebreak[0], 3); // rank '5' == index 3
});

test("wheel loses to 6-high straight", () => {
  const wheel = evaluate5(["Ac", "2d", "3h", "4s", "5d"]);
  const six = evaluate5(["2c", "3d", "4h", "5s", "6d"]);
  assert.ok(compareEval(six, wheel) > 0);
});

test("kickers break a tie within a category", () => {
  const aKQ = evaluate5(["Ac", "Ad", "Kh", "Qc", "9d"]);
  const aKJ = evaluate5(["As", "Ah", "Kd", "Jc", "9h"]);
  assert.ok(compareEval(aKQ, aKJ) > 0); // Q kicker beats J kicker
});

test("identical hands chop", () => {
  const a = evaluate5(["Ac", "Kd", "Qh", "Js", "9d"]);
  const b = evaluate5(["As", "Kh", "Qd", "Jc", "9h"]);
  assert.equal(compareEval(a, b), 0);
});

test("evaluate7 picks the best 5 of 7", () => {
  // Board makes a flush available with two hole cards.
  const ev = evaluate7(["As", "Ks", "Qs", "2s", "7s", "2d", "3c"]);
  assert.equal(ev.category, HandCategory.Flush);
});

test("evaluate7 finds full house over flush draw", () => {
  const ev = evaluate7(["Ac", "Ad", "Ah", "Kc", "Kd", "2s", "7s"]);
  assert.equal(ev.category, HandCategory.FullHouse);
});

test("bestOf returns all tied seats on a chop", () => {
  // Both seats play the board: a royal-ish straight on board.
  const board = ["Ac", "Kd", "Qh", "Js", "Td"];
  const winners = bestOf([
    { seat: 0, cards: [...board, "2c", "3d"] },
    { seat: 1, cards: [...board, "4c", "5d"] },
  ]);
  assert.deepEqual(winners.sort(), [0, 1]);
});

test("bestOf single winner", () => {
  const board = ["Ac", "Kd", "Qh", "2s", "7d"];
  const winners = bestOf([
    { seat: 0, cards: [...board, "Ah", "Kc"] }, // two pair, aces and kings
    { seat: 1, cards: [...board, "2h", "2d"] }, // trip twos
  ]);
  assert.deepEqual(winners, [1]);
});

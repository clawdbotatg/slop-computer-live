// Self-contained Texas Hold'em hand evaluator.
//
// No external dependency: the relay is a strict ESM/NodeNext project and
// the popular evaluators (pokersolver) ship untyped CommonJS that fights
// that setup. Hand ranking is the well-trodden, highly-testable part of
// poker, so we own it here behind a tiny typed surface and lean on
// poker.test.ts to prove it. The engine (poker.ts) only needs three
// things from this module: a card type, evaluate7(), and compareEval().
//
// A `Card` is a two-char string: rank + suit. Rank ∈ 23456789TJQKA,
// suit ∈ cdhs (clubs/diamonds/hearts/spades). e.g. "As", "Td", "2c".

export type Card = string;

export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";

/** Hand category, low → high. Numeric order is the primary comparison key. */
export enum HandCategory {
  HighCard = 0,
  Pair = 1,
  TwoPair = 2,
  Trips = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  Quads = 7,
  StraightFlush = 8,
}

/** A fully-resolved 5-card hand value. `tiebreak` is a list of rank values
 *  (high → low, 0..12 where 12 = Ace) that breaks ties WITHIN a category;
 *  compare it lexicographically. `cards` is the best 5 chosen from 7 (for
 *  UI/highlighting). */
export type HandEval = {
  category: HandCategory;
  /** Tiebreak ranks, most significant first. Same length for a given
   *  category, so a plain element-wise compare resolves kickers. */
  tiebreak: number[];
  cards: Card[];
};

const CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: "High Card",
  [HandCategory.Pair]: "Pair",
  [HandCategory.TwoPair]: "Two Pair",
  [HandCategory.Trips]: "Three of a Kind",
  [HandCategory.Straight]: "Straight",
  [HandCategory.Flush]: "Flush",
  [HandCategory.FullHouse]: "Full House",
  [HandCategory.Quads]: "Four of a Kind",
  [HandCategory.StraightFlush]: "Straight Flush",
};

export function handName(category: HandCategory): string {
  return CATEGORY_NAMES[category];
}

const RANK_SINGULAR = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "jack", "queen", "king", "ace"];
const RANK_PLURAL = ["twos", "threes", "fours", "fives", "sixes", "sevens", "eights", "nines", "tens", "jacks", "queens", "kings", "aces"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sing = (i: number) => RANK_SINGULAR[i] ?? "card";
const plur = (i: number) => RANK_PLURAL[i] ?? "cards";

/** A natural-language description of a hand, e.g. "Kings full of queens",
 *  "Ace-high flush", "Pair of jacks". Used so the showdown shows what
 *  actually won, not just the category. */
export function describeHand(ev: HandEval): string {
  const tb = ev.tiebreak;
  const hi = tb[0] ?? 0;
  switch (ev.category) {
    case HandCategory.StraightFlush:
      return hi === 12 ? "Royal flush" : `${cap(sing(hi))}-high straight flush`;
    case HandCategory.Quads:
      return `Four ${plur(hi)}`;
    case HandCategory.FullHouse:
      return `${cap(plur(hi))} full of ${plur(tb[1] ?? 0)}`;
    case HandCategory.Flush:
      return `${cap(sing(hi))}-high flush`;
    case HandCategory.Straight:
      return `${cap(sing(hi))}-high straight`;
    case HandCategory.Trips:
      return `Three ${plur(hi)}`;
    case HandCategory.TwoPair:
      return `${cap(plur(hi))} and ${plur(tb[1] ?? 0)}`;
    case HandCategory.Pair:
      return `Pair of ${plur(hi)}`;
    default:
      return `${cap(sing(hi))}-high`;
  }
}

/** 0-based rank value: '2'→0 … 'A'→12. */
export function rankValue(card: Card): number {
  const idx = RANKS.indexOf(card[0]!);
  if (idx < 0) throw new Error(`bad card rank: ${card}`);
  return idx;
}

function suitOf(card: Card): string {
  const s = card[1]!;
  if (SUITS.indexOf(s) < 0) throw new Error(`bad card suit: ${card}`);
  return s;
}

/** A fresh, ordered 52-card deck. */
export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

/** Compare two evals. >0 if a beats b, <0 if b beats a, 0 if a true tie
 *  (chop). Category first, then tiebreak ranks element-wise. */
export function compareEval(a: HandEval, b: HandEval): number {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] ?? -1;
    const bv = b.tiebreak[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// --- 5-card evaluation -------------------------------------------------

/** Detect the highest straight in a set of distinct rank values (0..12).
 *  Returns the high-card rank of the straight (e.g. 4 for a 5-high wheel,
 *  12 for a Broadway), or -1 if none. Handles the A-2-3-4-5 wheel where
 *  the Ace plays low. */
function straightHigh(distinctRanks: number[]): number {
  const present = new Set(distinctRanks);
  // Ace (12) also plays as low (-1) for the wheel.
  if (present.has(12)) present.add(-1);
  const sorted = [...present].sort((x, y) => y - x); // high → low
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]! - 1) {
      run++;
      // sorted[i] is the lowest of the 5 consecutive ⇒ high card is +4.
      if (run >= 5) return sorted[i]! + 4;
    } else {
      run = 1;
    }
  }
  return -1;
}

/** Evaluate exactly 5 cards. */
export function evaluate5(cards: Card[]): HandEval {
  if (cards.length !== 5) throw new Error("evaluate5 needs 5 cards");
  const ranks = cards.map(rankValue).sort((a, b) => b - a); // high → low
  const suits = cards.map(suitOf);
  const isFlush = suits.every(s => s === suits[0]);

  // Count rank multiplicities.
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Groups sorted by (count desc, rank desc) → drives pair/trips/quads tiebreaks.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const distinct = [...counts.keys()];
  const sHigh = distinct.length === 5 ? straightHigh(ranks) : -1;
  const isStraight = sHigh >= 0;

  if (isStraight && isFlush) {
    return { category: HandCategory.StraightFlush, tiebreak: [sHigh], cards };
  }
  if (groups[0]![1] === 4) {
    const quad = groups[0]![0];
    const kicker = groups[1]![0];
    return { category: HandCategory.Quads, tiebreak: [quad, kicker], cards };
  }
  if (groups[0]![1] === 3 && groups[1]![1] === 2) {
    return { category: HandCategory.FullHouse, tiebreak: [groups[0]![0], groups[1]![0]], cards };
  }
  if (isFlush) {
    return { category: HandCategory.Flush, tiebreak: ranks, cards };
  }
  if (isStraight) {
    return { category: HandCategory.Straight, tiebreak: [sHigh], cards };
  }
  if (groups[0]![1] === 3) {
    const trip = groups[0]![0];
    const kickers = groups.slice(1).map(g => g[0]).sort((a, b) => b - a);
    return { category: HandCategory.Trips, tiebreak: [trip, ...kickers], cards };
  }
  if (groups[0]![1] === 2 && groups[1]![1] === 2) {
    const hiPair = Math.max(groups[0]![0], groups[1]![0]);
    const loPair = Math.min(groups[0]![0], groups[1]![0]);
    const kicker = groups[2]![0];
    return { category: HandCategory.TwoPair, tiebreak: [hiPair, loPair, kicker], cards };
  }
  if (groups[0]![1] === 2) {
    const pair = groups[0]![0];
    const kickers = groups.slice(1).map(g => g[0]).sort((a, b) => b - a);
    return { category: HandCategory.Pair, tiebreak: [pair, ...kickers], cards };
  }
  return { category: HandCategory.HighCard, tiebreak: ranks, cards };
}

/** All 5-card combinations of an array. */
function combinations5<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  const n = arr.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) out.push([arr[a]!, arr[b]!, arr[c]!, arr[d]!, arr[e]!]);
  return out;
}

/** Best 5-card hand out of 5, 6, or 7 cards. */
export function evaluate7(cards: Card[]): HandEval {
  if (cards.length < 5 || cards.length > 7) throw new Error("evaluate7 needs 5–7 cards");
  if (cards.length === 5) return evaluate5(cards);
  let best: HandEval | null = null;
  for (const combo of combinations5(cards)) {
    const ev = evaluate5(combo);
    if (!best || compareEval(ev, best) > 0) best = ev;
  }
  return best!;
}

/** Given a set of contenders (seat → 7 cards), return the seat indices of
 *  the winner(s). A chop returns all tied seats. */
export function bestOf(hands: { seat: number; cards: Card[] }[]): number[] {
  if (hands.length === 0) return [];
  const evals = hands.map(h => ({ seat: h.seat, ev: evaluate7(h.cards) }));
  let best = evals[0]!;
  for (const e of evals) if (compareEval(e.ev, best.ev) > 0) best = e;
  return evals.filter(e => compareEval(e.ev, best.ev) === 0).map(e => e.seat);
}

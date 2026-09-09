// Gesture classifier + hold tests. Run: yarn tsx --test src/gestures.test.ts
// Also doubles as the "synthetic hands" recipe docs/GESTURES.md refers to:
// a 21-point hand normalized to the capture, fingertips folded toward the
// wrist for a fist.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GestureEngine, classify, fingerExt, isFist } from "./gestures.js";

type Pt = { x: number; y: number };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Build a hand (normalized capture coords, y down). Wrist at (0.5, 0.6),
 *  knuckles along y=0.5. `curl[i]` per finger (index, middle, ring, pinky):
 *  1 = folded tight into the palm, 0 = straight up, in between = half. */
function hand(curl: [number, number, number, number]): Pt[] {
  const lm: Pt[] = new Array(21).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
  lm[0] = { x: 0.5, y: 0.6 };
  // Thumb along the side of the palm.
  lm[1] = { x: 0.45, y: 0.58 };
  lm[2] = { x: 0.43, y: 0.55 };
  lm[3] = { x: 0.42, y: 0.52 };
  lm[4] = { x: 0.42, y: 0.5 };
  const xs = [0.44, 0.48, 0.52, 0.56];
  for (let f = 0; f < 4; f++) {
    const base = 5 + f * 4;
    const x = xs[f]!;
    const c = curl[f]!;
    lm[base] = { x, y: 0.5 }; // MCP
    lm[base + 1] = { x, y: 0.47 }; // PIP
    // Straight: DIP 0.44, tip 0.38. Folded: DIP 0.5, tip 0.55 (down by the palm).
    lm[base + 2] = { x, y: 0.44 + c * 0.06 };
    lm[base + 3] = { x, y: 0.38 + c * 0.17 };
  }
  return lm;
}
const wire = (lm: Pt[]) => ({ chirality: "R", lm: lm.map(p => [p.x, p.y]) });

test("a tight fist is a fist; a thumb-only or half-curled hand is nothing", () => {
  const fist = hand([1, 1, 1, 1]);
  assert.equal(isFist(fist), true);
  assert.equal(classify(fingerExt(fist), isFist(fist)), "fist");

  // Index only half folded: not tight enough for a fist, and the old
  // "<= 1 finger extended" rule must not rescue it into one.
  const half = hand([0.55, 1, 1, 1]);
  assert.equal(isFist(half), false);
  assert.notEqual(classify(fingerExt(half), isFist(half)), "fist");

  // One finger straight up: never a fist (it's an L with the thumb out).
  const one = hand([0, 1, 1, 1]);
  assert.equal(isFist(one), false);
  assert.notEqual(classify(fingerExt(one), isFist(one)), "fist");
});

test("horns / claw / L still classify", () => {
  const horns = hand([0, 1, 1, 0]);
  assert.equal(classify(fingerExt(horns), isFist(horns)), "horns");
  // The synthetic thumb sticks out (thumbOut true), so index+middle = claw.
  const claw = hand([0, 0, 1, 1]);
  assert.equal(classify(fingerExt(claw), isFist(claw)), "claw");
  const L = hand([0, 1, 1, 1]);
  // index + thumb -> L needs the thumb out AND count 2: fingerExt gives it.
  assert.equal(classify(fingerExt(L), isFist(L)), fingerExt(L)[0] ? "L" : "none");
});

function engine() {
  const out: { type: string; from: string; kind: string }[] = [];
  const e = new GestureEngine(m => out.push({ type: m.type, from: m.from, kind: m.kind }));
  e.setGeometry({
    vw: 1280,
    vh: 720,
    cams: [{ peerId: "guest1", rect: { x: 0, y: 0, w: 1280, h: 720 }, videoW: 1280, videoH: 720 }],
    at: Date.now(),
  });
  return { e, out };
}

test("a fist must hold ~300ms before the first eth, then keeps firing", async () => {
  const { e, out } = engine();
  const fist = [wire(hand([1, 1, 1, 1]))];
  e.handleHands(fist, 1280, 720);
  await sleep(100);
  e.handleHands(fist, 1280, 720);
  assert.equal(out.length, 0, "a fist seen for 100ms must not fire");
  await sleep(250);
  e.handleHands(fist, 1280, 720);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { type: "gesture_release", from: "guest1", kind: "eth" });
  await sleep(170);
  e.handleHands(fist, 1280, 720);
  assert.equal(out.length, 2, "held fist keeps releasing at EMIT_INTERVAL");
});

test("a fist that flickers away resets its hold", async () => {
  const { e, out } = engine();
  const fist = [wire(hand([1, 1, 1, 1]))];
  e.handleHands(fist, 1280, 720);
  await sleep(200);
  e.handleHands([], 1280, 720); // detector lost it for a frame
  await sleep(50);
  e.handleHands(fist, 1280, 720);
  await sleep(200);
  e.handleHands(fist, 1280, 720);
  assert.equal(out.length, 0, "200ms + gap + 200ms is two short holds, not one long one");
});

test("hands over no camera do nothing", async () => {
  const { e, out } = engine();
  e.setGeometry({
    vw: 1280,
    vh: 720,
    cams: [{ peerId: "guest1", rect: { x: 0, y: 0, w: 200, h: 200 }, videoW: 1280, videoH: 720 }],
    at: Date.now(),
  });
  const fist = [wire(hand([1, 1, 1, 1]))]; // palm at ~(640,360) — outside the 200x200 window
  e.handleHands(fist, 1280, 720);
  await sleep(350);
  e.handleHands(fist, 1280, 720);
  assert.equal(out.length, 0);
});

// Per-room server-authoritative Putt-Putt (turn-based mini golf) state.
//
// Up to 4 seats, each a colored ball. Unlike pong/worm this is NOT a
// continuous co-op sim — it's turn-based: players sit in a lobby, someone
// hits Start, then everyone plays the same short course one shot at a
// time. On your turn you set a shot vector (the client's pull-back
// slingshot resolves to an initial velocity); the relay simulates your
// ball rolling — friction, wall bounces, cup capture — broadcasting a
// fresh snapshot every physics tick until it comes to rest, then the turn
// passes to the next player who hasn't holed out this hole. When everyone
// has holed out (or hit the stroke cap) the course advances to the next
// hole after a short pause. After the last hole the lowest total strokes
// wins. Not persisted — matches die with the relay restart, by design
// (live moments between guests, like pong/worm, not durable state).

export const FIELD_W = 420;
export const FIELD_H = 620;
export const BALL_R = 8;
export const CUP_R = 15;
export const TICK_HZ = 30;
export const TICK_MS = Math.round(1000 / TICK_HZ);
export const MAX_PLAYERS = 4;
// Per-tick simulation is sub-stepped so a fast ball can't tunnel through a
// thin wall (max move per substep stays well under the 16px wall thickness).
// Six substeps keeps the per-substep move under the wall thickness even at
// the downhill-boosted max roll speed.
const SUBSTEPS = 6;
// Friction is modelled in two parts, like a real ball on grass:
//  • FRICTION — a viscous bleed (force ∝ speed) for a smooth high-speed slowdown.
//  • KINETIC_FRICTION — a constant per-tick deceleration (Coulomb rolling
//    resistance) that does NOT shrink with speed, so the ball always reaches a
//    full stop in finite time instead of creeping.
//  • STATIC_FRICTION — the most a stationary ball will resist: if the downhill
//    pull (SLOPE_ACCEL × slope) is below this, a slow ball sticks; only a steep
//    enough slope can break it loose and keep it rolling. This is what stops
//    the "endless ooze down a gentle grade".
const FRICTION = 0.955; // velocity retained per tick (viscous component)
const KINETIC_FRICTION = 0.08; // constant decel while rolling (px/tick²) — small;
//                                just enough to out-bleed the gentle-tilt pull
//                                and guarantee a finite stop without shortening
//                                a normal putt.
const STATIC_FRICTION = 0.06; // max downhill pull a resting ball holds (px/tick²)
const MIN_SPEED = 0.5; // below this a ball is slow enough to test for sticking
const MAX_POWER = 24; // cap on a shot's initial speed (px/tick)
const MAX_ROLL_SPEED = 30; // clamp so a long downhill can't fling the ball through a wall
const WALL_REST = 0.72; // restitution off walls + borders
const CAPTURE_SPEED = 7.2; // a ball over the cup faster than this lips out
const MAX_STROKES = 8; // stroke cap per hole — auto-hole-out so play never stalls
const HOLE_PAUSE_MS = 2600; // intermission between holes (shows the result)
// Gravity along the surface: the ball accelerates downhill by SLOPE_ACCEL ×
// (local slope) per tick. Slope is the height gradient (rise per px), so a
// 5% grade adds ~0.05·SLOPE_ACCEL px/tick² — it speeds the ball up rolling
// downhill and bleeds it off going uphill. Only applied while rolling.
// Deliberately gentle: a subtle break/drift, not a luge run.
const SLOPE_ACCEL = 0.55;
// A single shot is force-stopped after this many ticks — a safety valve so a
// sustained downhill between two walls can't roll forever.
const MAX_ROLL_TICKS = 480;

// Color per seat slot — the classic slop accents, mapped client-side to
// the matching --slop-* CSS var.
const SLOT_COLORS: PuttColor[] = ["cyan", "magenta", "lime", "purple"];

export type PuttColor = "cyan" | "magenta" | "lime" | "purple";
export type PuttVec = { x: number; y: number };
// Axis-aligned rectangle obstacle. Field borders are implicit (the ball
// bounces off the field edges); these are the internal walls.
export type PuttWall = { x: number; y: number; w: number; h: number };
// A rounded bump (h > 0 = hill) or dip (h < 0 = valley) of radius r centered
// at (x, y). Contributes a smooth squared-falloff hump to the height field.
export type PuttMound = { x: number; y: number; r: number; h: number };
// Per-hole topography: a linear tilt across the green (tiltX/tiltY are slope
// fractions — height rises by tiltX per px in +x, tiltY per px in +y) plus a
// set of mounds/dips. Height units are arbitrary; only the gradient matters
// for physics and only the relative range matters for the color bands.
export type PuttTerrain = { tiltX: number; tiltY: number; mounds: PuttMound[] };
export type PuttHole = { par: number; tee: PuttVec; cup: PuttVec; walls: PuttWall[]; terrain: PuttTerrain };

// waiting = lobby (join/leave/start). aiming = the `turn` player sets a
// shot. rolling = the active ball is in motion (no input). holed = every
// player finished the hole; brief pause before the next. ended = course
// over, totals shown.
export type PuttStatus = "waiting" | "aiming" | "rolling" | "holed" | "ended";

export type PuttPlayer = {
  slot: number; // 0..MAX_PLAYERS-1
  ownerKey: string;
  handle: string;
  color: PuttColor;
  /** Current ball position (in field units). */
  ball: PuttVec;
  /** Strokes taken per hole, indexed by hole. 0 until the player tees off. */
  strokes: number[];
  /** Holed-out (or stroke-capped) per hole. */
  done: boolean[];
};

export type PuttSnapshot = {
  /** Indexed by slot; null = open seat. Length MAX_PLAYERS. */
  players: (PuttPlayer | null)[];
  status: PuttStatus;
  /** Current hole index (0-based). */
  hole: number;
  /** Slot of the player whose turn it is, or null (waiting/ended). */
  turn: number | null;
  /** ms-since-epoch to advance from "holed" to the next hole. */
  holeDoneAt: number;
  /** Slot with the lowest total at course end, or null. */
  winner: number | null;
  /** Simulation step counter — bumps each physics tick so clients can tell
   *  a rolling update (interpolate) from a structural change (snap). */
  tick: number;
  /** Whole course + physics constants, shipped so clients don't keep them
   *  in sync. Small enough (3 holes) to send every snapshot. */
  course: {
    holes: PuttHole[];
    field: { w: number; h: number; ballR: number; cupR: number; maxStrokes: number; maxPower: number };
  };
};

type Listener = (snapshot: PuttSnapshot) => void;

// --- The 3-hole course ------------------------------------------------------
// Hand-designed in field units (420×620, portrait). Tee at the bottom, cup
// near the top. Walls are partial obstacles that force a curve/bank shot.
function buildCourse(): PuttHole[] {
  return [
    {
      // Hole 1 — gentle right-side detour around a left-anchored wall, with a
      // mild downhill toward the cup (the green falls away to the top) plus a
      // hill on the right that nudges a banked ball back toward center.
      par: 2,
      tee: { x: 210, y: 545 },
      cup: { x: 230, y: 95 },
      walls: [{ x: 40, y: 300, w: 220, h: 16 }],
      terrain: { tiltX: 0, tiltY: 0.05, mounds: [{ x: 340, y: 380, r: 130, h: 26 }] },
    },
    {
      // Hole 2 — a dogleg: bank off the walls to reach the top-right cup. The
      // green tilts gently to the right so a straight shot drifts toward the
      // wall; a dip sits in the elbow to gather a well-placed ball.
      par: 3,
      tee: { x: 90, y: 545 },
      cup: { x: 330, y: 100 },
      walls: [
        { x: 150, y: 360, w: 16, h: 200 },
        { x: 150, y: 200, w: 220, h: 16 },
      ],
      terrain: { tiltX: 0.04, tiltY: 0, mounds: [{ x: 90, y: 150, r: 110, h: -22 }] },
    },
    {
      // Hole 3 — split the gap or go around a central box. The whole green
      // runs uphill to the cup (you need extra pace), and a hill behind the
      // box punishes anyone who skirts it too tight.
      par: 2,
      tee: { x: 210, y: 550 },
      cup: { x: 210, y: 95 },
      walls: [{ x: 160, y: 270, w: 100, h: 70 }],
      terrain: { tiltX: 0, tiltY: -0.055, mounds: [{ x: 210, y: 180, r: 120, h: 24 }] },
    },
  ];
}

// Height of the terrain at a point: linear tilt across the green plus each
// mound's squared-falloff hump. Pure — shared shape with the client renderer.
function puttHeightAt(t: PuttTerrain, x: number, y: number): number {
  let h = t.tiltX * (x - FIELD_W / 2) + t.tiltY * (y - FIELD_H / 2);
  for (const m of t.mounds) {
    const d = Math.hypot(x - m.x, y - m.y);
    if (d < m.r) {
      const k = 1 - d / m.r;
      h += m.h * k * k;
    }
  }
  return h;
}

// Local slope (height gradient) via central finite differences. The ball
// accelerates along the negative of this (downhill).
function puttSlopeAt(t: PuttTerrain, x: number, y: number): PuttVec {
  const e = 2;
  return {
    x: (puttHeightAt(t, x + e, y) - puttHeightAt(t, x - e, y)) / (2 * e),
    y: (puttHeightAt(t, x, y + e) - puttHeightAt(t, x, y - e)) / (2 * e),
  };
}

function dist2(a: PuttVec, b: PuttVec): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export class Putt {
  private readonly holes: PuttHole[] = buildCourse();
  private snapshot: PuttSnapshot = {
    players: new Array(MAX_PLAYERS).fill(null),
    status: "waiting",
    hole: 0,
    turn: null,
    holeDoneAt: 0,
    winner: null,
    tick: 0,
    course: {
      holes: this.holes,
      field: { w: FIELD_W, h: FIELD_H, ballR: BALL_R, cupR: CUP_R, maxStrokes: MAX_STROKES, maxPower: MAX_POWER },
    },
  };
  // Active ball velocity — internal, never serialized; clients read ball
  // positions off the snapshot and render directly.
  private vel: PuttVec = { x: 0, y: 0 };
  // Ticks the current shot has been rolling — drives the runaway safety valve.
  private rollTicks = 0;
  private listeners: Listener[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  current(): { state: PuttSnapshot } {
    return { state: this.snapshot };
  }

  /** Claim the first open seat. Idempotent — re-claiming returns your slot.
   *  Only allowed in the lobby ("waiting") or after a course ends; mid-round
   *  the roster is locked. Returns the slot index, or null if unavailable. */
  claim(ownerKey: string, handle: string): number | null {
    if (!ownerKey) return null;
    const existing = this.findSlot(ownerKey);
    if (existing !== null) return existing;
    if (this.snapshot.status !== "waiting" && this.snapshot.status !== "ended") return null;
    const slot = this.snapshot.players.findIndex(p => p === null);
    if (slot === -1) return null;
    this.snapshot.players[slot] = {
      slot,
      ownerKey,
      handle,
      color: SLOT_COLORS[slot] ?? "cyan",
      ball: { ...this.teeFor(0) },
      strokes: new Array(this.holes.length).fill(0),
      done: new Array(this.holes.length).fill(false),
    };
    this.notify();
    return slot;
  }

  /** Drop the caller's seat. Works any time (covers WS disconnect mid-round):
   *  if the leaver was the active player their turn passes; if the lobby
   *  empties the game resets to waiting. Returns true if a seat was freed. */
  release(ownerKey: string): boolean {
    const slot = this.findSlot(ownerKey);
    if (slot === null) return false;
    const wasTurn = this.snapshot.turn === slot;
    this.snapshot.players[slot] = null;

    const anyPlayers = this.snapshot.players.some(p => p);
    if (!anyPlayers) {
      this.resetToLobby();
      this.notify();
      return true;
    }
    if (this.snapshot.status === "rolling" && wasTurn) {
      // The active shooter bailed mid-roll — stop the ball and pass on.
      this.vel = { x: 0, y: 0 };
      this.advanceTurn();
    } else if (this.snapshot.status === "aiming" && wasTurn) {
      this.advanceTurn();
    }
    this.notify();
    return true;
  }

  /** Begin a round from the lobby. Seated players only; needs ≥1 seat and
   *  status "waiting". Resets every scorecard and tees up hole 0. */
  start(ownerKey: string): boolean {
    if (this.findSlot(ownerKey) === null) return false;
    if (this.snapshot.status !== "waiting") return false;
    if (!this.snapshot.players.some(p => p)) return false;
    this.snapshot.hole = 0;
    this.snapshot.winner = null;
    this.snapshot.holeDoneAt = 0;
    for (const p of this.snapshot.players) {
      if (!p) continue;
      p.strokes = new Array(this.holes.length).fill(0);
      p.done = new Array(this.holes.length).fill(false);
    }
    this.placeBallsAtTee(0);
    this.snapshot.status = "aiming";
    this.snapshot.turn = this.firstTurnSlot();
    this.snapshot.tick += 1;
    this.notify();
    return true;
  }

  /** Take the active player's shot. `vx`/`vy` is the desired initial
   *  velocity (the client's slingshot already resolved direction + power);
   *  the relay clamps its magnitude and starts the roll. Only the player
   *  whose turn it is, while "aiming", can shoot. Returns true on success. */
  shoot(ownerKey: string, vx: number, vy: number): boolean {
    if (this.snapshot.status !== "aiming") return false;
    const slot = this.findSlot(ownerKey);
    if (slot === null || slot !== this.snapshot.turn) return false;
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return false;
    const p = this.snapshot.players[slot];
    if (!p) return false;
    let speed = Math.hypot(vx, vy);
    if (speed < 0.01) return false; // ignore a dead tap
    if (speed > MAX_POWER) {
      const k = MAX_POWER / speed;
      vx *= k;
      vy *= k;
      speed = MAX_POWER;
    }
    this.vel = { x: vx, y: vy };
    this.rollTicks = 0;
    p.strokes[this.snapshot.hole] = (p.strokes[this.snapshot.hole] ?? 0) + 1;
    this.snapshot.status = "rolling";
    this.ensureTicker();
    this.notify();
    return true;
  }

  /** Reset to the lobby (keeping seats + clearing scores). Seated players
   *  only — the "Play Again" button after a course ends hits this. */
  reset(ownerKey: string): boolean {
    if (this.findSlot(ownerKey) === null) return false;
    this.resetToLobby();
    this.notify();
    return true;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Tear down the physics interval. Room calls this on hibernate. */
  dispose(): void {
    this.stopTicker();
    this.listeners = [];
  }

  // --- internals ------------------------------------------------------------

  private findSlot(ownerKey: string): number | null {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (this.snapshot.players[i]?.ownerKey === ownerKey) return i;
    }
    return null;
  }

  private resetToLobby(): void {
    this.stopTicker();
    this.vel = { x: 0, y: 0 };
    this.snapshot.status = "waiting";
    this.snapshot.hole = 0;
    this.snapshot.turn = null;
    this.snapshot.winner = null;
    this.snapshot.holeDoneAt = 0;
    for (const p of this.snapshot.players) {
      if (!p) continue;
      p.strokes = new Array(this.holes.length).fill(0);
      p.done = new Array(this.holes.length).fill(false);
      p.ball = { ...this.teeFor(0) };
    }
  }

  /** The tee position for a hole, with a safe fallback (the course always
   *  has holes, but this keeps the indexed access total-typed). */
  private teeFor(hole: number): PuttVec {
    return this.holes[hole]?.tee ?? { x: FIELD_W / 2, y: FIELD_H - 60 };
  }

  private placeBallsAtTee(hole: number): void {
    const tee = this.teeFor(hole);
    for (const p of this.snapshot.players) {
      if (p) p.ball = { ...tee };
    }
  }

  /** Lowest seated slot not yet done on the current hole, or null. */
  private firstTurnSlot(): number | null {
    const hole = this.snapshot.hole;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = this.snapshot.players[i];
      if (p && !p.done[hole]) return i;
    }
    return null;
  }

  /** Pass play to the next eligible player this hole; if none remain the
   *  hole is complete. Called after a ball comes to rest or a leaver bails. */
  private advanceTurn(): void {
    const hole = this.snapshot.hole;
    const from = this.snapshot.turn ?? -1;
    for (let step = 1; step <= MAX_PLAYERS; step++) {
      const i = (from + step) % MAX_PLAYERS;
      const p = this.snapshot.players[i];
      if (p && !p.done[hole]) {
        this.snapshot.turn = i;
        this.snapshot.status = "aiming";
        this.stopTicker(); // no motion while aiming
        return;
      }
    }
    // Everyone's done with this hole.
    this.completeHole();
  }

  private completeHole(): void {
    this.vel = { x: 0, y: 0 };
    if (this.snapshot.hole >= this.holes.length - 1) {
      this.endCourse();
      return;
    }
    // Pause on the finished hole, then a tick advances us to the next one.
    this.snapshot.status = "holed";
    this.snapshot.turn = null;
    this.snapshot.holeDoneAt = Date.now() + HOLE_PAUSE_MS;
    this.ensureTicker();
  }

  private endCourse(): void {
    this.snapshot.status = "ended";
    this.snapshot.turn = null;
    this.snapshot.holeDoneAt = 0;
    this.snapshot.winner = this.lowestTotalSlot();
    this.stopTicker();
  }

  private lowestTotalSlot(): number | null {
    let best: number | null = null;
    let bestTotal = Infinity;
    for (const p of this.snapshot.players) {
      if (!p) continue;
      const total = p.strokes.reduce((a, b) => a + b, 0);
      if (total < bestTotal) {
        bestTotal = total;
        best = p.slot;
      }
    }
    return best;
  }

  private ensureTicker(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicker(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private tick(): void {
    if (this.snapshot.status === "holed") {
      if (Date.now() >= this.snapshot.holeDoneAt) {
        this.advanceHole();
      } else {
        this.notify(); // keep the countdown live for clients
      }
      return;
    }
    if (this.snapshot.status !== "rolling") {
      this.stopTicker();
      return;
    }
    this.stepBall();
    this.snapshot.tick += 1;
    this.notify();
  }

  private advanceHole(): void {
    this.snapshot.hole += 1;
    this.placeBallsAtTee(this.snapshot.hole);
    this.snapshot.holeDoneAt = 0;
    this.snapshot.turn = this.firstTurnSlot();
    this.snapshot.status = "aiming";
    this.snapshot.tick += 1;
    this.stopTicker();
    this.notify();
  }

  /** Advance the active ball one tick: sub-stepped motion with border + wall
   *  collisions and cup capture, then friction + rest check. */
  private stepBall(): void {
    const hole = this.holes[this.snapshot.hole];
    if (!hole) return;
    const slot = this.snapshot.turn;
    if (slot === null) return;
    const p = this.snapshot.players[slot];
    if (!p) return;

    let holed = false;
    for (let s = 0; s < SUBSTEPS && !holed; s++) {
      // Gravity along the slope: accelerate downhill (negative gradient).
      const slope = puttSlopeAt(hole.terrain, p.ball.x, p.ball.y);
      this.vel.x -= (SLOPE_ACCEL / SUBSTEPS) * slope.x;
      this.vel.y -= (SLOPE_ACCEL / SUBSTEPS) * slope.y;
      p.ball.x += this.vel.x / SUBSTEPS;
      p.ball.y += this.vel.y / SUBSTEPS;
      this.resolveBorders(p.ball);
      for (const w of hole.walls) this.resolveWall(p.ball, w);
      // Cup capture — a slow enough ball over the hole drops in.
      if (dist2(p.ball, hole.cup) <= CUP_R * CUP_R && Math.hypot(this.vel.x, this.vel.y) <= CAPTURE_SPEED) {
        p.ball = { ...hole.cup };
        holed = true;
      }
    }

    if (holed) {
      this.vel = { x: 0, y: 0 };
      p.done[this.snapshot.hole] = true;
      this.advanceTurn();
      return;
    }

    // Viscous bleed (smooth, speed-proportional).
    this.vel.x *= FRICTION;
    this.vel.y *= FRICTION;
    // Constant rolling resistance (Coulomb): subtract a fixed decel opposing
    // motion, capped so it can't reverse the ball. Guarantees a real stop.
    let speed = Math.hypot(this.vel.x, this.vel.y);
    if (speed > 0) {
      const dec = Math.min(speed, KINETIC_FRICTION);
      this.vel.x -= (this.vel.x / speed) * dec;
      this.vel.y -= (this.vel.y / speed) * dec;
      speed -= dec;
    }
    // Clamp so a long downhill run can't build enough speed to tunnel a wall.
    if (speed > MAX_ROLL_SPEED) {
      const k = MAX_ROLL_SPEED / speed;
      this.vel.x *= k;
      this.vel.y *= k;
      speed = MAX_ROLL_SPEED;
    }
    // Rest: a slow ball sticks UNLESS the local slope is too steep for static
    // friction to hold it (then it keeps rolling and accelerates downhill).
    // The runaway tick budget is a final safety net.
    const grad = puttSlopeAt(hole.terrain, p.ball.x, p.ball.y);
    const slopePull = SLOPE_ACCEL * Math.hypot(grad.x, grad.y);
    this.rollTicks += 1;
    if ((speed < MIN_SPEED && slopePull <= STATIC_FRICTION) || this.rollTicks >= MAX_ROLL_TICKS) {
      // Ball at rest. Stroke cap: if the player can't sink it, auto-finish
      // the hole so play never stalls.
      this.vel = { x: 0, y: 0 };
      if ((p.strokes[this.snapshot.hole] ?? 0) >= MAX_STROKES) p.done[this.snapshot.hole] = true;
      this.advanceTurn();
    }
  }

  private resolveBorders(b: PuttVec): void {
    if (b.x < BALL_R) {
      b.x = BALL_R;
      this.vel.x = Math.abs(this.vel.x) * WALL_REST;
    } else if (b.x > FIELD_W - BALL_R) {
      b.x = FIELD_W - BALL_R;
      this.vel.x = -Math.abs(this.vel.x) * WALL_REST;
    }
    if (b.y < BALL_R) {
      b.y = BALL_R;
      this.vel.y = Math.abs(this.vel.y) * WALL_REST;
    } else if (b.y > FIELD_H - BALL_R) {
      b.y = FIELD_H - BALL_R;
      this.vel.y = -Math.abs(this.vel.y) * WALL_REST;
    }
  }

  /** Circle-vs-AABB collision: if the ball overlaps the rect, push it back
   *  out along the nearest face and reflect the velocity off that normal. */
  private resolveWall(b: PuttVec, w: PuttWall): void {
    const nearestX = clamp(b.x, w.x, w.x + w.w);
    const nearestY = clamp(b.y, w.y, w.y + w.h);
    let dx = b.x - nearestX;
    let dy = b.y - nearestY;
    const d2 = dx * dx + dy * dy;
    if (d2 > BALL_R * BALL_R) return; // no contact

    if (d2 > 1e-6) {
      // Ball center outside the rect — normal points from the nearest face.
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      b.x = nearestX + nx * BALL_R;
      b.y = nearestY + ny * BALL_R;
      const vn = this.vel.x * nx + this.vel.y * ny;
      this.vel.x -= (1 + WALL_REST) * vn * nx;
      this.vel.y -= (1 + WALL_REST) * vn * ny;
    } else {
      // Center inside the rect (deep penetration) — eject along the axis of
      // least penetration.
      const left = b.x - w.x;
      const right = w.x + w.w - b.x;
      const top = b.y - w.y;
      const bottom = w.y + w.h - b.y;
      const min = Math.min(left, right, top, bottom);
      if (min === left) {
        b.x = w.x - BALL_R;
        this.vel.x = -Math.abs(this.vel.x) * WALL_REST;
      } else if (min === right) {
        b.x = w.x + w.w + BALL_R;
        this.vel.x = Math.abs(this.vel.x) * WALL_REST;
      } else if (min === top) {
        b.y = w.y - BALL_R;
        this.vel.y = -Math.abs(this.vel.y) * WALL_REST;
      } else {
        b.y = w.y + w.h + BALL_R;
        this.vel.y = Math.abs(this.vel.y) * WALL_REST;
      }
    }
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.snapshot);
      } catch {
        /* ignore */
      }
    }
  }
}

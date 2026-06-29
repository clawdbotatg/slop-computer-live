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
const STATIC_FRICTION = 0.12; // max downhill pull a resting ball holds (px/tick²)
const MIN_SPEED = 0.6; // below this a ball is slow enough to test for sticking
// Sand traps (bunkers): a ball whose center is over sand meets far heavier
// resistance — it digs in, slows hard, and buries (settles fast). No penalty,
// just sticky/slow. These replace the grass FRICTION/KINETIC for that tick.
const SAND_FRICTION = 0.8; // velocity retained per tick in sand (vs 0.955 grass)
const SAND_KINETIC = 0.4; // constant decel in sand (vs 0.08 grass) — bites hard
const SAND_STICK_SPEED = 1.8; // a ball this slow in sand just buries and stops
// Water hazard penalty: a ball that crosses the shoreline costs one extra
// stroke and is returned to the spot it was struck from this stroke
// (stroke-and-distance), not the bank and not the tee.
const WATER_PENALTY = 1;
// Settle backstop: if the ball crawls below SETTLE_SPEED for SETTLE_TICKS in a
// row it's force-stopped. Kills any residual imperceptible creep (a ball that
// reaches a tiny terminal velocity on a slope and never quite sticks) without
// affecting a real putt, which either stops via MIN_SPEED or is still moving
// fast. A genuine roll-off a steep mound flank is well above SETTLE_SPEED.
const SETTLE_SPEED = 1.1;
const SETTLE_TICKS = 30;
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
// Optional r0 (< r) gives a flat top/bottom of that radius — a raised plateau
// (or flat-bottomed pit) — with the squared-falloff ramp running from r0 out
// to the rim r. r0 omitted/0 → a plain squared-falloff hump (original shape).
// Optional wob warps the rim by sine harmonics of the bearing so the outline is
// wavy/lobed rather than a perfect circle (see wavyRadius); omitted → default.
export type PuttMound = { x: number; y: number; r: number; h: number; r0?: number; wob?: number };
// A hazard region — a circle (radius r at center x,y) or an axis-aligned rect
// (top-left x,y with size w,h). A hole carries arrays of each kind. WATER = a
// one-stroke penalty plus a return to where the shot was struck from
// (stroke-and-distance); SAND = heavy friction (sticky/slow), no penalty.
// Both are pure regions tested against the ball center.
export type PuttRegion =
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number };
// Per-hole topography: a linear tilt across the green (tiltX/tiltY are slope
// fractions — height rises by tiltX per px in +x, tiltY per px in +y) plus a
// set of mounds/dips. Height units are arbitrary; only the gradient matters
// for physics and only the relative range matters for the color bands.
export type PuttTerrain = { tiltX: number; tiltY: number; mounds: PuttMound[] };
// A spinning windmill obstacle: `blades` arms of length `bladeLen` (each a
// capsule of half-thickness `bladeW`) radiating from a solid hub (radius
// `hubR`) at (x,y), turning at `rpm` revolutions/min (signed → direction). The
// blade angle is a pure function of wall-clock time (see windmillAngle), so the
// relay's collision and every client's render stay in phase off Date.now()
// without shipping the angle each tick — same clock-sync trick as holeDoneAt.
// Clip a moving blade and you get swatted back; you have to time the gap.
export type PuttWindmill = {
  x: number;
  y: number;
  hubR: number;
  bladeLen: number;
  bladeW: number;
  blades: number;
  rpm: number;
};
export type PuttHole = {
  par: number;
  tee: PuttVec;
  cup: PuttVec;
  walls: PuttWall[];
  terrain: PuttTerrain;
  windmill?: PuttWindmill;
  /** Water hazards (one-stroke penalty + return to the pre-shot spot). */
  water?: PuttRegion[];
  /** Sand traps / bunkers (heavy friction, no penalty). */
  sand?: PuttRegion[];
};

// Every match plays a course generated *deterministically from its name* — the
// name IS the seed. "Green Links" always yields the same nine holes, on the
// relay and (since the holes ship in the snapshot) on every client. Rename the
// course in the lobby and you get a fresh, reproducible nine.
export const HOLE_COUNT = 9;

// Blade base angle (radians) at a given wall-clock time. Shared verbatim with
// the client renderer so the drawn sails line up with the server's collision.
// We REDUCE to [0, 2π): at raw scale the angle is billions of radians, which
// the client's canvas transform can't hold — it loses all precision, so every
// blade collapses onto one frozen direction. cos/sin of the reduced angle equal
// cos/sin of the full angle, so the server's collision is unchanged.
export function windmillAngle(wm: PuttWindmill, nowMs: number): number {
  const revs = (nowMs / 60000) * wm.rpm;
  return (revs - Math.floor(revs)) * Math.PI * 2;
}

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
  /** The course name — also the seed the nine holes were generated from.
   *  Shown + editable in the lobby; editing it regenerates the course. */
  courseName: string;
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
   *  in sync. Small enough (a handful of holes) to send every snapshot. */
  course: {
    holes: PuttHole[];
    field: { w: number; h: number; ballR: number; cupR: number; maxStrokes: number; maxPower: number };
  };
};

type Listener = (snapshot: PuttSnapshot) => void;

// --- Seeded course generation -----------------------------------------------
// The whole course is a deterministic function of the course *name*. Same name
// → same nine holes, byte-for-byte, on the relay and every client (the client
// just renders the holes shipped in the snapshot — it never runs the generator).

// String → a fast deterministic float stream in [0,1). xmur3 hashes the seed to
// a 32-bit state, mulberry32 turns that into a PRNG. Both are well-known public
// snippets chosen for being tiny, pure, and reproducible across engines.
function makeRng(seedStr: string): () => number {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^= h >>> 16) >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const rRange = (r: Rng, lo: number, hi: number): number => lo + r() * (hi - lo);
const rInt = (r: Rng, lo: number, hi: number): number => Math.floor(rRange(r, lo, hi + 1));
const rChance = (r: Rng, p: number): boolean => r() < p;

// Two-part links names — adjective + noun, in the slop cyberdelic register. The
// initial pick is non-deterministic (Math.random) so each fresh lobby suggests
// a new one; once chosen, the name deterministically seeds the holes.
const NAME_ADJ = [
  "Green", "Whispering", "Cyber", "Royal", "Hidden", "Sunset", "Crystal", "Thunder",
  "Emerald", "Misty", "Iron", "Crimson", "Neon", "Velvet", "Wandering", "Phantom",
  "Glitch", "Pixel", "Chrome", "Acid", "Lunar", "Static", "Vapor", "Hollow",
] as const;
const NAME_NOUN = [
  "Links", "Pines", "Dunes", "Hollow", "Greens", "Hills", "Meadows", "Springs",
  "Ridge", "Glen", "Sands", "Shores", "Bluffs", "Cove", "Fairway", "Gardens",
  "Circuit", "Grid", "Mirage", "Reef", "Wastes", "Heights", "Run", "Drift",
] as const;
function randomCourseName(): string {
  const a = NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)];
  const n = NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)];
  return `${a} ${n}`;
}

// Nearest-point distance from (x,y) to an axis-aligned rect — used to keep
// generated walls/hazards a respectful distance off the tee and cup.
function rectDist(x: number, y: number, rx: number, ry: number, rw: number, rh: number): number {
  const nx = clamp(x, rx, rx + rw);
  const ny = clamp(y, ry, ry + rh);
  return Math.hypot(x - nx, y - ny);
}

// Clearance kept around the two fixed points so a hole is always *reachable*:
// nothing solid spawns on the tee, and the cup keeps an open collar so a ball
// arriving with the right pace can actually drop. This is the only "fairness"
// guard for now — no full solver — so holes can still be weird and hard, just
// not impossible.
const TEE_CLEAR = 48;
const CUP_CLEAR = 66;

// Generate one hole, seeded by the course name + hole index so each hole is
// independent yet fully reproducible.
function generateHole(seed: string, index: number): PuttHole {
  const r = makeRng(`${seed}#${index}`);
  const W = FIELD_W;
  const H = FIELD_H;
  const margin = 46;

  // Tee in the bottom band, cup in the top band, both with free lateral play.
  const tee: PuttVec = { x: rRange(r, margin, W - margin), y: rRange(r, H - 92, H - 54) };
  const cup: PuttVec = { x: rRange(r, margin, W - margin), y: rRange(r, 58, 132) };

  const clearOfEnds = (x: number, y: number, pad = 0): boolean =>
    Math.hypot(x - tee.x, y - tee.y) > TEE_CLEAR + pad && Math.hypot(x - cup.x, y - cup.y) > CUP_CLEAR + pad;

  // A windmill hole skips the generic walls and instead gets a brick base with
  // a central doorway the sails sweep across — the classic gauntlet. ~1 in 4.
  const hasWindmill = rChance(r, 0.26);
  const walls: PuttWall[] = [];
  let windmill: PuttWindmill | undefined;

  if (hasWindmill) {
    const wmX = rRange(r, 140, W - 140);
    const wmY = rRange(r, 250, 380);
    const gapHalf = rRange(r, 58, 80);
    const barH = 20;
    const barY = wmY - barH / 2;
    const leftW = wmX - gapHalf;
    const rightX = wmX + gapHalf;
    if (leftW > 12) walls.push({ x: 0, y: barY, w: leftW, h: barH });
    if (W - rightX > 12) walls.push({ x: rightX, y: barY, w: W - rightX, h: barH });
    windmill = {
      x: wmX,
      y: wmY,
      hubR: 7,
      bladeLen: rRange(r, 44, 56),
      bladeW: 5,
      blades: 4,
      rpm: rRange(r, 7, 11) * (rChance(r, 0.5) ? 1 : -1),
    };
  } else {
    // 0–4 free-standing bars/posts in the mid band (well clear of both end rows
    // so they can never box the tee or cup in).
    const wallCount = rInt(r, 0, 4);
    for (let i = 0; i < wallCount; i++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const horiz = rChance(r, 0.5);
        const w = horiz ? rRange(r, 70, 220) : rRange(r, 14, 18);
        const h = horiz ? rRange(r, 14, 18) : rRange(r, 70, 200);
        const x = rRange(r, 8, W - 8 - w);
        const y = rRange(r, 150, H - 200 - h);
        if (rectDist(tee.x, tee.y, x, y, w, h) < TEE_CLEAR) continue;
        if (rectDist(cup.x, cup.y, x, y, w, h) < CUP_CLEAR) continue;
        walls.push({ x, y, w, h });
        break;
      }
    }
  }

  // Mounds: 5–9 hills/dips/plateaus scattered anywhere — a dense, rolling
  // topography of highs and lows (they overlap into compound ridges and
  // hollows). Taller peaks + deeper dips than before so the height-banding
  // really reads. A tall hill that lands on the cup would seal it, so any rise
  // too near the pin is flipped to a dip (a gathering bowl — both fair and
  // pretty). Tall hills are widened a touch so a big rise isn't a thin spike.
  const mounds: PuttMound[] = [];
  const moundCount = rInt(r, 5, 9);
  for (let i = 0; i < moundCount; i++) {
    const x = rRange(r, 30, W - 30);
    const y = rRange(r, 56, H - 56);
    let isDip = rChance(r, 0.42);
    if (!isDip && Math.hypot(x - cup.x, y - cup.y) < CUP_CLEAR) isDip = true;
    const height = isDip ? -rRange(r, 12, 28) : rRange(r, 18, 48);
    // Bigger rises get a bigger footprint (radius grows with height) so the
    // steepest flank stays rollable rather than wall-like.
    const rad = isDip ? rRange(r, 50, 120) : rRange(r, 60, 100) + height * 1.1;
    const plateau = !isDip && rChance(r, 0.4);
    const r0 = plateau ? rad * rRange(r, 0.25, 0.45) : 0;
    mounds.push({ x, y, r: rad, h: height, r0, wob: rRange(r, 0.12, 0.24) });
  }
  // A gentle gathering bowl around the cup most of the time — gives a well-paced
  // approach somewhere to settle.
  if (rChance(r, 0.6)) {
    mounds.push({ x: cup.x, y: cup.y, r: rRange(r, 54, 70), h: -rRange(r, 10, 15) });
  }

  // Gentle global tilt for break. The physics has static-friction/creep guards,
  // so a modest grade just bends the line — it won't ooze a resting ball away.
  const terrain: PuttTerrain = {
    tiltX: rRange(r, -0.035, 0.035),
    tiltY: rRange(r, -0.045, 0.035),
    mounds,
  };

  // Water: ~half the holes get a pond or two. Always circular — the wavy-rim
  // circles read as real ponds; rectangular pools looked fake, so we never
  // generate them. Capped well under field width so a dry lane to the cup
  // always exists, and kept off the tee/cup collars.
  const water: PuttRegion[] = [];
  const waterCount = rChance(r, 0.5) ? rInt(r, 1, 2) : 0;
  for (let i = 0; i < waterCount; i++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const rad = rRange(r, 38, 60);
      const x = rRange(r, rad + 8, W - rad - 8);
      const y = rRange(r, 170, H - 170);
      if (!clearOfEnds(x, y, rad)) continue;
      water.push({ kind: "circle", x, y, r: rad });
      break;
    }
  }

  // Sand: ~half the holes get 1–2 bunkers. No penalty, so they may sit closer to
  // the pin than water — just not on it.
  const sand: PuttRegion[] = [];
  const sandCount = rChance(r, 0.5) ? rInt(r, 1, 2) : 0;
  for (let i = 0; i < sandCount; i++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const rad = rRange(r, 30, 55);
      const x = rRange(r, rad + 8, W - rad - 8);
      const y = rRange(r, 110, H - 130);
      if (Math.hypot(x - tee.x, y - tee.y) < TEE_CLEAR + rad) continue;
      if (Math.hypot(x - cup.x, y - cup.y) < CUP_R + BALL_R + 18 + rad * 0.4) continue;
      sand.push({ kind: "circle", x, y, r: rad });
      break;
    }
  }

  // Par scales with the trouble in the way + the raw length of the hole.
  const dist = Math.hypot(cup.x - tee.x, cup.y - tee.y);
  let par = dist > 510 ? 4 : 3;
  if (windmill) par += 1;
  if (water.length >= 1) par += 1;
  par = clamp(par, 2, 5);

  return {
    par,
    tee,
    cup,
    walls,
    terrain,
    windmill,
    water: water.length ? water : undefined,
    sand: sand.length ? sand : undefined,
  };
}

/** Build a full deterministic course from a name. */
function generateCourse(seed: string): PuttHole[] {
  const name = seed.trim() || "Slop Links";
  const holes: PuttHole[] = [];
  for (let i = 0; i < HOLE_COUNT; i++) holes.push(generateHole(name, i));
  return holes;
}

/** Trim/cap a user-supplied course name; fall back to a fresh random one. */
function sanitizeCourseName(raw: string): string {
  const trimmed = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return trimmed || randomCourseName();
}

// Organic-rim warp shared by mounds and hazard circles: a circle of radius r at
// (x,y) whose *effective* radius along bearing `theta` is warped by three sine
// harmonics, so its outline is wavy/lobed and never a perfect circle. The phases
// are hashed deterministically from the circle's own (x,y,r) — so the shape is
// stable and reproducible with no extra data, and (this is the point) IDENTICAL
// on the relay and every client. wob = wobble as a fraction of r (0 → a clean
// circle). |w| peaks ~1.07, so the rim spans roughly r·(1 ± 1.07·wob). Pure;
// mirrored byte-for-byte in the client (PuttWindow.tsx) so the rendered shoreline
// matches where the physics actually puts the hazard. KEEP THE TWO IN SYNC.
function wavyRadius(x: number, y: number, r: number, theta: number, wob: number): number {
  if (wob <= 0) return r;
  const tau = Math.PI * 2;
  const fr = (n: number) => n - Math.floor(n);
  const p1 = fr(Math.sin(x * 12.9898 + y * 4.1414 + r * 0.713) * 43758.5453) * tau;
  const p2 = fr(Math.sin(x * 39.346 + y * 11.135 + r * 9.917) * 24634.6345) * tau;
  const p3 = fr(Math.sin(x * 73.156 + y * 52.235 + r * 3.171) * 13734.2371) * tau;
  const w = 0.55 * Math.sin(2 * theta + p1) + 0.3 * Math.sin(3 * theta + p2) + 0.22 * Math.sin(5 * theta + p3);
  return r * (1 + wob * w);
}
const PUTT_MOUND_WOB = 0.18; // default mound rim wobble (organic hills/dips)
const HAZARD_WOB = 0.16; // water/sand rim wobble (a touch tamer than the mounds)

// Height of the terrain at a point: linear tilt across the green plus each
// mound's squared-falloff hump. Pure — shared shape with the client renderer.
function puttHeightAt(t: PuttTerrain, x: number, y: number): number {
  let h = t.tiltX * (x - FIELD_W / 2) + t.tiltY * (y - FIELD_H / 2);
  for (const m of t.mounds) {
    const dx = x - m.x;
    const dy = y - m.y;
    const d = Math.hypot(dx, dy);
    const r = wavyRadius(m.x, m.y, m.r, Math.atan2(dy, dx), m.wob ?? PUTT_MOUND_WOB);
    if (d >= r) continue;
    const r0 = Math.min(m.r0 ?? 0, r * 0.92); // keep the flat top inside the wavy rim
    if (d <= r0) {
      h += m.h; // flat plateau top / pit floor
    } else {
      // Squared-falloff ramp from the plateau edge (k=1) to the rim (k=0).
      // r0=0 collapses to the original (1 - d/r)² hump.
      const k = (r - d) / (r - r0);
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

// Is (x,y) inside a single hazard region? Tested against the ball center.
function regionHit(rg: PuttRegion, x: number, y: number): boolean {
  if (rg.kind === "circle") {
    const dx = x - rg.x;
    const dy = y - rg.y;
    // Wavy shoreline (matches the rendered outline), not a flat circle.
    const rr = wavyRadius(rg.x, rg.y, rg.r, Math.atan2(dy, dx), HAZARD_WOB);
    return dx * dx + dy * dy <= rr * rr;
  }
  return x >= rg.x && x <= rg.x + rg.w && y >= rg.y && y <= rg.y + rg.h;
}

function inAnyRegion(regions: PuttRegion[] | undefined, x: number, y: number): boolean {
  if (!regions) return false;
  for (const rg of regions) if (regionHit(rg, x, y)) return true;
  return false;
}

export class Putt {
  // Seed + holes are mutable: renaming the course in the lobby regenerates both.
  private courseName: string = randomCourseName();
  private holes: PuttHole[] = generateCourse(this.courseName);
  private snapshot: PuttSnapshot = {
    players: new Array(MAX_PLAYERS).fill(null),
    courseName: this.courseName,
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
  // The active ball's resting position at the moment the current shot was
  // struck. A ball that finds the water is returned here (stroke-and-distance)
  // rather than dropped on the bank. Transient single-shot state like `vel`
  // (only one ball ever rolls at a time), so it stays off the wire snapshot.
  private shotStart: PuttVec = { x: 0, y: 0 };
  // Ticks the current shot has been rolling — drives the runaway safety valve.
  private rollTicks = 0;
  // Consecutive ticks the ball has been crawling below SETTLE_SPEED — drives
  // the settle backstop that kills imperceptible creep.
  private slowTicks = 0;
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
    // Remember where the ball sat when struck — a watered shot returns here.
    this.shotStart = { x: p.ball.x, y: p.ball.y };
    this.rollTicks = 0;
    this.slowTicks = 0;
    p.strokes[this.snapshot.hole] = (p.strokes[this.snapshot.hole] ?? 0) + 1;
    this.snapshot.status = "rolling";
    this.ensureTicker();
    this.notify();
    return true;
  }

  /** Reset to the lobby (keeping seats + clearing scores). Seated players
   *  only — the "Play Again" button after a course ends hits this. Rolls a
   *  fresh random course so "again" means a new nine, not a replay. */
  reset(ownerKey: string): boolean {
    if (this.findSlot(ownerKey) === null) return false;
    this.resetToLobby();
    this.notify();
    return true;
  }

  /** Rename the course (and thereby reseed + regenerate the nine holes). Only
   *  in the lobby/after a course ends, and only by a seated player. Empty names
   *  fall back to a fresh random one. Returns true if the course changed. */
  rename(ownerKey: string, name: string): boolean {
    if (this.findSlot(ownerKey) === null) return false;
    if (this.snapshot.status !== "waiting" && this.snapshot.status !== "ended") return false;
    const next = sanitizeCourseName(name);
    this.loadCourse(next);
    // A rename after a course ended drops everyone back to the lobby for the
    // new layout (their old scorecard was for a different course).
    this.snapshot.status = "waiting";
    this.snapshot.hole = 0;
    this.snapshot.turn = null;
    this.snapshot.winner = null;
    this.snapshot.holeDoneAt = 0;
    this.notify();
    return true;
  }

  /** Swap in a freshly generated course and reset every scorecard + ball to the
   *  new hole 1 tee. Used by rename and the lobby reset. */
  private loadCourse(name: string): void {
    this.courseName = name;
    this.holes = generateCourse(name);
    this.snapshot.courseName = name;
    this.snapshot.course.holes = this.holes;
    for (const p of this.snapshot.players) {
      if (!p) continue;
      p.strokes = new Array(this.holes.length).fill(0);
      p.done = new Array(this.holes.length).fill(false);
      p.ball = { ...this.teeFor(0) };
    }
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
    // Fresh random course each time we drop to the lobby (players can rename it
    // before starting). loadCourse also resets every scorecard + ball to tee 1.
    this.loadCourse(randomCourseName());
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

    // One clock read per tick: the sails' angle (and their swept speed) is a
    // pure function of this, matching what every client draws off Date.now().
    const now = Date.now();

    let holed = false;
    let watered = false;
    for (let s = 0; s < SUBSTEPS && !holed && !watered; s++) {
      // Gravity along the slope: accelerate downhill (negative gradient).
      const slope = puttSlopeAt(hole.terrain, p.ball.x, p.ball.y);
      this.vel.x -= (SLOPE_ACCEL / SUBSTEPS) * slope.x;
      this.vel.y -= (SLOPE_ACCEL / SUBSTEPS) * slope.y;
      p.ball.x += this.vel.x / SUBSTEPS;
      p.ball.y += this.vel.y / SUBSTEPS;
      this.resolveBorders(p.ball);
      for (const w of hole.walls) this.resolveWall(p.ball, w);
      if (hole.windmill) this.resolveWindmill(p.ball, hole.windmill, now);
      // Water: a ball whose center crosses the shoreline is penalised and
      // returned to where it was struck from (handled below). Checked
      // per-substep so a fast ball can't skip over a pond between ticks.
      if (inAnyRegion(hole.water, p.ball.x, p.ball.y)) {
        watered = true;
        break;
      }
      // Cup capture — a slow enough ball over the hole drops in.
      if (dist2(p.ball, hole.cup) <= CUP_R * CUP_R && Math.hypot(this.vel.x, this.vel.y) <= CAPTURE_SPEED) {
        p.ball = { ...hole.cup };
        holed = true;
      }
    }

    if (watered) {
      // Stroke-and-distance: one-stroke penalty AND the ball goes back to where
      // it was struck from this shot (not the bank). The shot stroke was counted
      // in shoot(), so a watered shot costs that + this penalty.
      this.vel = { x: 0, y: 0 };
      p.ball = { x: this.shotStart.x, y: this.shotStart.y };
      const h = this.snapshot.hole;
      p.strokes[h] = (p.strokes[h] ?? 0) + WATER_PENALTY;
      if ((p.strokes[h] ?? 0) >= MAX_STROKES) p.done[h] = true;
      this.advanceTurn();
      return;
    }

    if (holed) {
      this.vel = { x: 0, y: 0 };
      p.done[this.snapshot.hole] = true;
      this.advanceTurn();
      return;
    }

    // Sand digs in: over a bunker the ball meets much heavier resistance for
    // this tick (and buries at a higher speed, below). Tested at the ball's
    // resting position for this tick.
    const inSand = inAnyRegion(hole.sand, p.ball.x, p.ball.y);
    // Viscous bleed (smooth, speed-proportional) — sand bleeds far more.
    const visc = inSand ? SAND_FRICTION : FRICTION;
    this.vel.x *= visc;
    this.vel.y *= visc;
    // Constant rolling resistance (Coulomb): subtract a fixed decel opposing
    // motion, capped so it can't reverse the ball. Guarantees a real stop.
    let speed = Math.hypot(this.vel.x, this.vel.y);
    if (speed > 0) {
      const dec = Math.min(speed, inSand ? SAND_KINETIC : KINETIC_FRICTION);
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
    // The settle backstop catches any residual crawl; the tick budget is the
    // final safety net.
    const grad = puttSlopeAt(hole.terrain, p.ball.x, p.ball.y);
    const slopePull = SLOPE_ACCEL * Math.hypot(grad.x, grad.y);
    this.rollTicks += 1;
    this.slowTicks = speed < SETTLE_SPEED ? this.slowTicks + 1 : 0;
    // In sand a slow ball just buries (sand holds far more than a grass slope);
    // on grass it sticks only if the slope is too gentle for gravity to win.
    const stuck = inSand ? speed < SAND_STICK_SPEED : speed < MIN_SPEED && slopePull <= STATIC_FRICTION;
    if (stuck || this.slowTicks >= SETTLE_TICKS || this.rollTicks >= MAX_ROLL_TICKS) {
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

  /** Spinning windmill: a solid hub plus N blades, each a moving capsule. The
   *  blade angle comes from the shared wall-clock function so this matches the
   *  client's render. A blade carries its own surface velocity into the bounce
   *  (relative-velocity reflection), so a sweeping sail genuinely *swats* the
   *  ball — clip one and you get knocked back, not nudged. */
  private resolveWindmill(b: PuttVec, wm: PuttWindmill, now: number): void {
    // Solid hub at the center (a dead-center shot can't slip through the axle).
    this.resolveCircleObstacle(b, wm.x, wm.y, wm.hubR);
    const base = windmillAngle(wm, now);
    // Angular speed as radians per tick, so the contact-point surface velocity
    // comes out in px/tick (the same units as this.vel).
    const omegaPerTick = ((wm.rpm * Math.PI * 2) / 60000) * TICK_MS;
    for (let i = 0; i < wm.blades; i++) {
      const a = base + (i * Math.PI * 2) / wm.blades;
      this.resolveBlade(b, wm.x, wm.y, a, wm.bladeLen, wm.bladeW, omegaPerTick);
    }
  }

  /** Ball vs a solid circle (the windmill hub): push out + reflect off the
   *  radial normal with the usual wall restitution. */
  private resolveCircleObstacle(b: PuttVec, cx: number, cy: number, r: number): void {
    let nx = b.x - cx;
    let ny = b.y - cy;
    const rad = r + BALL_R;
    const d2 = nx * nx + ny * ny;
    if (d2 > rad * rad) return;
    const d = Math.sqrt(d2);
    if (d > 1e-6) {
      nx /= d;
      ny /= d;
    } else {
      nx = 0;
      ny = -1;
    }
    b.x = cx + nx * rad;
    b.y = cy + ny * rad;
    const vn = this.vel.x * nx + this.vel.y * ny;
    if (vn < 0) {
      this.vel.x -= (1 + WALL_REST) * vn * nx;
      this.vel.y -= (1 + WALL_REST) * vn * ny;
    }
  }

  /** Ball vs one rotating blade, modelled as a capsule from the hub to the tip.
   *  We reflect the ball's velocity *relative to the blade's surface velocity at
   *  the contact point*, so the moving sail imparts its swing — a stationary
   *  ball parked in the gap gets knocked clear, and a ball threading the gap
   *  bounces back the way it came. */
  private resolveBlade(
    b: PuttVec,
    hx: number,
    hy: number,
    a: number,
    len: number,
    halfW: number,
    omegaPerTick: number,
  ): void {
    const ex = Math.cos(a) * len;
    const ey = Math.sin(a) * len;
    const seg2 = ex * ex + ey * ey;
    // Closest point on the hub→tip segment to the ball center.
    let t = seg2 > 0 ? ((b.x - hx) * ex + (b.y - hy) * ey) / seg2 : 0;
    t = clamp(t, 0, 1);
    const cx = hx + ex * t;
    const cy = hy + ey * t;
    let nx = b.x - cx;
    let ny = b.y - cy;
    const rad = halfW + BALL_R;
    const d2 = nx * nx + ny * ny;
    if (d2 > rad * rad) return; // no contact
    let d = Math.sqrt(d2);
    if (d > 1e-6) {
      nx /= d;
      ny /= d;
    } else {
      // Ball center exactly on the blade — push out along the blade's normal.
      nx = -Math.sin(a);
      ny = Math.cos(a);
      d = 1;
    }
    b.x = cx + nx * rad;
    b.y = cy + ny * rad;
    // Surface velocity at the contact point: tangent (perpendicular to the
    // blade) scaled by radius × angular speed.
    const rr = t * len;
    const svx = -Math.sin(a) * omegaPerTick * rr;
    const svy = Math.cos(a) * omegaPerTick * rr;
    // Reflect the ball's velocity relative to the moving blade, then restore the
    // blade frame — the sail's swing is carried into the bounce.
    const rvx = this.vel.x - svx;
    const rvy = this.vel.y - svy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      this.vel.x -= (1 + WALL_REST) * vn * nx;
      this.vel.y -= (1 + WALL_REST) * vn * ny;
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

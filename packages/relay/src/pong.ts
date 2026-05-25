// Per-room server-authoritative Pong game state.
//
// Two seats (left, right) held by ownerKey. The relay runs the physics
// loop at 30Hz when both seats are filled and broadcasts a fresh
// snapshot every tick. Clients send paddle Y positions via WS; the
// relay clamps + assigns by ownerKey so a peer can only move their own
// paddle. First to WIN_SCORE wins; "play again" resets scores in
// place. Not persisted — pong matches die with the relay restart, by
// design (they're meant to be live moments between guests, not
// long-lived state).

export const FIELD_W = 800;
export const FIELD_H = 500;
export const PADDLE_H = 90;
export const PADDLE_W = 12;
export const PADDLE_INSET = 24;
export const BALL_R = 8;
export const TICK_HZ = 30;
export const WIN_SCORE = 11;
const BALL_BASE_SPEED = 7.5;
const BALL_MAX_SPEED = 16;
const PADDLE_SPEED_BOOST = 1.04;
const SERVE_DELAY_MS = 1500;

export type PongSide = "left" | "right";

export type PongSeat = {
  ownerKey: string;
  handle: string;
};

export type PongStatus = "waiting" | "serving" | "playing" | "ended";

export type PongSnapshot = {
  seats: { left: PongSeat | null; right: PongSeat | null };
  paddles: { left: number; right: number };
  ball: { x: number; y: number; vx: number; vy: number };
  score: { left: number; right: number };
  status: PongStatus;
  /** ms-since-epoch when the next serve fires (only meaningful when status === "serving"). */
  serveAt: number;
  /** Side that just scored — used by the UI to flash "GO!" toward them after a serve. */
  lastScorer: PongSide | null;
  winner: PongSide | null;
  /** Field constants, sent so clients don't have to keep them in sync. */
  field: { w: number; h: number; paddleH: number; paddleW: number; paddleInset: number; ballR: number };
};

type Listener = (snapshot: PongSnapshot) => void;

function centerBall(): { x: number; y: number; vx: number; vy: number } {
  return { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0 };
}

function serveVelocity(towards: PongSide): { vx: number; vy: number } {
  // Mild vertical angle so it's not boring; sign of vx points toward
  // `towards` (the side that just got scored on — they get the next serve).
  const angle = (Math.random() * 0.5 - 0.25) * Math.PI; // [-45°, +45°]
  const vx = Math.cos(angle) * BALL_BASE_SPEED * (towards === "right" ? 1 : -1);
  const vy = Math.sin(angle) * BALL_BASE_SPEED;
  return { vx, vy };
}

export class Pong {
  private snapshot: PongSnapshot = {
    seats: { left: null, right: null },
    paddles: { left: FIELD_H / 2, right: FIELD_H / 2 },
    ball: centerBall(),
    score: { left: 0, right: 0 },
    status: "waiting",
    serveAt: 0,
    lastScorer: null,
    winner: null,
    field: { w: FIELD_W, h: FIELD_H, paddleH: PADDLE_H, paddleW: PADDLE_W, paddleInset: PADDLE_INSET, ballR: BALL_R },
  };
  private listeners: Listener[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  current(): { state: PongSnapshot } {
    return { state: this.snapshot };
  }

  /** Claim the first empty seat. Returns the assigned side, or null if
   *  the caller already sits in a seat (idempotent — returns the existing
   *  side) or both seats are full. */
  claim(ownerKey: string, handle: string): PongSide | null {
    if (!ownerKey) return null;
    const existing = this.findSeat(ownerKey);
    if (existing) return existing;
    if (!this.snapshot.seats.left) {
      this.snapshot.seats.left = { ownerKey, handle };
      this.afterSeatChange();
      return "left";
    }
    if (!this.snapshot.seats.right) {
      this.snapshot.seats.right = { ownerKey, handle };
      this.afterSeatChange();
      return "right";
    }
    return null;
  }

  /** Drop the caller's seat. Returns true if a seat was actually freed. */
  release(ownerKey: string): boolean {
    const side = this.findSeat(ownerKey);
    if (!side) return false;
    this.snapshot.seats[side] = null;
    this.afterSeatChange();
    return true;
  }

  /** Move the caller's paddle. Silently no-ops if the caller has no seat. */
  setPaddle(ownerKey: string, y: number): void {
    const side = this.findSeat(ownerKey);
    if (!side) return;
    const clamped = clamp(y, PADDLE_H / 2, FIELD_H - PADDLE_H / 2);
    if (this.snapshot.paddles[side] === clamped) return;
    this.snapshot.paddles[side] = clamped;
    this.notify();
  }

  /** Reset scores + ball; only callable by a seated player. Returns true
   *  on success. From "ended" this is the "play again" path. From any
   *  state it cleanly restarts. */
  reset(ownerKey: string): boolean {
    if (!this.findSeat(ownerKey)) return false;
    this.snapshot.score = { left: 0, right: 0 };
    this.snapshot.winner = null;
    this.snapshot.lastScorer = null;
    this.snapshot.ball = centerBall();
    this.snapshot.paddles = { left: FIELD_H / 2, right: FIELD_H / 2 };
    if (this.snapshot.seats.left && this.snapshot.seats.right) {
      this.armServe(Math.random() < 0.5 ? "left" : "right");
    } else {
      this.snapshot.status = "waiting";
      this.snapshot.serveAt = 0;
      this.stopTicker();
    }
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

  private findSeat(ownerKey: string): PongSide | null {
    if (this.snapshot.seats.left?.ownerKey === ownerKey) return "left";
    if (this.snapshot.seats.right?.ownerKey === ownerKey) return "right";
    return null;
  }

  private afterSeatChange(): void {
    const both = this.snapshot.seats.left && this.snapshot.seats.right;
    if (both) {
      if (this.snapshot.status === "waiting") {
        this.armServe(Math.random() < 0.5 ? "left" : "right");
      } else if (this.snapshot.status === "playing" || this.snapshot.status === "serving") {
        this.ensureTicker();
      }
    } else {
      // Lost a seat → freeze the match in place; resume when the seat
      // is refilled (scores carry).
      this.snapshot.status = "waiting";
      this.snapshot.serveAt = 0;
      this.snapshot.ball = centerBall();
      this.stopTicker();
    }
    this.notify();
  }

  private armServe(towardsScoredOn: PongSide): void {
    this.snapshot.status = "serving";
    this.snapshot.lastScorer = towardsScoredOn === "left" ? "right" : "left";
    this.snapshot.ball = centerBall();
    this.snapshot.serveAt = Date.now() + SERVE_DELAY_MS;
    this.ensureTicker();
  }

  private ensureTicker(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), Math.round(1000 / TICK_HZ));
  }

  private stopTicker(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private tick(): void {
    if (!this.snapshot.seats.left || !this.snapshot.seats.right) {
      this.stopTicker();
      return;
    }
    if (this.snapshot.status === "ended") {
      this.stopTicker();
      return;
    }
    if (this.snapshot.status === "serving") {
      if (Date.now() < this.snapshot.serveAt) {
        // Still on the countdown — broadcast anyway so clients can
        // animate the "GO" countdown using server time.
        this.notify();
        return;
      }
      const serveTowards = this.snapshot.lastScorer ?? (Math.random() < 0.5 ? "left" : "right");
      const v = serveVelocity(serveTowards);
      this.snapshot.ball = { x: FIELD_W / 2, y: FIELD_H / 2, vx: v.vx, vy: v.vy };
      this.snapshot.status = "playing";
      this.notify();
      return;
    }
    // status === "playing"
    this.step();
    this.notify();
  }

  private step(): void {
    const b = this.snapshot.ball;
    b.x += b.vx;
    b.y += b.vy;

    // Top / bottom walls
    if (b.y < BALL_R) {
      b.y = BALL_R;
      b.vy = -b.vy;
    } else if (b.y > FIELD_H - BALL_R) {
      b.y = FIELD_H - BALL_R;
      b.vy = -b.vy;
    }

    // Paddle collisions (only check the side the ball is heading toward)
    const leftFront = PADDLE_INSET + PADDLE_W / 2;
    const rightFront = FIELD_W - PADDLE_INSET - PADDLE_W / 2;
    if (b.vx < 0 && b.x - BALL_R <= leftFront && b.x + BALL_R >= PADDLE_INSET - PADDLE_W / 2) {
      const py = this.snapshot.paddles.left;
      if (b.y >= py - PADDLE_H / 2 && b.y <= py + PADDLE_H / 2) {
        this.bouncePaddle("left", py);
        b.x = leftFront + BALL_R; // pop ball out so we don't re-collide next tick
      }
    } else if (b.vx > 0 && b.x + BALL_R >= rightFront && b.x - BALL_R <= FIELD_W - PADDLE_INSET + PADDLE_W / 2) {
      const py = this.snapshot.paddles.right;
      if (b.y >= py - PADDLE_H / 2 && b.y <= py + PADDLE_H / 2) {
        this.bouncePaddle("right", py);
        b.x = rightFront - BALL_R;
      }
    }

    // Score? (ball crossed the goal line behind a paddle)
    if (b.x < -BALL_R) {
      this.scoreFor("right");
    } else if (b.x > FIELD_W + BALL_R) {
      this.scoreFor("left");
    }
  }

  private bouncePaddle(side: PongSide, paddleY: number): void {
    const b = this.snapshot.ball;
    // Spin: where the ball hit on the paddle (-1..1) influences vy so
    // edges send it sharper. Classic pong feel.
    const offset = clamp((b.y - paddleY) / (PADDLE_H / 2), -1, 1);
    const speed = Math.min(Math.hypot(b.vx, b.vy) * PADDLE_SPEED_BOOST, BALL_MAX_SPEED);
    const maxAngle = (Math.PI * 5) / 12; // 75°
    const angle = offset * maxAngle;
    const dir = side === "left" ? 1 : -1;
    b.vx = Math.cos(angle) * speed * dir;
    b.vy = Math.sin(angle) * speed;
  }

  private scoreFor(side: PongSide): void {
    this.snapshot.score[side] += 1;
    if (this.snapshot.score[side] >= WIN_SCORE) {
      this.snapshot.status = "ended";
      this.snapshot.winner = side;
      this.snapshot.ball = centerBall();
      this.snapshot.serveAt = 0;
      this.stopTicker();
      return;
    }
    // Serve back to the side that got scored on.
    this.armServe(side === "left" ? "right" : "left");
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

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

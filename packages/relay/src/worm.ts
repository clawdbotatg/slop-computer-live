// Per-room server-authoritative Worm (multiplayer snake) game state.
//
// Up to 4 seats, each a colored worm (cyan / magenta / lime / purple).
// The relay owns the whole simulation: it runs a fixed-step move tick
// while at least one worm is seated, advances every worm one grid cell
// per tick (all worms move simultaneously), resolves food + collisions,
// and broadcasts a fresh snapshot every step. Clients send only their
// own desired direction; the relay queues it per-ownerKey and applies it
// at the next tick (rejecting 180° reversals), so a peer can only steer
// their own worm.
//
// Rules: walls kill. Crashing into a wall, yourself, or another worm
// (head-on counts for both) kills you; you respawn small after a short
// delay and keep playing — it's a respawn arena, not elimination. Eat a
// food orb to grow by one. First worm to reach WIN_LEN wins the round;
// "play again" (reset) re-spawns everyone. Not persisted — matches die
// with the relay restart, by design (live moments between guests, like
// pong, not durable state).

export const COLS = 40;
export const ROWS = 30;
export const CELL = 16; // px per grid cell → 640×480 field
export const START_LEN = 3;
export const MOVE_HZ = 8; // grid steps per second
export const MOVE_MS = Math.round(1000 / MOVE_HZ);
export const FOOD_COUNT = 4; // food orbs kept on the board at once
export const WIN_LEN = 16; // first worm to this length wins the round
export const RESPAWN_MS = 1800; // delay before a crashed worm respawns
export const MAX_PLAYERS = 4;

export type WormDir = "up" | "down" | "left" | "right";
export type WormColor = "cyan" | "magenta" | "lime" | "purple";
export type WormStatus = "waiting" | "playing" | "ended";
export type WormCell = { x: number; y: number };

// Color per seat slot — the classic slop accents, mapped client-side to
// the matching --slop-* CSS var. Food renders amber/yellow separately.
const SLOT_COLORS: WormColor[] = ["cyan", "magenta", "lime", "purple"];

export type WormPlayer = {
  slot: number; // 0..MAX_PLAYERS-1
  ownerKey: string;
  handle: string;
  color: WormColor;
  /** Head is body[0]. Empty while dead (awaiting respawn). */
  body: WormCell[];
  dir: WormDir;
  alive: boolean;
  /** ms-since-epoch when a dead worm respawns; 0 while alive. */
  respawnAt: number;
  /** Current length — body.length while alive, the player's "score". */
  len: number;
};

export type WormSnapshot = {
  /** Indexed by slot; null = open seat. Length MAX_PLAYERS. */
  players: (WormPlayer | null)[];
  food: WormCell[];
  status: WormStatus;
  /** Slot of the worm that reached WIN_LEN, or null. */
  winner: number | null;
  /** Move-step counter — clients only re-interpolate when this advances,
   *  so off-tick broadcasts (seat changes, reset) snap instead of slide. */
  tick: number;
  /** Board geometry, shipped so clients don't keep constants in sync. */
  field: { cols: number; rows: number; cell: number; moveMs: number; winLen: number; startLen: number };
};

type Listener = (snapshot: WormSnapshot) => void;

const DELTA: Record<WormDir, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE: Record<WormDir, WormDir> = { up: "down", down: "up", left: "right", right: "left" };
const ALL_DIRS: WormDir[] = ["up", "down", "left", "right"];

function cellKey(c: WormCell): string {
  return `${c.x},${c.y}`;
}

function step(c: WormCell, dir: WormDir): WormCell {
  return { x: c.x + DELTA[dir].x, y: c.y + DELTA[dir].y };
}

function inBounds(c: WormCell): boolean {
  return c.x >= 0 && c.x < COLS && c.y >= 0 && c.y < ROWS;
}

function randInt(lo: number, hi: number): number {
  // inclusive lo, exclusive hi
  return lo + Math.floor(Math.random() * (hi - lo));
}

export class Worm {
  private snapshot: WormSnapshot = {
    players: new Array(MAX_PLAYERS).fill(null),
    food: [],
    status: "waiting",
    winner: null,
    tick: 0,
    field: { cols: COLS, rows: ROWS, cell: CELL, moveMs: MOVE_MS, winLen: WIN_LEN, startLen: START_LEN },
  };
  // Queued direction per slot, applied (and validated against reversal)
  // on the next move tick. Internal — never serialized.
  private pendingDirs: (WormDir | null)[] = new Array(MAX_PLAYERS).fill(null);
  private listeners: Listener[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  current(): { state: WormSnapshot } {
    return { state: this.snapshot };
  }

  /** Claim the first open seat. Idempotent — re-claiming returns your
   *  existing slot. Returns the slot index, or null if all 4 are full. */
  claim(ownerKey: string, handle: string): number | null {
    if (!ownerKey) return null;
    const existing = this.findSlot(ownerKey);
    if (existing !== null) return existing;
    const slot = this.snapshot.players.findIndex(p => p === null);
    if (slot === -1) return null;
    const player: WormPlayer = {
      slot,
      ownerKey,
      handle,
      color: SLOT_COLORS[slot] ?? "cyan",
      body: [],
      dir: "right",
      alive: false,
      respawnAt: 0,
      len: 0,
    };
    this.snapshot.players[slot] = player;
    // Spawn the worm onto the board now unless the round is frozen in
    // "ended" — there the ticker is stopped, so a spawned worm would just
    // sit there looking alive but unmovable. Joining an ended round shows
    // a seated-but-bodyless "waiting for rematch" worm; reset() spawns it.
    // (Spawning doesn't need food; afterSeatChange flips waiting→playing
    // and tops up food around the freshly-placed worm.)
    if (this.snapshot.status !== "ended") this.spawnPlayer(player);
    this.afterSeatChange();
    return slot;
  }

  /** Drop the caller's seat. Returns true if a seat was actually freed. */
  release(ownerKey: string): boolean {
    const slot = this.findSlot(ownerKey);
    if (slot === null) return false;
    this.snapshot.players[slot] = null;
    this.pendingDirs[slot] = null;
    this.afterSeatChange();
    return true;
  }

  /** Queue the caller's next direction. Applied on the next tick and
   *  rejected if it reverses straight back into the neck. Does not notify
   *  — the move shows up at the next broadcast step. No-ops if unseated. */
  setDir(ownerKey: string, dir: WormDir): void {
    const slot = this.findSlot(ownerKey);
    if (slot === null) return;
    this.pendingDirs[slot] = dir;
  }

  /** Reset the round: respawn every seated worm small, clear food + winner,
   *  resume play. Seated players only (so spectators can't grief). From
   *  "ended" this is the "play again" path. */
  reset(ownerKey: string): boolean {
    if (this.findSlot(ownerKey) === null) return false;
    this.snapshot.winner = null;
    this.snapshot.food = [];
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const p = this.snapshot.players[slot];
      this.pendingDirs[slot] = null;
      if (p) {
        p.body = [];
        p.alive = false;
        p.respawnAt = 0;
      }
    }
    // Place worms after all bodies are cleared so they don't collide.
    for (const p of this.snapshot.players) if (p) this.spawnPlayer(p);
    const anyPlayers = this.snapshot.players.some(p => p);
    if (anyPlayers) {
      this.snapshot.status = "playing";
      this.spawnFoodToCount();
      this.ensureTicker();
    } else {
      this.snapshot.status = "waiting";
      this.stopTicker();
    }
    // No tick bump — clients snap to the fresh layout rather than sliding.
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

  /** Tear down the move interval. Room calls this on hibernate. */
  dispose(): void {
    this.stopTicker();
    this.listeners = [];
  }

  private findSlot(ownerKey: string): number | null {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (this.snapshot.players[i]?.ownerKey === ownerKey) return i;
    }
    return null;
  }

  private afterSeatChange(): void {
    const anyPlayers = this.snapshot.players.some(p => p);
    if (!anyPlayers) {
      // Lobby empty → reset to a clean waiting board.
      this.snapshot.status = "waiting";
      this.snapshot.winner = null;
      this.snapshot.food = [];
      this.stopTicker();
    } else if (this.snapshot.status === "waiting") {
      this.snapshot.status = "playing";
      this.spawnFoodToCount();
      this.ensureTicker();
    } else if (this.snapshot.status === "playing") {
      this.ensureTicker();
    }
    // status === "ended" stays frozen until someone hits reset.
    this.notify();
  }

  private ensureTicker(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), MOVE_MS);
  }

  private stopTicker(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private tick(): void {
    if (!this.snapshot.players.some(p => p)) {
      this.stopTicker();
      return;
    }
    if (this.snapshot.status === "ended") {
      this.stopTicker();
      return;
    }
    const now = Date.now();
    // Respawn any crashed worm whose delay has elapsed (before we move,
    // so the fresh worm participates in this step's collision set).
    for (const p of this.snapshot.players) {
      if (p && !p.alive && p.respawnAt && now >= p.respawnAt) {
        this.spawnPlayer(p);
      }
    }
    this.advance();
    this.snapshot.tick += 1;
    this.notify();
  }

  /** One simultaneous-move step for all alive worms: resolve directions,
   *  walls, then head↔body and head↔head collisions, then apply + eat. */
  private advance(): void {
    const alive = this.snapshot.players.filter((p): p is WormPlayer => !!p && p.alive);
    if (alive.length === 0) {
      this.spawnFoodToCount();
      return;
    }

    const foodKeys = new Set(this.snapshot.food.map(cellKey));

    // 1. Commit each worm's direction (reject straight reversal) and
    //    compute its new head + whether it lands on food.
    type Move = { p: WormPlayer; head: WormCell; willEat: boolean; newBody: WormCell[]; dead: boolean };
    const moves: Move[] = [];
    for (const p of alive) {
      const head0 = p.body[0];
      if (!head0) continue; // alive worms always carry a head; defensive
      const want = this.pendingDirs[p.slot];
      if (want && want !== OPPOSITE[p.dir]) p.dir = want;
      this.pendingDirs[p.slot] = null;
      const head = step(head0, p.dir);
      moves.push({ p, head, willEat: foodKeys.has(cellKey(head)), newBody: [], dead: false });
    }

    // 2. Walls kill.
    for (const m of moves) if (!inBounds(m.head)) m.dead = true;

    // 3. Build the post-move body for survivors (tail stays put if eating).
    for (const m of moves) {
      if (m.dead) continue;
      m.newBody = [m.head, ...m.p.body];
      if (!m.willEat) m.newBody.pop();
    }

    // 4. Collisions, evaluated against the post-move occupancy so chasing
    //    a vacating tail is legal. A worm dies if another worm's head
    //    lands on the same cell (head-on: both die) or if its head lands
    //    on any worm's body segment (its own included → self-collision).
    const headCount = new Map<string, number>();
    const bodyCells = new Set<string>();
    for (const m of moves) {
      if (m.dead) continue;
      headCount.set(cellKey(m.head), (headCount.get(cellKey(m.head)) ?? 0) + 1);
      for (const seg of m.newBody.slice(1)) bodyCells.add(cellKey(seg));
    }
    for (const m of moves) {
      if (m.dead) continue;
      const k = cellKey(m.head);
      if ((headCount.get(k) ?? 0) > 1) m.dead = true;
      else if (bodyCells.has(k)) m.dead = true;
    }

    // 5. Apply. Crashed worms drop their body and arm a respawn; survivors
    //    take their new body and consume any food they ate.
    let winnerSlot: number | null = null;
    for (const m of moves) {
      if (m.dead) {
        m.p.alive = false;
        m.p.body = [];
        m.p.len = 0;
        m.p.respawnAt = Date.now() + RESPAWN_MS;
        continue;
      }
      m.p.body = m.newBody;
      m.p.len = m.newBody.length;
      if (m.willEat) {
        this.snapshot.food = this.snapshot.food.filter(f => !(f.x === m.head.x && f.y === m.head.y));
      }
      if (winnerSlot === null && m.p.len >= WIN_LEN) winnerSlot = m.p.slot;
    }

    // 6. Top the board back up, then settle the round if someone won.
    this.spawnFoodToCount();
    if (winnerSlot !== null) {
      this.snapshot.status = "ended";
      this.snapshot.winner = winnerSlot;
      this.stopTicker();
    }
  }

  /** Place (or replace) a worm at a random spot with a clear straight run
   *  behind the head and a couple of open cells ahead, so it doesn't crash
   *  on spawn. Falls back to "stay dead, retry soon" if the board is too
   *  crowded to fit one. */
  private spawnPlayer(p: WormPlayer): void {
    const fresh = this.freshBody();
    if (!fresh) {
      // Board momentarily too packed — keep the worm out and try again on
      // a near-future tick rather than forcing an unfair spawn.
      p.alive = false;
      p.body = [];
      p.len = 0;
      p.respawnAt = Date.now() + 500;
      return;
    }
    p.body = fresh.body;
    p.dir = fresh.dir;
    p.alive = true;
    p.len = fresh.body.length;
    p.respawnAt = 0;
    this.pendingDirs[p.slot] = null;
  }

  private freshBody(): { body: WormCell[]; dir: WormDir } | null {
    const margin = START_LEN + 3;
    for (let attempt = 0; attempt < 200; attempt++) {
      const dir = ALL_DIRS[Math.floor(Math.random() * ALL_DIRS.length)] ?? "right";
      const d = DELTA[dir];
      const hx = randInt(margin, COLS - margin);
      const hy = randInt(margin, ROWS - margin);
      const body: WormCell[] = [];
      let ok = true;
      // Lay the body backwards from the head (so it points along `dir`).
      for (let i = 0; i < START_LEN; i++) {
        const c = { x: hx - d.x * i, y: hy - d.y * i };
        if (this.cellOccupied(c)) {
          ok = false;
          break;
        }
        body.push(c);
      }
      if (!ok) continue;
      // Keep the two cells directly ahead clear too.
      let clearAhead = true;
      for (let i = 1; i <= 2; i++) {
        if (this.cellOccupied({ x: hx + d.x * i, y: hy + d.y * i })) {
          clearAhead = false;
          break;
        }
      }
      if (!clearAhead) continue;
      return { body, dir };
    }
    return null;
  }

  /** True if any alive worm's body or any food orb sits on this cell. */
  private cellOccupied(c: WormCell): boolean {
    for (const p of this.snapshot.players) {
      if (!p || !p.alive) continue;
      for (const seg of p.body) if (seg.x === c.x && seg.y === c.y) return true;
    }
    for (const f of this.snapshot.food) if (f.x === c.x && f.y === c.y) return true;
    return false;
  }

  /** Keep FOOD_COUNT orbs on the board, each on an empty cell. */
  private spawnFoodToCount(): void {
    let guard = 0;
    while (this.snapshot.food.length < FOOD_COUNT && guard < 500) {
      guard++;
      const c = { x: randInt(0, COLS), y: randInt(0, ROWS) };
      if (!this.cellOccupied(c)) this.snapshot.food.push(c);
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

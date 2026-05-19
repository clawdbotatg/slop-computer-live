// Per-room server-authoritative chess game state.
//
// One active game at a time per room. The relay owns the truth: every
// move is validated here against chess.js, then broadcast to peers as a
// fresh snapshot. Clients never trust each other — they trust this
// module.
//
// Players are identified by `ownerKey` (lowercased address or handle,
// same scheme publications + cursors use). That key is stable across
// reconnects, so a player can drop offline mid-game and resume.
//
// Game state + recent history persist to disk; survives relay restart.

import { Chess } from "chess.js";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

export type ChessGameStatus =
  | "active"
  | "white_won"
  | "black_won"
  | "draw_stalemate"
  | "draw_threefold"
  | "draw_insufficient"
  | "draw_other"
  | "white_resigned"
  | "black_resigned";

export type ChessGame = {
  /** Stable identity (ownerKey) of the white player. */
  whiteKey: string;
  blackKey: string;
  /** Display label captured at game-start time (ENS, handle, or shortened address) — purely cosmetic. */
  whiteLabel: string;
  blackLabel: string;
  /** Forsyth-Edwards Notation — the canonical board state. */
  fen: string;
  /** SAN move list, oldest first. */
  moves: string[];
  status: ChessGameStatus;
  startedAt: number;
  endedAt?: number;
  /** Date.now() when the current side started thinking. Jumps to
   *  Date.now() on every applyMove (== when the OTHER side now gets
   *  to think). Used by clients to render a live "thinking Xs"
   *  counter under each player's name. */
  turnStartedAt: number;
  /** Wall-clock ms each completed move took, parallel to `moves`.
   *  Index 0 is white's first move, 1 is black's response, etc. */
  moveTimings: number[];
};

export type ChessResult = {
  whiteKey: string;
  blackKey: string;
  whiteLabel: string;
  blackLabel: string;
  status: Exclude<ChessGameStatus, "active">;
  startedAt: number;
  endedAt: number;
  moveCount: number;
};

const HISTORY_CAP = 50;

export type CreateGameArgs = {
  whiteKey: string;
  blackKey: string;
  whiteLabel: string;
  blackLabel: string;
};

export type MoveArgs = { from: string; to: string; promotion?: string };

export type MoveOutcome = { ok: true; game: ChessGame; ended: boolean } | { ok: false; error: string };

type ChessWaiter = { wake: () => void; cleanup: () => void };

export class ChessState {
  private current: ChessGame | null = null;
  private history: ChessResult[] = [];
  private loaded = false;
  private saveQueued = false;
  // Bumped every time the game state changes. Lets long-pollers wait
  // cheaply for the next change without us keeping diffs of the game.
  private version = 0;
  private waiters: ChessWaiter[] = [];

  constructor(
    private readonly filePath: string,
    private readonly legacyPath: string | null = null,
  ) {}

  /** Current `bumpVersion()` counter. Snap this after a get/list call
   *  and pass it as `?since=` to /v1/chess/wait. */
  getVersion(): number {
    this.load();
    return this.version;
  }

  pushWaiter(entry: ChessWaiter): void {
    this.waiters.push(entry);
  }

  removeWaiter(entry: ChessWaiter): void {
    const idx = this.waiters.findIndex(x => x === entry);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }

  /** Bump the version + wake all long-poll waiters. Called by the
   *  broadcastChessState wrapper in index.ts after every mutation so
   *  /v1/chess/wait clients react in real time. */
  bumpVersion(): void {
    this.version++;
    const woke = this.waiters.splice(0);
    for (const w of woke) {
      try { w.cleanup(); } catch { /* ignore */ }
      try { w.wake(); } catch { /* ignore */ }
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.readFrom(this.filePath)) return;
    if (this.legacyPath) this.readFrom(this.legacyPath);
  }

  private readFrom(path: string): boolean {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { current?: ChessGame | null; history?: ChessResult[] };
      if (parsed.current && typeof parsed.current === "object") {
        this.current = parsed.current;
        // Backfill fields added after this game was saved so the type
        // contract holds. Historical move timings are unknown.
        if (typeof this.current.turnStartedAt !== "number") this.current.turnStartedAt = this.current.startedAt;
        if (!Array.isArray(this.current.moveTimings)) this.current.moveTimings = [];
      }
      if (Array.isArray(parsed.history)) this.history = parsed.history.slice(0, HISTORY_CAP);
      return true;
    } catch {
      return false;
    }
  }

  private scheduleSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      try {
        writeFileAtomic(this.filePath, JSON.stringify({ current: this.current, history: this.history }));
      } catch (err) {
        console.error("[chess] failed to persist:", err);
      }
    });
  }

  getCurrentGame(): ChessGame | null {
    this.load();
    return this.current;
  }

  getHistory(): ChessResult[] {
    this.load();
    return this.history.slice();
  }

  createGame(args: CreateGameArgs): { ok: true; game: ChessGame } | { ok: false; error: string } {
    this.load();
    if (this.current && this.current.status === "active") return { ok: false, error: "game_already_active" };
    if (!args.whiteKey || !args.blackKey) return { ok: false, error: "missing_player" };
    const now = Date.now();
    const game: ChessGame = {
      whiteKey: args.whiteKey,
      blackKey: args.blackKey,
      whiteLabel: args.whiteLabel || args.whiteKey,
      blackLabel: args.blackLabel || args.blackKey,
      fen: new Chess().fen(),
      moves: [],
      status: "active",
      startedAt: now,
      turnStartedAt: now,
      moveTimings: [],
    };
    this.current = game;
    this.scheduleSave();
    return { ok: true, game };
  }

  applyMove(callerKey: string, args: MoveArgs): MoveOutcome {
    this.load();
    if (!this.current || this.current.status !== "active") return { ok: false, error: "no_active_game" };
    const ch = new Chess(this.current.fen);
    const turn = ch.turn(); // "w" | "b"
    const expected = turn === "w" ? this.current.whiteKey : this.current.blackKey;
    if (callerKey !== expected) return { ok: false, error: "not_your_turn" };
    let move;
    try {
      move = ch.move({ from: args.from, to: args.to, promotion: args.promotion ?? "q" });
    } catch {
      return { ok: false, error: "illegal_move" };
    }
    if (!move) return { ok: false, error: "illegal_move" };
    const now = Date.now();
    const thinkMs = Math.max(0, now - this.current.turnStartedAt);
    this.current.fen = ch.fen();
    this.current.moves.push(move.san);
    this.current.moveTimings.push(thinkMs);
    // The OTHER side now begins thinking — reset the timer.
    this.current.turnStartedAt = now;

    let ended = false;
    if (ch.isCheckmate()) {
      // chess.js's checkmate flips turn to the side that CAN'T move next.
      this.current.status = ch.turn() === "w" ? "black_won" : "white_won";
      ended = true;
    } else if (ch.isStalemate()) {
      this.current.status = "draw_stalemate";
      ended = true;
    } else if (ch.isThreefoldRepetition()) {
      this.current.status = "draw_threefold";
      ended = true;
    } else if (ch.isInsufficientMaterial()) {
      this.current.status = "draw_insufficient";
      ended = true;
    } else if (ch.isDraw()) {
      // Falls through to here for the 50-move rule and anything else
      // chess.js considers a draw that isn't above.
      this.current.status = "draw_other";
      ended = true;
    }
    if (ended) {
      this.current.endedAt = Date.now();
      this.archive();
    }
    this.scheduleSave();
    return { ok: true, game: this.current, ended };
  }

  resign(callerKey: string): { ok: true; game: ChessGame } | { ok: false; error: string } {
    this.load();
    if (!this.current || this.current.status !== "active") return { ok: false, error: "no_active_game" };
    // Self-play edge case: when whiteKey === blackKey (an AI playing
    // itself, mostly for testing) the naive "if caller===white" check
    // always marks the resignation as "white_resigned" regardless of
    // whose actual turn was stuck. Use the FEN's side-to-move to
    // disambiguate when the keys collide.
    if (this.current.whiteKey === this.current.blackKey) {
      if (callerKey !== this.current.whiteKey) return { ok: false, error: "not_a_player" };
      let side: "white" | "black" = "white";
      try {
        const ch = new Chess();
        ch.load(this.current.fen);
        side = ch.turn() === "w" ? "white" : "black";
      } catch {
        /* fall through with default */
      }
      this.current.status = side === "white" ? "white_resigned" : "black_resigned";
    } else if (callerKey === this.current.whiteKey) {
      this.current.status = "white_resigned";
    } else if (callerKey === this.current.blackKey) {
      this.current.status = "black_resigned";
    } else {
      return { ok: false, error: "not_a_player" };
    }
    this.current.endedAt = Date.now();
    this.archive();
    this.scheduleSave();
    return { ok: true, game: this.current };
  }

  /** Wipe the current game so the lobby reopens. Works whether the game
   *  is finished OR still active — an active game being cleared is an
   *  "abort" (no winner recorded, nothing appended to history). */
  clearGame(): { ok: true; aborted: boolean } {
    this.load();
    const wasActive = !!this.current && this.current.status === "active";
    this.current = null;
    this.scheduleSave();
    return { ok: true, aborted: wasActive };
  }

  private archive(): void {
    if (!this.current || this.current.status === "active") return;
    this.history = [
      {
        whiteKey: this.current.whiteKey,
        blackKey: this.current.blackKey,
        whiteLabel: this.current.whiteLabel,
        blackLabel: this.current.blackLabel,
        status: this.current.status as Exclude<ChessGameStatus, "active">,
        startedAt: this.current.startedAt,
        endedAt: this.current.endedAt ?? Date.now(),
        moveCount: this.current.moves.length,
      },
      ...this.history,
    ].slice(0, HISTORY_CAP);
  }
}

// Server-authoritative chess game state.
//
// One active game at a time across the whole mesh (singleton, like the
// music player). The relay owns the truth: every move is validated
// here against chess.js, then broadcast to peers as a fresh snapshot.
// Clients never trust each other — they trust this module.
//
// Players are identified by `ownerKey` (lowercased address or handle,
// same scheme publications + cursors use). That key is stable across
// reconnects, so a player can drop offline mid-game and resume.
//
// Game state + recent history persist to disk; survives relay restart.

import { Chess } from "chess.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

const CHESS_PATH = process.env.CHESS_PATH ?? "/var/lib/slop-relay/chess.json";
const HISTORY_CAP = 50;

let current: ChessGame | null = null;
let history: ChessResult[] = [];

(function load() {
  try {
    const raw = readFileSync(CHESS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { current?: ChessGame | null; history?: ChessResult[] };
    if (parsed.current && typeof parsed.current === "object") current = parsed.current;
    if (Array.isArray(parsed.history)) history = parsed.history.slice(0, HISTORY_CAP);
  } catch {
    /* fresh start, no file on disk yet */
  }
})();

let saveQueued = false;
function scheduleSave(): void {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    try {
      mkdirSync(dirname(CHESS_PATH), { recursive: true });
      writeFileSync(CHESS_PATH, JSON.stringify({ current, history }));
    } catch (err) {
      console.error("[chess] failed to persist:", err);
    }
  });
}

export function getCurrentGame(): ChessGame | null {
  return current;
}

export function getHistory(): ChessResult[] {
  return history.slice();
}

export type CreateGameArgs = {
  whiteKey: string;
  blackKey: string;
  whiteLabel: string;
  blackLabel: string;
};

export function createGame(args: CreateGameArgs): { ok: true; game: ChessGame } | { ok: false; error: string } {
  if (current && current.status === "active") return { ok: false, error: "game_already_active" };
  if (!args.whiteKey || !args.blackKey) return { ok: false, error: "missing_player" };
  const game: ChessGame = {
    whiteKey: args.whiteKey,
    blackKey: args.blackKey,
    whiteLabel: args.whiteLabel || args.whiteKey,
    blackLabel: args.blackLabel || args.blackKey,
    fen: new Chess().fen(),
    moves: [],
    status: "active",
    startedAt: Date.now(),
  };
  current = game;
  scheduleSave();
  return { ok: true, game };
}

export type MoveArgs = { from: string; to: string; promotion?: string };

export type MoveOutcome = { ok: true; game: ChessGame; ended: boolean } | { ok: false; error: string };

export function applyMove(callerKey: string, args: MoveArgs): MoveOutcome {
  if (!current || current.status !== "active") return { ok: false, error: "no_active_game" };
  const ch = new Chess(current.fen);
  const turn = ch.turn(); // "w" | "b"
  const expected = turn === "w" ? current.whiteKey : current.blackKey;
  if (callerKey !== expected) return { ok: false, error: "not_your_turn" };
  let move;
  try {
    move = ch.move({ from: args.from, to: args.to, promotion: args.promotion ?? "q" });
  } catch {
    return { ok: false, error: "illegal_move" };
  }
  if (!move) return { ok: false, error: "illegal_move" };
  current.fen = ch.fen();
  current.moves.push(move.san);

  let ended = false;
  if (ch.isCheckmate()) {
    // chess.js's checkmate flips turn to the side that CAN'T move next.
    current.status = ch.turn() === "w" ? "black_won" : "white_won";
    ended = true;
  } else if (ch.isStalemate()) {
    current.status = "draw_stalemate";
    ended = true;
  } else if (ch.isThreefoldRepetition()) {
    current.status = "draw_threefold";
    ended = true;
  } else if (ch.isInsufficientMaterial()) {
    current.status = "draw_insufficient";
    ended = true;
  } else if (ch.isDraw()) {
    // Falls through to here for the 50-move rule and anything else
    // chess.js considers a draw that isn't above.
    current.status = "draw_other";
    ended = true;
  }
  if (ended) {
    current.endedAt = Date.now();
    archive();
  }
  scheduleSave();
  return { ok: true, game: current, ended };
}

export function resign(callerKey: string): { ok: true; game: ChessGame } | { ok: false; error: string } {
  if (!current || current.status !== "active") return { ok: false, error: "no_active_game" };
  if (callerKey === current.whiteKey) current.status = "white_resigned";
  else if (callerKey === current.blackKey) current.status = "black_resigned";
  else return { ok: false, error: "not_a_player" };
  current.endedAt = Date.now();
  archive();
  scheduleSave();
  return { ok: true, game: current };
}

/** Wipe the current game so the lobby reopens. Works whether the game
 *  is finished OR still active — an active game being cleared is an
 *  "abort" (no winner recorded, nothing appended to history). The
 *  alternative (refusing to clear active games) leaves us stuck when
 *  both players walk away without resigning. */
export function clearGame(): { ok: true; aborted: boolean } {
  const wasActive = !!current && current.status === "active";
  current = null;
  scheduleSave();
  return { ok: true, aborted: wasActive };
}

function archive() {
  if (!current || current.status === "active") return;
  history = [
    {
      whiteKey: current.whiteKey,
      blackKey: current.blackKey,
      whiteLabel: current.whiteLabel,
      blackLabel: current.blackLabel,
      status: current.status as Exclude<ChessGameStatus, "active">,
      startedAt: current.startedAt,
      endedAt: current.endedAt ?? Date.now(),
      moveCount: current.moves.length,
    },
    ...history,
  ].slice(0, HISTORY_CAP);
}

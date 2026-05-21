"use client";

import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import type { ChessGame, ChessResult, Peer, PeerMeshState } from "~~/hooks/usePeerMesh";

// Multiplayer chess. Singleton across the mesh — there's only one game
// at a time, and the relay owns the truth. This component is just a
// view + input surface: it renders the board from `mesh.chessGame.fen`,
// and every user action (move, resign, create, close) goes through
// `mesh.chessMove(...)` etc. and waits for the server's echo.
//
// Visual orientation: if my ownerKey == the black player's, the board
// flips so black sits at the bottom. Everyone else (white player +
// audience) sees white at the bottom.
//
// Move input model: click your piece → legal-move targets light up →
// click a target. Click anywhere illegal to cancel. Pawn promotion
// silently defaults to queen for now (matches the relay's fallback).

type Props = {
  mesh: PeerMeshState;
  /** My stable ownerKey (lowercased address ?? handle ?? peerId). */
  myOwnerKey: string | null;
  /** Display label captured at game start (ENS, handle, or shortened address). */
  myLabel: string | null;
};

export const ChessWindow = ({ mesh, myOwnerKey, myLabel }: Props) => {
  const game = mesh.chessGame;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "linear-gradient(180deg, #0a0820 0%, #06030d 100%)",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-display)",
      }}
    >
      {game ? (
        <ActiveOrEnded mesh={mesh} game={game} myOwnerKey={myOwnerKey} />
      ) : (
        <Lobby mesh={mesh} myOwnerKey={myOwnerKey} myLabel={myLabel} />
      )}
    </div>
  );
};

// =====================================================================
// Lobby: no active game. Shows create-game form + recent history.
// =====================================================================

const Lobby = ({
  mesh,
  myOwnerKey,
  myLabel,
}: {
  mesh: PeerMeshState;
  myOwnerKey: string | null;
  myLabel: string | null;
}) => {
  // Build a "selectable identities" list = every connected peer + me +
  // every server-side AI player. Dedupe by ownerKey so a peer whose
  // peerId differs from their wallet address doesn't show twice.
  const options = useMemo(
    () => buildOptions(mesh.peers, myOwnerKey, myLabel, mesh.aiPlayers, mesh.customNames),
    [mesh.peers, myOwnerKey, myLabel, mesh.aiPlayers, mesh.customNames],
  );
  const [whiteKey, setWhiteKey] = useState<string>("");
  const [blackKey, setBlackKey] = useState<string>("");

  // Default selections: me as white, anyone else as black if available.
  useEffect(() => {
    if (!whiteKey && myOwnerKey) setWhiteKey(myOwnerKey);
    if (!blackKey) {
      const other = options.find(o => o.key !== myOwnerKey);
      if (other) setBlackKey(other.key);
    }
  }, [options, myOwnerKey, whiteKey, blackKey]);

  const canStart = whiteKey && blackKey;
  const start = () => {
    if (!canStart) return;
    const white = options.find(o => o.key === whiteKey);
    const black = options.find(o => o.key === blackKey);
    mesh.chessCreate({
      whiteKey,
      blackKey,
      whiteLabel: white?.label ?? whiteKey,
      blackLabel: black?.label ?? blackKey,
    });
  };

  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
      <h2
        style={{
          margin: 0,
          fontSize: 14,
          letterSpacing: "0.12em",
          color: "var(--slop-magenta, #ff3ec9)",
          textTransform: "uppercase",
        }}
      >
        New Game
      </h2>

      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span style={{ color: "var(--slop-cyan, #3fcfff)", letterSpacing: "0.08em" }}>WHITE</span>
        <PlayerSelect value={whiteKey} options={options} onChange={setWhiteKey} />
        <span style={{ color: "var(--slop-magenta, #ff3ec9)", letterSpacing: "0.08em" }}>BLACK</span>
        <PlayerSelect value={blackKey} options={options} onChange={setBlackKey} />
      </div>

      <button
        type="button"
        onClick={start}
        disabled={!canStart}
        className="slop-button slop-button--primary"
        style={{ alignSelf: "flex-start", padding: "6px 18px", opacity: canStart ? 1 : 0.45 }}
      >
        Start Game
      </button>

      <div
        style={{
          marginTop: 6,
          paddingTop: 10,
          borderTop: "1px solid rgba(255, 62, 201, 0.25)",
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 11,
            letterSpacing: "0.14em",
            color: "var(--slop-text-muted)",
            textTransform: "uppercase",
          }}
        >
          Recent Results ({mesh.chessHistory.length})
        </h3>
        {mesh.chessHistory.length === 0 ? (
          <p style={{ marginTop: 8, fontSize: 11, color: "var(--slop-text-muted)", fontStyle: "italic" }}>
            no games played yet
          </p>
        ) : (
          <div
            style={{
              marginTop: 8,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 200,
              overflowY: "auto",
            }}
          >
            {mesh.chessHistory.slice(0, 12).map((r, i) => (
              <ResultRow key={`${r.startedAt}-${i}`} result={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const PlayerSelect = ({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { key: string; label: string }[];
  onChange: (v: string) => void;
}) => (
  <select
    value={value}
    onChange={e => onChange(e.target.value)}
    style={{
      background: "#06030d",
      color: "var(--slop-text)",
      border: "1px solid rgba(255, 62, 201, 0.4)",
      fontFamily: "var(--slop-font-display)",
      fontSize: 12,
      padding: "4px 8px",
      borderRadius: 0,
    }}
  >
    <option value="">— pick a player —</option>
    {options.map(o => (
      <option key={o.key} value={o.key}>
        {o.label}
      </option>
    ))}
  </select>
);

const ResultRow = ({ result }: { result: ChessResult }) => {
  const winner = winnerLabel(result);
  const winColor = winner === result.whiteLabel ? "#3fcfff" : winner === result.blackLabel ? "#ff3ec9" : "#bcff5b";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        alignItems: "center",
        fontSize: 11,
        padding: "3px 6px",
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ color: "#3fcfff" }}>{result.whiteLabel}</span>
        <span style={{ color: "var(--slop-text-muted)" }}> vs </span>
        <span style={{ color: "#ff3ec9" }}>{result.blackLabel}</span>
      </span>
      <span style={{ color: winColor, letterSpacing: "0.06em", marginLeft: 8 }}>{winner}</span>
    </div>
  );
};

// =====================================================================
// Active + ended game: board + status + actions.
// =====================================================================

const ActiveOrEnded = ({
  mesh,
  game,
  myOwnerKey,
}: {
  mesh: PeerMeshState;
  game: ChessGame;
  myOwnerKey: string | null;
}) => {
  // chess.js is the source of truth for legal moves + side-to-move +
  // king-in-check rendering. We construct a fresh instance from the
  // FEN every render — chess.js is cheap (no async, no I/O).
  const chess = useMemo(() => {
    const ch = new Chess();
    try {
      ch.load(game.fen);
    } catch {
      /* should never happen — relay validates before broadcasting */
    }
    return ch;
  }, [game.fen]);

  const board = chess.board();
  const turn = chess.turn(); // "w" | "b"
  const isWhitePlayer = myOwnerKey != null && myOwnerKey === game.whiteKey;
  const isBlackPlayer = myOwnerKey != null && myOwnerKey === game.blackKey;
  const isPlayer = isWhitePlayer || isBlackPlayer;
  const myTurn = game.status === "active" && ((turn === "w" && isWhitePlayer) || (turn === "b" && isBlackPlayer));

  const flipped = isBlackPlayer;
  const ranks = flipped ? ["1", "2", "3", "4", "5", "6", "7", "8"] : ["8", "7", "6", "5", "4", "3", "2", "1"];
  const files = flipped ? ["h", "g", "f", "e", "d", "c", "b", "a"] : ["a", "b", "c", "d", "e", "f", "g", "h"];

  const [selected, setSelected] = useState<string | null>(null);
  // Held when a move triggers a pawn promotion — we don't fire the
  // mesh.chessMove call until the user has picked which piece. While
  // this is non-null, the picker overlay is rendered on top of the
  // board and click-on-square is suppressed.
  const [pendingPromotion, setPendingPromotion] = useState<{ from: string; to: string } | null>(null);

  // Drop the selection + any open picker any time the position changes
  // (server moved on) so we don't keep highlighting a stale square or
  // hold a picker for a move that no longer applies.
  useEffect(() => {
    setSelected(null);
    setPendingPromotion(null);
  }, [game.fen]);

  const legalMoves = useMemo(() => {
    if (!selected) return [] as { to: string; promotion?: string }[];
    try {
      return chess.moves({ square: selected as never, verbose: true }) as { to: string; promotion?: string }[];
    } catch {
      return [];
    }
  }, [selected, chess]);
  const legalTargets = useMemo(() => new Set(legalMoves.map(m => m.to)), [legalMoves]);

  // The king-in-check square: paint it red so the player can see why
  // their move was rejected, or that they need to respond.
  const checkSquare = useMemo(() => {
    if (game.status !== "active" || !chess.inCheck()) return null;
    const target = chess.turn(); // side in check is side to move
    for (let r = 0; r < 8; r++) {
      const row = board[r];
      if (!row) continue;
      for (let f = 0; f < 8; f++) {
        const sq = row[f];
        if (sq && sq.type === "k" && sq.color === target) {
          const file = "abcdefgh"[f]!;
          const rank = String(8 - r);
          return `${file}${rank}`;
        }
      }
    }
    return null;
  }, [chess, board, game.status]);

  const onSquareClick = (square: string) => {
    if (game.status !== "active") return;
    if (!isPlayer) return; // observers can't move
    if (!myTurn) return;
    if (pendingPromotion) return; // picker takes priority — pick or cancel first
    if (selected) {
      const m = legalMoves.find(x => x.to === square);
      if (m) {
        if (m.promotion) {
          // Hold the move open while the user picks a piece. We don't
          // call mesh.chessMove yet — the picker's button does that.
          setPendingPromotion({ from: selected, to: square });
          setSelected(null);
          return;
        }
        mesh.chessMove(selected, square);
        setSelected(null);
        return;
      }
      // Click on another piece of mine? Switch selection.
      const piece = chess.get(square as never);
      if (piece && ((piece.color === "w" && isWhitePlayer) || (piece.color === "b" && isBlackPlayer))) {
        setSelected(square);
        return;
      }
      setSelected(null);
      return;
    }
    const piece = chess.get(square as never);
    if (!piece) return;
    if ((piece.color === "w" && isWhitePlayer) || (piece.color === "b" && isBlackPlayer)) {
      setSelected(square);
    }
  };

  const whiteToMove = game.status === "active" && turn === "w";
  const blackToMove = game.status === "active" && turn === "b";
  const inCheck = game.status === "active" && chess.inCheck();
  const turnColor = turn === "w" ? "#3fcfff" : "#ff3ec9";
  const turnGlow = turn === "w" ? "rgba(63,207,255,0.6)" : "rgba(255,62,201,0.6)";

  const statusText = useMemo(() => {
    if (game.status === "active") {
      const sideLabel = turn === "w" ? game.whiteLabel : game.blackLabel;
      if (inCheck) return `${sideLabel} — IN CHECK`;
      return `${sideLabel} to move`;
    }
    return endStatusText(game);
  }, [game, turn, inCheck]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 8, gap: 8 }}>
      {/* Player banner — the side TO MOVE pops with a colored
          background, border, glow, and a pulsing dot. The other
          side fades back. Strong, instant "whose turn is it" cue
          even before you read the status line. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          letterSpacing: "0.06em",
        }}
      >
        <PlayerChip color="white" label={game.whiteLabel} active={whiteToMove} inCheck={inCheck && turn === "w"} />
        <span style={{ color: "var(--slop-text-muted)" }}>vs</span>
        <PlayerChip
          color="black"
          label={game.blackLabel}
          active={blackToMove}
          inCheck={inCheck && turn === "b"}
          alignRight
        />
      </div>

      {/* Per-side think-time counters: cumulative total + this turn
          in parens. Side-to-move's numbers tick live; the other
          side's are static (their last completed move). */}
      <ThinkTimeRow game={game} whiteToMove={whiteToMove} blackToMove={blackToMove} />

      {/* Board */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            // CSS aspect-ratio keeps the board square as the window resizes;
            // the min(...) clamps to whichever dimension is the bottleneck.
            position: "relative",
            aspectRatio: "1 / 1",
            width: "min(100%, calc(100% * 1))",
            maxWidth: "100%",
            maxHeight: "100%",
            display: "grid",
            gridTemplateColumns: "repeat(8, 1fr)",
            gridTemplateRows: "repeat(8, 1fr)",
            // Border colored by side-to-move: cyan when white's
            // turn, magenta when black's. Glows brighter on your
            // own turn to reinforce "go" vs "wait".
            border: `2px solid ${turnColor}`,
            boxShadow: `0 0 ${myTurn ? 24 : 12}px ${turnGlow}`,
            // If I'm a player and it's NOT my turn, dim the board so
            // a glance is enough to know I can't move. Observers see
            // the board at full opacity always.
            opacity: isPlayer && !myTurn && game.status === "active" ? 0.55 : 1,
            transition: "opacity 200ms ease, box-shadow 200ms ease, border-color 200ms ease",
          }}
        >
          {ranks.map((rank, rIdx) =>
            files.map((file, fIdx) => {
              const square = `${file}${rank}`;
              // chess.js board is [rank 8 → rank 1], so we have to look up by file/rank.
              // For each square, find which board row/col it corresponds to.
              const rankIdx = 8 - parseInt(rank, 10);
              const fileIdx = "abcdefgh".indexOf(file);
              const cell = board[rankIdx]?.[fileIdx] ?? null;
              const dark = (rIdx + fIdx) % 2 === 1;
              const isSelected = selected === square;
              const isLegal = legalTargets.has(square);
              const isCheck = checkSquare === square;
              return (
                <Square
                  key={square}
                  square={square}
                  cell={cell}
                  dark={dark}
                  isSelected={isSelected}
                  isLegal={isLegal}
                  isCheck={isCheck}
                  clickable={myTurn && game.status === "active"}
                  showFileLabel={rIdx === 7}
                  showRankLabel={fIdx === 0}
                  onClick={onSquareClick}
                />
              );
            }),
          )}

          {pendingPromotion ? (
            <PromotionPicker
              color={turn}
              onPick={piece => {
                mesh.chessMove(pendingPromotion.from, pendingPromotion.to, piece);
                setPendingPromotion(null);
              }}
              onCancel={() => setPendingPromotion(null)}
            />
          ) : null}
        </div>
      </div>

      {/* Status bar + actions. The status text takes the to-move
          color so it visually agrees with the player chip + board
          border above. Bold + bigger for an unmissable read. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        <span
          style={{
            color: game.status === "active" ? turnColor : "var(--slop-text-muted)",
            textShadow: game.status === "active" ? `0 0 6px ${turnGlow}` : "none",
            fontWeight: 600,
          }}
        >
          {statusText}
          {myTurn ? <span style={{ color: "var(--slop-lime, #bcff5b)", marginLeft: 8 }}>(YOU)</span> : null}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          {/* Resign records a loss + appends history — only the actual
              players can do that for themselves. */}
          {game.status === "active" && isPlayer ? (
            <button
              type="button"
              onClick={() => {
                if (confirm("Resign the game?")) mesh.chessResign();
              }}
              className="slop-button"
              style={{ padding: "4px 12px", fontSize: 11 }}
            >
              Resign
            </button>
          ) : null}
          {/* Abort wipes the slot without recording a result. Any
              authenticated peer can do it — covers AI-vs-AI games
              that never end, two players who walked away, or the
              wrong people getting picked at game-start. */}
          {game.status === "active" ? (
            <button
              type="button"
              onClick={() => {
                if (confirm("Abort this game? No result will be recorded.")) mesh.chessCloseGame();
              }}
              className="slop-button"
              style={{ padding: "4px 12px", fontSize: 11 }}
            >
              Abort
            </button>
          ) : (
            <button
              type="button"
              onClick={() => mesh.chessCloseGame()}
              className="slop-button slop-button--primary"
              style={{ padding: "4px 12px", fontSize: 11 }}
            >
              New Game
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const Square = ({
  square,
  cell,
  dark,
  isSelected,
  isLegal,
  isCheck,
  clickable,
  showFileLabel,
  showRankLabel,
  onClick,
}: {
  square: string;
  cell: { type: string; color: "w" | "b" } | null;
  dark: boolean;
  isSelected: boolean;
  isLegal: boolean;
  isCheck: boolean;
  clickable: boolean;
  showFileLabel: boolean;
  showRankLabel: boolean;
  onClick: (square: string) => void;
}) => {
  const base = dark ? "#1a1140" : "#2a1f5a";
  const bg = isCheck
    ? "rgba(255, 85, 119, 0.55)"
    : isSelected
      ? "rgba(255, 62, 201, 0.55)"
      : isLegal
        ? "rgba(63, 207, 255, 0.18)"
        : base;
  const glyph = cell ? PIECE_GLYPH[cell.color === "w" ? cell.type.toUpperCase() : cell.type] : "";
  const isWhitePiece = cell?.color === "w";
  return (
    <div
      onClick={() => onClick(square)}
      style={{
        position: "relative",
        background: bg,
        border: isSelected ? "1px solid var(--slop-magenta, #ff3ec9)" : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        userSelect: "none",
      }}
    >
      {/* Legal-move dot for empty target squares; a thin ring for captures */}
      {isLegal && !cell ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            width: "30%",
            height: "30%",
            borderRadius: "50%",
            background: "rgba(63, 207, 255, 0.6)",
            boxShadow: "0 0 6px rgba(63, 207, 255, 0.5)",
            pointerEvents: "none",
          }}
        />
      ) : null}
      {isLegal && cell ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: "8%",
            borderRadius: "50%",
            border: "2px solid rgba(63, 207, 255, 0.55)",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* Piece glyph */}
      {glyph ? (
        <span
          style={{
            fontSize: "clamp(18px, 6vw, 38px)",
            lineHeight: 1,
            color: isWhitePiece ? "#e0f4ff" : "#1a0a1a",
            textShadow: isWhitePiece
              ? "0 0 8px rgba(63, 207, 255, 0.85), 0 1px 0 rgba(0,0,0,0.6)"
              : "0 0 8px rgba(255, 62, 201, 0.85), 0 1px 0 rgba(255,255,255,0.2)",
            pointerEvents: "none",
          }}
        >
          {glyph}
        </span>
      ) : null}

      {/* Coordinate labels along edges */}
      {showFileLabel ? <CoordLabel pos="bottomRight">{square[0]}</CoordLabel> : null}
      {showRankLabel ? <CoordLabel pos="topLeft">{square[1]}</CoordLabel> : null}

      {/* Hover hint */}
      {clickable ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
          }}
        />
      ) : null}
    </div>
  );
};

const CoordLabel = ({ pos, children }: { pos: "bottomRight" | "topLeft"; children: string }) => (
  <span
    style={{
      position: "absolute",
      [pos === "bottomRight" ? "bottom" : "top"]: 1,
      [pos === "bottomRight" ? "right" : "left"]: 3,
      fontSize: 8,
      color: "rgba(255, 255, 255, 0.35)",
      pointerEvents: "none",
    }}
  >
    {children}
  </span>
);

// =====================================================================
// Player chip — header banner per player. The chip for the side TO
// MOVE pops with a colored fill, border, glow, and a pulsing dot;
// the other side fades back. Overrides cleanly read at a glance.
// =====================================================================

// Per-side timing row. Format: "total (this turn)" — e.g. "12.4s (4.2s)".
// Side-to-move's numbers tick live (re-render every 200ms); the other
// side's are static (their last completed move time).
const ThinkTimeRow = ({
  game,
  whiteToMove,
  blackToMove,
}: {
  game: ChessGame;
  whiteToMove: boolean;
  blackToMove: boolean;
}) => {
  // Re-render at 5Hz so the live counters tick. Cheap — a single
  // setState on a small component, no canvas / DOM recomputes
  // beyond the two text spans.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (game.status !== "active") return;
    const id = window.setInterval(() => setTick(t => t + 1), 200);
    return () => window.clearInterval(id);
  }, [game.status]);

  const timings = game.moveTimings ?? [];
  // Even indices = white moves (0, 2, 4 …). Odd = black.
  let whiteTotal = 0;
  let blackTotal = 0;
  let whiteLast = 0;
  let blackLast = 0;
  for (let i = 0; i < timings.length; i++) {
    const t = timings[i] ?? 0;
    if (i % 2 === 0) {
      whiteTotal += t;
      whiteLast = t;
    } else {
      blackTotal += t;
      blackLast = t;
    }
  }

  const liveTurn = game.status === "active" ? Math.max(0, Date.now() - (game.turnStartedAt ?? game.startedAt)) : 0;
  const whiteThisTurn = whiteToMove ? liveTurn : whiteLast;
  const blackThisTurn = blackToMove ? liveTurn : blackLast;
  const whiteTotalLive = whiteToMove ? whiteTotal + liveTurn : whiteTotal;
  const blackTotalLive = blackToMove ? blackTotal + liveTurn : blackTotal;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        alignItems: "center",
        gap: 6,
        padding: "0 4px",
        fontSize: 9,
        color: "var(--slop-text-muted)",
        letterSpacing: "0.04em",
      }}
    >
      <span style={{ color: whiteToMove ? "#3fcfff" : undefined }}>
        {fmtThink(whiteTotalLive)} <span style={{ opacity: 0.7 }}>({fmtThink(whiteThisTurn)})</span>
      </span>
      <span />
      <span style={{ color: blackToMove ? "#ff3ec9" : undefined, textAlign: "right" }}>
        {fmtThink(blackTotalLive)} <span style={{ opacity: 0.7 }}>({fmtThink(blackThisTurn)})</span>
      </span>
    </div>
  );
};

const fmtThink = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const totalSec = Math.floor(s);
  const m = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (m < 60) return `${m}m ${remSec}s`;
  const h = Math.floor(m / 60);
  const remMin = m % 60;
  return `${h}h ${remMin}m`;
};

const PlayerChip = ({
  color,
  label,
  active,
  inCheck,
  alignRight = false,
}: {
  color: "white" | "black";
  label: string;
  active: boolean;
  inCheck: boolean;
  alignRight?: boolean;
}) => {
  const accent = color === "white" ? "#3fcfff" : "#ff3ec9";
  const accentSoft = color === "white" ? "rgba(63,207,255,0.18)" : "rgba(255,62,201,0.22)";
  const accentGlow = color === "white" ? "rgba(63,207,255,0.7)" : "rgba(255,62,201,0.7)";
  const king = color === "white" ? "♔" : "♚";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        fontSize: 11,
        letterSpacing: "0.06em",
        color: active ? "#fff" : accent,
        background: active ? accentSoft : "transparent",
        border: `1px solid ${active ? accent : "transparent"}`,
        boxShadow: active ? `0 0 10px ${accentGlow}` : "none",
        textShadow: active ? `0 0 6px ${accentGlow}` : "none",
        fontWeight: active ? 600 : 400,
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        justifySelf: alignRight ? "end" : "start",
        flexDirection: alignRight ? "row-reverse" : "row",
      }}
    >
      <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
        {king}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {active ? (
        <span
          aria-hidden
          className="slop-chess-pulse"
          style={{
            width: 6,
            height: 6,
            background: accent,
            boxShadow: `0 0 6px ${accent}`,
          }}
        />
      ) : null}
      {inCheck ? (
        <span
          style={{
            fontSize: 9,
            padding: "1px 4px",
            background: "var(--slop-red, #ff5577)",
            color: "#fff",
            letterSpacing: "0.08em",
            marginLeft: 2,
          }}
        >
          CHK
        </span>
      ) : null}
    </span>
  );
};

// =====================================================================
// Promotion picker — overlaid on the board when a pawn move would
// promote. Renders the four legal piece choices in the moving side's
// color; click to commit, click the X (or anywhere outside) to cancel.
// =====================================================================

const PROMOTION_CHOICES: { piece: "q" | "r" | "b" | "n"; label: string }[] = [
  { piece: "q", label: "queen" },
  { piece: "r", label: "rook" },
  { piece: "b", label: "bishop" },
  { piece: "n", label: "knight" },
];

const PromotionPicker = ({
  color,
  onPick,
  onCancel,
}: {
  color: "w" | "b";
  onPick: (piece: "q" | "r" | "b" | "n") => void;
  onCancel: () => void;
}) => {
  const isWhite = color === "w";
  const glow = isWhite ? "rgba(63, 207, 255, 0.85)" : "rgba(255, 62, 201, 0.85)";
  const ink = isWhite ? "#e0f4ff" : "#1a0a1a";
  return (
    <>
      {/* Click-outside scrim — covers the whole board. Clicking anywhere
          off the picker dismisses without moving. */}
      <div
        onClick={onCancel}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(2px)",
          zIndex: 5,
        }}
      />
      <div
        // Centered inside the board. Use grid 1×4 so the pieces line up
        // in a single row regardless of board size.
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 4,
          padding: 8,
          background: "linear-gradient(180deg, #1a1140 0%, #06030d 100%)",
          border: "2px solid var(--slop-magenta, #ff3ec9)",
          boxShadow: "0 0 24px rgba(255, 62, 201, 0.6)",
          zIndex: 6,
          minWidth: "60%",
        }}
      >
        {PROMOTION_CHOICES.map(c => {
          const glyph = PIECE_GLYPH[isWhite ? c.piece.toUpperCase() : c.piece];
          return (
            <button
              key={c.piece}
              type="button"
              onClick={() => onPick(c.piece)}
              aria-label={`promote to ${c.label}`}
              title={c.label}
              style={{
                aspectRatio: "1 / 1",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255, 62, 201, 0.4)",
                color: ink,
                fontSize: "clamp(22px, 5vw, 40px)",
                lineHeight: 1,
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                textShadow: `0 0 8px ${glow}, 0 1px 0 rgba(0,0,0,0.6)`,
                borderRadius: 0,
              }}
            >
              {glyph}
            </button>
          );
        })}
      </div>
      {/* Tiny "promote to:" label above the row, plus an X cancel pin
          in the corner. Both purely cosmetic. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, calc(-50% - 56px))",
          fontSize: 10,
          letterSpacing: "0.12em",
          color: "var(--slop-text-muted)",
          textTransform: "uppercase",
          zIndex: 7,
          pointerEvents: "none",
        }}
      >
        Promote to
      </div>
    </>
  );
};

// =====================================================================
// Helpers
// =====================================================================

const PIECE_GLYPH: Record<string, string> = {
  P: "♙",
  R: "♖",
  N: "♘",
  B: "♗",
  Q: "♕",
  K: "♔",
  p: "♟",
  r: "♜",
  n: "♞",
  b: "♝",
  q: "♛",
  k: "♚",
};

const peerKey = (p: Peer) => (p.address ?? p.handle ?? p.id).toLowerCase();
const peerLabel = (p: Peer, customNames: Record<string, string>) => {
  const custom = p.address ? customNames[p.address.toLowerCase()] : undefined;
  if (custom) return custom;
  return p.handle ?? (p.address ? `${p.address.slice(0, 6)}…${p.address.slice(-4)}` : p.id.slice(0, 6));
};

function buildOptions(
  peers: Peer[],
  myKey: string | null,
  myLabel: string | null,
  aiPlayers: { ownerKey: string; label: string }[] = [],
  customNames: Record<string, string> = {},
) {
  const map = new Map<string, { key: string; label: string }>();
  // Me first if known, then other connected humans.
  if (myKey) {
    const myCustom = customNames[myKey.toLowerCase()];
    map.set(myKey, { key: myKey, label: myCustom ?? myLabel ?? myKey });
  }
  for (const p of peers) {
    const k = peerKey(p);
    if (map.has(k)) continue;
    map.set(k, { key: k, label: peerLabel(p, customNames) });
  }
  // Then the server-side AI roster — labels already carry a 🤖 marker
  // in the registry config, so the dropdown reads them as obviously bot.
  for (const ai of aiPlayers) {
    if (map.has(ai.ownerKey)) continue;
    map.set(ai.ownerKey, { key: ai.ownerKey, label: ai.label });
  }
  return [...map.values()];
}

function winnerLabel(r: ChessResult): string {
  switch (r.status) {
    case "white_won":
    case "black_resigned":
      return r.whiteLabel;
    case "black_won":
    case "white_resigned":
      return r.blackLabel;
    default:
      return "draw";
  }
}

function endStatusText(g: ChessGame): string {
  switch (g.status) {
    case "white_won":
      return `${g.whiteLabel} wins by checkmate`;
    case "black_won":
      return `${g.blackLabel} wins by checkmate`;
    case "white_resigned":
      return `${g.whiteLabel} resigned — ${g.blackLabel} wins`;
    case "black_resigned":
      return `${g.blackLabel} resigned — ${g.whiteLabel} wins`;
    case "draw_stalemate":
      return "draw by stalemate";
    case "draw_threefold":
      return "draw by threefold repetition";
    case "draw_insufficient":
      return "draw — insufficient material";
    case "draw_other":
      return "draw";
    default:
      return "";
  }
}

export default ChessWindow;

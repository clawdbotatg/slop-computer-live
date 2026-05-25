"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PeerMeshState, PongSide, PongState } from "~~/hooks/usePeerMesh";

// Multiplayer Pong. Server is authoritative for ball + score; clients
// own only their own paddle's Y position. Two seats, claimed on a
// first-come basis — when both are full the relay starts the physics
// loop and broadcasts the ball at 30Hz.
//
// Keyboard: W/S or Up/Down moves your paddle. Local optimistic paddle
// position keeps input snappy; the next server snapshot reconciles.
// Spectators (3rd+ peer with the window open) see the live game with
// a "spectating" banner and can't claim a seat until someone leaves.

const PADDLE_STEP_PER_SEC = 540; // px/sec for held-key paddle speed
const PADDLE_SEND_HZ = 30; // network rate-limit on paddle updates

type Props = { mesh: PeerMeshState };

export const PongWindow = ({ mesh }: Props) => {
  const { pongState, myPongSeat, pongClaim, pongRelease, pongPaddle, pongReset } = mesh;
  const { field } = pongState;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Local optimistic paddle Y. We keep our own paddle here so input
  // response feels instant; the server's broadcast reconciles when it
  // arrives. For the OTHER side we just render the server value.
  const localPaddleRef = useRef<number>(field.h / 2);
  // Held keys; integrated each animation frame so two simultaneous
  // presses cancel naturally and a held key moves smoothly.
  const heldKeysRef = useRef<Set<string>>(new Set());
  const lastSentAtRef = useRef<number>(0);
  const lastSentValueRef = useRef<number>(-1);
  const seatRef = useRef<PongSide | null>(myPongSeat);
  const fieldRef = useRef(field);
  const pongPaddleRef = useRef(pongPaddle);
  // Latest pongState in a ref so the RAF loop can read it without
  // restarting every server tick (~30Hz). Restarting the loop on
  // every snapshot dropped frames mid-integration and contributed to
  // visible paddle jitter.
  const pongStateRef = useRef(pongState);

  useEffect(() => {
    seatRef.current = myPongSeat;
  }, [myPongSeat]);
  useEffect(() => {
    fieldRef.current = field;
  }, [field]);
  useEffect(() => {
    pongPaddleRef.current = pongPaddle;
  }, [pongPaddle]);
  useEffect(() => {
    pongStateRef.current = pongState;
  }, [pongState]);

  // Reset the local paddle on seat acquisition / loss. We intentionally
  // do NOT reconcile against `pongState.paddles[myPongSeat]` on every
  // server snapshot: the server's record of OUR paddle lags our input
  // by ~1 RTT, so adopting it mid-move snaps us backwards. The local
  // ref is the single source of truth for our own paddle while seated;
  // the server's stored value only matters for what the OPPONENT sees.
  useEffect(() => {
    localPaddleRef.current = fieldRef.current.h / 2;
    // Make sure the next move forces a send (the throttle's "value
    // changed" check would otherwise debounce the reset).
    lastSentValueRef.current = -1;
  }, [myPongSeat]);

  // Keyboard input — only attach when the window is focused / hovered.
  // We listen on document but only act on the keys we care about.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!seatRef.current) return;
      const k = e.key;
      if (k === "w" || k === "W" || k === "s" || k === "S" || k === "ArrowUp" || k === "ArrowDown") {
        heldKeysRef.current.add(k);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      heldKeysRef.current.delete(e.key);
    };
    const onBlur = () => heldKeysRef.current.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Animation loop: integrate paddle input + repaint canvas every frame.
  useEffect(() => {
    let raf = 0;
    let prevT = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - prevT) / 1000); // cap so a stalled tab doesn't fling the paddle
      prevT = t;
      // Integrate input
      const seat = seatRef.current;
      if (seat) {
        let dir = 0;
        if (heldKeysRef.current.has("w") || heldKeysRef.current.has("W") || heldKeysRef.current.has("ArrowUp"))
          dir -= 1;
        if (heldKeysRef.current.has("s") || heldKeysRef.current.has("S") || heldKeysRef.current.has("ArrowDown"))
          dir += 1;
        if (dir !== 0) {
          const f = fieldRef.current;
          const halfH = f.paddleH / 2;
          localPaddleRef.current = Math.min(
            f.h - halfH,
            Math.max(halfH, localPaddleRef.current + dir * PADDLE_STEP_PER_SEC * dt),
          );
          // Throttle network updates to PADDLE_SEND_HZ; always send the
          // latest value when the throttle window expires.
          const sendIntervalMs = 1000 / PADDLE_SEND_HZ;
          if (t - lastSentAtRef.current >= sendIntervalMs && lastSentValueRef.current !== localPaddleRef.current) {
            lastSentAtRef.current = t;
            lastSentValueRef.current = localPaddleRef.current;
            pongPaddleRef.current(localPaddleRef.current);
          }
        }
      }
      paint(canvasRef.current, pongStateRef.current, seat, localPaddleRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Resize the canvas to fit the container while preserving aspect.
  const [canvasSize, setCanvasSize] = useState({ w: field.w, h: field.h });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const aspect = field.w / field.h;
        let w = width;
        let h = w / aspect;
        if (h > height) {
          h = height;
          w = h * aspect;
        }
        setCanvasSize({ w: Math.floor(w), h: Math.floor(h) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [field.w, field.h]);

  const seatsTaken = (pongState.seats.left ? 1 : 0) + (pongState.seats.right ? 1 : 0);
  const canJoin = !myPongSeat && seatsTaken < 2;
  const statusLine = buildStatusLine(pongState, myPongSeat);

  const onJoinClick = useCallback(() => pongClaim(), [pongClaim]);
  const onLeaveClick = useCallback(() => pongRelease(), [pongRelease]);
  const onResetClick = useCallback(() => pongReset(), [pongReset]);

  return (
    <div className="flex h-full w-full flex-col gap-2 bg-black p-3 text-white">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-widest text-white/70">
        <div className="flex items-baseline gap-3">
          <SeatLabel side="left" seat={pongState.seats.left} mySeat={myPongSeat} />
          <span className="font-mono text-2xl text-white">
            {pongState.score.left} : {pongState.score.right}
          </span>
          <SeatLabel side="right" seat={pongState.seats.right} mySeat={myPongSeat} />
        </div>
        <div className="flex items-center gap-2">
          {canJoin && (
            <button
              type="button"
              onClick={onJoinClick}
              className="rounded border border-white/40 bg-white/10 px-2 py-1 text-[10px] uppercase tracking-widest hover:bg-white/20"
            >
              Join
            </button>
          )}
          {myPongSeat && (
            <button
              type="button"
              onClick={onLeaveClick}
              className="rounded border border-white/40 bg-white/10 px-2 py-1 text-[10px] uppercase tracking-widest hover:bg-white/20"
            >
              Leave
            </button>
          )}
          {pongState.status === "ended" && myPongSeat && (
            <button
              type="button"
              onClick={onResetClick}
              className="rounded border border-[var(--slop-cyan)] bg-[var(--slop-cyan)]/20 px-2 py-1 text-[10px] uppercase tracking-widest text-[var(--slop-cyan)] hover:bg-[var(--slop-cyan)]/30"
            >
              Play Again
            </button>
          )}
        </div>
      </div>
      <div ref={containerRef} className="relative flex flex-1 items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          width={field.w}
          height={field.h}
          style={{ width: canvasSize.w, height: canvasSize.h, imageRendering: "pixelated" }}
          className="bg-black"
        />
        {statusLine && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded bg-black/70 px-4 py-2 text-center font-mono text-sm uppercase tracking-widest text-white">
              {statusLine}
            </div>
          </div>
        )}
      </div>
      <div className="text-center font-mono text-[10px] uppercase tracking-widest text-white/50">
        W/S or ↑/↓ — first to 11
      </div>
    </div>
  );
};

function SeatLabel({
  side,
  seat,
  mySeat,
}: {
  side: PongSide;
  seat: { handle: string } | null;
  mySeat: PongSide | null;
}) {
  const isMe = mySeat === side;
  const label = seat ? seat.handle : "open seat";
  return (
    <span
      className={`font-mono text-[11px] ${seat ? (isMe ? "text-[var(--slop-cyan)]" : "text-white") : "text-white/40"}`}
    >
      {label}
      {isMe && " (you)"}
    </span>
  );
}

function buildStatusLine(state: PongState, mySeat: PongSide | null): string {
  if (state.status === "ended") {
    return `${state.winner === "left" ? "LEFT" : "RIGHT"} WINS — ${mySeat ? "press play again" : "waiting for rematch"}`;
  }
  if (state.status === "waiting") {
    if (!state.seats.left && !state.seats.right) return "Press Join to take a seat";
    return "Waiting for player 2…";
  }
  if (state.status === "serving") {
    const ms = Math.max(0, state.serveAt - Date.now());
    if (ms > 0) {
      const secs = Math.ceil(ms / 1000);
      return `Serve in ${secs}…`;
    }
    return "GO";
  }
  return "";
}

function paint(canvas: HTMLCanvasElement | null, state: PongState, mySeat: PongSide | null, localPaddleY: number) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const f = state.field;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, f.w, f.h);

  // Center dashed line
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 12]);
  ctx.beginPath();
  ctx.moveTo(f.w / 2, 0);
  ctx.lineTo(f.w / 2, f.h);
  ctx.stroke();
  ctx.setLineDash([]);

  // Paddles. For our own paddle render the local optimistic value; for
  // the opponent render the server's snapshot.
  ctx.fillStyle = "#fff";
  const leftY = mySeat === "left" ? localPaddleY : state.paddles.left;
  const rightY = mySeat === "right" ? localPaddleY : state.paddles.right;
  drawPaddle(ctx, f.paddleInset - f.paddleW / 2, leftY - f.paddleH / 2, f.paddleW, f.paddleH);
  drawPaddle(ctx, f.w - f.paddleInset - f.paddleW / 2, rightY - f.paddleH / 2, f.paddleW, f.paddleH);

  // Ball (only render during playing; during serving the ball sits at
  // center and the status overlay tells the user what's happening)
  if (state.status === "playing" || state.status === "serving") {
    ctx.beginPath();
    ctx.arc(state.ball.x, state.ball.y, f.ballR, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPaddle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillRect(x, y, w, h);
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PeerMeshState, WormColor, WormDir, WormState } from "~~/hooks/usePeerMesh";

// Multiplayer Worm (snake). The relay owns the entire grid simulation —
// movement, food, collisions, respawns — and broadcasts the whole board
// once per move tick (~8 Hz). Clients never simulate; they render the
// server snapshot with light interpolation between ticks so the chunky
// grid steps read as smooth slithering, and send only their own desired
// direction on each turn.
//
// Up to 4 worms, one per classic slop accent. Eat the amber food orbs to
// grow; walls / yourself / other worms kill you (you respawn small after
// a beat); first worm to the win length takes the round.
//
// Keyboard: Arrow keys or WASD steer your worm. Like Pong, the input
// listener is global but gated on holding a seat, and reads the live
// snapshot via refs so the render loop never tears down mid-tick.

// Canvas colors mirror the --slop-* palette (globals.css). Canvas can't
// read CSS vars, so the hexes are inlined here; the DOM scoreboard uses
// the same values via WORM_HEX to stay in lockstep.
const WORM_HEX: Record<WormColor, string> = {
  cyan: "#3fcfff",
  magenta: "#ff3ec9",
  lime: "#bcff5b",
  purple: "#7c4dff",
};
const FOOD_HEX = "#ffae00"; // --slop-amber
const GRID_HEX = "rgba(124, 77, 255, 0.10)"; // faint purple grid

type Props = { mesh: PeerMeshState };

export const WormWindow = ({ mesh }: Props) => {
  const { wormState, myWormSlot, wormClaim, wormRelease, wormSetDir, wormReset } = mesh;
  const { field } = wormState;
  const pxW = field.cols * field.cell;
  const pxH = field.rows * field.cell;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Interpolation between the previous and current server snapshots. We
  // only advance `from → to` when the move-tick counter changes; off-tick
  // broadcasts (seat changes, reset) snap by setting both to the new
  // state. RAF reads these refs so the loop never restarts per snapshot.
  const fromRef = useRef<WormState>(wormState);
  const toRef = useRef<WormState>(wormState);
  const tStartRef = useRef<number>(performance.now());
  const mySlotRef = useRef<number | null>(myWormSlot);
  const setDirRef = useRef(wormSetDir);

  useEffect(() => {
    mySlotRef.current = myWormSlot;
  }, [myWormSlot]);
  useEffect(() => {
    setDirRef.current = wormSetDir;
  }, [wormSetDir]);

  // Feed each new snapshot into the interpolator.
  useEffect(() => {
    const prevTo = toRef.current;
    if (wormState.tick !== prevTo.tick) {
      fromRef.current = prevTo;
      toRef.current = wormState;
      tStartRef.current = performance.now();
    } else {
      // Same move-step (a join/leave/reset broadcast) — snap, don't slide.
      fromRef.current = wormState;
      toRef.current = wormState;
    }
  }, [wormState]);

  // Direction input — global listener, active only while seated.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (mySlotRef.current === null) return;
      let dir: WormDir | null = null;
      switch (e.key) {
        case "ArrowUp":
        case "w":
        case "W":
          dir = "up";
          break;
        case "ArrowDown":
        case "s":
        case "S":
          dir = "down";
          break;
        case "ArrowLeft":
        case "a":
        case "A":
          dir = "left";
          break;
        case "ArrowRight":
        case "d":
        case "D":
          dir = "right";
          break;
      }
      if (!dir) return;
      e.preventDefault();
      if (e.repeat) return; // one send per physical press; the worm keeps going
      setDirRef.current(dir);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Render loop.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      paint(canvasRef.current, fromRef.current, toRef.current, tStartRef.current, mySlotRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Fit the canvas to the container while preserving the board aspect.
  const [canvasSize, setCanvasSize] = useState({ w: pxW, h: pxH });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const aspect = pxW / pxH;
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
  }, [pxW, pxH]);

  const seatsTaken = wormState.players.filter(p => p).length;
  const canJoin = myWormSlot === null && seatsTaken < wormState.players.length;
  const winnerHandle = wormState.winner !== null ? (wormState.players[wormState.winner]?.handle ?? null) : null;
  const statusLine =
    wormState.status === "ended"
      ? `${winnerHandle ?? "someone"} WINS — ${myWormSlot !== null ? "press play again" : "waiting for rematch"}`
      : seatsTaken === 0
        ? "Press Join to drop a worm"
        : "";

  const onJoinClick = useCallback(() => wormClaim(), [wormClaim]);
  const onLeaveClick = useCallback(() => wormRelease(), [wormRelease]);
  const onResetClick = useCallback(() => wormReset(), [wormReset]);

  return (
    <div className="flex h-full w-full flex-col gap-2 bg-black p-3 text-white">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {wormState.players.map((p, slot) => (
            <SeatChip key={slot} slot={slot} player={p} mySlot={myWormSlot} />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canJoin && (
            <button
              type="button"
              onClick={onJoinClick}
              className="rounded border border-white/40 bg-white/10 px-2 py-1 text-[10px] uppercase tracking-widest hover:bg-white/20"
            >
              Join
            </button>
          )}
          {myWormSlot !== null && (
            <button
              type="button"
              onClick={onLeaveClick}
              className="rounded border border-white/40 bg-white/10 px-2 py-1 text-[10px] uppercase tracking-widest hover:bg-white/20"
            >
              Leave
            </button>
          )}
          {wormState.status === "ended" && myWormSlot !== null && (
            <button
              type="button"
              onClick={onResetClick}
              className="rounded border border-[var(--slop-lime)] bg-[var(--slop-lime)]/20 px-2 py-1 text-[10px] uppercase tracking-widest text-[var(--slop-lime)] hover:bg-[var(--slop-lime)]/30"
            >
              Play Again
            </button>
          )}
        </div>
      </div>
      <div ref={containerRef} className="relative flex flex-1 items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          width={pxW}
          height={pxH}
          style={{ width: canvasSize.w, height: canvasSize.h }}
          className="rounded bg-black"
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
        ↑↓←→ / WASD — eat the food, first to {field.winLen} wins
      </div>
    </div>
  );
};

function SeatChip({
  slot,
  player,
  mySlot,
}: {
  slot: number;
  player: WormState["players"][number];
  mySlot: number | null;
}) {
  const isMe = mySlot === slot;
  const color = player ? WORM_HEX[player.color] : "rgba(255,255,255,0.25)";
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px]">
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color, boxShadow: player ? `0 0 6px ${color}` : "none" }}
      />
      {player ? (
        <span style={{ color }}>
          {player.handle}
          {isMe && " (you)"} · {player.len}
        </span>
      ) : (
        <span className="text-white/40">open</span>
      )}
    </span>
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function paint(
  canvas: HTMLCanvasElement | null,
  from: WormState,
  to: WormState,
  tStart: number,
  mySlot: number | null,
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const f = to.field;
  const cell = f.cell;
  const w = f.cols * cell;
  const h = f.rows * cell;
  const alpha = Math.max(0, Math.min(1, (performance.now() - tStart) / f.moveMs));

  ctx.fillStyle = "#05030c";
  ctx.fillRect(0, 0, w, h);

  // Faint grid so the discrete board reads.
  ctx.strokeStyle = GRID_HEX;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= f.cols; x++) {
    ctx.moveTo(x * cell + 0.5, 0);
    ctx.lineTo(x * cell + 0.5, h);
  }
  for (let y = 0; y <= f.rows; y++) {
    ctx.moveTo(0, y * cell + 0.5);
    ctx.lineTo(w, y * cell + 0.5);
  }
  ctx.stroke();

  // Food orbs — amber, gently pulsing.
  const pulse = 1 + 0.12 * Math.sin(performance.now() / 220);
  ctx.fillStyle = FOOD_HEX;
  ctx.shadowColor = FOOD_HEX;
  ctx.shadowBlur = 10;
  for (const food of to.food) {
    ctx.beginPath();
    ctx.arc(food.x * cell + cell / 2, food.y * cell + cell / 2, cell * 0.34 * pulse, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // Worms.
  for (let slot = 0; slot < to.players.length; slot++) {
    const tp = to.players[slot];
    if (!tp || !tp.alive || tp.body.length === 0) continue;
    const fp = from.players[slot];
    const fpUsable = !!fp && fp.alive && fp.body.length > 0;
    const color = WORM_HEX[tp.color];

    // Interpolated segment centers (head first).
    const pts = tp.body.map((toCell, i) => {
      const fromCell = fpUsable ? (fp.body[i] ?? toCell) : toCell;
      return {
        x: lerp(fromCell.x, toCell.x, alpha) * cell + cell / 2,
        y: lerp(fromCell.y, toCell.y, alpha) * cell + cell / 2,
      };
    });

    // Body as a glowing rounded stroke through the centers.
    ctx.strokeStyle = color;
    ctx.lineWidth = cell * 0.78;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
    else for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Head + eyes.
    const head = pts[0];
    const r = cell * 0.5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Ring around your own worm's head so you can find yourself.
    if (slot === mySlot) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(head.x, head.y, r + 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    drawEyes(ctx, head.x, head.y, r, tp.dir);
  }
}

function drawEyes(ctx: CanvasRenderingContext2D, hx: number, hy: number, r: number, dir: WormDir) {
  const fwd =
    dir === "up"
      ? { x: 0, y: -1 }
      : dir === "down"
        ? { x: 0, y: 1 }
        : dir === "left"
          ? { x: -1, y: 0 }
          : { x: 1, y: 0 };
  const perp = { x: -fwd.y, y: fwd.x };
  const eyeR = r * 0.26;
  const fwdOff = r * 0.18;
  const sideOff = r * 0.36;
  for (const s of [-1, 1]) {
    const ex = hx + fwd.x * fwdOff + perp.x * sideOff * s;
    const ey = hy + fwd.y * fwdOff + perp.y * sideOff * s;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#05030c";
    ctx.beginPath();
    ctx.arc(ex + fwd.x * eyeR * 0.4, ey + fwd.y * eyeR * 0.4, eyeR * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

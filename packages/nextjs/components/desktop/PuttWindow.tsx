"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePageVisible } from "~~/hooks/usePageVisible";
import type {
  PeerMeshState,
  PuttColor,
  PuttHole,
  PuttRegion,
  PuttState,
  PuttTerrain,
  PuttWindmill,
} from "~~/hooks/usePeerMesh";
import {
  isPuttMuted,
  setPuttMuted,
  sfxBrickClunk,
  sfxCupDrop,
  sfxPutterHit,
  sfxSandThud,
  sfxWaterSplash,
  unlockPuttAudio,
} from "~~/utils/puttSounds";

// Turn-based multiplayer mini golf. The relay is authoritative for the ball
// physics and the whole turn/scorecard flow; a client only sends a shot
// vector on its own turn. Aiming is a pull-back slingshot: press anywhere
// and drag away from your target — the ball flies the opposite way, power
// scaling with how far you pull. Up to 4 players sit in a lobby, someone
// hits Start, and everyone plays the same 3-hole course. Lowest total wins.

// Canvas colors mirror the --slop-* palette (globals.css); canvas can't read
// CSS vars, so the hexes are duplicated here.
const COLOR_HEX: Record<PuttColor, string> = {
  cyan: "#3fcfff",
  magenta: "#ff3ec9",
  lime: "#bcff5b",
  purple: "#7c4dff",
};
const FELT_GREEN = "#3a9d3a"; // flat fallback (empty/lobby with no hole yet)
const FRAME_BROWN = "#9c6b35";
const AIM_YELLOW = "#ffe14d";
// Hazard fills. Water = a blue pool with a lighter center + dark shoreline;
// sand = a warm tan bunker with a soft rim. Both are distinct from the green
// height-banded felt so they read instantly.
const WATER_DEEP = "#1763b8";
const WATER_SHALLOW = "#3fa9f5";
const WATER_EDGE = "#0c3d77";
const SAND_FILL = "#e6d3a0";
const SAND_EDGE = "#c4a86a";
// Topographic height bands (low → high). Distinct green steps so different
// elevations read as different colors, like a contour map.
const HEIGHT_BANDS = ["#14692f", "#1c7a37", "#2c8e40", "#43a44a", "#5fbb55", "#80d263", "#a3e678"];

// How far (in field units) you pull to reach full power, and the on-felt
// length of the forward aim line at full power.
const MAX_DRAG_FIELD = 240;
const AIM_LINE_MAX = 150;
const MIN_SHOT_POWER_FRAC = 0.04; // a tiny pull is treated as a cancel
// You must grab your own ball to start a shot (not just anywhere on the
// field). Generous radius — a few ball-widths, floored — so it stays an easy
// target on touch while still requiring you to actually pick up the ball.
const grabRadius = (ballR: number) => Math.max(ballR * 4, 36);

type Props = { mesh: PeerMeshState };
// A live aim drag, in field coords. The pull is measured as (cur - start)
// so the shot is relative to drag *motion*, not to where you grabbed — a
// tap that doesn't move can't fire.
type Drag = { startX: number; startY: number; curX: number; curY: number };

export const PuttWindow = ({ mesh }: Props) => {
  const { puttState, myPuttSlot, puttClaim, puttRelease, puttStart, puttShoot, puttReset } = mesh;
  const { field, holes } = puttState.course;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageVisible = usePageVisible();

  // Latest snapshot + my seat in refs so the RAF loop reads them without
  // restarting every server tick (~30Hz while a ball rolls).
  const stateRef = useRef(puttState);
  const slotRef = useRef(myPuttSlot);
  // Live drag while aiming (field coords); null when not aiming.
  const dragRef = useRef<Drag | null>(null);
  useEffect(() => {
    stateRef.current = puttState;
  }, [puttState]);
  useEffect(() => {
    slotRef.current = myPuttSlot;
  }, [myPuttSlot]);

  const isMyTurn = puttState.status === "aiming" && myPuttSlot !== null && myPuttSlot === puttState.turn;

  const [muted, setMuted] = useState(false);
  useEffect(() => setMuted(isPuttMuted()), []);

  // Sound effects, derived by diffing consecutive public snapshots so the whole
  // course is audible to every client (not just the player taking the shot).
  // The relay ships only ball positions + status + strokes — no velocity, no
  // collision events — so each cue is inferred from a snapshot transition:
  //   • putter hit  → status aiming→rolling (the shot fired)
  //   • cup drop    → a player's done[hole] flips with their ball on the cup
  //                   (vs. a stroke-cap, where the ball rests elsewhere)
  //   • water       → the turn player's stroke count rises while rolling (the
  //                   WATER_PENALTY; a normal settle adds no stroke)
  //   • sand        → the active ball's center crosses into a sand region
  //   • brick clunk → the active ball's travel direction reverses at speed
  //                   (covers brick walls, field borders and the windmill)
  const prevSndRef = useRef<PuttState | null>(null);
  // Per-slot motion + sand state for the active ball, kept across snapshots so
  // a direction reversal (bounce) or a dry→wet/grass→sand crossing can be seen
  // in the position stream. Cleared whenever no ball is rolling.
  const motionRef = useRef<Map<number, { x: number; y: number; vx: number; vy: number }>>(new Map());
  const inSandRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const prev = prevSndRef.current;
    prevSndRef.current = puttState;
    if (!prev) return; // first snapshot — nothing to compare, stay silent
    const cur = puttState;
    const h = prev.hole;
    const hole = cur.course.holes[h];

    // Putter hit — the shot just fired (and a fresh shot is now rolling).
    if (prev.status === "aiming" && cur.status === "rolling") sfxPutterHit();

    // Cup drop vs. stroke-cap — a player's hole just finished. A holed ball
    // sits exactly on the cup; a capped (or watered-out) ball rests elsewhere.
    const cup = hole?.cup;
    for (let i = 0; i < cur.players.length; i++) {
      const pp = prev.players[i];
      const cp = cur.players[i];
      if (!pp || !cp || pp.done[h] || !cp.done[h]) continue;
      if (cup && Math.hypot(cp.ball.x - cup.x, cp.ball.y - cup.y) <= cur.course.field.cupR + 4) sfxCupDrop();
    }

    // Water — the active player's stroke count rose during/ending a roll. The
    // only stroke increment that isn't the shot itself (counted at aiming→
    // rolling) is the one-stroke water penalty applied as the ball is fished out.
    if (prev.status === "rolling" && prev.turn !== null) {
      const pp = prev.players[prev.turn];
      const cp = cur.players[prev.turn];
      if (pp && cp && (cp.strokes[h] ?? 0) > (pp.strokes[h] ?? 0)) sfxWaterSplash();
    }

    // Sand + brick — only while the active ball is actually rolling.
    if (cur.status === "rolling" && cur.turn !== null && hole) {
      const slot = cur.turn;
      const cp = cur.players[slot];
      if (cp) {
        const nx = cp.ball.x;
        const ny = cp.ball.y;
        const prevM = motionRef.current.get(slot);
        if (prevM) {
          const vx = nx - prevM.x;
          const vy = ny - prevM.y;
          const sp = Math.hypot(vx, vy);
          // Ignore sub-pixel jitter and teleports (a tee/shoreline reset is a
          // jump larger than any real per-tick roll, ~30px max).
          if (sp > 0.05 && sp < 45) {
            const lastSp = Math.hypot(prevM.vx, prevM.vy);
            // A bounce is a sharp direction reversal at speed; a slope-break is
            // a gentle curve (dot stays well positive) — so gate on both speed
            // and a > ~105° turn.
            if (sp > 2.5 && lastSp > 2.5 && (vx * prevM.vx + vy * prevM.vy) / (sp * lastSp) < -0.25) {
              sfxBrickClunk(Math.min(1, sp / 12));
            }
            motionRef.current.set(slot, { x: nx, y: ny, vx, vy });
          } else {
            motionRef.current.set(slot, { x: nx, y: ny, vx: 0, vy: 0 });
          }
        } else {
          motionRef.current.set(slot, { x: nx, y: ny, vx: 0, vy: 0 });
        }

        const nowSand = !!hole.sand && hole.sand.some(rg => regionContains(rg, nx, ny));
        if (nowSand && !inSandRef.current.has(slot)) sfxSandThud();
        if (nowSand) inSandRef.current.add(slot);
        else inSandRef.current.delete(slot);
      }
    } else {
      // No ball in motion — drop the transient tracking so the next shot's
      // first frame seeds clean (no phantom bounce off a teed-up jump).
      motionRef.current.clear();
      inSandRef.current.clear();
    }
  }, [puttState]);

  // Repaint every animation frame (server positions render directly — 30Hz
  // is smooth enough, same as pong).
  useEffect(() => {
    if (!pageVisible) return;
    let raf = 0;
    const tick = () => {
      paint(canvasRef.current, stateRef.current, slotRef.current, dragRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pageVisible]);

  // Fit the canvas to its container while preserving the field aspect.
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

  // Map a pointer event to field coordinates.
  const toField = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const fx = ((clientX - rect.left) / rect.width) * field.w;
      const fy = ((clientY - rect.top) / rect.height) * field.h;
      return { x: fx, y: fy };
    },
    [field.w, field.h],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      unlockPuttAudio(); // browsers gate the AudioContext behind a user gesture
      if (!isMyTurn || myPuttSlot === null) return;
      const me = stateRef.current.players[myPuttSlot];
      if (!me) return;
      const p = toField(e.clientX, e.clientY);
      if (!p) return;
      // Only start a shot if you grabbed your own ball — clicking empty felt
      // does nothing.
      const r = grabRadius(field.ballR);
      if (Math.hypot(p.x - me.ball.x, p.y - me.ball.y) > r) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: p.x, startY: p.y, curX: p.x, curY: p.y };
    },
    [isMyTurn, myPuttSlot, toField, field.ballR],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const p = toField(e.clientX, e.clientY);
      if (!p) return;
      d.curX = p.x;
      d.curY = p.y;
    },
    [toField],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be gone */
      }
      // Slingshot: fling away from the pull. Direction = -(drag motion).
      const dx = d.startX - d.curX;
      const dy = d.startY - d.curY;
      const dragLen = Math.hypot(dx, dy);
      if (dragLen < 1e-3) return;
      const frac = Math.min(dragLen / MAX_DRAG_FIELD, 1);
      if (frac < MIN_SHOT_POWER_FRAC) return; // treat a tiny tap as a cancel
      const power = frac * field.maxPower;
      puttShoot((dx / dragLen) * power, (dy / dragLen) * power);
    },
    [field.maxPower, puttShoot],
  );

  const seated = puttState.players.filter((p): p is NonNullable<typeof p> => !!p);
  const seatOpen = puttState.players.some(p => p === null);
  const amSeated = myPuttSlot !== null;
  const canJoin = !amSeated && seatOpen && (puttState.status === "waiting" || puttState.status === "ended");
  const canStart = amSeated && puttState.status === "waiting" && seated.length >= 1;
  const hole = holes[puttState.hole];
  const overlay = buildOverlay(puttState);

  return (
    <div className="flex h-full w-full flex-col gap-2 bg-[#5a5a3a] p-3 text-white">
      {/* Header: hole + par, status, controls */}
      <div className="flex items-center justify-between text-[11px] uppercase tracking-widest text-white/80">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-lg text-white">
            Hole {puttState.hole + 1}
            <span className="text-white/50">/{holes.length || 3}</span>
          </span>
          {hole && (
            <span className="rounded border border-[var(--slop-lime)]/60 bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-[var(--slop-lime)]">
              Par {hole.par}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canJoin && (
            <button
              type="button"
              onClick={() => puttClaim()}
              className="rounded border border-white/40 bg-white/10 px-2 py-1 text-[10px] uppercase tracking-widest hover:bg-white/20"
            >
              Join
            </button>
          )}
          {amSeated && puttState.status === "waiting" && (
            <button
              type="button"
              onClick={() => puttRelease()}
              className="rounded border border-white/40 bg-white/10 px-2 py-1 text-[10px] uppercase tracking-widest hover:bg-white/20"
            >
              Leave
            </button>
          )}
          {canStart && (
            <button
              type="button"
              onClick={() => puttStart()}
              className="rounded border border-[var(--slop-lime)] bg-[var(--slop-lime)]/20 px-2 py-1 text-[10px] uppercase tracking-widest text-[var(--slop-lime)] hover:bg-[var(--slop-lime)]/30"
            >
              Start
            </button>
          )}
          {puttState.status === "ended" && amSeated && (
            <button
              type="button"
              onClick={() => puttReset()}
              className="rounded border border-[var(--slop-cyan)] bg-[var(--slop-cyan)]/20 px-2 py-1 text-[10px] uppercase tracking-widest text-[var(--slop-cyan)] hover:bg-[var(--slop-cyan)]/30"
            >
              Play Again
            </button>
          )}
          <button
            type="button"
            title={muted ? "Unmute course sounds" : "Mute course sounds"}
            onClick={() => {
              const next = !muted;
              setPuttMuted(next);
              setMuted(next);
              if (!next) unlockPuttAudio();
            }}
            className="text-[15px] leading-none text-white/60 hover:text-white"
          >
            {muted ? "🔈" : "🔊"}
          </button>
        </div>
      </div>

      {/* Turn / status bar — lives outside the course so it never covers a
          ball, wherever the ball ends up on the field. Fixed height keeps the
          course from resizing as the text appears/disappears. */}
      <div className="flex h-7 shrink-0 items-center justify-center">
        {overlay && (
          <div className="rounded bg-black/70 px-4 py-1 text-center font-mono text-sm uppercase tracking-widest text-white">
            {overlay}
          </div>
        )}
      </div>

      {/* Course */}
      <div ref={containerRef} className="relative flex flex-1 items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          width={field.w}
          height={field.h}
          style={{
            width: canvasSize.w,
            height: canvasSize.h,
            touchAction: "none",
            cursor: isMyTurn ? "crosshair" : "default",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      {/* Scorecard */}
      <Scorecard state={puttState} mySlot={myPuttSlot} />

      <div className="text-center font-mono text-[10px] uppercase tracking-widest text-white/50">
        {isMyTurn ? "Your turn — drag back from your ball to aim & power" : "Pull-back slingshot · lowest total wins"}
      </div>
    </div>
  );
};

// --- Scorecard -------------------------------------------------------------

function Scorecard({ state, mySlot }: { state: PuttState; mySlot: number | null }) {
  const holes = state.course.holes;
  const holeCount = holes.length || 3;
  const players = state.players.filter((p): p is NonNullable<typeof p> => !!p);
  if (players.length === 0) {
    return (
      <div className="rounded bg-black/30 px-2 py-2 text-center font-mono text-[10px] uppercase tracking-widest text-white/50">
        No players yet — press Join
      </div>
    );
  }
  const cell = "w-6 shrink-0 text-center font-mono text-[11px] tabular-nums";
  return (
    <div className="overflow-x-auto rounded bg-black/30 p-2">
      <div className="min-w-max">
        {/* Header: hole numbers */}
        <div className="flex items-center gap-1 border-b border-white/20 pb-1">
          <div className="w-20 shrink-0 font-mono text-[10px] uppercase tracking-widest text-white/60">Hole</div>
          {Array.from({ length: holeCount }, (_, h) => (
            <div key={h} className={`${cell} ${h === state.hole ? "text-[var(--slop-lime)]" : "text-white/70"}`}>
              {h + 1}
            </div>
          ))}
          <div className="w-10 shrink-0 text-center font-mono text-[10px] uppercase tracking-widest text-white/60">
            Tot
          </div>
        </div>
        {/* Par row */}
        <div className="flex items-center gap-1 border-b border-white/10 py-1">
          <div className="w-20 shrink-0 font-mono text-[10px] uppercase tracking-widest text-white/40">Par</div>
          {Array.from({ length: holeCount }, (_, h) => (
            <div key={h} className={`${cell} text-amber-300/80`}>
              {holes[h]?.par ?? "-"}
            </div>
          ))}
          <div className="w-10 shrink-0 text-center font-mono text-[11px] tabular-nums text-amber-300/80">
            {holes.reduce((a, b) => a + b.par, 0) || "-"}
          </div>
        </div>
        {/* Player rows */}
        {players.map(p => {
          const total = p.strokes.reduce((a, b) => a + b, 0);
          const isMe = p.slot === mySlot;
          const isWinner = state.status === "ended" && state.winner === p.slot;
          return (
            <div key={p.slot} className="flex items-center gap-1 py-1">
              <div className="flex w-20 shrink-0 items-center gap-1 overflow-hidden">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLOR_HEX[p.color] }} />
                <span className={`truncate font-mono text-[10px] ${isMe ? "text-white" : "text-white/70"}`}>
                  {p.handle}
                  {isWinner ? " 🏆" : ""}
                </span>
              </div>
              {Array.from({ length: holeCount }, (_, h) => {
                // Show a stroke count once the hole is reached; the active
                // turn's in-progress count shows live.
                const reached = h < state.hole || p.done[h] || (h === state.hole && p.strokes[h] > 0);
                const v = reached ? p.strokes[h] : "";
                const par = holes[h]?.par ?? 0;
                const under = reached && par > 0 && p.strokes[h] > 0 && p.strokes[h] < par;
                const over = reached && par > 0 && p.strokes[h] > par;
                return (
                  <div
                    key={h}
                    className={`${cell} ${h === state.hole ? "rounded bg-white/10" : ""} ${
                      under ? "text-[var(--slop-cyan)]" : over ? "text-[var(--slop-magenta)]" : "text-white"
                    }`}
                  >
                    {v}
                  </div>
                );
              })}
              <div className="w-10 shrink-0 text-center font-mono text-[12px] font-bold tabular-nums text-white">
                {total}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Overlay text ----------------------------------------------------------

function buildOverlay(state: PuttState): string {
  const players = state.players.filter((p): p is NonNullable<typeof p> => !!p);
  if (state.status === "waiting") {
    if (players.length === 0) return "Press Join to take a seat";
    return "Press Start when everyone's in";
  }
  if (state.status === "ended") {
    if (state.winner === null) return "Course complete";
    const w = state.players[state.winner];
    const total = w ? w.strokes.reduce((a, b) => a + b, 0) : 0;
    return w ? `${w.handle} wins — ${total} strokes` : "Course complete";
  }
  if (state.status === "holed") {
    const ms = Math.max(0, state.holeDoneAt - Date.now());
    return `Hole ${state.hole + 1} done — next in ${Math.ceil(ms / 1000)}…`;
  }
  if (state.status === "aiming" && state.turn !== null) {
    const p = state.players[state.turn];
    return p ? `${p.handle}'s turn` : "";
  }
  return "";
}

// --- Canvas painting -------------------------------------------------------

function paint(canvas: HTMLCanvasElement | null, state: PuttState, mySlot: number | null, drag: Drag | null) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const f = state.course.field;
  const hole = state.course.holes[state.hole];
  const now = Date.now(); // shared clock for the windmill sails + water shimmer

  // Backdrop (the brown surround) + the green felt frame.
  ctx.fillStyle = "#5a5a3a";
  ctx.fillRect(0, 0, f.w, f.h);
  const pad = 6;
  ctx.fillStyle = FRAME_BROWN;
  roundRect(ctx, pad - 4, pad - 4, f.w - 2 * (pad - 4), f.h - 2 * (pad - 4), 10);
  ctx.fill();
  if (!hole) {
    // No hole yet (lobby / default snapshot) — plain felt, nothing to map.
    ctx.fillStyle = FELT_GREEN;
    roundRect(ctx, pad, pad, f.w - 2 * pad, f.h - 2 * pad, 8);
    ctx.fill();
    return;
  }

  // Topographic felt — height-banded greens (cached per hole), clipped to the
  // rounded play area. Lighter bands are higher ground; the ball speeds up
  // rolling toward darker (downhill) and bleeds off climbing to lighter.
  ctx.save();
  roundRect(ctx, pad, pad, f.w - 2 * pad, f.h - 2 * pad, 8);
  ctx.clip();
  ctx.drawImage(getTerrainCanvas(state.hole, hole, f.w, f.h), 0, 0);
  ctx.restore();

  // Hazards sit on top of the felt but under the tee/cup/walls/balls. Sand
  // first, then water (so a pool reads on top where they ever touch). Clipped
  // to the play area like the terrain so a rect can't bleed past the rounded
  // frame.
  if (hole.sand?.length || hole.water?.length) {
    ctx.save();
    roundRect(ctx, pad, pad, f.w - 2 * pad, f.h - 2 * pad, 8);
    ctx.clip();
    if (hole.sand) for (const rg of hole.sand) drawSand(ctx, rg);
    if (hole.water) for (const rg of hole.water) drawWater(ctx, rg, now);
    ctx.restore();
  }

  // Tee marker (subtle ring).
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(hole.tee.x, hole.tee.y, 13, 0, Math.PI * 2);
  ctx.stroke();

  // Cup: a plain black circle.
  drawCup(ctx, hole.cup.x, hole.cup.y, f.cupR);

  // Pin
  ctx.strokeStyle = "#222";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(hole.cup.x, hole.cup.y);
  ctx.lineTo(hole.cup.x + 14, hole.cup.y - 34);
  ctx.stroke();
  ctx.fillStyle = "#e23b3b";
  ctx.beginPath();
  ctx.moveTo(hole.cup.x + 14, hole.cup.y - 34);
  ctx.lineTo(hole.cup.x + 14, hole.cup.y - 24);
  ctx.lineTo(hole.cup.x + 30, hole.cup.y - 29);
  ctx.closePath();
  ctx.fill();

  // Walls (brick texture). Drop shadows first (so one wall's shadow never
  // falls on another wall's bricks), then blit the baked running-bond brick
  // pattern — clipped to each wall's rounded rect so it can't bleed past the
  // wall boundary. Positions/sizes are untouched (collision is server-side).
  for (const w of hole.walls) {
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(w.x + 2, w.y + 3, w.w, w.h);
  }
  ctx.drawImage(getWallsCanvas(state.hole, hole, f.w, f.h), 0, 0);

  // Windmill (hole 4): the spinning sails mounted over the gap in the brick
  // base. Drawn from Date.now() so the rendered angle tracks the relay's
  // collision (which reads the same clock) — see windmillAngle. Drawn here,
  // over the walls but under the balls, so your ball always stays visible on
  // top as it threads (or clips) the gap.
  if (hole.windmill) drawWindmill(ctx, hole.windmill, now);

  // Balls. Draw a single dimpled, rolling golf ball for a player. The server
  // exposes only position (no velocity), so we derive roll direction + speed
  // from the per-frame position delta and draw scrolling dimples (see
  // drawGolfBall). The ball body itself carries the player's color (no
  // separate ring); drawGolfBall adds a thin dark outline so it stays readable
  // on the felt. A holed-out ball isn't drawn (it's gone into the cup).
  const players = state.players.filter((p): p is NonNullable<typeof p> => !!p);
  const drawBall = (p: NonNullable<(typeof players)[number]>) => {
    if (p.done[state.hole]) return;
    const roll = rollFor(p.slot, p.ball.x, p.ball.y);
    drawGolfBall(ctx, p.ball.x, p.ball.y, f.ballR, roll, COLOR_HEX[p.color]);
  };
  // Tee-off: at the start of a hole nobody has struck yet (strokes[hole] is 0
  // until a player shoots — see relay putt.ts). While teed off, show only the
  // current-turn (whoever's-up) player's ball — identical for every client,
  // not the local viewer's own; once play is underway every ball renders.
  const teedOff = !players.some(p => (p.strokes[state.hole] ?? 0) > 0);
  const visible = teedOff ? players.filter(p => p.slot === state.turn) : players;
  // Layering = canvas draw order (no z-index on a canvas). Draw every
  // non-active ball first, then the current-turn player's ball LAST so it
  // always stacks on top when balls overlap.
  for (const p of visible) if (p.slot !== state.turn) drawBall(p);
  for (const p of visible) if (p.slot === state.turn) drawBall(p);

  // Aim preview (only while I'm dragging).
  if (drag && mySlot !== null) {
    const me = state.players[mySlot];
    if (me && !me.done[state.hole]) {
      const dx = drag.startX - drag.curX;
      const dy = drag.startY - drag.curY;
      const len = Math.hypot(dx, dy);
      if (len > 1e-3) {
        const frac = Math.min(len / MAX_DRAG_FIELD, 1);
        const ux = dx / len;
        const uy = dy / len;
        // Forward dotted aim line (from the ball, toward the shot).
        ctx.setLineDash([6, 8]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = AIM_YELLOW;
        ctx.beginPath();
        ctx.moveTo(me.ball.x, me.ball.y);
        ctx.lineTo(me.ball.x + ux * AIM_LINE_MAX * frac, me.ball.y + uy * AIM_LINE_MAX * frac);
        ctx.stroke();
        ctx.setLineDash([]);
        // Pull-back handle behind the ball (mirrors the drag, slingshot feel).
        ctx.strokeStyle = "rgba(255,225,77,0.5)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(me.ball.x, me.ball.y);
        ctx.lineTo(me.ball.x - ux * AIM_LINE_MAX * frac, me.ball.y - uy * AIM_LINE_MAX * frac);
        ctx.stroke();
        // Power pip near the ball.
        ctx.fillStyle = AIM_YELLOW;
        ctx.font = "bold 16px monospace";
        ctx.textAlign = "center";
        ctx.fillText(`${Math.round(frac * 100)}%`, me.ball.x, me.ball.y - f.ballR - 20);
        ctx.textAlign = "start";
      }
    }
  }
}

// --- Rolling golf ball -----------------------------------------------------

// Per-slot roll tracking. The relay snapshot carries only ball {x,y}, so we
// remember each ball's last position to recover its travel direction and the
// distance it has rolled. `phase` accumulates rolled distance (in field units),
// which scrolls the dimple lattice so the surface looks like it's turning.
type Roll = { x: number; y: number; phase: number; ux: number; uy: number; seen: boolean };
const rollState = new Map<number, Roll>();

function rollFor(slot: number, x: number, y: number): Roll {
  const prev = rollState.get(slot);
  const next: Roll = prev ?? { x, y, phase: 0, ux: 1, uy: 0, seen: false };
  if (prev?.seen) {
    const dx = x - prev.x;
    const dy = y - prev.y;
    const sp = Math.hypot(dx, dy);
    // Ignore sub-pixel jitter and teleports (tee resets between holes/turns).
    if (sp > 0.05 && sp < 40) {
      next.ux = dx / sp;
      next.uy = dy / sp;
      // Surface arc-length ≈ distance travelled for a rolling ball.
      next.phase += sp;
    }
  }
  next.x = x;
  next.y = y;
  next.seen = true;
  rollState.set(slot, next);
  return next;
}

// Parse a "#rrggbb" hex into [r,g,b].
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
// Mix an [r,g,b] toward white (t>0) or black (t<0) by fraction |t|, → "rgb(...)".
function shade([r, g, b]: [number, number, number], t: number): string {
  const target = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  const mix = (c: number) => Math.round(c + (target - c) * k);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

// A colored sphere (the player's owner color) with shading and dimples that
// scroll in the travel direction (forward, over the leading edge) so the ball
// reads as rolling, not sliding. Dimples shrink + fade toward the rim for a
// spherical, foreshortened look.
function drawGolfBall(ctx: CanvasRenderingContext2D, bx: number, by: number, R: number, roll: Roll, color: string) {
  const rgb = hexToRgb(color);
  // Shaded colored sphere: a near-white highlight of the color toward the
  // upper-left light source, the base color through the mid, and a darker
  // shade at the rim — so it still reads as a lit 3D ball.
  const grad = ctx.createRadialGradient(bx - R * 0.35, by - R * 0.35, R * 0.1, bx, by, R);
  grad.addColorStop(0, shade(rgb, 0.7));
  grad.addColorStop(0.45, shade(rgb, 0.2));
  grad.addColorStop(0.8, color);
  grad.addColorStop(1, shade(rgb, -0.35));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(bx, by, R, 0, Math.PI * 2);
  ctx.fill();

  // Dimples, clipped to the ball.
  const ux = roll.ux;
  const uy = roll.uy;
  const px = -uy; // perpendicular axis
  const py = ux;
  const spacing = R * 0.6;
  const base = R * 0.16;
  const off = ((roll.phase % spacing) + spacing) % spacing;
  ctx.save();
  ctx.beginPath();
  ctx.arc(bx, by, R - 0.4, 0, Math.PI * 2);
  ctx.clip();
  for (let ia = -4; ia <= 4; ia++) {
    // Scrolling along the travel axis (+off → dimples move forward).
    const la = ia * spacing + off;
    const an = la / R;
    if (Math.abs(an) > 1.1) continue;
    for (let ib = -4; ib <= 4; ib++) {
      // Stagger alternate rows for a hex-ish pack.
      const lp = ib * spacing + (Math.abs(ia) % 2) * (spacing / 2);
      const pn = lp / R;
      if (Math.abs(pn) > 1.1) continue;
      // Spherical foreshortening: dimples compress + fade toward the rim.
      const fore = Math.sqrt(Math.max(0, 1 - an * an) * Math.max(0, 1 - pn * pn));
      if (fore <= 0.02) continue;
      const sx = bx + la * ux + lp * px;
      const sy = by + la * uy + lp * py;
      const r = base * (0.4 + 0.6 * fore);
      // Dimples are darker pits in the colored surface (a translucent dark
      // overlay that deepens toward the lit center, fades toward the rim).
      ctx.fillStyle = `rgba(0,0,0,${(0.1 + 0.22 * fore).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // Thin dark outline so the colored ball stays crisp against the green felt.
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.beginPath();
  ctx.arc(bx, by, R, 0, Math.PI * 2);
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// --- Windmill (hole 4) -----------------------------------------------------
// Mirror of the relay's windmillAngle (packages/relay/src/putt.ts) — the blade
// angle is a pure function of wall-clock time, so the drawn sails line up with
// the server's collision off the same Date.now(). Kept in sync by hand, like
// the seat-color hexes and puttHeightAt. MUST stay reduced to [0, 2π): the raw
// angle is billions of radians and a canvas transform can't hold that — it
// rounds every blade onto one frozen direction (the "single static sail" bug).
function windmillAngle(wm: PuttWindmill, nowMs: number): number {
  const revs = (nowMs / 60000) * wm.rpm;
  return (revs - Math.floor(revs)) * Math.PI * 2;
}

// A hot magenta + cream Dutch-sail windmill in the slop palette. We draw: a
// soft ground shadow of the whole fan, the four lattice sails, then the red
// motor housing + dark axle hub on top. The visible sail half-width tracks the
// collision capsule (bladeW + a hair) so a bounce reads where it actually
// happens; the swept shadow sells "this thing is spinning above the green".
const SAIL_CREAM = "#f4ead2";
const SAIL_FRAME = "#ff3ec9";
const WINDMILL_RED = "#c0392b";
function drawWindmill(ctx: CanvasRenderingContext2D, wm: PuttWindmill, now: number) {
  const ang = windmillAngle(wm, now);
  const half = wm.bladeW + 2; // visible half-width ≈ collision capsule

  // Ground shadow of the sails (offset down-right, soft + translucent), drawn
  // first so the real sails sit above their own shadow.
  ctx.save();
  ctx.translate(wm.x + 4, wm.y + 5);
  for (let i = 0; i < wm.blades; i++) {
    const a = ang + (i * Math.PI * 2) / wm.blades;
    drawSail(ctx, a, wm.hubR, wm.bladeLen, half, true);
  }
  ctx.restore();

  // The sails themselves, radiating from the hub.
  ctx.save();
  ctx.translate(wm.x, wm.y);
  for (let i = 0; i < wm.blades; i++) {
    const a = ang + (i * Math.PI * 2) / wm.blades;
    drawSail(ctx, a, wm.hubR, wm.bladeLen, half, false);
  }
  ctx.restore();

  // Motor housing: a small red boss behind the axle so the fan looks mounted.
  // Kept tight so the long sails read as sails, not a blob with stubs.
  const hr = wm.hubR + 4;
  const houseGrad = ctx.createRadialGradient(wm.x - hr * 0.4, wm.y - hr * 0.4, hr * 0.2, wm.x, wm.y, hr);
  houseGrad.addColorStop(0, "#e85d4e");
  houseGrad.addColorStop(1, WINDMILL_RED);
  ctx.fillStyle = houseGrad;
  ctx.beginPath();
  ctx.arc(wm.x, wm.y, hr, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Dark axle hub with a tiny highlight (the bolt the sails turn on).
  ctx.fillStyle = "#1c1410";
  ctx.beginPath();
  ctx.arc(wm.x, wm.y, wm.hubR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath();
  ctx.arc(wm.x - wm.hubR * 0.3, wm.y - wm.hubR * 0.3, wm.hubR * 0.32, 0, Math.PI * 2);
  ctx.fill();
}

// One sail: a tapered lattice blade from the hub out to the tip, in local
// (rotated) coordinates. `shadow` renders a flat translucent silhouette instead
// of the lit/latticed version. The caller has already translated to the hub.
function drawSail(ctx: CanvasRenderingContext2D, a: number, hubR: number, len: number, half: number, shadow: boolean) {
  ctx.save();
  ctx.rotate(a);
  const inner = hubR * 0.4;
  if (shadow) {
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    roundRect(ctx, inner, -half, len - inner, half * 2, half);
    ctx.fill();
    ctx.restore();
    return;
  }
  // Cream sail body with a magenta frame.
  ctx.fillStyle = SAIL_CREAM;
  roundRect(ctx, inner, -half, len - inner, half * 2, half * 0.6);
  ctx.fill();
  // Lattice: a few cross spars down the length, clipped to the sail.
  ctx.save();
  roundRect(ctx, inner, -half, len - inner, half * 2, half * 0.6);
  ctx.clip();
  ctx.strokeStyle = "rgba(192,57,43,0.55)";
  ctx.lineWidth = 1;
  for (let x = inner + 8; x < len; x += 9) {
    ctx.beginPath();
    ctx.moveTo(x, -half);
    ctx.lineTo(x, half);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(inner, 0);
  ctx.lineTo(len, 0);
  ctx.stroke();
  ctx.restore();
  // Bright leading-edge frame so the spin reads crisply against the felt.
  ctx.strokeStyle = SAIL_FRAME;
  ctx.lineWidth = 2;
  roundRect(ctx, inner, -half, len - inner, half * 2, half * 0.6);
  ctx.stroke();
  ctx.restore();
}

// --- Hazards (water + sand) -------------------------------------------------
// Region shapes mirror the relay's PuttRegion (circle | rect). Geometry is
// authoritative on the server (packages/relay/src/putt.ts); these only paint.

// Is (x,y) inside a hazard region? Mirrors the relay's regionHit (same wavy
// shoreline for circles) so the sand-thud cue fires exactly when the physics
// considers the ball over the bunker.
function regionContains(rg: PuttRegion, x: number, y: number): boolean {
  if (rg.kind === "circle") {
    const dx = x - rg.x;
    const dy = y - rg.y;
    const rr = wavyRadius(rg.x, rg.y, rg.r, Math.atan2(dy, dx), HAZARD_WOB);
    return dx * dx + dy * dy <= rr * rr;
  }
  return x >= rg.x && x <= rg.x + rg.w && y >= rg.y && y <= rg.y + rg.h;
}

// Trace a region's outline as the current path (no fill/stroke). A circle is
// traced as a wavy polygon (wavyRadius, same warp + seed the relay's regionHit
// uses) so water/sand read as organic blobs, never perfect discs — and the
// painted shoreline lines up with where the physics actually penalizes.
function regionPath(ctx: CanvasRenderingContext2D, rg: PuttRegion) {
  ctx.beginPath();
  if (rg.kind === "circle") {
    const STEPS = 72;
    for (let i = 0; i <= STEPS; i++) {
      const a = (i / STEPS) * Math.PI * 2;
      const rr = wavyRadius(rg.x, rg.y, rg.r, a, HAZARD_WOB);
      const px = rg.x + Math.cos(a) * rr;
      const py = rg.y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else {
    const r = Math.min(14, rg.w / 2, rg.h / 2);
    roundRect(ctx, rg.x, rg.y, rg.w, rg.h, r);
  }
}

// Approximate center + extent of a region (for the water gradient + ripples).
function regionBounds(rg: PuttRegion): { cx: number; cy: number; rad: number } {
  if (rg.kind === "circle") return { cx: rg.x, cy: rg.y, rad: rg.r };
  return { cx: rg.x + rg.w / 2, cy: rg.y + rg.h / 2, rad: Math.max(rg.w, rg.h) / 2 };
}

// Sand bunker: a flat tan fill with a soft darker rim and a scatter of
// deterministic speckles so it reads as grainy, not a solid blob.
function drawSand(ctx: CanvasRenderingContext2D, rg: PuttRegion) {
  regionPath(ctx, rg);
  ctx.fillStyle = SAND_FILL;
  ctx.fill();
  // Speckle texture, clipped to the bunker.
  const { cx, cy, rad } = regionBounds(rg);
  ctx.save();
  regionPath(ctx, rg);
  ctx.clip();
  ctx.fillStyle = "rgba(150,120,60,0.35)";
  for (let i = 0; i < 90; i++) {
    const n = brickRand(i, Math.round(cx + cy));
    const n2 = brickRand(i + 31, Math.round(rad));
    const sx = cx - rad + n * rad * 2;
    const sy = cy - rad + n2 * rad * 2;
    ctx.beginPath();
    ctx.arc(sx, sy, 0.8 + n * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // Soft rim.
  regionPath(ctx, rg);
  ctx.strokeStyle = SAND_EDGE;
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// Water hazard: a radial blue pool (lighter center → deeper rim) with a dark
// shoreline and a couple of slow concentric ripples that drift over time so it
// reads as live water, not a painted disc.
function drawWater(ctx: CanvasRenderingContext2D, rg: PuttRegion, now: number) {
  const { cx, cy, rad } = regionBounds(rg);
  const grad = ctx.createRadialGradient(cx, cy, rad * 0.1, cx, cy, rad);
  grad.addColorStop(0, WATER_SHALLOW);
  grad.addColorStop(0.7, WATER_DEEP);
  grad.addColorStop(1, WATER_EDGE);
  regionPath(ctx, rg);
  ctx.fillStyle = grad;
  ctx.fill();
  // Drifting ripples, clipped to the pool.
  ctx.save();
  regionPath(ctx, rg);
  ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1.5;
  const phase = (now / 2600) % 1;
  for (let i = 0; i < 3; i++) {
    const t = ((phase + i / 3) % 1) * 1.05;
    ctx.globalAlpha = Math.max(0, 1 - t) * 0.8;
    ctx.beginPath();
    ctx.arc(cx, cy, rad * t, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  // Dark shoreline.
  regionPath(ctx, rg);
  ctx.strokeStyle = WATER_EDGE;
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// --- Cup --------------------------------------------------------------------
// Just a flat black circle. Center/radius match the hit radius exactly.
function drawCup(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number) {
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = "#000000";
  ctx.fill();
}

// --- Brick walls -----------------------------------------------------------
// Stable per-brick pseudo-random in [0,1) (no Math.random, so the texture is
// identical every frame — bake-once via the cache below).
function brickRand(r: number, c: number): number {
  let h = (r * 374761393 + c * 668265263) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}

// Per-hole walls are static, so render the brickwork once to an offscreen
// canvas (running-bond courses, mortar gaps, per-brick gray/reddish variation,
// upper-left bevel) and blit it each frame — same pattern as the terrain map.
// Each wall's bricks are clipped to its rounded rect so they never bleed past
// the wall; positions/sizes come straight from hole.walls (server collision).
const wallsCache = new Map<string, HTMLCanvasElement>();
function getWallsCanvas(holeIndex: number, hole: PuttHole, fw: number, fh: number): HTMLCanvasElement {
  const key = `${holeIndex}:${fw}x${fh}`;
  const cached = wallsCache.get(key);
  if (cached) return cached;
  const cv = document.createElement("canvas");
  cv.width = fw;
  cv.height = fh;
  const cx = cv.getContext("2d");
  if (cx) {
    for (const w of hole.walls) {
      if (w.h > w.w) {
        // Vertical wall (taller than wide): rotate the context 90° about the
        // wall's center and draw the running-bond courses into a swapped-dim
        // rect, so the courses run along the wall's long (vertical) axis.
        const cxC = w.x + w.w / 2;
        const cyC = w.y + w.h / 2;
        cx.save();
        cx.translate(cxC, cyC);
        cx.rotate(Math.PI / 2);
        drawWallBricks(cx, -w.h / 2, -w.w / 2, w.h, w.w);
        cx.restore();
      } else {
        // Horizontal wall: courses already run along the long axis.
        drawWallBricks(cx, w.x, w.y, w.w, w.h);
      }
    }
  }
  wallsCache.set(key, cv);
  return cv;
}

// Draw a single wall's running-bond brickwork into the rect (rx,ry,rw,rh) of
// the current (possibly rotated) context. Clipped to the wall's rounded rect;
// jitter is deterministic so the baked texture never flickers.
function drawWallBricks(cx: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number) {
  const cellW = 26;
  const cellH = 13;
  const mortar = 2;
  const brickW = cellW - mortar;
  const brickH = cellH - mortar;
  cx.save();
  roundRect(cx, rx, ry, rw, rh, 4);
  cx.clip();
  // Dark mortar bed showing through the brick gaps.
  cx.fillStyle = "#6f6f6f";
  cx.fillRect(rx, ry, rw, rh);
  let row = 0;
  // Start a cell early on both axes so the running-bond offset still fully
  // covers the clipped wall edges.
  for (let by = ry - cellH; by < ry + rh; by += cellH, row++) {
    const xoff = row % 2 ? -(cellW / 2) : 0;
    let col = 0;
    for (let bx = rx + xoff - cellW; bx < rx + rw; bx += cellW, col++) {
      const n = brickRand(row, col);
      const n2 = brickRand(col + 7, row + 3);
      // Grayish bricks leaning slightly warm/reddish, with per-brick jitter.
      const base = 138 + Math.round(n * 30); // 138..168
      const r = Math.min(192, base + Math.round(n2 * 28));
      const g = base - 4;
      const b = base - 13;
      const x0 = bx + mortar;
      const y0 = by + mortar;
      cx.fillStyle = `rgb(${r},${g},${b})`;
      cx.fillRect(x0, y0, brickW, brickH);
      // Upper-left bevel highlight, lower-right shadow — light from UL.
      cx.fillStyle = "rgba(255,255,255,0.12)";
      cx.fillRect(x0, y0, brickW, 1);
      cx.fillRect(x0, y0, 1, brickH);
      cx.fillStyle = "rgba(0,0,0,0.2)";
      cx.fillRect(x0, y0 + brickH - 1, brickW, 1);
      cx.fillRect(x0 + brickW - 1, y0, 1, brickH);
    }
  }
  cx.restore();
}

// --- Topography ------------------------------------------------------------
// Mirror of the relay's wavyRadius / puttHeightAt (packages/relay/src/putt.ts)
// — kept in sync BY HAND, like the seat-color hexes. wavyRadius warps a circle's
// rim with three sine harmonics of the bearing (phases hashed from x,y,r) so the
// outline is wavy/lobed, never a perfect circle; it backs both the mound shapes
// here and the hazard shorelines (regionPath). Must stay byte-for-byte the relay
// version or the rendered terrain/shoreline drifts from where the physics is.
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
const PUTT_MOUND_WOB = 0.18;
const HAZARD_WOB = 0.16;

function puttHeightAt(t: PuttTerrain, x: number, y: number, fw: number, fh: number): number {
  let h = t.tiltX * (x - fw / 2) + t.tiltY * (y - fh / 2);
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
      // Squared-falloff ramp from the plateau edge (k=1) to the rim (k=0);
      // r0=0 collapses to the original (1 - d/r)² hump.
      const k = (r - d) / (r - r0);
      h += m.h * k * k;
    }
  }
  return h;
}

// The band hexes parsed to RGB — used as anchor stops for a color ramp.
const BAND_RGB: Array<[number, number, number]> = HEIGHT_BANDS.map(hex => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]);
const TERRAIN_CELL = 12; // px per color block — the chunky, pixelated grid
const TERRAIN_STEPS = 16; // discrete elevation steps across the gradient
const GRASS_MOTTLE = 0.1; // per-cell elevation jitter → light/dark green patches
const GRASS_DOT_CHANCE = 0.38; // fraction of cells that get a surface grain dot

// Color along the band palette for t∈[0,1] — lerp between the two nearest
// anchors. We quantize t into TERRAIN_STEPS before calling this, so the result
// is a stepped (pixelated) gradient rather than a smooth one.
function rampColor(t: number): [number, number, number] {
  const last = BAND_RGB.length - 1;
  const f = Math.max(0, Math.min(1, t)) * last;
  const i = Math.min(Math.floor(f), last - 1);
  const frac = f - i;
  const a = BAND_RGB[i] ?? BAND_RGB[0]!;
  const b = BAND_RGB[i + 1] ?? a;
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

// Per-hole terrain is static, so render it once to an offscreen canvas and blit
// it each frame. Chunky cells quantized into many elevation steps give a
// pixelated, stepped gradient (more steps than the first cut, same blocky feel).
const terrainCache = new Map<string, HTMLCanvasElement>();
function getTerrainCanvas(holeIndex: number, hole: PuttHole, fw: number, fh: number): HTMLCanvasElement {
  const key = `${holeIndex}:${fw}x${fh}`;
  const cached = terrainCache.get(key);
  if (cached) return cached;
  const cv = document.createElement("canvas");
  cv.width = fw;
  cv.height = fh;
  const cx = cv.getContext("2d");
  if (cx) {
    // Coarse first pass for the height range (to normalize the gradient).
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < fh; y += 8) {
      for (let x = 0; x < fw; x += 8) {
        const h = puttHeightAt(hole.terrain, x, y, fw, fh);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    const span = max - min || 1;
    const steps = TERRAIN_STEPS - 1;
    for (let y = 0; y < fh; y += TERRAIN_CELL) {
      for (let x = 0; x < fw; x += TERRAIN_CELL) {
        const col = Math.floor(x / TERRAIN_CELL);
        const row = Math.floor(y / TERRAIN_CELL);
        const h = puttHeightAt(hole.terrain, x + TERRAIN_CELL / 2, y + TERRAIN_CELL / 2, fw, fh);
        // Deterministic per-cell mottle: nudge the elevation a touch so even the
        // flat green breaks into light/dark patches instead of one solid color.
        const n = brickRand(col, row);
        const t = Math.max(0, Math.min(1, (h - min) / span + (n - 0.5) * 2 * GRASS_MOTTLE));
        const q = Math.round(t * steps) / steps; // snap to a discrete elevation step
        const [r, g, b] = rampColor(q);
        cx.fillStyle = `rgb(${r},${g},${b})`;
        cx.fillRect(x, y, TERRAIN_CELL, TERRAIN_CELL);
        // Surface grain: a small lighter/darker green pip in some cells, so the
        // turf is dotted/textured all over — the same speckle the sand bunkers
        // have, just greener and sparser.
        const n2 = brickRand(col + 17, row + 5);
        if (n2 > 1 - GRASS_DOT_CHANCE) {
          const dq = Math.max(0, Math.min(1, q + (n2 > 0.81 ? 0.13 : -0.13)));
          const [dr, dg, db] = rampColor(dq);
          cx.fillStyle = `rgb(${dr},${dg},${db})`;
          const ds = 3;
          const ox = 2 + Math.floor(brickRand(col + 3, row + 11) * (TERRAIN_CELL - ds - 3));
          const oy = 2 + Math.floor(brickRand(col + 9, row + 2) * (TERRAIN_CELL - ds - 3));
          cx.fillRect(x + ox, y + oy, ds, ds);
        }
      }
    }
  }
  terrainCache.set(key, cv);
  return cv;
}

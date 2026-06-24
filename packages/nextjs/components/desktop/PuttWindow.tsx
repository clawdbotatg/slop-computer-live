"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePageVisible } from "~~/hooks/usePageVisible";
import type { PeerMeshState, PuttColor, PuttHole, PuttState, PuttTerrain } from "~~/hooks/usePeerMesh";

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
// Topographic height bands (low → high). Distinct green steps so different
// elevations read as different colors, like a contour map.
const HEIGHT_BANDS = ["#14692f", "#1c7a37", "#2c8e40", "#43a44a", "#5fbb55", "#80d263", "#a3e678"];

// How far (in field units) you pull to reach full power, and the on-felt
// length of the forward aim line at full power.
const MAX_DRAG_FIELD = 240;
const AIM_LINE_MAX = 150;
const MIN_SHOT_POWER_FRAC = 0.04; // a tiny pull is treated as a cancel

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
      if (!isMyTurn || myPuttSlot === null) return;
      const me = stateRef.current.players[myPuttSlot];
      if (!me) return;
      const p = toField(e.clientX, e.clientY);
      if (!p) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: p.x, startY: p.y, curX: p.x, curY: p.y };
    },
    [isMyTurn, myPuttSlot, toField],
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
        </div>
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
        {overlay && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <div className="rounded bg-black/70 px-4 py-2 text-center font-mono text-sm uppercase tracking-widest text-white">
              {overlay}
            </div>
          </div>
        )}
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

  // Tee marker (subtle ring).
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(hole.tee.x, hole.tee.y, 13, 0, Math.PI * 2);
  ctx.stroke();

  // Cup: a recessed 3D hole you look down into. The scene light is upper-left
  // (same as the balls), so a depression reads inverted from a bump — the
  // near (upper-left) rim casts an inner shadow, while the far (lower-right)
  // wall catches light and the opposite lip gets a thin highlight. A radial
  // gradient (dark pit → faintly lit rim) plus a faint inner ellipse make it
  // read as a cylinder sunk into the felt. Center + radius are unchanged, so
  // the hit radius is identical — only the look differs.
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

// --- Cup (recessed 3D hole) ------------------------------------------------
// Draw the hole the way a real golf cup looks from above with the camera tipped
// slightly back (matching the leaning flag): a ragged grass lip, an earthen
// side wall whose far rim catches the light, a cream cup-liner ring, and a deep
// dark shaft. Light is upper-left (same as the balls), so the void is offset
// up-and-left and the lit dirt/liner crescent sits on the lower-right far wall.
// Drawn with a slight vertical squash for the tipped-back perspective. The
// collision center/radius are untouched — this is purely cosmetic.
function drawCup(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number) {
  ctx.save();

  const SQUASH = 0.86; // tip the opening back into the green a touch
  const ry = R * SQUASH;
  // The void sits up-and-left of the opening so the lower-right wall is the one
  // that faces the light and reads as lit.
  const offX = R * 0.16;
  const offY = R * 0.2;

  // Soft grassy recess — the green dips and darkens into the hole, a wider/
  // softer ring than a hard shadow so the lip blends into the felt.
  const ring = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R + 4);
  ring.addColorStop(0, "rgba(20,46,18,0.55)");
  ring.addColorStop(1, "rgba(20,46,18,0)");
  ctx.beginPath();
  ctx.ellipse(cx, cy, R + 4, ry + 4, 0, 0, Math.PI * 2);
  ctx.fillStyle = ring;
  ctx.fill();

  // Earthen side wall: the whole opening filled with a dirt gradient, lit tan on
  // the lower-right far rim, falling to dark soil toward the shaded near rim.
  const wall = ctx.createRadialGradient(cx + R * 0.34, cy + ry * 0.4, R * 0.15, cx, cy, R);
  wall.addColorStop(0, "#7a5128");
  wall.addColorStop(0.45, "#5e3c1d");
  wall.addColorStop(0.8, "#3c2713");
  wall.addColorStop(1, "#26180c");
  ctx.beginPath();
  ctx.ellipse(cx, cy, R, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = wall;
  ctx.fill();

  // Cream cup-liner ring just inside the lip — a real cup's plastic sleeve,
  // brightest where it faces the light (lower-right), fading into shadow.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, R, ry, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.lineWidth = R * 0.16;
  ctx.strokeStyle = "rgba(226,214,180,0.9)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, R * 0.92, ry * 0.92, 0, Math.PI * -0.1, Math.PI * 0.78);
  ctx.stroke();
  ctx.strokeStyle = "rgba(150,134,98,0.45)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, R * 0.92, ry * 0.92, 0, Math.PI * 0.78, Math.PI * 1.9);
  ctx.stroke();
  ctx.restore();

  // The shaft: a dark void offset up-and-left, deep black at the bottom so the
  // hole reads as going down into the ground rather than a flat disc.
  const shaftR = R * 0.66;
  const shaftRy = ry * 0.66;
  const sx = cx - offX;
  const sy = cy - offY;
  const shaft = ctx.createRadialGradient(sx + shaftR * 0.3, sy + shaftRy * 0.3, shaftR * 0.1, sx, sy, shaftR);
  shaft.addColorStop(0, "#1a1206");
  shaft.addColorStop(0.6, "#0a0703");
  shaft.addColorStop(1, "#000000");
  ctx.beginPath();
  ctx.ellipse(sx, sy, shaftR, shaftRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = shaft;
  ctx.fill();

  // Ragged grass lip overlapping the opening — short blades of felt-green poking
  // in over the edge break the perfect circle so it reads as cut grass, not a
  // drawn ring. Deterministic (brickRand) so it's stable frame-to-frame.
  const blades = 38;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    const j = brickRand(i, 7);
    const j2 = brickRand(i, 13);
    // Blades on the lit (upper-left) side are brighter; shaded far side dimmer.
    const lit = Math.cos(a) < 0 || Math.sin(a) < 0 ? 1 : 0.7;
    const baseR = R + 1.5;
    const tipR = R - (1.5 + j * 4.5);
    const wob = (j2 - 0.5) * 0.12;
    const bx = cx + Math.cos(a + wob) * baseR;
    const by = cy + Math.sin(a + wob) * ry + Math.sin(a + wob);
    const tx = cx + Math.cos(a) * tipR;
    const ty = cy + Math.sin(a) * (tipR * SQUASH);
    const g1 = Math.round(120 + j * 50 * lit);
    ctx.strokeStyle = `rgba(${Math.round(40 + j * 30)},${g1},${Math.round(30 + j * 25)},${0.85 * lit})`;
    ctx.lineWidth = 1 + j2 * 1.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(tx, ty);
    ctx.stroke();
  }

  ctx.restore();
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
    const cellW = 26;
    const cellH = 13;
    const mortar = 2;
    const brickW = cellW - mortar;
    const brickH = cellH - mortar;
    for (const w of hole.walls) {
      cx.save();
      roundRect(cx, w.x, w.y, w.w, w.h, 4);
      cx.clip();
      // Dark mortar bed showing through the brick gaps.
      cx.fillStyle = "#6f6f6f";
      cx.fillRect(w.x, w.y, w.w, w.h);
      let row = 0;
      // Start a cell early on both axes so the running-bond offset still fully
      // covers the clipped wall edges.
      for (let by = w.y - cellH; by < w.y + w.h; by += cellH, row++) {
        const xoff = row % 2 ? -(cellW / 2) : 0;
        let col = 0;
        for (let bx = w.x + xoff - cellW; bx < w.x + w.w; bx += cellW, col++) {
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
  }
  wallsCache.set(key, cv);
  return cv;
}

// --- Topography ------------------------------------------------------------
// Mirror of the relay's puttHeightAt (packages/relay/src/putt.ts) — kept in
// sync by hand, like the seat-color hexes. Linear tilt across the green plus
// each mound's squared-falloff hump.
function puttHeightAt(t: PuttTerrain, x: number, y: number, fw: number, fh: number): number {
  let h = t.tiltX * (x - fw / 2) + t.tiltY * (y - fh / 2);
  for (const m of t.mounds) {
    const d = Math.hypot(x - m.x, y - m.y);
    if (d < m.r) {
      const k = 1 - d / m.r;
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
        const h = puttHeightAt(hole.terrain, x + TERRAIN_CELL / 2, y + TERRAIN_CELL / 2, fw, fh);
        const t = Math.max(0, Math.min(1, (h - min) / span));
        const q = Math.round(t * steps) / steps; // snap to a discrete elevation step
        const [r, g, b] = rampColor(q);
        cx.fillStyle = `rgb(${r},${g},${b})`;
        cx.fillRect(x, y, TERRAIN_CELL, TERRAIN_CELL);
      }
    }
  }
  terrainCache.set(key, cv);
  return cv;
}

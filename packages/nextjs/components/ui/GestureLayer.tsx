"use client";

import { useEffect, useRef } from "react";
import type { GestureEvent } from "~~/hooks/usePeerMesh";

// Full-viewport canvas that renders hand-gesture effects (relay `gesture`
// broadcasts) flying across the top of everything — desktop, windows, chat.
// Every client (god-mode included, which is what puts it on the stream) runs
// the same deterministic flight from (seed, receivedAt), so all screens agree
// without streaming any animation state. An effect dies when it drifts
// off-screen; the mesh's 15s prune is the backstop. pointer-events: none, so
// it can never eat a click.
//
// The eth / claw draw functions are ported from slop-computer-background's
// slop-shapes.js (the OBS rig) so the shared effects match the show's look.

// Just under the cursor layer (2^31-1) — above every window and modal.
const Z = 2147483646;
const FADE_IN_MS = 300;

/* ---- Ethereum octahedron (ported from slop-shapes.js) ---- */
const ETH = { r: 0.95, hTop: 1.75, hBot: 1.45, gap: 0.18, tilt: -0.3 };
const EV = (() => {
  const { r, hTop, hBot, gap } = ETH;
  const g = gap / 2;
  return [
    [0, hTop + g, 0],
    [r, g, 0],
    [0, g, r],
    [-r, g, 0],
    [0, g, -r],
    [0, -hBot - g, 0],
    [r, -g, 0],
    [0, -g, r],
    [-r, -g, 0],
    [0, -g, -r],
  ];
})();
const EE = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 1],
  [5, 6],
  [5, 7],
  [5, 8],
  [5, 9],
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 6],
];
const EF = [
  [0, 1, 2],
  [0, 2, 3],
  [0, 3, 4],
  [0, 4, 1],
  [5, 6, 7],
  [5, 7, 8],
  [5, 8, 9],
  [5, 9, 6],
];

function drawEth(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number, spin: number, alpha: number) {
  const cs = Math.cos(spin),
    sn = Math.sin(spin),
    ct = Math.cos(ETH.tilt),
    st = Math.sin(ETH.tilt);
  const P = EV.map(([x, y, z]) => {
    const x1 = x * cs + z * sn,
      z1 = -x * sn + z * cs;
    const y2 = y * ct - z1 * st,
      z2 = y * st + z1 * ct;
    return { x: cx + x1 * scale, y: cy - y2 * scale, z: z2 };
  });
  const order = EF.map(f => ({ f, z: (P[f[0]].z + P[f[1]].z + P[f[2]].z) / 3 })).sort((a, b) => a.z - b.z);
  for (const { f, z } of order) {
    ctx.beginPath();
    ctx.moveTo(P[f[0]].x, P[f[0]].y);
    ctx.lineTo(P[f[1]].x, P[f[1]].y);
    ctx.lineTo(P[f[2]].x, P[f[2]].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(188,255,91,${(z > 0 ? 0.22 : 0.08) * alpha})`;
    ctx.fill();
  }
  ctx.shadowColor = "#bcff5b";
  ctx.shadowBlur = 16;
  ctx.strokeStyle = `rgba(210,255,140,${0.95 * alpha})`;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (const [a, b] of EE) {
    ctx.moveTo(P[a].x, P[a].y);
    ctx.lineTo(P[b].x, P[b].y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/* ---- lobster claw (ported from slop-shapes.js) ---- */
const CLAW_BASE = [
  [0.1, 0.42],
  [-0.18, 0.56],
  [-0.58, 0.4],
  [-0.74, 0.0],
  [-0.58, -0.4],
  [-0.18, -0.56],
  [0.1, -0.42],
];
const CLAW_JAW = [
  [0.0, 0.06],
  [0.0, 0.46],
  [0.46, 0.56],
  [0.96, 0.3],
  [1.22, 0.04],
  [0.76, 0.11],
  [0.36, 0.09],
];
const CLAW_JAW_LO = CLAW_JAW.map(([x, y]) => [x, -y]);

function drawClaw(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  scale: number,
  handAngle: number,
  openAngle: number,
  alpha: number,
) {
  const chA = Math.cos(handAngle),
    shA = Math.sin(handAngle);
  const tf = (px: number, py: number, jaw: number) => {
    const cj = Math.cos(jaw),
      sj = Math.sin(jaw);
    const x1 = px * cj - py * sj,
      y1 = px * sj + py * cj;
    const x2 = x1 * chA - y1 * shA,
      y2 = x1 * shA + y1 * chA;
    return { x: cx + x2 * scale, y: cy + y2 * scale };
  };
  const poly = (pts: number[][], jaw: number) => {
    ctx.beginPath();
    const p0 = tf(pts[0][0], pts[0][1], jaw);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = tf(pts[i][0], pts[i][1], jaw);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(255,40,55,${0.14 * alpha})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(255,75,85,${0.96 * alpha})`;
    ctx.lineWidth = 2.4;
    ctx.stroke();
  };
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.shadowColor = "#ff2a3a";
  ctx.shadowBlur = 16;
  poly(CLAW_BASE, 0);
  poly(CLAW_JAW, +openAngle);
  poly(CLAW_JAW_LO, -openAngle);
  ctx.strokeStyle = `rgba(255,110,120,${0.6 * alpha})`;
  ctx.lineWidth = 1.4;
  for (const jaw of [+openAngle, -openAngle]) {
    const a = tf(0.1, jaw > 0 ? 0.16 : -0.16, jaw),
      b = tf(1.0, 0.05 * (jaw > 0 ? 1 : -1), jaw);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.restore();
}

// Tiny seeded PRNG so every client derives the same flight from the same
// broadcast. Never Math.random() at render time — that's what would make
// screens diverge.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Flight = {
  vx: number; // viewport-widths per second
  vy: number; // viewport-heights per second
  wobbleAmp: number;
  wobbleHz: number;
  wobblePhase: number;
};

const flightFor = (g: GestureEvent): Flight => {
  const rnd = mulberry32(g.seed);
  // Drift toward the far side of the screen from the spawn point, with a
  // seeded vertical component — reads as "released and floating away".
  const dir = g.x < 0.5 ? 1 : -1;
  return {
    vx: dir * (0.1 + rnd() * 0.12),
    vy: (rnd() - 0.5) * 0.1,
    wobbleAmp: 0.015 + rnd() * 0.02,
    wobbleHz: 0.4 + rnd() * 0.5,
    wobblePhase: rnd() * Math.PI * 2,
  };
};

export const GestureLayer = ({ gestures }: { gestures: GestureEvent[] }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gesturesRef = useRef<GestureEvent[]>(gestures);
  gesturesRef.current = gestures;
  const flightsRef = useRef<Map<number, Flight>>(new Map());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || gestures.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = window.innerWidth,
        H = window.innerHeight;
      if (canvas.width !== Math.floor(W * dpr) || canvas.height !== Math.floor(H * dpr)) {
        canvas.width = Math.floor(W * dpr);
        canvas.height = Math.floor(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const now = Date.now();
      const live = gesturesRef.current;
      const flights = flightsRef.current;
      for (const g of live) {
        let fl = flights.get(g.id);
        if (!fl) {
          fl = flightFor(g);
          flights.set(g.id, fl);
        }
        const t = (now - g.receivedAt) / 1000;
        const x = (g.x + fl.vx * t) * W;
        const y = (g.y + fl.vy * t + fl.wobbleAmp * Math.sin(fl.wobblePhase + t * fl.wobbleHz * Math.PI * 2)) * H;
        const size = g.s * H;
        // Dead once fully off-screen — skip drawing, mesh prune collects it.
        if (x < -size * 2 || x > W + size * 2 || y < -size * 2 || y > H + size * 2) continue;
        const alpha = Math.min(1, (now - g.receivedAt) / FADE_IN_MS);
        if (g.kind === "eth") {
          drawEth(ctx, x, y, size * 0.5, g.spin + t * 1.5, alpha);
        } else {
          drawClaw(ctx, x, y, size, g.angle + Math.sin(t * 1.1) * 0.15, g.open + 0.12 + 0.12 * Math.sin(t * 3), alpha);
        }
      }
      // Drop flight params for pruned gestures so the map can't grow forever.
      for (const id of flights.keys()) if (!live.some(g => g.id === id)) flights.delete(id);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      const c = canvasRef.current;
      c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    };
  }, [gestures.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (gestures.length === 0) return null;
  return (
    <canvas
      ref={canvasRef}
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", pointerEvents: "none", zIndex: Z }}
    />
  );
};

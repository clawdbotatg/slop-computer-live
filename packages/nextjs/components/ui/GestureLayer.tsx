"use client";

import { useEffect, useRef } from "react";
import type { GestureEvent, LiveGesture, Publication } from "~~/hooks/usePeerMesh";

// The room's shared FOREGROUND: a full-viewport canvas rendering hand-gesture
// effects on top of everything — desktop, windows, chat. Two phases:
//
//   HOLD    — while a peer holds a gesture, their page streams position
//             updates at cursor rate and the symbol renders LIVE at their
//             hand, sized to and anchored on their camera window.
//   RELEASE — the symbol launches: eth/claw fly outward from screen center
//             through the launch point; the slop computer logo zooms "at"
//             the screen (grows + fades, gone in under a second).
//
// x/y/s in the events are normalized to the SENDER's camera frame; each
// viewer maps them through that peer's camera window rect + the video's
// object-fit:cover crop, so the effect sits on the hand on every screen —
// god mode included, which is what puts it on the stream. If the sender's
// camera window isn't up and visible, their effects simply don't render.
// pointer-events: none — this layer can never eat a click.
//
// The eth / claw draw functions are ported from slop-computer-background's
// slop-shapes.js so the look matches the original OBS rig.

// Just under the cursor layer (2^31-1) — above every window and modal.
const Z = 2147483646;
const FADE_IN_MS = 200;
// The slop computer logo flies "at" the screen: grows and fades over this long.
const COMPUTER_LIFE_MS = 900;
// A live gesture with no update for this long is stale — hidden here, swept
// from state by the mesh shortly after.
const LIVE_STALE_MS = 700;
// How hard live symbols chase their latest broadcast position (per second).
const SMOOTH_RATE = 14;

// The slop computer logo (copied from the rig's computer.png). Loaded lazily
// on the client only — this module is imported during SSR where Image doesn't
// exist.
let computerImg: HTMLImageElement | null = null;
function getComputerImg(): HTMLImageElement | null {
  if (typeof window === "undefined") return null;
  if (!computerImg) {
    computerImg = new Image();
    computerImg.src = "/gesture-computer.png";
  }
  return computerImg.complete && computerImg.naturalWidth > 0 ? computerImg : null;
}

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

// Where a peer's normalized camera-frame point lands on THIS viewer's screen:
// their camera window's <video>, mapped through object-fit:cover. Returns the
// point plus the displayed video height (the size basis, so symbols scale
// with the window). Null when that camera isn't up and visible — effect is
// simply not rendered.
function frameToScreen(
  from: string,
  nx: number,
  ny: number,
  pubs: Publication[],
): { x: number; y: number; dh: number } | null {
  const pub = pubs.find(p => p.kind === "camera" && !p.cameraOff && p.peerId === from);
  if (!pub) return null;
  const slotId = `owner-${pub.ownerKey}-camera`;
  const video = document.querySelector(`[data-slot-id="${CSS.escape(slotId)}"] video`);
  if (!(video instanceof HTMLVideoElement) || !video.videoWidth || !video.videoHeight) return null;
  const r = video.getBoundingClientRect();
  // A docked/minimized pill (or an off-screen window) doesn't count as
  // "camera up and visible".
  if (r.width < 80 || r.height < 60) return null;
  const scale = Math.max(r.width / video.videoWidth, r.height / video.videoHeight);
  const dw = video.videoWidth * scale;
  const dh = video.videoHeight * scale;
  return {
    x: r.left + nx * dw - (dw - r.width) / 2,
    y: r.top + ny * dh - (dh - r.height) / 2,
    dh,
  };
}

type Flight = {
  sx: number; // launch point in viewport px, frozen at release
  sy: number;
  size: number; // px size basis, frozen at release
  vx: number; // viewport-widths per second
  vy: number; // viewport-heights per second
  wobbleAmp: number;
  wobbleHz: number;
  wobblePhase: number;
};

const flightFor = (g: GestureEvent, sx: number, sy: number, size: number, W: number, H: number): Flight => {
  const rnd = mulberry32(g.seed);
  // Fly outward: away from the center of the screen, along the line from
  // center through the launch point (seeded direction when launched dead
  // center).
  const dx = sx - W / 2;
  const dy = sy - H / 2;
  const len = Math.hypot(dx, dy);
  const a = len < 1 ? rnd() * Math.PI * 2 : Math.atan2(dy, dx);
  const speed = 0.1 + rnd() * 0.12;
  return {
    sx,
    sy,
    size,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    wobbleAmp: 0.015 + rnd() * 0.02,
    wobbleHz: 0.4 + rnd() * 0.5,
    wobblePhase: rnd() * Math.PI * 2,
  };
};

// Locally-smoothed screen position for a live (held) gesture, so 10Hz
// broadcasts render as continuous motion.
type Smooth = { x: number; y: number; angle: number; open: number; spin: number; lastT: number };

export const GestureLayer = ({
  gestures,
  liveGestures,
  publications,
}: {
  gestures: GestureEvent[];
  liveGestures: Record<string, LiveGesture>;
  publications: Publication[];
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gesturesRef = useRef<GestureEvent[]>(gestures);
  gesturesRef.current = gestures;
  const liveRef = useRef<Record<string, LiveGesture>>(liveGestures);
  liveRef.current = liveGestures;
  const pubsRef = useRef<Publication[]>(publications);
  pubsRef.current = publications;
  const flightsRef = useRef<Map<number, Flight>>(new Map());
  const deadRef = useRef<Set<number>>(new Set());
  const smoothRef = useRef<Map<string, Smooth>>(new Map());

  const active = gestures.length > 0 || Object.keys(liveGestures).length > 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
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
      const pubs = pubsRef.current;

      // ---- live (held) gestures: track the hand on the sender's window ----
      const smooth = smoothRef.current;
      for (const g of Object.values(liveRef.current)) {
        if (now - g.updatedAt > LIVE_STALE_MS) continue;
        const p = frameToScreen(g.from, g.x, g.y, pubs);
        if (!p) continue;
        let sm = smooth.get(g.key);
        if (!sm) {
          sm = { x: p.x, y: p.y, angle: g.angle, open: g.open, spin: g.spin, lastT: now };
          smooth.set(g.key, sm);
        }
        const dt = Math.min(0.1, (now - sm.lastT) / 1000);
        sm.lastT = now;
        const k = Math.min(1, dt * SMOOTH_RATE);
        sm.x += (p.x - sm.x) * k;
        sm.y += (p.y - sm.y) * k;
        sm.angle += (g.angle - sm.angle) * k;
        sm.open += (g.open - sm.open) * k;
        sm.spin = g.spin;
        const size = g.s * p.dh;
        if (g.kind === "eth") {
          drawEth(ctx, sm.x, sm.y, size * 0.5, sm.spin, 1);
        } else if (g.kind === "claw") {
          drawClaw(ctx, sm.x, sm.y, size, sm.angle, sm.open, 1);
        } else {
          const img = getComputerImg();
          if (img) {
            ctx.save();
            ctx.shadowColor = "#ff3ec9";
            ctx.shadowBlur = 24;
            ctx.drawImage(img, sm.x - size / 2, sm.y - size / 2, size, size);
            ctx.restore();
          }
        }
      }
      for (const key of smooth.keys()) if (!(key in liveRef.current)) smooth.delete(key);

      // ---- released gestures: launch from the hand and fly ----
      const live = gesturesRef.current;
      const flights = flightsRef.current;
      const dead = deadRef.current;
      for (const g of live) {
        if (dead.has(g.id)) continue;
        let fl = flights.get(g.id);
        if (!fl) {
          const p = frameToScreen(g.from, g.x, g.y, pubs);
          if (!p) {
            // Sender's camera vanished between hold and release — drop it.
            dead.add(g.id);
            continue;
          }
          fl = flightFor(g, p.x, p.y, g.s * p.dh, W, H);
          flights.set(g.id, fl);
        }
        const t = (now - g.receivedAt) / 1000;

        if (g.kind === "computer") {
          // The slop computer logo flies "at" the screen: stays put, grows
          // fast, fades to nothing, gone in under a second.
          const lifeT = (now - g.receivedAt) / COMPUTER_LIFE_MS;
          if (lifeT >= 1) {
            dead.add(g.id);
            continue;
          }
          const img = getComputerImg();
          if (!img) continue;
          const size = fl.size * (1 + lifeT * 3.5);
          ctx.save();
          ctx.globalAlpha = 1 - lifeT;
          ctx.shadowColor = "#ff3ec9";
          ctx.shadowBlur = 24;
          ctx.drawImage(img, fl.sx - size / 2, fl.sy - size / 2, size, size);
          ctx.restore();
          continue;
        }

        const x = fl.sx + fl.vx * W * t;
        const y = fl.sy + fl.vy * H * t + fl.wobbleAmp * H * Math.sin(fl.wobblePhase + t * fl.wobbleHz * Math.PI * 2);
        const size = fl.size;
        // Dead once fully off-screen — skip drawing, mesh prune collects it.
        if (x < -size * 2 || x > W + size * 2 || y < -size * 2 || y > H + size * 2) continue;
        const alpha = Math.min(1, (now - g.receivedAt) / FADE_IN_MS);
        if (g.kind === "eth") {
          drawEth(ctx, x, y, size * 0.5, g.spin + t * 1.5, alpha);
        } else {
          drawClaw(ctx, x, y, size, g.angle + Math.sin(t * 1.1) * 0.15, g.open + 0.12 + 0.12 * Math.sin(t * 3), alpha);
        }
      }
      // Drop bookkeeping for pruned gestures so the maps can't grow forever.
      for (const id of flights.keys()) if (!live.some(g => g.id === id)) flights.delete(id);
      for (const id of dead) if (!live.some(g => g.id === id)) dead.delete(id);

      // Debug hook — lets a console (or an agent) confirm events are flowing
      // without reading pixels. Cheap: three numbers.
      (window as unknown as Record<string, unknown>).__slopGestures = {
        live: Object.keys(liveRef.current).length,
        flights: flights.size,
        drawnAt: now,
      };
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      const c = canvasRef.current;
      c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    };
  }, [active]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", pointerEvents: "none", zIndex: Z }}
    />
  );
};

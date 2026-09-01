"use client";

import { useEffect, useRef } from "react";
import type { GestureEvent, Peer, Publication } from "~~/hooks/usePeerMesh";

// Full-viewport canvas that renders hand-gesture effects (relay `gesture`
// broadcasts) flying across the top of everything — desktop, windows, chat.
// Each effect spawns AT THE GESTURING HAND: the event's x/y are normalized
// coords inside the anchor identity's camera frame, mapped through that
// camera window's rect + object-fit:cover crop on this viewer's screen. If
// that camera isn't up and visible, the effect is not rendered at all. Every
// client (god-mode included, which is what puts it on the stream) runs the
// same seeded flight, so screens agree without streaming animation state. An
// effect dies when it drifts off-screen; the mesh's 15s prune is the
// backstop. pointer-events: none, so it can never eat a click.
//
// The eth / claw draw functions are ported from slop-computer-background's
// slop-shapes.js (the OBS rig) so the shared effects match the show's look.

// Just under the cursor layer (2^31-1) — above every window and modal.
const Z = 2147483646;
const FADE_IN_MS = 300;
// The slop computer logo flies "at" the screen: grows and fades over this long.
const COMPUTER_LIFE_MS = 900;

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

type Flight = {
  // Spawn point in viewport px, resolved once from the anchor camera window.
  sx: number;
  sy: number;
  vx: number; // viewport-widths per second
  vy: number; // viewport-heights per second
  wobbleAmp: number;
  wobbleHz: number;
  wobblePhase: number;
};

// How long after arrival we keep trying to resolve the anchor window before
// declaring the gesture dead (covers a slot/publication landing a beat late).
const ANCHOR_GRACE_MS = 1000;

const flightFor = (g: GestureEvent, sx: number, sy: number, W: number, H: number): Flight => {
  const rnd = mulberry32(g.seed);
  // Fly outward: away from the center of the screen, along the line from
  // center through the spawn point (seeded direction when spawned dead
  // center). Speed stays in viewport-widths/heights per second.
  const dx = sx - W / 2;
  const dy = sy - H / 2;
  const len = Math.hypot(dx, dy);
  const a = len < 1 ? rnd() * Math.PI * 2 : Math.atan2(dy, dx);
  const speed = 0.1 + rnd() * 0.12;
  return {
    sx,
    sy,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    wobbleAmp: 0.015 + rnd() * 0.02,
    wobbleHz: 0.4 + rnd() * 0.5,
    wobblePhase: rnd() * Math.PI * 2,
  };
};

// Where the gesturing hand is on THIS viewer's screen: find the anchor
// identity's camera window and map the normalized in-frame hand position
// through the video's object-fit:cover crop. Null when that camera isn't up
// and visible — in which case the effect is simply not rendered (per Austin:
// no full-screen fallback). Note the point can land slightly outside the
// window when cover-cropping cut the band the hand was in; that still reads
// correctly ("just off the edge of their window").
function anchorPoint(g: GestureEvent, pubs: Publication[], peers: Peer[]): { x: number; y: number } | null {
  if (!g.anchor) return null;
  const pub = pubs.find(
    p =>
      p.kind === "camera" &&
      !p.cameraOff &&
      (p.ownerKey.toLowerCase() === g.anchor ||
        peers.some(
          pe => pe.id === p.peerId && (pe.address?.toLowerCase() === g.anchor || pe.handle?.toLowerCase() === g.anchor),
        )),
  );
  if (!pub) return null;
  // Same deterministic slot id the relay's desktop.ts mints for camera pubs.
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
    x: r.left + g.x * dw - (dw - r.width) / 2,
    y: r.top + g.y * dh - (dh - r.height) / 2,
  };
}

export const GestureLayer = ({
  gestures,
  publications,
  peers,
}: {
  gestures: GestureEvent[];
  publications: Publication[];
  peers: Peer[];
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gesturesRef = useRef<GestureEvent[]>(gestures);
  gesturesRef.current = gestures;
  const pubsRef = useRef<Publication[]>(publications);
  pubsRef.current = publications;
  const peersRef = useRef<Peer[]>(peers);
  peersRef.current = peers;
  const flightsRef = useRef<Map<number, Flight>>(new Map());
  const deadRef = useRef<Set<number>>(new Set());

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
      const dead = deadRef.current;
      for (const g of live) {
        if (dead.has(g.id)) continue;
        let fl = flights.get(g.id);
        if (!fl) {
          // Resolve the spawn point from the anchor's camera window on this
          // viewer's screen. Not resolvable → retry briefly (a pub/slot can
          // land a beat after the broadcast), then give up: camera not up
          // and visible means the effect is not shown at all.
          const p = anchorPoint(g, pubsRef.current, peersRef.current);
          if (!p) {
            if (now - g.receivedAt > ANCHOR_GRACE_MS) dead.add(g.id);
            continue;
          }
          fl = flightFor(g, p.x, p.y, W, H);
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
          if (!img) continue; // still loading — it'll pop in next frame
          const grow = 1 + lifeT * 3.5;
          const size = g.s * H * grow;
          const alpha = 1 - lifeT;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.shadowColor = "#ff3ec9";
          ctx.shadowBlur = 24;
          ctx.drawImage(img, fl.sx - size / 2, fl.sy - size / 2, size, size);
          ctx.restore();
          continue;
        }

        const x = fl.sx + fl.vx * W * t;
        const y = fl.sy + fl.vy * H * t + fl.wobbleAmp * H * Math.sin(fl.wobblePhase + t * fl.wobbleHz * Math.PI * 2);
        // Half the raw broadcast size — full-size read as too big on the
        // shared desktop.
        const size = g.s * H * 0.5;
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

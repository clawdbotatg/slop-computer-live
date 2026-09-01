"use client";

import { useEffect, useRef } from "react";
import type { GestureKind, LiveGesture, Publication } from "~~/hooks/usePeerMesh";

// Bridge from the OBS rig's native hand detector to the room's shared
// gesture layer. slop-computer-background's slop-detector captures the clean
// camera feed via ScreenCaptureKit + Apple Vision and publishes 21 MediaPipe-
// order landmarks on http://localhost:9911/hands.sse. This hook — running in
// the room page on the SAME machine (guaranteed: the camera reaches the room
// via OBS Virtual Camera → getUserMedia, which only works on the OBS box) —
// classifies those hands and streams gesture_hold / gesture_release over the
// page's own WS. Identity, room, and auth all inherit from the session:
// nothing to configure, works in any room.
//
// On machines without the rig the EventSource simply never connects and this
// hook does nothing. Guests (phase 2) will run an in-browser detector that
// feeds the SAME classifier and send path.
//
// The classifier + gesture state machine below is a faithful port of
// foreground.html from slop-computer-background (the retired OBS overlay) —
// same signatures, same hold-to-activate debounce, same tuning constants.

const RIG_SSE = "http://localhost:9911/hands.sse";
// Virtual canvas the port runs in — 16:9 like the rig's foreground canvas, so
// every px-tuned constant (span thresholds, hold radii) behaves identically.
// Outputs are normalized (x/VW, y/VH, s/VH) before sending.
const VW = 1280;
const VH = 720;
const THUMB_OUT = 0.1; // thumb-out cutoff (separates 🦞 claw from ✌️ peace)
const CLAW_INWARD = (40 * Math.PI) / 180; // rotate claws toward frame center
const HOLD_MS = 150; // signature must be stable this long before it fires
const EMIT_INTERVAL = 150; // fist's eth-drop cadence
const FRAME_HOLD_MS = 200; // two-L computer frame persistence
const STALE_MS = 700; // detector silent this long -> hands are gone

type LM = { x: number; y: number }[];
type HandInfo = {
  key: string;
  lm: LM;
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  span: number;
  scale: number;
  raw: string;
  pose: string;
};

const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function palmCenter(lm: LM) {
  const idx = [0, 5, 9, 13, 17];
  let x = 0,
    y = 0;
  for (const i of idx) {
    x += lm[i].x;
    y += lm[i].y;
  }
  return { x: x / idx.length, y: y / idx.length };
}

// Signed, chirality-free thumb-out: + when splayed to the radial side.
function thumbOut(lm: LM): boolean {
  const ux = lm[9].x - lm[0].x,
    uy = lm[9].y - lm[0].y,
    ul = Math.hypot(ux, uy) || 1;
  const nx = -uy / ul,
    ny = ux / ul;
  const lat = (p: { x: number; y: number }) => (p.x - lm[0].x) * nx + (p.y - lm[0].y) * ny;
  return (lat(lm[4]) * Math.sign(lat(lm[1]) || 1)) / ul > THUMB_OUT;
}

function fingerExt(lm: LM): boolean[] {
  const w = lm[0];
  const ext: boolean[] = [];
  ext[0] = thumbOut(lm);
  const pr = [
    [8, 6],
    [12, 10],
    [16, 14],
    [20, 18],
  ];
  for (let i = 0; i < 4; i++) ext[i + 1] = dist2(lm[pr[i][0]], w) > dist2(lm[pr[i][1]], w) * 0.9;
  return ext;
}

// Finger signature -> deliberate gesture; unrecognized -> 'none'.
function classify(ext: boolean[]): string {
  const [t, i, m, r, p] = ext;
  const count = ext.filter(Boolean).length;
  if (count <= 1) return "fist"; // ✊ emit eth stream
  if (i && p && !m && !r) return "horns"; // 🤘 eth held on the hand
  if (t && i && m && !r && !p) return "claw"; // 🦞
  if (t && i && !m && !r && !p) return "L"; // 📐 two of these summon the computer
  return "none";
}

type GestureIO = {
  hold: (g: Omit<LiveGesture, "key" | "from" | "updatedAt">) => void;
  release: (g: Omit<LiveGesture, "key" | "from" | "updatedAt">) => void;
};

export function useRigGestures(opts: {
  enabled: boolean; // this session is the gesturing one: publishing its camera, not god-mode
  sendGestureHold: GestureIO["hold"];
  sendGestureRelease: GestureIO["release"];
  publications: Publication[];
  myId: string | null;
}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    // ---- gesture state (ported from foreground.html's loop) ----
    const heldEth: Record<string, { x: number; y: number; scale: number; spin: number }> = {};
    const heldClaw: Record<string, { x: number; y: number; scale: number; angle: number; open: number }> = {};
    const lastEmit: Record<string, number> = {};
    const poseState: Record<string, { name: string; since: number }> = {};
    let compActive = false;
    let lastComp: { cx: number; cy: number; size: number } | null = null;
    let frameHoldUntil = 0;
    let lastMsgAt = 0;

    const io = (): GestureIO | null => {
      const o = optsRef.current;
      if (!o.enabled) return null;
      return { hold: o.sendGestureHold, release: o.sendGestureRelease };
    };

    const norm = (kind: GestureKind, hand: string, x: number, y: number, s: number, extra: Partial<LiveGesture>) => ({
      kind,
      hand,
      x: x / VW,
      y: y / VH,
      s: s / VH,
      spin: extra.spin ?? 0,
      angle: extra.angle ?? 0,
      open: extra.open ?? 0.25,
    });

    // Release everything currently held (hands lost / detector quiet / teardown).
    const releaseAll = () => {
      const out = io();
      for (const key of Object.keys(heldEth)) {
        const h = heldEth[key];
        out?.release(norm("eth", key, h.x, h.y, h.scale, { spin: h.spin }));
        delete heldEth[key];
      }
      for (const key of Object.keys(heldClaw)) {
        const h = heldClaw[key];
        out?.release(norm("claw", key, h.x, h.y, h.scale, { angle: h.angle, open: h.open }));
        delete heldClaw[key];
      }
      if (compActive && lastComp) {
        out?.release(norm("computer", "frame", lastComp.cx, lastComp.cy, lastComp.size, {}));
        compActive = false;
      }
    };

    const onHands = (raw: { chirality?: string; lm?: number[][] }[]) => {
      const now = performance.now();
      const dt = lastMsgAt ? Math.min(0.15, (now - lastMsgAt) / 1000) : 0.1;
      lastMsgAt = now;
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(releaseAll, STALE_MS);

      const out = io();
      if (!out) {
        releaseAll();
        return;
      }

      const hands: HandInfo[] = [];
      raw.forEach((h, idx) => {
        const lm = (h.lm || []).map(p => ({ x: p[0] * VW, y: p[1] * VH }));
        if (lm.length < 21) return;
        const c = palmCenter(lm);
        const dx = lm[9].x - lm[0].x,
          dy = lm[9].y - lm[0].y;
        const span = Math.hypot(dx, dy);
        const rawPose = classify(fingerExt(lm));
        hands.push({
          key: (h.chirality || "h") + idx,
          lm,
          sx: c.x,
          sy: c.y,
          dx,
          dy,
          span,
          scale: Math.max(30, span * 1.7),
          raw: rawPose,
          pose: "none",
        });
      });

      // Hold-to-activate: a signature fires only after HOLD_MS of stability;
      // 'fist' fires instantly (snappy eth drops).
      for (const hi of hands) {
        const st = poseState[hi.key] || (poseState[hi.key] = { name: hi.raw, since: now });
        if (st.name !== hi.raw) {
          st.name = hi.raw;
          st.since = now;
        }
        hi.pose = hi.raw === "fist" || now - st.since >= HOLD_MS ? hi.raw : "none";
      }
      for (const k of Object.keys(poseState)) if (!hands.some(h => h.key === k)) delete poseState[k];

      // Two-hand L frame -> the slop computer.
      let frame: { cx: number; cy: number; size: number } | null = null;
      if (hands.length >= 2) {
        const a = hands[0],
          b = hands[1];
        const d = Math.hypot(a.sx - b.sx, a.sy - b.sy),
          avg = (a.span + b.span) / 2;
        if (a.pose === "L" && b.pose === "L" && d < avg * 7) {
          let minx = 1e9,
            miny = 1e9,
            maxx = -1e9,
            maxy = -1e9;
          for (const hi of [a, b])
            for (const p of hi.lm) {
              if (p.x < minx) minx = p.x;
              if (p.x > maxx) maxx = p.x;
              if (p.y < miny) miny = p.y;
              if (p.y > maxy) maxy = p.y;
            }
          frame = {
            cx: (minx + maxx) / 2,
            cy: (miny + maxy) / 2,
            size: Math.min(Math.max(maxx - minx, maxy - miny) * 1.15, VH * 0.92),
          };
        }
      }
      if (frame) {
        frameHoldUntil = now + FRAME_HOLD_MS;
        lastComp = frame;
      }

      const ethSeen: Record<string, 1> = {};
      const clawSeen: Record<string, 1> = {};
      if (now < frameHoldUntil && lastComp) {
        compActive = true;
        out.hold(norm("computer", "frame", lastComp.cx, lastComp.cy, lastComp.size, {}));
      } else {
        if (compActive && lastComp) {
          out.release(norm("computer", "frame", lastComp.cx, lastComp.cy, lastComp.size, {}));
          compActive = false;
        }
        for (const hi of hands) {
          const angle = Math.atan2(hi.dy, hi.dx);
          if (hi.pose === "horns") {
            // 🤘 eth tracks the hand
            const prev = heldEth[hi.key];
            heldEth[hi.key] = { x: hi.sx, y: hi.sy, scale: hi.scale, spin: (prev ? prev.spin : 0) + dt * 1.2 };
            ethSeen[hi.key] = 1;
            out.hold(norm("eth", hi.key, hi.sx, hi.sy, hi.scale, { spin: heldEth[hi.key].spin }));
          } else if (hi.pose === "fist") {
            // ✊ drop + emit eth stream
            if (now - (lastEmit[hi.key] || 0) >= EMIT_INTERVAL) {
              lastEmit[hi.key] = now;
              const jx = (Math.random() - 0.5) * 18,
                jy = (Math.random() - 0.5) * 18;
              out.release(norm("eth", hi.key, hi.sx + jx, hi.sy + jy, hi.scale, { spin: Math.random() * 6.28 }));
            }
          } else if (hi.pose === "claw") {
            // 🦞 claw, opens with pinch
            const pinch = Math.hypot(hi.lm[4].x - hi.lm[8].x, hi.lm[4].y - hi.lm[8].y);
            const openAmt = Math.max(0, Math.min(1, (pinch / Math.max(1, hi.span) - 0.35) / 1.0)) * 0.5;
            const clawAngle = angle + (hi.sx < VW / 2 ? 1 : -1) * CLAW_INWARD;
            heldClaw[hi.key] = { x: hi.sx, y: hi.sy, scale: hi.span * 2.4, angle: clawAngle, open: openAmt };
            clawSeen[hi.key] = 1;
            out.hold(norm("claw", hi.key, hi.sx, hi.sy, hi.span * 2.4, { angle: clawAngle, open: openAmt }));
          }
        }
      }

      // Release anything whose hand-state ended this message.
      for (const key of Object.keys(heldEth))
        if (!ethSeen[key]) {
          const h = heldEth[key];
          out.release(norm("eth", key, h.x, h.y, h.scale, { spin: h.spin }));
          delete heldEth[key];
        }
      for (const key of Object.keys(heldClaw))
        if (!clawSeen[key]) {
          const h = heldClaw[key];
          out.release(norm("claw", key, h.x, h.y, h.scale, { angle: h.angle, open: h.open }));
          delete heldClaw[key];
        }
    };

    const connect = () => {
      if (closed) return;
      try {
        es = new EventSource(RIG_SSE);
      } catch {
        return; // environment without EventSource — nothing to do
      }
      es.onmessage = e => {
        try {
          const d = JSON.parse(e.data);
          onHands(d.hands || []);
        } catch {
          /* malformed frame — skip */
        }
      };
      es.onerror = () => {
        // EventSource auto-retries transient failures; if it gave up
        // entirely (readyState CLOSED — e.g. no rig on this machine), try
        // again on a slow timer so plugging the rig in later still works.
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          if (!closed) retryTimer = setTimeout(connect, 60_000);
        }
      };
    };
    connect();

    return () => {
      closed = true;
      releaseAll();
      if (retryTimer) clearTimeout(retryTimer);
      if (staleTimer) clearTimeout(staleTimer);
      es?.close();
    };
  }, []);
}

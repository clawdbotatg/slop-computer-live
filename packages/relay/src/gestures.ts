// One detector watches the whole show — this is its brain.
//
// The "eye" is an effects-free spectator view of the room (?fx=0) captured by
// the native slop-detector (ScreenCaptureKit + Apple Vision) on the rig. The
// detector POSTs raw 21-point hand landmarks (normalized to the captured
// window) to /v1/hands; the eye page reports its viewport + every camera
// window's rect and video dimensions over its WS (eye_geometry). This engine
// joins the two: it maps each detected hand into whichever peer's camera
// window it sits over, classifies the pose (fist / horns / claw / two-L
// computer — the same signatures as the original OBS rig), runs the
// hold-to-activate state machine, and broadcasts the exact gesture_hold /
// gesture_release events the clients already render. Guests need nothing:
// if your hands are visible on the show, your gestures work.
//
// The classifier + state machine are a port of foreground.html from
// slop-computer-background (via useRigGestures.ts) — same tuning constants,
// run in a virtual 1280x720 "frame space" per camera so every px-tuned
// threshold behaves identically.

type Pt = { x: number; y: number };
type LM = Pt[];

export type EyeCam = {
  peerId: string;
  rect: { x: number; y: number; w: number; h: number }; // video element rect, eye-viewport CSS px
  videoW: number;
  videoH: number;
};
export type EyeGeometry = { vw: number; vh: number; cams: EyeCam[]; at: number };

export type GestureBroadcast = {
  type: "gesture_hold" | "gesture_release";
  from: string;
  hand: string;
  kind: "eth" | "claw" | "computer";
  x: number;
  y: number;
  s: number;
  spin: number;
  angle: number;
  open: number;
  seed?: number;
};

// Virtual frame space (16:9) — matches the rig foreground's canvas so the
// px-tuned constants below keep their meaning.
const VW = 1280;
const VH = 720;
const THUMB_OUT = 0.1;
const CLAW_INWARD = (40 * Math.PI) / 180;
const HOLD_MS = 150;
const EMIT_INTERVAL = 150;
const FRAME_HOLD_MS = 200;
export const HANDS_STALE_MS = 700; // detector quiet this long -> release all

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
// Safe landmark accessor — the wire guarantees 21 points, TS doesn't.
const at = (lm: LM, i: number): Pt => lm[i] ?? { x: 0, y: 0 };

function palmCenter(lm: LM): Pt {
  const idx = [0, 5, 9, 13, 17];
  let x = 0,
    y = 0;
  for (const i of idx) {
    const p = at(lm, i);
    x += p.x;
    y += p.y;
  }
  return { x: x / idx.length, y: y / idx.length };
}

function thumbOut(lm: LM): boolean {
  const ux = at(lm, 9).x - at(lm, 0).x,
    uy = at(lm, 9).y - at(lm, 0).y,
    ul = Math.hypot(ux, uy) || 1;
  const nx = -uy / ul,
    ny = ux / ul;
  const lat = (p: Pt) => (p.x - at(lm, 0).x) * nx + (p.y - at(lm, 0).y) * ny;
  return (lat(at(lm, 4)) * Math.sign(lat(at(lm, 1)) || 1)) / ul > THUMB_OUT;
}

function fingerExt(lm: LM): boolean[] {
  const w = at(lm, 0);
  const ext: boolean[] = [];
  ext[0] = thumbOut(lm);
  const pr: [number, number][] = [
    [8, 6],
    [12, 10],
    [16, 14],
    [20, 18],
  ];
  for (let i = 0; i < 4; i++) {
    const [tip, pip] = pr[i]!;
    ext[i + 1] = dist(at(lm, tip), w) > dist(at(lm, pip), w) * 0.9;
  }
  return ext;
}

function classify(ext: boolean[]): string {
  const [t, i, m, r, p] = ext;
  const count = ext.filter(Boolean).length;
  if (count <= 1) return "fist";
  if (i && p && !m && !r) return "horns";
  if (t && i && m && !r && !p) return "claw";
  if (t && i && !m && !r && !p) return "L";
  return "none";
}

type HandInFrame = {
  key: string; // `${peerId}:${chirality}${idx}` — stable enough per frame stream
  hand: string;
  peerId: string;
  lm: LM; // virtual frame px
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  span: number;
  scale: number;
  raw: string;
  pose: string;
};

export class GestureEngine {
  private geometry: EyeGeometry | null = null;
  private poseState = new Map<string, { name: string; since: number }>();
  private heldEth = new Map<string, { peerId: string; hand: string; x: number; y: number; scale: number; spin: number }>();
  private heldClaw = new Map<
    string,
    { peerId: string; hand: string; x: number; y: number; scale: number; angle: number; open: number }
  >();
  private lastEmit = new Map<string, number>();
  // Two-L computer frame, per peer window.
  private comp = new Map<string, { active: boolean; last: { cx: number; cy: number; size: number } | null; holdUntil: number }>();
  private lastHandsAt = 0;
  private lastMsgAt = 0;

  constructor(private emit: (msg: GestureBroadcast) => void) {}

  setGeometry(g: EyeGeometry) {
    this.geometry = g;
  }

  hasGeometry(): boolean {
    return !!this.geometry && Date.now() - this.geometry.at < 5000;
  }

  /** Call periodically — releases everything if the detector went quiet. */
  tick(now = Date.now()) {
    if (this.lastHandsAt && now - this.lastHandsAt > HANDS_STALE_MS) {
      this.releaseAll();
      this.lastHandsAt = 0;
    }
  }

  private out(type: GestureBroadcast["type"], peerId: string, hand: string, kind: GestureBroadcast["kind"], x: number, y: number, s: number, extra: Partial<GestureBroadcast>) {
    this.emit({
      type,
      from: peerId,
      hand,
      kind,
      x: x / VW,
      y: y / VH,
      s: s / VH,
      spin: extra.spin ?? 0,
      angle: extra.angle ?? 0,
      open: extra.open ?? 0.25,
      ...(type === "gesture_release" ? { seed: Math.floor(Math.random() * 0xffffffff) } : {}),
    });
  }

  releaseAll() {
    for (const [key, h] of this.heldEth) {
      this.out("gesture_release", h.peerId, h.hand, "eth", h.x, h.y, h.scale, { spin: h.spin });
      this.heldEth.delete(key);
    }
    for (const [key, h] of this.heldClaw) {
      this.out("gesture_release", h.peerId, h.hand, "claw", h.x, h.y, h.scale, { angle: h.angle, open: h.open });
      this.heldClaw.delete(key);
    }
    for (const [peerId, c] of this.comp) {
      if (c.active && c.last) this.out("gesture_release", peerId, "frame", "computer", c.last.cx, c.last.cy, c.last.size, {});
      this.comp.delete(peerId);
    }
    this.poseState.clear();
  }

  /**
   * One detector frame: raw hands normalized to the captured window
   * (capW x capH capture px; the eye viewport is vw x vh CSS px — width
   * assumed equal modulo DPR scaling, extra capture height is title bar).
   */
  handleHands(rawHands: { chirality?: string; lm?: number[][] }[], capW: number, capH: number) {
    const g = this.geometry;
    if (!g || !capW || !capH) return;
    const now = Date.now();
    const dt = this.lastMsgAt ? Math.min(0.15, (now - this.lastMsgAt) / 1000) : 0.1;
    this.lastMsgAt = now;
    this.lastHandsAt = now;

    const ratio = capW / g.vw; // capture px per CSS px (DPR of the eye window)
    const chromeH = Math.max(0, capH - g.vh * ratio); // title bar etc, top of capture

    // Map each raw hand into the camera window under its palm; drop hands
    // over no camera (desktop background, app windows).
    const hands: HandInFrame[] = [];
    rawHands.forEach((h, idx) => {
      const lmCss = (h.lm || []).map(p => ({
        x: ((p[0] ?? 0) * capW) / ratio,
        y: ((p[1] ?? 0) * capH - chromeH) / ratio,
      }));
      if (lmCss.length < 21) return;
      const pcCss = palmCenter(lmCss);
      const cam = g.cams.find(
        c => pcCss.x >= c.rect.x && pcCss.x <= c.rect.x + c.rect.w && pcCss.y >= c.rect.y && pcCss.y <= c.rect.y + c.rect.h,
      );
      if (!cam || !cam.videoW || !cam.videoH) return;
      // Invert object-fit:cover to get normalized in-frame coords, then into
      // virtual 1280x720 frame space for the px-tuned classifier.
      const scale = Math.max(cam.rect.w / cam.videoW, cam.rect.h / cam.videoH);
      const dw = cam.videoW * scale;
      const dh = cam.videoH * scale;
      const lm = lmCss.map(p => ({
        x: ((p.x - cam.rect.x + (dw - cam.rect.w) / 2) / dw) * VW,
        y: ((p.y - cam.rect.y + (dh - cam.rect.h) / 2) / dh) * VH,
      }));
      const c = palmCenter(lm);
      const dx = at(lm, 9).x - at(lm, 0).x,
        dy = at(lm, 9).y - at(lm, 0).y;
      const span = Math.hypot(dx, dy);
      hands.push({
        key: `${cam.peerId}:${h.chirality || "h"}${idx}`,
        hand: `${h.chirality || "h"}${idx}`,
        peerId: cam.peerId,
        lm,
        sx: c.x,
        sy: c.y,
        dx,
        dy,
        span,
        scale: Math.max(30, span * 1.7),
        raw: classify(fingerExt(lm)),
        pose: "none",
      });
    });

    // Hold-to-activate debounce ('fist' fires instantly).
    for (const hi of hands) {
      let st = this.poseState.get(hi.key);
      if (!st) {
        st = { name: hi.raw, since: now };
        this.poseState.set(hi.key, st);
      }
      if (st.name !== hi.raw) {
        st.name = hi.raw;
        st.since = now;
      }
      hi.pose = hi.raw === "fist" || now - st.since >= HOLD_MS ? hi.raw : "none";
    }
    for (const k of this.poseState.keys()) if (!hands.some(h => h.key === k)) this.poseState.delete(k);

    // Two-L computer frame — both hands must sit in the SAME peer's window.
    const byPeer = new Map<string, HandInFrame[]>();
    for (const hi of hands) {
      const arr = byPeer.get(hi.peerId) ?? [];
      arr.push(hi);
      byPeer.set(hi.peerId, arr);
    }

    const ethSeen = new Set<string>();
    const clawSeen = new Set<string>();
    const compSeen = new Set<string>();

    for (const [peerId, peerHands] of byPeer) {
      let frame: { cx: number; cy: number; size: number } | null = null;
      if (peerHands.length >= 2) {
        const a = peerHands[0]!,
          b = peerHands[1]!;
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
      let comp = this.comp.get(peerId);
      if (!comp) {
        comp = { active: false, last: null, holdUntil: 0 };
        this.comp.set(peerId, comp);
      }
      if (frame) {
        comp.holdUntil = now + FRAME_HOLD_MS;
        comp.last = frame;
      }

      if (now < comp.holdUntil && comp.last) {
        comp.active = true;
        compSeen.add(peerId);
        this.out("gesture_hold", peerId, "frame", "computer", comp.last.cx, comp.last.cy, comp.last.size, {});
        continue; // frame active: suppress single-hand gestures in this window
      }
      if (comp.active && comp.last) {
        this.out("gesture_release", peerId, "frame", "computer", comp.last.cx, comp.last.cy, comp.last.size, {});
        comp.active = false;
      }

      for (const hi of peerHands) {
        const angle = Math.atan2(hi.dy, hi.dx);
        if (hi.pose === "horns") {
          const prev = this.heldEth.get(hi.key);
          const held = {
            peerId,
            hand: hi.hand,
            x: hi.sx,
            y: hi.sy,
            scale: hi.scale,
            spin: (prev ? prev.spin : 0) + dt * 1.2,
          };
          this.heldEth.set(hi.key, held);
          ethSeen.add(hi.key);
          this.out("gesture_hold", peerId, hi.hand, "eth", hi.sx, hi.sy, hi.scale, { spin: held.spin });
        } else if (hi.pose === "fist") {
          if (now - (this.lastEmit.get(hi.key) || 0) >= EMIT_INTERVAL) {
            this.lastEmit.set(hi.key, now);
            const jx = (Math.random() - 0.5) * 18,
              jy = (Math.random() - 0.5) * 18;
            this.out("gesture_release", peerId, hi.hand, "eth", hi.sx + jx, hi.sy + jy, hi.scale, {
              spin: Math.random() * 6.28,
            });
          }
        } else if (hi.pose === "claw") {
          const pinch = Math.hypot(hi.lm[4]!.x - hi.lm[8]!.x, hi.lm[4]!.y - hi.lm[8]!.y);
          const openAmt = Math.max(0, Math.min(1, (pinch / Math.max(1, hi.span) - 0.35) / 1.0)) * 0.5;
          const clawAngle = angle + (hi.sx < VW / 2 ? 1 : -1) * CLAW_INWARD;
          const held = { peerId, hand: hi.hand, x: hi.sx, y: hi.sy, scale: hi.span * 2.4, angle: clawAngle, open: openAmt };
          this.heldClaw.set(hi.key, held);
          clawSeen.add(hi.key);
          this.out("gesture_hold", peerId, hi.hand, "claw", hi.sx, hi.sy, held.scale, {
            angle: clawAngle,
            open: openAmt,
          });
        }
      }
    }

    // Release anything whose hand-state ended this frame.
    for (const [key, h] of this.heldEth)
      if (!ethSeen.has(key)) {
        this.out("gesture_release", h.peerId, h.hand, "eth", h.x, h.y, h.scale, { spin: h.spin });
        this.heldEth.delete(key);
      }
    for (const [key, h] of this.heldClaw)
      if (!clawSeen.has(key)) {
        this.out("gesture_release", h.peerId, h.hand, "claw", h.x, h.y, h.scale, { angle: h.angle, open: h.open });
        this.heldClaw.delete(key);
      }
    for (const [peerId, c] of this.comp)
      if (!compSeen.has(peerId) && c.active && c.last && now >= c.holdUntil) {
        this.out("gesture_release", peerId, "frame", "computer", c.last.cx, c.last.cy, c.last.size, {});
        c.active = false;
      }
  }
}

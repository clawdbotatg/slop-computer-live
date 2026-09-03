"use client";

import { useEffect, useRef, useState } from "react";
import type { Publication } from "~~/hooks/usePeerMesh";

// The eye's own stage. The ?fx=0 eye window is the hand detector's ONLY
// input, so instead of mirroring the shared desktop layout it renders every
// live camera feed uncropped and as large as the viewport allows.
//
// Where an effect lands never depends on this layout: the relay converts each
// detected hand into the sender's video-frame coordinates by inverting the
// object-fit:cover crop of the tile the eye reports (gestures.ts), and every
// viewer re-projects those frame coordinates onto their own camera window
// (GestureLayer.tsx). So this stage is free to be whatever detects best:
//   · a camera can never sit off-screen or clipped for the detector
//   · the shared layout, and its viewport-resize clamp, can't touch detection
//   · a hand gets a viewport-sized tile instead of a 440px desktop window
// Each tile is sized to its video's own aspect so cover crops nothing — the
// whole camera frame is visible to the detector. Tiles carry
// data-eye-cam=<ownerKey>; the eye_geometry reporter in Desktop prefers them
// over the desktop windows still mounted (hidden) underneath.

// Just under the cursor layer (2^31-1) — above every window and modal, so the
// detector sees only cameras.
const Z = 2147483645;
const GAP = 8;

function bestGrid(n: number, W: number, H: number, aspect: number): { cols: number; rows: number } {
  let best = { cols: 1, rows: Math.max(1, n), area: -1 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    const cw = W / cols;
    const ch = H / rows;
    const w = Math.min(cw, ch * aspect);
    const area = w * (w / aspect);
    if (area > best.area) best = { cols, rows, area };
  }
  return { cols: best.cols, rows: best.rows };
}

const EyeTile = ({
  stream,
  ownerKey,
  label,
  cellW,
  cellH,
}: {
  stream: MediaStream | null;
  ownerKey: string;
  label: string;
  cellW: number;
  cellH: number;
}) => {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  // Size the tile to the video's intrinsic aspect so object-fit:cover is a
  // no-op crop. `resize` fires when the remote track changes resolution.
  const onMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
  };
  const w = Math.max(60, Math.floor(Math.min(cellW, cellH * aspect)));
  const h = Math.max(45, Math.floor(w / aspect));
  return (
    <div data-eye-cam={ownerKey} style={{ width: w, height: h, position: "relative", background: "#000" }}>
      <video
        ref={ref}
        autoPlay
        muted
        playsInline
        onLoadedMetadata={onMeta}
        onResize={onMeta}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
      <div
        style={{
          position: "absolute",
          left: 6,
          top: 4,
          font: "11px/1 monospace",
          color: "#bcff5b",
          opacity: 0.75,
          pointerEvents: "none",
        }}
      >
        {label}
      </div>
    </div>
  );
};

export const EyeStage = ({
  slug,
  cams,
  streamFor,
  labelFor,
}: {
  slug: string;
  cams: Publication[];
  streamFor: (pub: Publication) => MediaStream | null;
  labelFor: (pub: Publication) => string;
}) => {
  const [vp, setVp] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const read = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  const n = cams.length;
  const { cols, rows } = bestGrid(n, vp.w, vp.h, 16 / 9);
  const cellW = Math.max(0, vp.w / cols - GAP * 2);
  const cellH = Math.max(0, vp.h / rows - GAP * 2);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z,
        background: "#000",
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        placeItems: "center",
      }}
    >
      {cams.map(pub => (
        <EyeTile
          key={`${pub.peerId}-${pub.streamId}`}
          stream={streamFor(pub)}
          ownerKey={pub.ownerKey}
          label={labelFor(pub)}
          cellW={cellW}
          cellH={cellH}
        />
      ))}
      <div
        style={{
          position: "fixed",
          right: 8,
          bottom: 6,
          font: "11px/1 monospace",
          color: "#8a8a8a",
          pointerEvents: "none",
        }}
      >
        SLOP-EYE · {slug} · {n} cam{n === 1 ? "" : "s"}
      </div>
    </div>
  );
};

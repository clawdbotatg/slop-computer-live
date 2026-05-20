"use client";

import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useCursorSvg } from "~~/hooks/useCursorSvg";
import type { CursorKind } from "~~/hooks/useLocalCursor";
import type { Bands } from "~~/utils/blockieBands";

const SIZE: Record<CursorKind, number> = {
  pointer: 64,
  grab: 64,
  grabbing: 50,
  text: 24,
};

// Hotspot offsets in cursor pixels — where the click point lands inside
// the rendered SVG. Dialed in with the dev nudge tool against /cursor-test.
// grabbing reuses grab's formula so the click point doesn't jump when the
// hand transitions from open → closed under the same finger.
const HOTSPOT: Record<CursorKind, { x: number; y: number }> = {
  pointer: { x: SIZE.pointer * 0.22 - 2, y: SIZE.pointer * 0.12 + 3 },
  grab: { x: SIZE.grab * 0.45 - 12, y: SIZE.grab * 0.35 },
  grabbing: { x: SIZE.grabbing * 0.45 - 12, y: SIZE.grabbing * 0.35 },
  text: { x: SIZE.text * 0.5, y: SIZE.text * 0.5 },
};

// Default neutral palette used while the SVG markup is still loading or
// when no peer identity is available.
const DEFAULT_BANDS: Bands = { band1: "#7a7a7a", band2: "#5c5c5c", band3: "#404040" };

type CursorProps = {
  x: number;
  y: number;
  kind?: CursorKind;
  label?: ReactNode;
  dimmed?: boolean;
  bands?: Bands;
};

export const Cursor = ({ x, y, kind = "pointer", label, dimmed = false, bands }: CursorProps) => {
  const size = SIZE[kind];
  const hot = HOTSPOT[kind];
  const svg = useCursorSvg(kind);
  const b = bands ?? DEFAULT_BANDS;

  // Once the React cursor has the SVG in hand AND has committed to the
  // DOM, flip <html> into "cursor-ready" mode so globals.css hides the
  // OS cursor. Until then the OS cursor stays visible — cold-cache
  // visitors should never stare at a blank screen with no cursor at
  // all. Doing this in useEffect (post-paint) avoids a one-frame gap
  // where the OS cursor is hidden but the custom one isn't drawn yet.
  useEffect(() => {
    if (svg && typeof document !== "undefined") {
      document.documentElement.classList.add("slop-cursor-ready");
    }
  }, [svg]);

  const wrapperStyle: CSSProperties = {
    position: "fixed",
    left: x - hot.x,
    top: y - hot.y,
    pointerEvents: "none",
    zIndex: 2147483647,
    filter: "drop-shadow(1px 2px 0 rgba(0,0,0,0.5))",
    willChange: "transform",
    opacity: dimmed ? 0.65 : 1,
  };

  // Per-peer band colors are applied as inline CSS vars on the <svg>
  // itself so they override the class-scoped defaults baked into the
  // inlined SVG markup (`.slop-cursor-svg { --band-1: ... }`).
  const svgStyle = {
    display: "block",
    userSelect: "none",
    overflow: "visible",
    "--band-1": b.band1,
    "--band-2": b.band2,
    "--band-3": b.band3,
    "--band-neutral": "#111111",
  } as CSSProperties;

  return (
    <div style={wrapperStyle}>
      {svg ? (
        <svg
          className="slop-cursor-svg"
          width={size}
          height={size}
          viewBox={svg.viewBox}
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="xMidYMid meet"
          style={svgStyle}
          dangerouslySetInnerHTML={{ __html: svg.markup }}
        />
      ) : (
        <div style={{ width: size, height: size }} />
      )}
      {label ? (
        <div
          className="slop-cursor-label"
          style={{
            position: "absolute",
            left: hot.x + size * 0.4 + 10,
            top: hot.y + size * 0.5 + 10,
            color: "#fff",
            fontFamily: "var(--slop-font-display)",
            fontSize: 11,
            whiteSpace: "nowrap",
            letterSpacing: "0.04em",
            textShadow: "0 1px 2px rgba(0,0,0,0.9), 0 0 1px rgba(0,0,0,0.9)",
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
};

export default Cursor;

import type { CursorKind } from "~~/hooks/useLocalCursor";

const SRC: Record<CursorKind, string> = {
  pointer: "/cursors/six_finger_pointer_exact_band_masks_no_bleed.svg",
  grab: "/cursors/six_finger_open_grab_dynamic_bands.svg",
  grabbing: "/cursors/six_finger_grabbing_fist_dynamic_bands_clean.svg",
  text: "/cursors/text_cursor_ibeam_clean.svg",
};

// Hotspot offsets (in cursor pixels) — where the click point is inside
// the SVG so we shift the rendered image to align with the real mouse.
// Tuned to roughly center on the index-finger tip / i-beam center.
const HOTSPOT: Record<CursorKind, { x: number; y: number }> = {
  pointer: { x: 8, y: 4 },
  grab: { x: 16, y: 12 },
  grabbing: { x: 16, y: 12 },
  text: { x: 12, y: 12 },
};

const SIZE: Record<CursorKind, number> = {
  pointer: 36,
  grab: 36,
  grabbing: 36,
  text: 24,
};

type CursorProps = {
  x: number;
  y: number;
  kind?: CursorKind;
  label?: string;
};

export const Cursor = ({ x, y, kind = "pointer", label }: CursorProps) => {
  const size = SIZE[kind];
  const hot = HOTSPOT[kind];
  return (
    <div
      style={{
        position: "fixed",
        left: x - hot.x,
        top: y - hot.y,
        pointerEvents: "none",
        zIndex: 10000,
        filter: "drop-shadow(1px 2px 0 rgba(0,0,0,0.5))",
        willChange: "transform",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={SRC[kind]}
        alt=""
        width={size}
        height={size}
        style={{ display: "block", userSelect: "none", WebkitUserDrag: "none" } as React.CSSProperties}
        draggable={false}
      />
      {label ? (
        <div
          style={{
            position: "absolute",
            left: hot.x + size * 0.4,
            top: hot.y + size * 0.5,
            background: "var(--slop-magenta, #ff3ec9)",
            color: "#fff",
            fontFamily: "var(--slop-font-display)",
            fontSize: 11,
            padding: "1px 5px",
            whiteSpace: "nowrap",
            letterSpacing: "0.04em",
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
};

export default Cursor;

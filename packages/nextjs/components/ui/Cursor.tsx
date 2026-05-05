import type { CursorKind } from "~~/hooks/useLocalCursor";

const SRC: Record<CursorKind, string> = {
  pointer: "/cursors/six_finger_pointer_exact_band_masks_no_bleed.svg",
  grab: "/cursors/six_finger_open_grab_dynamic_bands.svg",
  grabbing: "/cursors/six_finger_grabbing_fist_dynamic_bands_clean.svg",
  text: "/cursors/text_cursor_ibeam_clean.svg",
};

const SIZE: Record<CursorKind, number> = {
  pointer: 64,
  grab: 64,
  grabbing: 36,
  text: 24,
};

// Hotspot offsets in cursor pixels — where the click point lands inside
// the rendered SVG. Pointer dialed in with the dev nudge tool to land on
// the index-finger tip; others tuned to roughly the middle of the palm.
const HOTSPOT: Record<CursorKind, { x: number; y: number }> = {
  pointer: { x: SIZE.pointer * 0.22 - 1, y: SIZE.pointer * 0.12 + 4 },
  grab: { x: SIZE.grab * 0.45, y: SIZE.grab * 0.35 },
  grabbing: { x: SIZE.grabbing * 0.45, y: SIZE.grabbing * 0.35 },
  text: { x: SIZE.text * 0.5, y: SIZE.text * 0.5 },
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
        zIndex: 2147483647,
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

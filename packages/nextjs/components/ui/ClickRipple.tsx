"use client";

import type { Bands } from "~~/utils/blockieBands";

export type ClickRippleProps = {
  x: number;
  y: number;
  bands: Bands;
};

// Three concentric rings expanding outward from a click position. Each ring
// is colored by one of the peer's three blockie bands so different people's
// clicks are visually distinct. CSS animation in globals.css runs once per
// mount; the parent prunes the ripple from state after ~1s.
export const ClickRipple = ({ x, y, bands }: ClickRippleProps) => {
  const colors = [bands.band1, bands.band2, bands.band3];
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        left: x,
        top: y,
        // Centered on the click point. translateZ to nudge onto its own
        // compositor layer — the animation stays smooth even when the
        // page is doing other work.
        transform: "translate(-50%, -50%) translateZ(0)",
        pointerEvents: "none",
        zIndex: 2147483646, // just under the cursor layer
      }}
    >
      {colors.map((color, i) => (
        <span
          key={i}
          className="slop-ripple"
          style={{
            // Each ring stagger by 110ms — total span ~880ms, fits a click feel
            animationDelay: `${i * 110}ms`,
            borderColor: color,
            boxShadow: `0 0 8px ${color}`,
          }}
        />
      ))}
    </div>
  );
};

export default ClickRipple;

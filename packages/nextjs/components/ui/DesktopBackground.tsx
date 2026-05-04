"use client";

import { useMemo } from "react";

/**
 * Quiet ambient backdrop for /desktop, /admin, /join, /. Just a base color,
 * a dotted dither texture, a faint starfield, and a soft radial pulse —
 * no mountains, no bubble blobs, nothing that competes with content
 * windows on top of it.
 */
export function DesktopBackground() {
  // Deterministic stars so SSR/CSR don't mismatch.
  const stars = useMemo(
    () =>
      Array.from({ length: 100 }).map((_, i) => {
        const seed = (i * 9301 + 49297) % 233280;
        const r = seed / 233280;
        return {
          l: `${(r * 100).toFixed(2)}%`,
          t: `${(((seed * 7) % 9000) / 100).toFixed(2)}%`,
          s: r > 0.92 ? 2 : 1,
          o: r > 0.92 ? 0.85 : 0.5,
        };
      }),
    [],
  );

  return (
    <div className="slop-desktop-bg" aria-hidden>
      {/* base color — sits behind everything else */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "var(--slop-base)",
        }}
      />

      {/* faint radial wash for depth */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse 70% 50% at 50% 30%, rgba(124,77,255,0.12) 0%, transparent 70%)",
        }}
      />

      {/* dotted dither texture, full viewport */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.45 }}>
        <defs>
          <pattern id="slop-dot" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="transparent" />
            <rect x="0" y="0" width="1" height="1" fill="#7c4dff" opacity="0.7" />
            <rect x="3" y="3" width="1" height="1" fill="#3fcfff" opacity="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#slop-dot)" />
      </svg>

      {/* faint starfield */}
      <div style={{ position: "absolute", inset: 0 }}>
        {stars.map((s, i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              left: s.l,
              top: s.t,
              width: s.s,
              height: s.s,
              background: "#fff",
              opacity: s.o,
            }}
          />
        ))}
      </div>

      {/* gentle scanlines */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "repeating-linear-gradient(0deg, transparent 0, transparent 2px, rgba(0,0,0,0.18) 2px, rgba(0,0,0,0.18) 3px)",
          mixBlendMode: "multiply",
        }}
      />
    </div>
  );
}

export default DesktopBackground;

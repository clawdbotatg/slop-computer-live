"use client";

import { useMemo } from "react";

/**
 * E2 · ASCII Topo background — used as the full-screen backdrop on
 * /desktop, /admin, /join, /. Renders deterministically-positioned
 * stars, dotted dither, hatched mountain mask, and bubble blobs.
 */
export function DesktopBackground() {
  // Deterministic star positions so SSR/CSR don't mismatch.
  const stars = useMemo(() => {
    return Array.from({ length: 80 }).map((_, i) => {
      const seed = (i * 9301 + 49297) % 233280;
      const r = seed / 233280;
      return {
        l: `${(r * 100).toFixed(2)}%`,
        t: `${(((seed * 7) % 8000) / 100).toFixed(2)}%`,
        s: r > 0.9 ? 2 : 1,
      };
    });
  }, []);

  return (
    <div className="slop-desktop-bg" aria-hidden>
      {/* dither + hatch mountain */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.55 }}>
        <defs>
          <pattern id="slop-dot" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="transparent" />
            <rect x="0" y="0" width="1" height="1" fill="#7c4dff" opacity="0.7" />
            <rect x="3" y="3" width="1" height="1" fill="#3fcfff" opacity="0.5" />
          </pattern>
          <pattern id="slop-hatch" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse">
            <rect width="4" height="4" fill="transparent" />
            <rect x="0" y="0" width="1" height="1" fill="#ff3ec9" opacity="0.45" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#slop-dot)" />
        <polygon
          points="0,560 120,400 200,500 320,360 460,500 600,380 760,520 900,400 1060,500 1200,420 1280,500 1280,1000 0,1000"
          fill="url(#slop-hatch)"
        />
      </svg>

      {/* stars */}
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
              opacity: 0.7,
              boxShadow: "0 0 4px #fff",
            }}
          />
        ))}
      </div>

      {/* bubble blobs */}
      {[
        { l: "15%", t: "15%", s: 220, c: "rgba(255, 62, 201, 0.5)" },
        { l: "70%", t: "12%", s: 260, c: "rgba(124, 77, 255, 0.5)" },
      ].map((b, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: b.l,
            top: b.t,
            width: b.s,
            height: b.s,
            borderRadius: "50%",
            background: `radial-gradient(circle at 30% 30%, ${b.c}, transparent 70%)`,
            filter: "blur(28px)",
            mixBlendMode: "screen",
          }}
        />
      ))}

      {/* gentle scanlines */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `repeating-linear-gradient(0deg, transparent 0, transparent 2px, rgba(0,0,0,0.22) 2px, rgba(0,0,0,0.22) 3px)`,
          mixBlendMode: "multiply",
        }}
      />
    </div>
  );
}

export default DesktopBackground;

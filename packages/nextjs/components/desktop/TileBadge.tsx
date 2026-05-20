"use client";

import type { ReactNode } from "react";
import { BandFlag } from "~~/components/ui";
import type { Bands } from "~~/utils/blockieBands";

// Tiny identity chip overlaid on the bottom-left of every video / audio /
// screen-share tile. Shows the publisher's blockie band-flag next to
// their current display label (custom name > ENS > short address) so a
// viewer can tell who's talking / sharing at a glance even when the
// tile is small or the underlying media is anonymous-looking (audio
// orb, blank screen, etc.).
//
// pointer-events: none — we don't want this to swallow clicks for tile
// settings buttons (camera flip, audio settings, etc.) which sit in the
// same area in some tiles.

export type TileBadgeProps = {
  bands: Bands;
  label: ReactNode;
};

export const TileBadge = ({ bands, label }: TileBadgeProps) => (
  <div
    style={{
      position: "absolute",
      left: 6,
      bottom: 6,
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      maxWidth: "calc(100% - 12px)",
      padding: "3px 7px",
      borderRadius: 4,
      background: "rgba(6,3,13,0.72)",
      backdropFilter: "blur(6px)",
      border: "1px solid rgba(255,62,201,0.35)",
      color: "var(--slop-text)",
      fontFamily: "var(--slop-font-body)",
      fontSize: 11,
      lineHeight: 1.2,
      letterSpacing: "0.02em",
      pointerEvents: "none",
      textShadow: "0 1px 2px rgba(0,0,0,0.9)",
      zIndex: 2,
    }}
  >
    <BandFlag bands={bands} />
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
      }}
    >
      {label}
    </span>
  </div>
);

export default TileBadge;

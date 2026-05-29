"use client";

import { SlopAddress } from "~~/components/ui";
import type { PeerMeshState, Publication } from "~~/hooks/usePeerMesh";

// Slim row above the subtitle band that attributes audio-only
// publishers (no camera, or camera flipped to cameraOff). Visible only
// when at least one such publisher exists. Keeps STT subtitles from
// looking like they come from nowhere.

export type AudioPillRowProps = {
  mesh: PeerMeshState;
  publishers: Publication[];
  /** Pixel height — caller decides whether to render a 0-height row. */
  height: number;
};

export const AudioPillRow = ({ mesh, publishers, height }: AudioPillRowProps) => {
  if (publishers.length === 0) return null;
  return (
    <div
      style={{
        height,
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 12px",
        overflowX: "auto",
        background: "rgba(6,8,24,0.55)",
        borderTop: "1px solid rgba(63,207,255,0.20)",
        borderBottom: "1px solid rgba(63,207,255,0.20)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--slop-font-display)",
          fontSize: 9,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--slop-text-muted)",
          flexShrink: 0,
        }}
      >
        audio
      </span>
      {publishers.map(pub => {
        const peer = mesh.peers.find(p => p.id === pub.peerId);
        return (
          <div
            key={`${pub.peerId}-${pub.streamId}`}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "4px 10px",
              borderRadius: 999,
              background: "rgba(255,62,201,0.12)",
              border: "1px solid rgba(255,62,201,0.40)",
              color: "var(--slop-text)",
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            <SlopAddress
              address={peer?.address ?? undefined}
              handle={peer?.handle ?? undefined}
              anonId={peer?.anonId ?? undefined}
              fallback={pub.ownerKey || pub.peerId}
              customNames={mesh.customNames}
            />
          </div>
        );
      })}
    </div>
  );
};

export default AudioPillRow;

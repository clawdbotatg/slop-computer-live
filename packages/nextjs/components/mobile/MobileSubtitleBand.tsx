"use client";

import { useEffect, useState } from "react";
import { SlopAddress } from "~~/components/ui";
import type { LiveCaption, PeerMeshState, TranscriptSegment } from "~~/hooks/usePeerMesh";

// Mobile-clip-style caption band. Same data source as the desktop
// `SubtitleCaption`, but positioned inside the MobileStage's bottom
// strip (not over the chyron) and styled bigger for vertical clip
// readability. Multi-line wrap is allowed — phone clips read 30+
// characters before going off-screen.

const HOLD_MS = 4500;
const FADE_MS = 700;
const INTERIM_OPACITY = 0.85;
const LIVE_CAPTION_STALE_MS = 8000;

type DisplaySource =
  | { kind: "live"; cap: LiveCaption; lockedAt: number | null }
  | { kind: "seg"; seg: TranscriptSegment };

export type MobileSubtitleBandProps = {
  mesh: PeerMeshState;
  /** Pixel height of the band container (caller controls layout). */
  height: number;
};

export const MobileSubtitleBand = ({ mesh, height }: MobileSubtitleBandProps) => {
  const live = mesh.liveCaption;
  const seg = mesh.latestTranscriptSeg;

  const [finalAnchor, setFinalAnchor] = useState<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!live || !live.isFinal) return;
    const key = `${live.speakerKey ?? "?"}:${live.ts}`;
    setFinalAnchor(prev => (prev?.key === key ? prev : { key, at: Date.now() }));
  }, [live]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const liveFresh = !!live && now - live.ts < LIVE_CAPTION_STALE_MS;
  let source: DisplaySource | null = null;
  if (liveFresh && live) {
    source = { kind: "live", cap: live, lockedAt: live.isFinal ? (finalAnchor?.at ?? null) : null };
  } else if (seg) {
    source = { kind: "seg", seg };
  }

  // Always render the band container so the layout doesn't reflow when
  // a caption arrives — empty band is just a dim strip with the
  // SLOP.COMPUTER trim along the bottom.
  const containerStyle: React.CSSProperties = {
    height,
    width: "100%",
    background: "rgba(6,8,24,0.78)",
    borderTop: "1px solid rgba(63,207,255,0.30)",
    padding: "10px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  };

  if (!source) {
    return <div style={containerStyle} />;
  }

  let opacity = 1;
  let text = "";
  let speakerProps: {
    address: string | null;
    handle: string | null;
    anonId: string | null;
    fallback: string;
  };

  if (source.kind === "live") {
    text = source.cap.text;
    speakerProps = {
      address: source.cap.address ?? null,
      handle: source.cap.handle ?? null,
      anonId: source.cap.anonId ?? null,
      fallback: source.cap.speakerKey ?? "speaker",
    };
    if (!source.cap.isFinal) {
      opacity = INTERIM_OPACITY;
    } else if (source.lockedAt != null) {
      const age = now - source.lockedAt;
      if (age >= HOLD_MS + FADE_MS) return <div style={containerStyle} />;
      opacity = age <= HOLD_MS ? 1 : Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);
    }
  } else {
    text = source.seg.text;
    speakerProps = {
      address: source.seg.address ?? null,
      handle: source.seg.handle ?? null,
      anonId: source.seg.anonId ?? null,
      fallback: source.seg.id,
    };
    const age = now - source.seg.ts;
    if (age >= HOLD_MS + FADE_MS) return <div style={containerStyle} />;
    opacity = age <= HOLD_MS ? 1 : Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);
  }

  return (
    <div style={containerStyle}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
          maxWidth: "100%",
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          fontSize: 18,
          lineHeight: 1.25,
          opacity,
          textAlign: "center",
        }}
      >
        <SlopAddress
          address={speakerProps.address ?? undefined}
          handle={speakerProps.handle ?? undefined}
          anonId={speakerProps.anonId ?? undefined}
          fallback={speakerProps.fallback}
          customNames={mesh.customNames}
        />
        <span
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          &ldquo;{text}&rdquo;
        </span>
      </div>
    </div>
  );
};

export default MobileSubtitleBand;

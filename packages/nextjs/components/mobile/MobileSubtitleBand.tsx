"use client";

import { useEffect, useState } from "react";
import { SlopAddress } from "~~/components/ui";
import type { LiveCaption, PeerMeshState, TranscriptSegment } from "~~/hooks/usePeerMesh";

// Mobile-clip-style caption chip. Same data source as the desktop
// `SubtitleCaption`, but positioned to land in the SEAM between video
// tiles (computed by layoutFor → captionY) instead of a permanent
// bottom strip. The chip is centered both horizontally on screen AND
// vertically on the seam, so it overlaps a sliver of the tile edges
// without covering faces (heads almost never land at the very top/
// bottom edge of a 16:9 frame). Falls back to a normal chip render
// when there's no seam (single-tile layouts).

const HOLD_MS = 4500;
const FADE_MS = 700;
const INTERIM_OPACITY = 0.85;
const LIVE_CAPTION_STALE_MS = 8000;

type DisplaySource =
  | { kind: "live"; cap: LiveCaption; lockedAt: number | null }
  | { kind: "seg"; seg: TranscriptSegment };

export type MobileSubtitleBandProps = {
  mesh: PeerMeshState;
  /** Pixel Y (relative to the band's positioned parent) where the chip
   *  should be vertically centered. Caller is responsible for adding
   *  any title-bar offset before passing this in. */
  top: number;
};

export const MobileSubtitleBand = ({ mesh, top }: MobileSubtitleBandProps) => {
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

  if (!source) return null;

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
      if (age >= HOLD_MS + FADE_MS) return null;
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
    if (age >= HOLD_MS + FADE_MS) return null;
    opacity = age <= HOLD_MS ? 1 : Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);
  }

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top,
        transform: "translate(-50%, -50%)",
        maxWidth: "min(92%, 720px)",
        padding: "8px 14px",
        background: "rgba(6,8,24,0.82)",
        border: "1px solid rgba(63,207,255,0.40)",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0,0,0,0.55)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        fontSize: 18,
        lineHeight: 1.25,
        opacity,
        textAlign: "center",
        pointerEvents: "none",
        zIndex: 50,
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
  );
};

export default MobileSubtitleBand;

"use client";

import { useEffect, useState } from "react";
import { SlopAddress } from "~~/components/ui";
import type { PeerMeshState, TranscriptSegment } from "~~/hooks/usePeerMesh";

// Broadcast-style on-screen caption. Driven by the live STT pipeline
// the god-mode tab runs (see useGodModeStt) — every Whisper-finalized
// segment hits the room WS as `transcript_seg`, lands in
// `mesh.latestTranscriptSeg`, and shows up here within ~50ms.
//
// Position is dynamic: sits directly above the chyron bar when one
// is set, otherwise directly above the Twitter timeline bar. That
// keeps the subtitle from overlapping the chyron when both are on
// screen.
//
// Dwell: each segment shows immediately on arrival, holds for
// HOLD_MS, then fades over FADE_MS. A new segment arriving mid-fade
// snaps back to full opacity and restarts the timer.
//
// We intentionally only retain the most recent segment in mesh state
// — the full archive lives in TranscriptWindow, and a single-line
// chyron is the convention for stream captions.

// Bar heights — mirror the constants in the other bar components so
// the caption snaps to whichever surface is currently the top of the
// stack.
const TIMELINE_BOTTOM = 52; // TimelineBar bottom (above headlines + ticker)
const TIMELINE_HEIGHT = 24;
const CHYRON_BAR_BOTTOM = 76; // ChyronBar bottom
const CHYRON_BAR_HEIGHT = 60;

// Visual budget: caption stays opaque for HOLD_MS after a new segment,
// then fades over FADE_MS. 4s of hold matches a comfortable broadcast
// caption reading time; 600ms fade is fast enough that silence reads
// as "off" not "stalled".
const HOLD_MS = 4000;
const FADE_MS = 600;

export type SubtitleCaptionProps = {
  mesh: PeerMeshState;
};

export const SubtitleCaption = ({ mesh }: SubtitleCaptionProps) => {
  const seg = mesh.latestTranscriptSeg;
  const chyronVisible = !!mesh.chyronState?.text;

  // Local "now" tick — drives the fade purely from segment age. A 200ms
  // interval is cheap and gives a smooth opacity ramp without hooking
  // into requestAnimationFrame. We could also schedule a single
  // setTimeout at HOLD_MS + FADE_MS to flip a flag, but a steady tick
  // keeps the math trivial and avoids interpolation edge cases when a
  // new segment arrives during the fade.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!seg) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [seg]);

  if (!seg) return null;

  const age = now - seg.ts;
  if (age >= HOLD_MS + FADE_MS) return null;
  const opacity = age <= HOLD_MS ? 1 : Math.max(0, 1 - (age - HOLD_MS) / FADE_MS);

  // Stack the caption on whichever bar is currently the top of the
  // bottom-of-screen surface. 8px breathing room.
  const bottom = chyronVisible ? CHYRON_BAR_BOTTOM + CHYRON_BAR_HEIGHT + 8 : TIMELINE_BOTTOM + TIMELINE_HEIGHT + 8;

  return (
    <div
      key={seg.id}
      style={{
        position: "fixed",
        left: "50%",
        bottom,
        transform: "translateX(-50%)",
        zIndex: 60,
        maxWidth: "min(86vw, 1400px)",
        padding: "8px 18px",
        background: "rgba(6,8,24,0.78)",
        border: "1px solid rgba(63,207,255,0.30)",
        borderRadius: 6,
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        boxShadow: "0 4px 18px rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        fontSize: 18,
        lineHeight: 1.25,
        // No transition — opacity is animated by the now-tick re-render
        // so a mid-fade replacement snaps cleanly without competing
        // CSS transitions creating a flicker.
        opacity,
        pointerEvents: "none",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      <SlopAddress
        address={seg.address ?? undefined}
        handle={seg.handle ?? undefined}
        anonId={seg.anonId ?? undefined}
        fallback={seg.id}
        customNames={mesh.customNames}
      />
      <span style={{ color: "var(--slop-text-muted)" }}>:</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
        &ldquo;{(seg as TranscriptSegment).text}&rdquo;
      </span>
    </div>
  );
};

export default SubtitleCaption;

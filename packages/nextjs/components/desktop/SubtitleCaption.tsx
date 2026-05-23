"use client";

import { useEffect, useState } from "react";
import { SlopAddress } from "~~/components/ui";
import type { LiveCaption, PeerMeshState, TranscriptSegment } from "~~/hooks/usePeerMesh";

// Broadcast-style on-screen caption. Two source lanes:
//
//   1. `mesh.liveCaption` — per-speaker in-browser STT (useLiveTranscript)
//      pushing interim + final results over the WS. Latency ~200ms-1s.
//      Default lane when the speaker's browser supports Web Speech.
//
//   2. `mesh.latestTranscriptSeg` — god-mode Whisper segments, the
//      canonical archive source. Latency ~3-5s post-utterance. Only
//      used as the caption source for speakers whose live lane is
//      dead (Firefox, denied perms, recognizer crashed). The server
//      handles the routing — it suppresses transcript_seg broadcasts
//      for any speaker whose live_caption_state is alive=true.
//
// Display rule: render the freshest of the two. `liveCaption` carries
// interim updates that overwrite themselves rapidly; finals lock and
// start the HOLD_MS dwell. `transcript_seg` lines also start dwell on
// arrival.
//
// Position is dynamic: sits directly above the chyron bar when one
// is set, otherwise directly above the Twitter timeline bar.

const TIMELINE_BOTTOM = 52;
const TIMELINE_HEIGHT = 24;
const CHYRON_BAR_BOTTOM = 76;
const CHYRON_BAR_HEIGHT = 60;

// Visual budget: caption stays opaque for HOLD_MS after a new FINAL
// landing, then fades over FADE_MS. Interim updates ignore this — they
// only show while they keep arriving, and a new interim resets the
// "last seen" clock continuously. Once a final lands the dwell timer
// starts from there.
const HOLD_MS = 4000;
const FADE_MS = 600;

// Interim opacity is dimmer than final so viewers can tell the caption
// is still being formed vs. locked. 85% reads as "subtitled, but the
// sentence isn't done" without looking broken.
const INTERIM_OPACITY = 0.85;

// If we haven't seen any liveCaption frame in this long, fall back to
// transcript_seg as the source. Covers the "speaker stops talking
// entirely" case — without it, an old liveCaption from minutes ago
// would shadow a fresh transcript_seg from a different speaker.
const LIVE_CAPTION_STALE_MS = 8000;

type DisplaySource =
  | { kind: "live"; cap: LiveCaption; lockedAt: number | null }
  | { kind: "seg"; seg: TranscriptSegment };

export type SubtitleCaptionProps = {
  mesh: PeerMeshState;
};

export const SubtitleCaption = ({ mesh }: SubtitleCaptionProps) => {
  const live = mesh.liveCaption;
  const seg = mesh.latestTranscriptSeg;
  const chyronVisible = !!mesh.chyronState?.text;

  // Track when the current FINAL was locked. Interim updates have no
  // dwell (they keep coming), so we anchor the fade to the most recent
  // final's wall-clock. We compare on `speakerKey + ts` of the final to
  // detect "new final".
  const [finalAnchor, setFinalAnchor] = useState<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!live || !live.isFinal) return;
    const key = `${live.speakerKey ?? "?"}:${live.ts}`;
    setFinalAnchor(prev => (prev?.key === key ? prev : { key, at: Date.now() }));
  }, [live]);

  // Local "now" tick — drives the fade purely from age. 200ms is cheap
  // and gives a smooth opacity ramp without rAF, and it picks up new
  // interim arrivals immediately because React re-renders on the
  // mesh.liveCaption prop change anyway.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  // Decide which lane to render. Live wins if it exists and is fresh.
  // "Fresh" = within LIVE_CAPTION_STALE_MS, with the timeline anchored
  // to the most recent interim/final, NOT the final-lock anchor.
  const liveFresh = !!live && now - live.ts < LIVE_CAPTION_STALE_MS;
  let source: DisplaySource | null = null;
  if (liveFresh && live) {
    source = { kind: "live", cap: live, lockedAt: live.isFinal ? (finalAnchor?.at ?? null) : null };
  } else if (seg) {
    source = { kind: "seg", seg };
  }
  if (!source) return null;

  // Compute opacity.
  // - Live interim: full INTERIM_OPACITY, no fade until a new final
  //   locks or the live frame goes stale.
  // - Live final: 1.0 until HOLD_MS past lockedAt, then fade.
  // - Seg: 1.0 until HOLD_MS past seg.ts, then fade. Same dwell math.
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

  const bottom = chyronVisible ? CHYRON_BAR_BOTTOM + CHYRON_BAR_HEIGHT + 8 : TIMELINE_BOTTOM + TIMELINE_HEIGHT + 8;

  // React keys: keep them tied to the speaker so a same-speaker stream
  // of interims animates in-place rather than cross-fading on every
  // update (which would look like flicker).
  const reactKey = source.kind === "live" ? `live:${source.cap.speakerKey ?? "?"}` : `seg:${source.seg.id}`;

  return (
    <div
      key={reactKey}
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
        opacity,
        pointerEvents: "none",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      <SlopAddress
        address={speakerProps.address ?? undefined}
        handle={speakerProps.handle ?? undefined}
        anonId={speakerProps.anonId ?? undefined}
        fallback={speakerProps.fallback}
        customNames={mesh.customNames}
      />
      <span style={{ color: "var(--slop-text-muted)" }}>:</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>&ldquo;{text}&rdquo;</span>
    </div>
  );
};

export default SubtitleCaption;

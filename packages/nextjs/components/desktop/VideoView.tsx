"use client";

import { useEffect, useRef, useState } from "react";
import { useAudioBusElement } from "~~/hooks/useAudioBus";
import { ACTIVATED_EVENT } from "~~/hooks/useUserGesture";
import { useRoomSlug } from "~~/lib/room-slug";

// Persisted alongside the resume flags so reload preserves the pause
// state. **Scoped to the current room slug** — switching from /main to
// /ep0 shouldn't auto-restore a paused state from a different room.
// Cleared by Desktop.tsx when the camera publication is fully stopped
// (not when it's merely re-acquired by auto-resume).
const VIDEO_PAUSED_KEY_BASE = "slop-video-paused-v1";
export const videoPausedKey = (slug: string) => `${VIDEO_PAUSED_KEY_BASE}:${slug}`;

export type VideoViewProps = {
  stream: MediaStream;
  /** Mute local playback on self streams (audio rides on a separate audio
   *  publication, but defensive against future bundling). */
  muted?: boolean;
  /** When true, render the pause-video toggle overlay. Only the publisher
   *  controls their own camera state. */
  isMine?: boolean;
  /** Optional. When provided, render a gear (settings) button next to the
   *  pause toggle. Click handler should re-open the share dialog in edit
   *  mode so the user can hot-swap camera without dropping the publication. */
  onSettings?: () => void;
  /** When true, hydrate the pause toggle from VIDEO_PAUSED_STORAGE_KEY on
   *  mount and write changes back so reload preserves the paused state.
   *  Only set for the publisher's own camera. Screen-share and remote
   *  views keep ephemeral local-only state. */
  persistPause?: boolean;
  /** When set, register the inner `<video>` element with the shared
   *  AudioBus under this id. Camera publications carry the publisher's
   *  mic (see lockstep enable above) and screen shares can carry
   *  system audio — both need to ride the bus in god-mode so the EQ
   *  popup sees them. null on non-spectator sessions. */
  audioBusId?: string | null;
  /** Human-readable label for the /eq popup row. */
  audioBusLabel?: string;
};

// Camera / screen-share renderer with a publisher-only pause toggle in the
// top-right. Pausing flips track.enabled = false on every video track —
// peers see the last frame freeze and the publisher's preview goes black.
// Doesn't unpublish, so unpause is instant (no permission re-prompt).
export const VideoView = ({
  stream,
  muted = false,
  isMine = false,
  onSettings,
  persistPause = false,
  audioBusId = null,
  audioBusLabel = "video",
}: VideoViewProps) => {
  const slug = useRoomSlug();
  const storageKey = videoPausedKey(slug);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Lazy init from localStorage when persistence is on, so the initial
  // track.enabled effect below sees the resumed paused=true and freezes
  // the just-re-acquired camera immediately — no one-frame flash.
  const [paused, setPaused] = useState<boolean>(() => {
    if (!persistPause || typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!persistPause || typeof window === "undefined") return;
    try {
      if (paused) window.localStorage.setItem(storageKey, "1");
      else window.localStorage.removeItem(storageKey);
    } catch {
      /* quota / private mode */
    }
  }, [paused, persistPause, storageKey]);
  // Per-user "mute on my side" for remote streams. Doesn't touch the
  // upstream — only my local <video> element goes silent. Same model
  // as the music player + AudioVisualizer.
  const [selfMuted, setSelfMuted] = useState(false);

  useEffect(() => {
    if (!isMine) return;
    // Camera publications bundle audio (the mic rides on the same stream
    // as the camera — useLocalMedia.startCamera requests both); screen
    // share can carry system audio. "Pause my video" reads as "I'm
    // off" — flipping only video would freeze the frame but leave my
    // bundled mic broadcasting, which is exactly the leak users
    // complain about. Disable both track kinds in lockstep so paused
    // means silent + frozen, full stop. A standalone Share-Audio
    // publication (separate stream) is independent and unaffected.
    for (const t of stream.getVideoTracks()) t.enabled = !paused;
    for (const t of stream.getAudioTracks()) t.enabled = !paused;
  }, [stream, paused, isMine]);

  // God-mode only — route this video's audio through the shared
  // AudioBus. Camera streams bundle mic audio; screen shares may
  // carry system audio. No-op when audioBusId is null.
  useAudioBusElement(videoRef, audioBusId ?? "", audioBusLabel, !!audioBusId);

  // Reload-without-gesture can leave an unmuted <video> paused (Chrome's
  // autoplay policy occasionally bites WebRTC streams too). The page
  // EntryGate fires slop:activated on the first user click; retry play
  // in the same gesture so the remote camera/screen wakes up.
  useEffect(() => {
    const onActivated = () => {
      const v = videoRef.current;
      if (v && v.paused) v.play().catch(() => undefined);
    };
    window.addEventListener(ACTIVATED_EVENT, onActivated);
    return () => window.removeEventListener(ACTIVATED_EVENT, onActivated);
  }, []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#000" }}>
      <video
        ref={el => {
          videoRef.current = el;
          if (el && el.srcObject !== stream) el.srcObject = stream;
        }}
        autoPlay
        playsInline
        // Self-publication is always muted (echo prevention). For
        // remote, the per-user `selfMuted` toggle silences this peer's
        // local playback only — the upstream stream is unchanged.
        muted={muted || (!isMine && selfMuted)}
        style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000", display: "block" }}
      />
      {!isMine ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            gap: 6,
            zIndex: 5,
          }}
        >
          <button
            type="button"
            onClick={() => setSelfMuted(m => !m)}
            aria-label={selfMuted ? "unmute (local)" : "mute (local)"}
            title={selfMuted ? "unmute (only on your side)" : "mute (only on your side)"}
            style={overlayBtnStyle(selfMuted)}
          >
            {selfMuted ? <SpeakerOffIcon /> : <SpeakerIcon />}
          </button>
        </div>
      ) : null}
      {isMine ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            gap: 6,
            zIndex: 5,
          }}
        >
          <button
            type="button"
            onClick={() => setPaused(p => !p)}
            aria-label={paused ? "resume video" : "pause video"}
            title={paused ? "resume video" : "pause video"}
            style={overlayBtnStyle(paused)}
          >
            {paused ? <VideoOffIcon /> : <VideoOnIcon />}
          </button>
          {onSettings ? (
            <button
              type="button"
              onClick={onSettings}
              aria-label="video settings"
              title="video settings"
              style={overlayBtnStyle(false)}
            >
              <GearIcon />
            </button>
          ) : null}
        </div>
      ) : null}
      {paused && isMine ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
            fontFamily: "var(--slop-font-display)",
            fontSize: 14,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            pointerEvents: "none",
          }}
        >
          video paused
        </div>
      ) : null}
    </div>
  );
};

const overlayBtnStyle = (active: boolean): React.CSSProperties => ({
  width: 32,
  height: 32,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: active ? "var(--slop-magenta, #ff3ec9)" : "rgba(6,3,13,0.7)",
  border: `1px solid ${active ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-bevel-light, #4a4a4a)"}`,
  color: "#fff",
  cursor: "pointer",
  backdropFilter: "blur(4px)",
});

// Mac OS 9-flavored monochrome icons. ~16px viewBox.
const VideoOnIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden
  >
    <rect x="2" y="4.5" width="8.5" height="7" rx="1" fill="currentColor" stroke="none" />
    <path d="M10.5 7 L 14 5 V 11 L 10.5 9 Z" fill="currentColor" stroke="none" />
  </svg>
);

const VideoOffIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden
  >
    <rect x="2" y="4.5" width="8.5" height="7" rx="1" fill="currentColor" stroke="none" />
    <path d="M10.5 7 L 14 5 V 11 L 10.5 9 Z" fill="currentColor" stroke="none" />
    <line x1="2" y1="2" x2="14" y2="14" stroke="#000" strokeWidth="2.6" />
    <line x1="2" y1="2" x2="14" y2="14" />
  </svg>
);

const GearIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <line x1="2" y1="4" x2="14" y2="4" />
    <line x1="2" y1="8" x2="14" y2="8" />
    <line x1="2" y1="12" x2="14" y2="12" />
    <circle cx="10" cy="4" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="5" cy="8" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="11" cy="12" r="1.7" fill="currentColor" stroke="none" />
  </svg>
);

// Per-user "mute on my side" speaker — same glyph the music player +
// AudioVisualizer use, kept inline so each window stays self-contained.
const SpeakerIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M2.5 6 H 4.5 L 7.5 3 V 13 L 4.5 10 H 2.5 Z" fill="currentColor" stroke="none" />
    <path d="M9.5 6 Q 11 8 9.5 10" />
    <path d="M11 4.5 Q 13.5 8 11 11.5" />
  </svg>
);

const SpeakerOffIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M2.5 6 H 4.5 L 7.5 3 V 13 L 4.5 10 H 2.5 Z" fill="currentColor" stroke="none" />
    <line x1="9.5" y1="5.5" x2="14" y2="10.5" />
    <line x1="14" y1="5.5" x2="9.5" y2="10.5" />
  </svg>
);

export default VideoView;

"use client";

import { useEffect, useRef, useState } from "react";

export type VideoViewProps = {
  stream: MediaStream;
  /** Mute local playback on self streams (audio rides on a separate audio
   *  publication, but defensive against future bundling). */
  muted?: boolean;
  /** When true, render the pause-video toggle overlay. Only the publisher
   *  controls their own camera state. */
  isMine?: boolean;
};

// Camera / screen-share renderer with a publisher-only pause toggle in the
// top-right. Pausing flips track.enabled = false on every video track —
// peers see the last frame freeze and the publisher's preview goes black.
// Doesn't unpublish, so unpause is instant (no permission re-prompt).
export const VideoView = ({ stream, muted = false, isMine = false }: VideoViewProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!isMine) return;
    for (const t of stream.getVideoTracks()) t.enabled = !paused;
  }, [stream, paused, isMine]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: "#000" }}>
      <video
        ref={el => {
          videoRef.current = el;
          if (el && el.srcObject !== stream) el.srcObject = stream;
        }}
        autoPlay
        playsInline
        muted={muted}
        style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000", display: "block" }}
      />
      {isMine ? (
        <button
          type="button"
          onClick={() => setPaused(p => !p)}
          aria-label={paused ? "resume video" : "pause video"}
          title={paused ? "resume video" : "pause video"}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            background: paused ? "var(--slop-magenta, #ff3ec9)" : "rgba(6,3,13,0.7)",
            border: `1px solid ${paused ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-bevel-light, #4a4a4a)"}`,
            color: "#fff",
            cursor: "pointer",
            zIndex: 5,
            backdropFilter: "blur(4px)",
          }}
        >
          {paused ? <VideoOffIcon /> : <VideoOnIcon />}
        </button>
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

export default VideoView;

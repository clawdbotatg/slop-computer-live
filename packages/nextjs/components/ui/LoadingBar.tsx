"use client";

import type { CSSProperties, ReactNode } from "react";

export type LoadingBarProps = {
  /** Inner track width in characters (~7px each in mono). Default 20. */
  cells?: number;
  /** 0–100 for a determinate fill (e.g. BITRATE 70%). Omit for indeterminate. */
  progress?: number;
  /** Caption to the right. Defaults to "{progress}%" if progress is given. */
  caption?: ReactNode;
  /** Indeterminate cycle duration (seconds). */
  cycleSeconds?: number;
  className?: string;
  style?: CSSProperties;
};

const CHAR_WIDTH = 7;

// Bracketed CLI bar matching the slop-platinum stream-settings mockup.
//   [ ██████████░░░░░░░░ ] 70%
// Determinate mode renders the fill at the given progress. Indeterminate
// fills 0→100, holds briefly, then resets — DOS-installer feel rather than
// a smooth modern spinner.
export const LoadingBar = ({
  cells = 20,
  progress,
  caption,
  cycleSeconds = 1.8,
  className = "",
  style,
}: LoadingBarProps) => {
  const trackWidth = cells * CHAR_WIDTH;
  const isDeterminate = typeof progress === "number" && Number.isFinite(progress);
  const clamped = isDeterminate ? Math.max(0, Math.min(100, progress!)) : 0;

  return (
    <span
      className={`slop-loader ${className}`.trim()}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: "var(--slop-font-body), monospace",
        fontSize: 13,
        color: "var(--slop-text-muted)",
        ...style,
      }}
    >
      <span aria-hidden>[</span>
      <span
        className="slop-loader__track"
        style={{
          position: "relative",
          width: trackWidth,
          height: 12,
        }}
      >
        <span
          className={`slop-loader__bar${isDeterminate ? "" : " slop-loader__bar--indeterminate"}`}
          style={
            isDeterminate
              ? { width: `${clamped}%` }
              : {
                  // CSS animation needs to know the cycle duration; everything
                  // else lives in globals.css so the keyframes are reusable.
                  animationDuration: `${cycleSeconds}s`,
                }
          }
        />
      </span>
      <span aria-hidden>]</span>
      {caption !== undefined ? (
        <span style={{ marginLeft: 4 }}>{caption}</span>
      ) : isDeterminate ? (
        <span style={{ marginLeft: 4 }}>{Math.round(clamped)}%</span>
      ) : null}
    </span>
  );
};

export default LoadingBar;

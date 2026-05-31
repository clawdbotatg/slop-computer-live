"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

const FILLED = "▓"; // U+2593 medium shade
const EMPTY = "░"; // U+2591 light shade

export type LoadingBarProps = {
  /** Total cells in the bar (filled + empty). */
  cells?: number;
  /** 0–100 for a static fill (e.g. BITRATE 70%). Omit for animated indeterminate mode. */
  progress?: number;
  /**
   * Timed determinate mode: creep toward ~95% over this many ms, then
   * hold there until the bar unmounts (i.e. until the real work finishes
   * and the caller stops rendering it). Use when you have a rough ETA but
   * no real progress signal — far more honest than an indeterminate loop
   * for multi-second waits. Ignored if `progress` is set.
   */
  estimateMs?: number;
  /** Caption to the right of the bar. Defaults to `${pct}%`. */
  caption?: ReactNode;
  /** Indeterminate mode: ms between each step. */
  stepMs?: number;
  /** Indeterminate mode: ms to hold at full before resetting. */
  holdMs?: number;
  className?: string;
  style?: CSSProperties;
};

/**
 * Direct port of the BITRATE bar from `slop-design-explorations/app/_lib/scene.tsx`
 * (E2 · ASCII Topo theme):
 *
 *   [ ▓▓▓▓▓▓▓░░░ ] 70%
 *
 * Magenta accent with a 4px text-shadow glow, letter-spacing reset to 0
 * inside the brackets so the blocks pack tight, monospace font.
 */
// How far the timed-mode bar is allowed to creep before the real work
// finishes — it holds here rather than ever showing a misleading 100%.
const TIMED_MAX_FRACTION = 0.95;

export const LoadingBar = ({
  cells = 10,
  progress,
  estimateMs,
  caption,
  stepMs = 150,
  holdMs = 350,
  className = "",
  style,
}: LoadingBarProps) => {
  const isStatic = typeof progress === "number" && Number.isFinite(progress);
  const isTimed = !isStatic && typeof estimateMs === "number" && estimateMs > 0;
  const isIndeterminate = !isStatic && !isTimed;
  const [tick, setTick] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  // Indeterminate animation: step 0 → cells, hold at full briefly, reset.
  useEffect(() => {
    if (!isIndeterminate) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const advance = () => {
      if (cancelled) return;
      setTick(prev => {
        if (prev >= cells) {
          // hit full — pause, then reset on next tick
          timer = setTimeout(() => {
            if (!cancelled) setTick(0);
            timer = setTimeout(advance, stepMs);
          }, holdMs);
          return prev;
        }
        timer = setTimeout(advance, stepMs);
        return prev + 1;
      });
    };
    timer = setTimeout(advance, stepMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isIndeterminate, cells, stepMs, holdMs]);

  // Timed mode: sample wall-clock elapsed every ~250ms and let the fill
  // computation below derive the fraction. Holds at TIMED_MAX_FRACTION
  // once estimateMs passes — the bar unmounts when the work completes.
  useEffect(() => {
    if (!isTimed) return;
    const start = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - start), 250);
    return () => clearInterval(id);
  }, [isTimed, estimateMs]);

  let fraction: number;
  if (isStatic) {
    fraction = Math.max(0, Math.min(100, progress!)) / 100;
  } else if (isTimed) {
    fraction = Math.min(TIMED_MAX_FRACTION, elapsed / estimateMs!);
  } else {
    fraction = tick / cells;
  }
  // In timed mode never let the bar visually top out — keep at least the
  // last cell empty so it reads as "still working", not "done".
  const filledRaw = Math.round(fraction * cells);
  const filled = isTimed ? Math.min(cells - 1, filledRaw) : filledRaw;
  const empty = cells - filled;
  const pct = Math.round(fraction * 100);

  return (
    <span
      className={`slop-loader ${className}`.trim()}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontFamily: "var(--slop-font-mono, ui-monospace, monospace)",
        fontSize: 16,
        letterSpacing: "0.04em",
        color: "var(--slop-text)",
        ...style,
      }}
    >
      <span>[</span>
      <span
        aria-hidden
        style={{
          color: "var(--slop-magenta, #ff3ec9)",
          letterSpacing: 0,
          textShadow: "0 0 4px var(--slop-magenta, #ff3ec9)",
          // Reserve enough width for the full bar so the layout doesn't
          // shift between empty and full frames.
          minWidth: `${cells}ch`,
        }}
      >
        {FILLED.repeat(filled)}
        {EMPTY.repeat(empty)}
      </span>
      <span>] {caption ?? `${pct}%`}</span>
    </span>
  );
};

export default LoadingBar;

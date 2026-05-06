"use client";

import type { CSSProperties, ReactNode } from "react";

export type LoadingBarProps = {
  /** Number of blocks in the bar. */
  cells?: number;
  /** Width and height of each block in pixels. */
  size?: number;
  /** Optional caption underneath. */
  label?: ReactNode;
  /** Override the cycle duration (seconds). Lower = faster march. */
  cycleSeconds?: number;
  className?: string;
  style?: CSSProperties;
};

// Indeterminate loader — a row of inset blocks with a magenta wave that
// marches left-to-right and wraps. Tuned to look like the CLI/installer
// loaders from a 1999 OS rather than a smooth modern spinner.
export const LoadingBar = ({
  cells = 16,
  size = 14,
  label,
  cycleSeconds = 1.6,
  className = "",
  style,
}: LoadingBarProps) => {
  const cellArr = Array.from({ length: cells }, (_, i) => i);
  return (
    <div
      className={`slop-loader ${className}`.trim()}
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        ...style,
      }}
    >
      <div style={{ display: "flex", gap: 2 }}>
        {cellArr.map(i => (
          <span
            key={i}
            className="slop-loader__cell"
            style={{
              width: size,
              height: size,
              animationDelay: `${(i / cells) * cycleSeconds}s`,
              animationDuration: `${cycleSeconds}s`,
            }}
          />
        ))}
      </div>
      {label ? (
        <span
          style={{
            fontFamily: "var(--slop-font-body), monospace",
            fontSize: 11,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--slop-text-muted)",
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
};

export default LoadingBar;

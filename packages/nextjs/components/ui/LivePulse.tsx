import React from "react";

interface LivePulseProps {
  live?: boolean;
  size?: number;
  label?: string;
  className?: string;
}

export const LivePulse = ({ live = true, size, label, className = "" }: LivePulseProps) => {
  const dotStyle: React.CSSProperties | undefined = size ? { width: size, height: size } : undefined;
  return (
    <span className={`inline-flex items-center gap-2 ${className}`.trim()}>
      <span className={`slop-pulse${live ? "" : " slop-pulse--off"}`} style={dotStyle} aria-hidden />
      {label && (
        <span
          className="slop-mono"
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--slop-live)",
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
};

export default LivePulse;

type LivePulseProps = {
  live: boolean;
  size?: number;
};

export const LivePulse = ({ live, size = 8 }: LivePulseProps) => (
  <span
    aria-label={live ? "live" : "offline"}
    style={{
      display: "inline-block",
      width: size,
      height: size,
      background: live ? "var(--slop-live)" : "var(--slop-text-muted)",
      borderRadius: 0,
      animation: live ? "slop-live-pulse 1s ease-in-out infinite" : undefined,
      verticalAlign: "middle",
    }}
  />
);

export default LivePulse;

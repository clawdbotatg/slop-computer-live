import React from "react";

interface TitleBarProps {
  title: React.ReactNode;
  active?: boolean;
  right?: React.ReactNode;
  showDots?: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onZoom?: () => void;
  className?: string;
}

type DotKind = "close" | "minimize" | "zoom";

// Glyph rendered inside each titlebar button. Unicode characters keep
// the bundle tiny and scale crisply at any zoom; the font size in CSS
// handles the visual weight. Don't swap to SVGs unless you also need
// per-button styling beyond what CSS can express.
const DOT_GLYPH: Record<DotKind, string> = {
  close: "✕",
  minimize: "–",
  zoom: "+",
};

const Dot = ({ kind, onClick, label }: { kind: DotKind; onClick?: () => void; label?: string }) => {
  const cls = `slop-titlebar__dot slop-titlebar__dot--${kind}${onClick ? "" : " slop-titlebar__dot--disabled"}`;
  if (!onClick) {
    return (
      <span className={cls} aria-hidden data-grab="false">
        {DOT_GLYPH[kind]}
      </span>
    );
  }
  return (
    <span
      className={cls}
      role="button"
      aria-label={label}
      data-grab="false"
      onClick={e => {
        e.stopPropagation();
        onClick();
      }}
    >
      {DOT_GLYPH[kind]}
    </span>
  );
};

export const TitleBar = ({
  title,
  active = false,
  right,
  showDots = true,
  onClose,
  onMinimize,
  onZoom,
  className = "",
}: TitleBarProps) => {
  return (
    <div data-grab="true" className={`slop-titlebar ${active ? "slop-titlebar--active" : ""} ${className}`.trim()}>
      {showDots && (
        // data-grab="false" so the cursor stays a pointer over the row.
        // (We've tried other approaches to also stop the drag itself
        // from this region — none worked without side effects.)
        <div className="slop-titlebar__dots" data-grab="false">
          <Dot kind="close" onClick={onClose} label="close" />
          <Dot kind="minimize" onClick={onMinimize} label="minimize" />
          <Dot kind="zoom" onClick={onZoom} label="zoom" />
        </div>
      )}
      <div className="slop-titlebar__title flex-1 truncate">{title}</div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
};

export default TitleBar;

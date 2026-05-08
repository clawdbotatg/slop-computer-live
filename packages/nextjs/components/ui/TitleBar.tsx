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

const Dot = ({ onClick, label }: { onClick?: () => void; label?: string }) => {
  if (!onClick) return <span className="slop-titlebar__dot" aria-hidden data-grab="false" />;
  return (
    <span
      className="slop-titlebar__dot"
      role="button"
      aria-label={label}
      data-grab="false"
      style={{ cursor: "pointer" }}
      onClick={e => {
        e.stopPropagation();
        onClick();
      }}
    />
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
          <Dot onClick={onClose} label="close" />
          <Dot onClick={onMinimize} label="minimize" />
          <Dot onClick={onZoom} label="zoom" />
        </div>
      )}
      <div className="flex-1 truncate">{title}</div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
};

export default TitleBar;

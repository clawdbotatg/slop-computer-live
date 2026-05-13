import React, { useRef } from "react";

interface TitleBarProps {
  title: React.ReactNode;
  active?: boolean;
  right?: React.ReactNode;
  showDots?: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onZoom?: () => void;
  /** Optional click handler for the whole title row. Used by the
   *  minimized "dock" mode where any click on the bar restores the
   *  window. A real drag won't fire onClick because react-rnd's drag
   *  threshold suppresses the synthetic click. */
  onTitleClick?: () => void;
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
  // Fire the action on mousedown rather than click. The titlebar IS the
  // react-rnd drag handle, so when an unfocused window receives a click
  // on a dot, react-rnd's drag-init + the parent window's focus bump can
  // race the synthetic click and we'd need a second click to commit.
  // Acting on mousedown removes the race — the X closes immediately, even
  // when the window doesn't have focus.
  //
  // stopPropagation on every relevant event keeps the parent .slop-titlebar
  // from also receiving it (so we don't bump z while closing, and we don't
  // hand react-rnd a half-started drag). The onClick path is kept for
  // keyboard activation (Space/Enter on role="button"); a `firedRef`
  // dedupes the case where mouse click also dispatches click after our
  // mousedown handler already ran (Dot still in the tree, e.g. zoom).
  const firedRef = useRef(false);
  if (!onClick) {
    return (
      <span className={cls} aria-hidden data-grab="false">
        {DOT_GLYPH[kind]}
      </span>
    );
  }
  const fire = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    if (firedRef.current) return;
    firedRef.current = true;
    // Clear next tick so a follow-up gesture can fire again. The dot may
    // be unmounted before this runs (close/minimize) — harmless.
    setTimeout(() => {
      firedRef.current = false;
    }, 0);
    onClick();
  };
  return (
    <span className={cls} role="button" aria-label={label} data-grab="false" onMouseDown={fire} onClick={fire}>
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
  onTitleClick,
  className = "",
}: TitleBarProps) => {
  return (
    <div
      data-grab="true"
      className={`slop-titlebar ${active ? "slop-titlebar--active" : ""} ${className}`.trim()}
      onClick={onTitleClick}
      style={onTitleClick ? { cursor: "pointer" } : undefined}
    >
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

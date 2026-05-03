"use client";

import type { CSSProperties, ReactNode } from "react";

type TitleBarProps = {
  title: string;
  active?: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onZoom?: () => void;
  className?: string;
  right?: ReactNode;
};

const dotBase: CSSProperties = {
  width: 12,
  height: 12,
  display: "inline-block",
  marginRight: 4,
  cursor: "pointer",
  borderRadius: 0,
  border: "1px solid var(--slop-bevel-dark)",
};

const Dot = ({
  color,
  glyph,
  onClick,
  title,
}: {
  color: string;
  glyph?: string;
  onClick?: () => void;
  title: string;
}) => (
  <span
    onClick={e => {
      e.stopPropagation();
      onClick?.();
    }}
    style={{ ...dotBase, background: color }}
    title={title}
  >
    {glyph && (
      <span
        style={{
          fontFamily: "var(--slop-font-display)",
          fontSize: 10,
          lineHeight: "10px",
          color: "var(--slop-bevel-dark)",
          display: "block",
          textAlign: "center",
        }}
      >
        {glyph}
      </span>
    )}
  </span>
);

export const TitleBar = ({ title, active = true, onClose, onMinimize, onZoom, className, right }: TitleBarProps) => (
  <div
    className={`slop-title-bar ${className ?? ""}`}
    style={{
      background: active ? "var(--slop-titlebar-active)" : "var(--slop-titlebar)",
      color: "var(--slop-text)",
      fontFamily: "var(--slop-font-display)",
      fontSize: 12,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      height: 22,
      display: "flex",
      alignItems: "center",
      padding: "0 6px",
      borderBottom: "1px solid var(--slop-bevel-dark)",
      userSelect: "none",
      cursor: "move",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
      <Dot color="#ff5e57" glyph="✕" onClick={onClose} title="Close" />
      <Dot color="#ffbd2e" glyph="—" onClick={onMinimize} title="Minimize" />
      <Dot color="#28c840" glyph="◇" onClick={onZoom} title="Zoom" />
    </div>
    <div style={{ flex: 1, textAlign: "center", paddingRight: 50 }}>{title}</div>
    {right}
  </div>
);

export default TitleBar;

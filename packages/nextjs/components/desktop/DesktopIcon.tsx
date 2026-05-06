"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Rnd } from "react-rnd";

const DEFAULT_SIZE = 88;
const LABEL_HEIGHT = 22;

export type DesktopIconProps = {
  iconSrc: string;
  label: string;
  x: number;
  y: number;
  size?: number;
  zIndex?: number;
  onMove?: (pos: { x: number; y: number }) => void;
  onDoubleClick?: () => void;
  style?: CSSProperties;
};

export const DesktopIcon = ({
  iconSrc,
  label,
  x,
  y,
  size = DEFAULT_SIZE,
  zIndex = 1,
  onMove,
  onDoubleClick,
  style,
}: DesktopIconProps) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Distinguish "the user moved the icon" from "the user double-clicked".
  // Without this, every second click after a no-op drag fires onMove with
  // unchanged coords and we save a slot update for nothing.
  const dragMovedRef = useRef(false);

  const body = (
    <div
      onDoubleClick={() => {
        if (dragMovedRef.current) return;
        onDoubleClick?.();
      }}
      style={{
        width: size,
        height: size + LABEL_HEIGHT,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        cursor: "default",
        userSelect: "none",
        textAlign: "center",
      }}
    >
      <img
        src={iconSrc}
        alt={label}
        width={size}
        height={size}
        draggable={false}
        style={{
          width: size,
          height: size,
          imageRendering: "pixelated",
          pointerEvents: "none",
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.6))",
        }}
      />
      <span
        style={{
          fontSize: 11,
          color: "var(--slop-text)",
          padding: "1px 6px",
          maxWidth: size + 16,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          textShadow: "0 1px 2px #000, 0 0 4px #000",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
    </div>
  );

  if (!mounted) {
    return (
      <div
        style={{
          position: "absolute",
          left: x,
          top: y,
          zIndex,
          ...style,
        }}
      >
        {body}
      </div>
    );
  }

  return (
    <Rnd
      position={{ x, y }}
      size={{ width: size, height: size + LABEL_HEIGHT }}
      enableResizing={false}
      bounds="parent"
      style={{ zIndex, ...style }}
      onDragStart={() => {
        dragMovedRef.current = false;
      }}
      onDrag={(_e, d) => {
        if (d.x !== x || d.y !== y) dragMovedRef.current = true;
      }}
      onDragStop={(_e, d) => {
        if (!dragMovedRef.current) return;
        onMove?.({ x: d.x, y: d.y });
      }}
    >
      {body}
    </Rnd>
  );
};

export default DesktopIcon;

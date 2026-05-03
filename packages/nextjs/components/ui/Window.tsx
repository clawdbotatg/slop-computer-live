"use client";

import type { CSSProperties, ReactNode } from "react";
import { useRef } from "react";
import { bevelStyle } from "./Bevel";
import { TitleBar } from "./TitleBar";
import { Rnd } from "react-rnd";

export type WindowProps = {
  title: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  active?: boolean;
  minWidth?: number;
  minHeight?: number;
  onFocus?: () => void;
  onClose?: () => void;
  onMinimize?: () => void;
  onZoom?: () => void;
  onMove?: (pos: { x: number; y: number }) => void;
  onResize?: (size: { x: number; y: number; width: number; height: number }) => void;
  bodyStyle?: CSSProperties;
  children?: ReactNode;
};

export const Window = ({
  title,
  x = 80,
  y = 80,
  width = 320,
  height = 240,
  zIndex = 1,
  active = true,
  minWidth = 180,
  minHeight = 120,
  onFocus,
  onClose,
  onMinimize,
  onZoom,
  onMove,
  onResize,
  bodyStyle,
  children,
}: WindowProps) => {
  const dragHandleRef = useRef<HTMLDivElement | null>(null);

  return (
    <Rnd
      default={{ x, y, width, height }}
      bounds="parent"
      minWidth={minWidth}
      minHeight={minHeight}
      dragHandleClassName="slop-title-bar"
      style={{
        ...bevelStyle("outset"),
        background: "var(--slop-panel)",
        zIndex,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: 0,
      }}
      onMouseDown={onFocus}
      onDragStop={(_e, d) => onMove?.({ x: d.x, y: d.y })}
      onResizeStop={(_e, _dir, ref, _delta, position) =>
        onResize?.({
          x: position.x,
          y: position.y,
          width: ref.offsetWidth,
          height: ref.offsetHeight,
        })
      }
      resizeHandleStyles={{
        bottomRight: {
          width: 12,
          height: 12,
          right: 0,
          bottom: 0,
          background: "var(--slop-panel-light)",
          borderTop: "1px solid var(--slop-bevel-light)",
          borderLeft: "1px solid var(--slop-bevel-light)",
          cursor: "nwse-resize",
        },
      }}
    >
      <div ref={dragHandleRef} style={{ flex: "0 0 auto" }}>
        <TitleBar title={title} active={active} onClose={onClose} onMinimize={onMinimize} onZoom={onZoom} />
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: "var(--slop-panel)",
          color: "var(--slop-text)",
          padding: 8,
          overflow: "auto",
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </Rnd>
  );
};

export default Window;

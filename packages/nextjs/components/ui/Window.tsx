"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
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
  bodyClassName?: string;
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
  bodyClassName = "",
  bodyStyle,
  children,
}: WindowProps) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const body = (
    <>
      <TitleBar title={title} active={active} onClose={onClose} onMinimize={onMinimize} onZoom={onZoom} />
      <div
        className={bodyClassName}
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
    </>
  );

  if (!mounted) {
    return (
      <div
        className="slop-window"
        style={{
          position: "absolute",
          left: x,
          top: y,
          width,
          height,
          zIndex,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {body}
      </div>
    );
  }

  return (
    <Rnd
      position={{ x, y }}
      size={{ width, height }}
      bounds="parent"
      minWidth={minWidth}
      minHeight={minHeight}
      dragHandleClassName="slop-titlebar"
      className="slop-window"
      style={{
        zIndex,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
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
          // Large enough to win the click against the bottom + right edge
          // handles (10px strips that overlap this corner). zIndex puts
          // the corner handle on top so dragging here resizes both axes.
          width: 22,
          height: 22,
          right: 0,
          bottom: 0,
          background:
            "repeating-linear-gradient(135deg, var(--slop-bevel-light) 0, var(--slop-bevel-light) 1px, transparent 1px, transparent 3px)",
          zIndex: 2,
        },
      }}
      resizeHandleClasses={{ bottomRight: "slop-resize" }}
    >
      {body}
    </Rnd>
  );
};

export default Window;

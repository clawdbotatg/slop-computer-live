"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { TitleBar } from "./TitleBar";
import { Rnd } from "react-rnd";

const TITLEBAR_HEIGHT = 36;

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
  // Inset within the viewport that maximize should respect (e.g. 26px top
  // for the menubar in production). Defaults to 0 on all sides.
  containerInset?: { top?: number; right?: number; bottom?: number; left?: number };
};

type WindowMode = "normal" | "max" | "dock";
type Rect = { x: number; y: number; width: number; height: number };

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
  containerInset,
}: WindowProps) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [mode, setMode] = useState<WindowMode>("normal");
  const [savedRect, setSavedRect] = useState<Rect | null>(null);

  const insets = {
    top: containerInset?.top ?? 0,
    right: containerInset?.right ?? 0,
    bottom: containerInset?.bottom ?? 0,
    left: containerInset?.left ?? 0,
  };

  const restore = () => {
    if (!savedRect) return;
    onMove?.({ x: savedRect.x, y: savedRect.y });
    onResize?.({ ...savedRect });
    setMode("normal");
  };

  const handleZoom = () => {
    onZoom?.();
    if (mode === "max") {
      restore();
      return;
    }
    if (mode === "normal") setSavedRect({ x, y, width, height });
    const W = window.innerWidth - insets.left - insets.right;
    const H = window.innerHeight - insets.top - insets.bottom;
    onMove?.({ x: insets.left, y: insets.top });
    onResize?.({ x: insets.left, y: insets.top, width: W, height: H });
    setMode("max");
  };

  const handleMinimize = () => {
    onMinimize?.();
    if (mode === "dock") {
      restore();
      return;
    }
    // From max → snap back to the saved size first so the docked titlebar
    // is the window's natural width, not viewport-wide. From normal → save
    // current rect so we can restore later.
    let dockX = x;
    let dockW = width;
    let dockH = height;
    if (mode === "max" && savedRect) {
      dockX = savedRect.x;
      dockW = savedRect.width;
      dockH = savedRect.height;
    } else if (mode === "normal") {
      setSavedRect({ x, y, width, height });
    }
    const dockY = window.innerHeight - insets.bottom - TITLEBAR_HEIGHT;
    onMove?.({ x: dockX, y: dockY });
    onResize?.({ x: dockX, y: dockY, width: dockW, height: dockH });
    setMode("dock");
  };

  const body = (
    <>
      <TitleBar title={title} active={active} onClose={onClose} onMinimize={handleMinimize} onZoom={handleZoom} />
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
      onDragStop={(_e, d) => {
        // react-rnd fires onDragStop on every mouseup, even when the user
        // didn't actually move the window (e.g. a click on a titlebar dot).
        // Only treat this as a manual move if something changed — otherwise
        // we'd nuke the saved restore-rect on every click of max/min.
        if (d.x === x && d.y === y) return;
        // Clamp y so the titlebar can't slide under the menubar — the
        // <Rnd bounds="parent"> constraint binds to the wrapper's
        // bounding rect (which still spans 0..viewportH), so without
        // this a fast drag past the top edge would pin the window
        // behind the menubar with no way to grab it back.
        const clampedY = Math.max(insets.top, d.y);
        onMove?.({ x: d.x, y: clampedY });
        if (mode !== "normal") {
          setMode("normal");
          setSavedRect(null);
        }
      }}
      onResizeStop={(_e, _dir, ref, _delta, position) => {
        const newW = ref.offsetWidth;
        const newH = ref.offsetHeight;
        if (position.x === x && position.y === y && newW === width && newH === height) return;
        const clampedY = Math.max(insets.top, position.y);
        onResize?.({ x: position.x, y: clampedY, width: newW, height: newH });
        if (mode !== "normal") {
          setMode("normal");
          setSavedRect(null);
        }
      }}
      resizeHandleStyles={{
        // Stop the bottom + right edge handles 24px before the corner so
        // they don't cover the corner-resize handle. Edges resize one
        // axis; the corner resizes both.
        right: { height: "calc(100% - 24px)" },
        bottom: { width: "calc(100% - 24px)" },
        bottomRight: {
          width: 24,
          height: 24,
          right: 0,
          bottom: 0,
          background:
            "repeating-linear-gradient(135deg, var(--slop-bevel-light) 0, var(--slop-bevel-light) 1px, transparent 1px, transparent 3px)",
          zIndex: 3,
          pointerEvents: "auto",
        },
      }}
      resizeHandleClasses={{ bottomRight: "slop-resize" }}
    >
      {body}
    </Rnd>
  );
};

export default Window;

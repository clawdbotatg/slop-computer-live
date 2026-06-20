"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { TitleBar } from "./TitleBar";
import { Rnd } from "react-rnd";

export const TITLEBAR_HEIGHT = 36;
// While docked, dragging the pill UP by at least this many px pops the
// window back open (live, mid-drag). Below it, the drag just slides the
// pill left/right along the dock edge — so a little vertical wobble while
// repositioning doesn't un-minimize.
const UNDOCK_DRAG_THRESHOLD = 24;
// Movement (px) below which a docked press is a click (→ restore), not a
// drag — used to decide whether to swallow the trailing click.
const DOCK_DRAG_EPS = 3;
// Dragging a normal window DOWN so its bottom edge passes its on-screen
// resting spot (bottom flush with the dock) by more than this drops it
// into the minimized pill on release — the mirror of drag-up-to-restore.
// Measured against the window's lowest resting y, NOT the cursor: the
// cursor sits on the titlebar at the TOP of the window, so a cursor-band
// test made a tall window impossible to dock and demanded a huge drag for
// short ones. Overshoot is `max(MIN px, FRAC × height)` so the gesture
// feels the same regardless of window size: a small overshoot just snaps
// the window fully back on-screen (a little wobble near the bottom won't
// minimize), a bigger one means "drop it."
const DOCK_DROP_OVERSHOOT_MIN = 50;
const DOCK_DROP_OVERSHOOT_FRAC = 0.18;

export type WindowProps = {
  title: string;
  // Stable slot id, surfaced on the rendered root as `data-slot-id`. The
  // god-mode/OBS browser measures these elements' on-screen rects to log the
  // exact recorded-frame window geometry (see Desktop.tsx's god-geometry effect
  // + the relay's geometry-log). Purely a measurement hook — no behaviour.
  slotId?: string;
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
  // Extra class on the <TitleBar> root. Used to paint a window's chrome a
  // different color — e.g. "slop-titlebar--private" greys it out to signal a
  // single-player window only the local viewer can see. Empty = the default
  // purple/magenta shared chrome.
  titleBarClassName?: string;
  children?: ReactNode;
  // Inset within the viewport that maximize should respect (e.g. 26px top
  // for the menubar in production). Defaults to 0 on all sides.
  containerInset?: { top?: number; right?: number; bottom?: number; left?: number };
  // Extra gap (px) the minimized "pill" leaves at the bottom of the screen,
  // measured from the viewport bottom to the pill's BOTTOM edge. Affects
  // ONLY the docked pill's resting position — not maximize, which still
  // uses containerInset. Default 0 (generic component). The slop desktop
  // passes an inset slightly smaller than its bottom bar stack so the pill
  // tucks BEHIND the opaque bars with just the top of its titlebar peeking
  // above them (see DOCKED_PILL_BOTTOM_INSET in bottomBarLayout.ts) —
  // pair it with dockUnderZ so the tucked portion actually hides.
  dockBottomInset?: number;
  // z-index of the bottom-pinned chrome the pill tucks under. While docked,
  // the window's zIndex is capped just below this so the tucked part of the
  // pill stays hidden behind the bars. Without the cap, slot z — which
  // grows unboundedly (focus = maxZ + 1, never compacted) — eventually
  // passes the bars' z and the pill paints on top of the ticker. Undefined
  // (default) = no cap.
  dockUnderZ?: number;
  // Keep the body (children) mounted while docked instead of unmounting
  // it. Default false: docked windows render titlebar-only and drop their
  // body to save work. Opt in for windows whose body owns live state that
  // must survive minimize — e.g. SLOPAMP's <audio> element keeps playing
  // when minimized only because it stays in the DOM. The hidden body is
  // `display:none` so it neither paints nor inflates the docked pill.
  keepMountedWhenDocked?: boolean;
};

type WindowMode = "normal" | "max" | "dock";
type Rect = { x: number; y: number; width: number; height: number };

export const Window = ({
  title,
  slotId,
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
  titleBarClassName = "",
  children,
  containerInset,
  dockBottomInset = 0,
  dockUnderZ,
  keepMountedWhenDocked = false,
}: WindowProps) => {
  const [mounted, setMounted] = useState(false);
  // Track THIS viewer's viewport height. The docked "pill" pins to the
  // bottom of the local screen, so its y must be derived from this and
  // never from the shared slot — see `dockedY` below.
  const [viewportH, setViewportH] = useState(0);
  useEffect(() => {
    setMounted(true);
    const sync = () => setViewportH(window.innerHeight);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  const [mode, setMode] = useState<WindowMode>("normal");
  const [savedRect, setSavedRect] = useState<Rect | null>(null);

  // Set true by a docked drag (reposition or undock) so the synthetic
  // click that the browser fires after the same mouseup doesn't ALSO
  // restore the window. Reset at the start of every gesture so it can't
  // get stuck across gestures.
  const dockSuppressClickRef = useRef(false);
  // Teardown for the in-flight docked-drag pointer listeners, so a window
  // that unmounts mid-drag doesn't leak them.
  const dockDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dockDragCleanupRef.current?.(), []);

  const insets = {
    top: containerInset?.top ?? 0,
    right: containerInset?.right ?? 0,
    bottom: containerInset?.bottom ?? 0,
    left: containerInset?.left ?? 0,
  };

  // Vertical position of the docked "pill" — flush to the bottom of
  // THIS viewer's screen. Computed locally on every render (and on
  // resize) so a peer with a different screen height sees it on their
  // own bottom edge, not at the initiator's absolute coordinate. The
  // synced slot y is deliberately ignored while docked. dockBottomInset
  // lifts the pill's bottom edge off the viewport bottom — the slop
  // desktop sizes it so the pill sits mostly behind the bar stack with
  // just a sliver of titlebar peeking above it.
  const dockedY = Math.max(insets.top, viewportH - insets.bottom - dockBottomInset - TITLEBAR_HEIGHT);

  const restore = () => {
    if (savedRect) {
      onMove?.({ x: savedRect.x, y: savedRect.y });
      onResize?.({ ...savedRect });
      setMode("normal");
      return;
    }
    // No saved rect — happens for peers that didn't initiate the dock,
    // or after a reload where the slot height is TITLEBAR but the
    // component's React state is fresh. Fall back to a reasonable
    // restore: re-inflate at current x to min dimensions, positioned
    // just above the LOCAL dock edge (not the synced slot y, which may
    // be off-screen for a viewer whose screen height differs from the
    // peer that minimized).
    const fallbackW = Math.max(minWidth, 320);
    const fallbackH = Math.max(minHeight, 240);
    const fallbackY = Math.max(insets.top, dockedY - fallbackH - 8);
    onMove?.({ x, y: fallbackY });
    onResize?.({ x, y: fallbackY, width: fallbackW, height: fallbackH });
    setMode("normal");
  };

  // Click (not drag) on the docked pill restores it. A real drag sets
  // dockSuppressClickRef in onDragStop, so the follow-up synthetic click
  // is swallowed here and a horizontal reposition doesn't un-minimize.
  const handleDockClick = () => {
    if (dockSuppressClickRef.current) {
      dockSuppressClickRef.current = false;
      return;
    }
    restore();
  };

  // Drag the docked "pill" ourselves (react-rnd dragging is disabled while
  // docked). Below the pull-up threshold the pill slides left/right along
  // the dock edge; the instant the cursor crosses the threshold upward we
  // restore the window full-size UNDER the cursor and keep moving it with
  // the same press — so it's in-hand immediately, not on release.
  //
  // MOUSE events, not pointer events: the custom SVG cursor (useLocalCursor)
  // tracks `mousemove`, and calling preventDefault on a *pointerdown* would
  // suppress the browser's compatibility mouse events for the whole gesture
  // — freezing the cursor mid-drag. preventDefault on *mousedown* only stops
  // text selection and is safe (mousemove still fires).
  const handleDockMouseDown = (e: React.MouseEvent) => {
    if (!isDocked || e.button !== 0) return;
    e.preventDefault();
    onFocus?.();

    const startX = e.clientX;
    const startY = e.clientY;
    const pillX = x;
    const restoredW = savedRect?.width ?? Math.max(minWidth, 320);
    const restoredH = savedRect?.height ?? Math.max(minHeight, 240);
    // Keep the cursor at the same horizontal spot on the (wider) restored
    // titlebar that it grabbed on the pill.
    const grabDX = Math.min(Math.max(startX - pillX, 8), restoredW - 8);
    let restored = false;
    let moved = false;
    // Track the last position we drove the restored window to, so `finish`
    // can snap it fully on-screen on release.
    let lastNx = pillX;
    let lastNy = dockedY;

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const draggedUp = startY - ev.clientY;
      if (Math.abs(dx) > DOCK_DRAG_EPS || draggedUp > DOCK_DRAG_EPS) moved = true;

      if (!restored && draggedUp > UNDOCK_DRAG_THRESHOLD) {
        // Cross the threshold → restore full-size, titlebar under cursor.
        restored = true;
        lastNx = ev.clientX - grabDX;
        lastNy = Math.max(insets.top, ev.clientY - TITLEBAR_HEIGHT / 2);
        // Drive position via onResize, NOT onMove: SlotWindow's onMove
        // closure still carries the docked 200×36 size captured at
        // mousedown, so calling it here would re-minimize us every frame.
        // onResize takes explicit dims, so it keeps us full-size.
        onResize?.({ x: lastNx, y: lastNy, width: restoredW, height: restoredH });
        setSavedRect(null);
        setMode("normal");
        return;
      }
      if (restored) {
        // Keep the restored window glued to the cursor — still via onResize
        // (full dims) so each frame doesn't snap back to the docked size.
        lastNx = ev.clientX - grabDX;
        lastNy = Math.max(insets.top, ev.clientY - TITLEBAR_HEIGHT / 2);
        onResize?.({ x: lastNx, y: lastNy, width: restoredW, height: restoredH });
      } else {
        // Still docked → slide horizontally, stay pinned to the dock edge.
        // (onMove's docked 200×36 size is correct while we're docked.)
        onMove?.({ x: pillX + dx, y: dockedY });
      }
    };

    const finish = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", finish);
      dockDragCleanupRef.current = null;
      // Swallow the click the browser fires after a real drag (so it can't
      // also toggle restore). A no-move press leaves this false and falls
      // through to handleDockClick → restore.
      dockSuppressClickRef.current = moved;
      if (restored) {
        // Just undocked → make sure the freshly-restored window lands fully
        // on-screen, not hanging off the bottom after a minimal pull-up
        // (its titlebar can be near the dock edge with the body below it).
        // Mirror of onDragStop's snap-back clamp.
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const cx = Math.min(Math.max(lastNx, 0), Math.max(0, vw - restoredW));
        const cy = Math.min(Math.max(lastNy, insets.top), Math.max(insets.top, vh - insets.bottom - restoredH));
        if (cx !== lastNx || cy !== lastNy) {
          onResize?.({ x: cx, y: cy, width: restoredW, height: restoredH });
        }
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", finish);
    dockDragCleanupRef.current = finish;
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

  // dockXOverride: where to place the pill horizontally (used by
  // drag-down-to-minimize so the pill lands at the drop x). Omitted for
  // the minimize button, which keeps the window's current x.
  const handleMinimize = (dockXOverride?: number) => {
    onMinimize?.();
    if (mode === "dock") {
      restore();
      return;
    }
    // Collapse to a titlebar-only "pill" pinned at the bottom of the
    // screen. We save the current rect so a later click on the docked
    // titlebar can restore the original geometry.
    //
    // Width also collapses to ~the docked title's natural display size
    // (~200px). The body div isn't rendered in dock mode below, so
    // size here is what react-rnd's wrapper actually paints.
    let dockX = dockXOverride ?? x;
    if (dockXOverride === undefined && mode === "max" && savedRect) {
      dockX = savedRect.x;
    }
    if (mode === "normal") {
      setSavedRect({ x, y, width, height });
    }
    const dockW = 200;
    const dockH = TITLEBAR_HEIGHT;
    // The slot only carries height=36 as the cross-peer "is minimized"
    // marker. The y written here is never read back for rendering — each
    // viewer recomputes `dockedY` against its own viewport — so storing
    // the local dockedY is just a sensible placeholder.
    onMove?.({ x: dockX, y: dockedY });
    onResize?.({ x: dockX, y: dockedY, width: dockW, height: dockH });
    setMode("dock");
  };

  // Derive docked state from height so it stays correct across peers
  // (only the initiator has mode="dock" locally — others receive the
  // 36px slot height via the shared mesh) and across reloads (fresh
  // mount loses local mode state but the slot persists).
  const isDocked = mode === "dock" || height <= TITLEBAR_HEIGHT;

  // While docked, keep the pill under the bottom-bar chrome so its tucked
  // portion hides behind the opaque bars (see dockUnderZ prop comment).
  const renderZ = isDocked && dockUnderZ !== undefined ? Math.min(zIndex, dockUnderZ - 1) : zIndex;

  const body = (
    <>
      <TitleBar
        title={title}
        active={active}
        className={titleBarClassName}
        showDots={!isDocked}
        onClose={isDocked ? undefined : onClose}
        onMinimize={isDocked ? undefined : handleMinimize}
        onZoom={isDocked ? undefined : handleZoom}
        onTitleClick={isDocked ? handleDockClick : undefined}
        onTitleMouseDown={isDocked ? handleDockMouseDown : undefined}
      />
      {isDocked && !keepMountedWhenDocked ? null : (
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
            // Docked + kept-mounted: stay in the DOM (so live state like
            // an <audio> element keeps running) but render nothing and
            // take no space, so the pill stays titlebar-only.
            ...(isDocked ? { display: "none" } : null),
          }}
        >
          {children}
        </div>
      )}
    </>
  );

  if (!mounted) {
    return (
      <div
        className="slop-window"
        data-slot-id={slotId}
        style={{
          position: "absolute",
          left: x,
          top: y,
          width,
          height,
          zIndex: renderZ,
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
      // Unknown prop → react-rnd routes it through to the rendered root div
      // (its `__rest` spread onto re-resizable), so `[data-slot-id]` is
      // queryable in the DOM for god-mode geometry measurement.
      data-slot-id={slotId}
      // While docked, render against the locally-computed bottom edge
      // instead of the synced slot y (which was set on whoever's screen
      // initiated the minimize). Dragging is disabled when docked, so
      // this never fights a user gesture.
      position={{ x, y: isDocked ? dockedY : y }}
      size={{ width, height }}
      // No bounds clamp: the window must be free to follow the cursor BELOW
      // the bottom edge during a drag (it slides off, clipped by the
      // desktop's overflow:hidden — exactly the look we want for
      // drag-to-minimize). A non-minimized drop is snapped back fully
      // on-screen in onDragStop instead, so windows can't get lost.
      minWidth={minWidth}
      minHeight={minHeight}
      dragHandleClassName="slop-titlebar"
      // Even though the titlebar is the drag handle, the traffic-light
      // buttons within it must NOT start a drag. Without this, react-rnd's
      // drag-init on mousedown can swallow the synthetic click on the
      // button (especially when the window isn't focused and the parent's
      // onMouseDown also fires to bump z), forcing users to click twice
      // to close.
      cancel=".slop-titlebar__dot"
      // While docked, react-rnd's own dragging is OFF — the docked "pill"
      // is dragged by our pointer handler (handleDockPointerDown) instead,
      // because react-rnd can't restore-and-keep-dragging mid-gesture
      // (react-draggable ignores position changes while a drag is live).
      disableDragging={isDocked}
      // Only allow resizing from the bottom + right edges and the
      // bottom-right grip. react-rnd's default top/left/topLeft/topRight
      // handles are positioned at -10px and span 20px, so their inner
      // half sits on top of the titlebar — which made the corner of the
      // close (X) button silently eat clicks meant for closing the window.
      enableResizing={
        isDocked
          ? false
          : {
              top: false,
              left: false,
              topLeft: false,
              topRight: false,
              bottomLeft: false,
              right: true,
              bottom: true,
              bottomRight: true,
            }
      }
      className="slop-window"
      style={{
        zIndex: renderZ,
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
        const vw = typeof window !== "undefined" ? window.innerWidth : width;
        const vh = viewportH || (typeof window !== "undefined" ? window.innerHeight : height);
        // Lowest the window can rest with its bottom flush against the dock
        // edge (clamped so it never tucks under the top menubar). How far the
        // drop dragged the window BELOW that resting spot is the dock gesture.
        const maxRestY = Math.max(insets.top, vh - insets.bottom - height);
        const overshoot = d.y - maxRestY;
        const dropThreshold = Math.max(DOCK_DROP_OVERSHOOT_MIN, height * DOCK_DROP_OVERSHOOT_FRAC);
        // Dragged the bottom edge well past its resting spot → minimize (the
        // mirror of drag-up-to-restore). Pill lands at the drop x.
        if (!isDocked && vh > 0 && overshoot > dropThreshold) {
          // Swallow the synthetic click the browser fires after this drag's
          // mouseup. The instant we minimize, the titlebar becomes the docked
          // pill whose click handler RESTORES — and because you drag toward
          // the bottom to dock, the drop leaves the cursor right over where
          // the pill now sits, so that trailing click immediately un-minimizes
          // it (the flicker: drag down → minimize → restore → "didn't
          // minimize"). Same guard the pill-drag path uses. Cleared on the
          // next macrotask so it only eats THIS click, never a later genuine
          // restore-click (the cursor may not even land on the pill).
          dockSuppressClickRef.current = true;
          setTimeout(() => {
            dockSuppressClickRef.current = false;
          }, 0);
          handleMinimize(d.x);
          return;
        }
        // Not minimized → snap fully back on-screen. With bounds removed,
        // a drag can leave the window partly past any edge; clamp so the
        // titlebar never hides under the menubar (top) or off the bottom,
        // and at least part stays grabbable horizontally.
        const clampedY = Math.min(Math.max(d.y, insets.top), maxRestY);
        const clampedX = Math.min(Math.max(d.x, 0), Math.max(0, vw - width));
        onMove?.({ x: clampedX, y: clampedY });
        // Dragging out of max → revert to normal. (Dragging is disabled
        // while docked so the docked case can't fire here.)
        if (mode === "max") {
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

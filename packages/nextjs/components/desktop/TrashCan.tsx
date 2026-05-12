"use client";

import { useEffect, useRef, useState } from "react";

// Fixed-position trash can pinned to the bottom-right of EVERY peer's
// viewport. Position is per-peer (different viewport sizes → different
// absolute coords) so we don't put it in the shared slot system at all.
//
// Behavior is driven by the parent (page.tsx): the parent intercepts
// the drag-end of each icon and checks whether the icon's final
// position overlaps this can. We just render the visual + a "hover
// while dragging" highlight.

export const TRASH_SIZE = 88;
const TRASH_MARGIN = 24;

export type TrashCanProps = {
  /** Forwarded ref so the parent can compute bounding-box overlap with
   *  dropped icons in viewport coords. */
  trashRef: React.RefObject<HTMLDivElement | null>;
};

export const TrashCan = ({ trashRef }: TrashCanProps) => {
  const [isHover, setIsHover] = useState(false);
  // Tracks whether the user is mid-drag with a primary button held.
  // We can't reliably detect "an icon is being dragged" specifically,
  // so we use "primary mouse button held + cursor over trash" as the
  // signal to highlight. Good enough for UX feedback; the actual
  // delete/snap-back logic is in the parent's drag-end handlers.
  const buttonHeldRef = useRef(false);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      // e.buttons bitfield — 1 = primary. If no button held, we're not
      // dragging, so the trash shouldn't be highlighted.
      const held = (e.buttons & 1) !== 0;
      buttonHeldRef.current = held;
      const el = trashRef.current;
      if (!el || !held) {
        setIsHover(false);
        return;
      }
      const r = el.getBoundingClientRect();
      const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      setIsHover(over);
    };
    const onUp = () => {
      buttonHeldRef.current = false;
      setIsHover(false);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [trashRef]);

  return (
    <div
      ref={trashRef}
      aria-label="trash"
      title="drag uploaded files here to delete"
      style={{
        position: "fixed",
        right: TRASH_MARGIN,
        bottom: TRASH_MARGIN,
        width: TRASH_SIZE,
        height: TRASH_SIZE,
        zIndex: 50, // above icons (z=1) but below windows (z>=4-500)
        // Pointer-events: none so it doesn't intercept drags. The
        // bounding-box overlap check works just as well without us
        // capturing pointer events directly.
        pointerEvents: "none",
        userSelect: "none",
        transition: "transform 0.12s ease-out, filter 0.12s ease-out",
        transform: isHover ? "scale(1.12)" : "scale(1)",
        filter: isHover
          ? "drop-shadow(0 0 12px var(--slop-magenta, #ff3ec9)) brightness(1.15)"
          : "drop-shadow(0 4px 8px rgba(0,0,0,0.6))",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/icons/trash.png"
        alt="trash"
        width={TRASH_SIZE}
        height={TRASH_SIZE}
        draggable={false}
        style={{
          width: TRASH_SIZE,
          height: TRASH_SIZE,
          pointerEvents: "none",
        }}
      />
      {isHover ? (
        <div
          style={{
            position: "absolute",
            top: -22,
            left: -8,
            right: -8,
            textAlign: "center",
            fontSize: 10,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--slop-magenta, #ff3ec9)",
            textShadow: "0 1px 2px rgba(0,0,0,0.8)",
            pointerEvents: "none",
          }}
        >
          drop to trash
        </div>
      ) : null}
    </div>
  );
};

export default TrashCan;

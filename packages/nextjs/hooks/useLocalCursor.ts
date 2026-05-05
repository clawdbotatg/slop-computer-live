"use client";

import { useEffect, useState } from "react";

export type CursorKind = "pointer" | "grab" | "grabbing" | "text";

/**
 * Track the local mouse position + the appropriate cursor variant based on
 * what's under the pointer. Used to render a custom-SVG cursor in place of
 * the native browser cursor.
 *
 * Hover detection uses elementFromPoint + closest() so that nesting works:
 * a click on an inner span inside a draggable titlebar still resolves to
 * the outer [data-grab] element.
 */
export function useLocalCursor() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [kind, setKind] = useState<CursorKind>("pointer");

  useEffect(() => {
    let down = false;
    const resolve = (clientX: number, clientY: number): CursorKind => {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el) return "pointer";
      // Inputs / textareas / contenteditable
      const tag = el.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (el as HTMLElement).isContentEditable ||
        el.closest("input, textarea, [contenteditable=true]")
      ) {
        return "text";
      }
      // Walk up to the nearest cursor-marked ancestor. data-grab="false"
      // (e.g. close/min/zoom dots inside a draggable titlebar) wins because
      // it's closer in the DOM, so we return "pointer" for that subtree.
      const marker = el.closest("[data-grab], .slop-resize");
      if (!marker) return "pointer";
      if (marker.classList.contains("slop-resize")) return "grab";
      return marker.getAttribute("data-grab") === "true" ? "grab" : "pointer";
    };

    const onMove = (e: MouseEvent) => {
      setPos({ x: e.clientX, y: e.clientY });
      if (down) {
        setKind("grabbing");
        return;
      }
      setKind(resolve(e.clientX, e.clientY));
    };
    const onDown = (e: MouseEvent) => {
      down = true;
      const onTop = resolve(e.clientX, e.clientY);
      // Only switch to grabbing if pressing on something draggable
      if (onTop === "grab") setKind("grabbing");
    };
    const onUp = (e: MouseEvent) => {
      down = false;
      setKind(resolve(e.clientX, e.clientY));
    };
    const onLeave = () => setPos(null);

    // Capture phase: react-rnd / re-resizable stops propagation on
    // resize-handle mousedown, so a bubble-phase listener on window
    // never fires and the cursor stays stuck on "grab" during a drag.
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", onUp, true);
    document.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
      document.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return { pos, kind };
}

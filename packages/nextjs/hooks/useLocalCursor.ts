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
      if (el.closest("[data-grab=true]")) return "grab";
      return "pointer";
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

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    document.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      document.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return { pos, kind };
}

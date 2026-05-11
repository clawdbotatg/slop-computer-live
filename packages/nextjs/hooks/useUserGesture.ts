"use client";

import { useCallback, useEffect, useState } from "react";

/** Custom event dispatched once, on first user gesture this page-load.
 *  Audio components can listen for this to retry audio.play() and
 *  ctx.resume() — both of which need a gesture in scope on Chrome's
 *  autoplay policy. */
export const ACTIVATED_EVENT = "slop:activated";

/**
 * Tracks whether the user has produced a "user activation" gesture in
 * this tab since page load. Used by the entry gate: if the user is
 * already authenticated (valid cookie) but hasn't clicked anything since
 * loading, we surface a one-click Enter overlay so the browser will
 * later allow audio playback + AudioContext resumption.
 *
 * State is intentionally NOT persisted — autoplay permission is
 * per-page-load, so a reload must always re-prompt.
 */
export function useUserGesture() {
  const [gestured, setGestured] = useState(false);

  useEffect(() => {
    if (gestured) return;
    const trip = () => {
      setGestured(true);
      // Tell anyone listening (the music player, future media apps) to
      // retry whatever they had pending. Fired exactly once.
      window.dispatchEvent(new Event(ACTIVATED_EVENT));
    };
    // Capture-phase so we trip even if a child handler stops propagation.
    window.addEventListener("pointerdown", trip, { capture: true, once: true });
    window.addEventListener("keydown", trip, { capture: true, once: true });
    window.addEventListener("touchstart", trip, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", trip, { capture: true } as EventListenerOptions);
      window.removeEventListener("keydown", trip, { capture: true } as EventListenerOptions);
      window.removeEventListener("touchstart", trip, { capture: true } as EventListenerOptions);
    };
  }, [gestured]);

  // Manual trip — useful for the Enter overlay's button (the click itself
  // would also flip the flag via the listener, but firing here keeps the
  // intent obvious in the call site).
  const trip = useCallback(() => {
    if (gestured) return;
    setGestured(true);
    window.dispatchEvent(new Event(ACTIVATED_EVENT));
  }, [gestured]);

  return { gestured, trip };
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  // A ref guards against double-fire when the Enter button is clicked:
  // the capture-phase pointerdown listener AND the React onClick (which
  // calls our manual trip()) both run from the same physical click,
  // and `gestured` state hasn't applied yet between them.
  const firedRef = useRef(false);

  const fire = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    setGestured(true);
    // Tell anyone listening (the music player, future media apps) to
    // retry whatever they had pending. Fired exactly once.
    window.dispatchEvent(new Event(ACTIVATED_EVENT));
  }, []);

  useEffect(() => {
    if (firedRef.current) return;
    // Capture-phase so we trip even if a child handler stops propagation.
    const opts = { capture: true, once: true } as AddEventListenerOptions;
    window.addEventListener("pointerdown", fire, opts);
    window.addEventListener("keydown", fire, opts);
    window.addEventListener("touchstart", fire, opts);
    return () => {
      window.removeEventListener("pointerdown", fire, { capture: true } as EventListenerOptions);
      window.removeEventListener("keydown", fire, { capture: true } as EventListenerOptions);
      window.removeEventListener("touchstart", fire, { capture: true } as EventListenerOptions);
    };
  }, [fire]);

  return { gestured, trip: fire };
}

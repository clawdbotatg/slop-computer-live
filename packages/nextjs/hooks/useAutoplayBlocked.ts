"use client";

import { useEffect, useState } from "react";

/**
 * Detects whether the browser will actually refuse to autoplay UNMUTED
 * audio without a user gesture this page-load.
 *
 * The EntryGate exists only to manufacture a gesture so the music player
 * (an unmuted <audio>) can start. But browsers don't always require one:
 * Chrome grants autoplay based on the site's Media Engagement Index, so a
 * reload-into-active-music (high engagement) plays with no gesture at all.
 * In that case forcing a "click to enter" screen is pure friction.
 *
 * Returns:
 *   - `null`  while we don't yet know (async probe in flight). Render as
 *             "not blocked" to avoid a gate flash — the worst case is the
 *             gate appears a tick late on the rare async-fallback path.
 *   - `true`  browser will block unmuted autoplay → gate is needed.
 *   - `false` autoplay is allowed → skip the gate entirely.
 *
 * Not persisted: autoplay permission is per-page-load, so every mount
 * re-probes.
 */
export function useAutoplayBlocked(): boolean | null {
  // Chrome 110+ / Firefox expose a synchronous, authoritative answer.
  // Resolve it in the initializer so the common case (allowed) never
  // flashes the gate.
  const [blocked, setBlocked] = useState<boolean | null>(() => readPolicySync());

  useEffect(() => {
    // Sync path already decided — nothing to probe.
    if (readPolicySync() !== null) return;
    let cancelled = false;
    probeAutoplayAsync().then(result => {
      if (!cancelled) setBlocked(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return blocked;
}

/**
 * Synchronous, authoritative read via navigator.getAutoplayPolicy.
 * "allowed" is the only value that lets UNMUTED media play freely —
 * "allowed-muted" still needs a gesture for sound, and "disallowed"
 * obviously does. Returns null when the API is absent (Safari, older
 * browsers) so the caller falls back to the async probe.
 */
function readPolicySync(): boolean | null {
  if (typeof navigator === "undefined") return null;
  const getPolicy = (navigator as Navigator & { getAutoplayPolicy?: (t: string) => string }).getAutoplayPolicy;
  if (typeof getPolicy !== "function") return null;
  try {
    return getPolicy.call(navigator, "mediaelement") !== "allowed";
  } catch {
    return null;
  }
}

/**
 * Fallback for browsers without getAutoplayPolicy (Safari). We can't ask,
 * so we test: spin up a throwaway AudioContext and see if it's allowed to
 * run without a gesture. A context that comes up "running" (or resumes to
 * running) means the browser isn't gating audio; one stuck "suspended"
 * means it is. Safari resets this every page-load and doesn't do Chrome-
 * style engagement autoplay, so this typically reports blocked there —
 * matching the prior always-gate behavior, no regression.
 */
async function probeAutoplayAsync(): Promise<boolean> {
  if (typeof window === "undefined") return true;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return true; // no Web Audio — be safe, keep the gate
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    if (ctx.state === "running") return false; // already unlocked
    await ctx.resume().catch(() => undefined);
    // Read as a plain string so TS doesn't narrow away "running" after
    // the early return above — resume() can flip the state.
    const stateAfterResume = ctx.state as string;
    return stateAfterResume !== "running";
  } catch {
    return true;
  } finally {
    void ctx?.close().catch(() => undefined);
  }
}

export default useAutoplayBlocked;

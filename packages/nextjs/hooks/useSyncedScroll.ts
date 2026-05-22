"use client";

import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { PeerMeshState } from "./usePeerMesh";

// Shared scroll-position sync for any scrollable surface on the
// desktop (transcript, chat, notes editor, research, wallet tabs,
// glossary, news, todo, music playlist, chess history, …). One peer
// scrolls, every peer's matching surface follows.
//
// How it works:
//  • Caller passes a stable surface `key` (e.g. "transcript",
//    "wallet:chat", "notes-editor:abc"). The relay broadcasts a
//    `frac` 0..1 keyed by it; every peer applies the same fraction
//    to their own element's `scrollTop`. Per-viewer screen + content
//    sizes are respected — only the *fraction* is multiplayer, not
//    pixel coords. (Same lesson as window-dock position sync.)
//  • Caller passes a `ref` to the scrollable element AND wires the
//    returned `onScroll` into its `onScroll` prop. The hook handles
//    everything else: applying foreign updates, throttling outgoing
//    broadcasts (~150ms), and a 2.5s "detach" grace after a local
//    scroll so a peer reading at their own pace isn't yanked.
//
// Surfaces with their own scroll-aware logic (e.g. chat's
// sticky-to-bottom) can compose by calling the returned onScroll
// inside their own handler.
//
// Same pattern as the older text-preview scroll sync in
// FilePreviewWindow.tsx — generalized so every surface gets it.

const DETACH_MS = 2500;
const THROTTLE_MS = 150;
// Slop for recognizing our own follow-scroll. If the resulting scroll
// event's frac is within this of what we just applied, swallow it so
// we don't echo-broadcast back out.
const FRAC_EPSILON = 0.002;

export function useSyncedScroll<T extends HTMLElement>(
  mesh: PeerMeshState,
  key: string,
  ref: RefObject<T | null>,
): () => void {
  // Frac we most recently applied from a foreign update — lets the
  // scroll handler tell our own follow-scroll apart from a genuine
  // user scroll.
  const lastAppliedFracRef = useRef<number | null>(null);
  // Timestamp of the last genuine user scroll; foreign updates within
  // DETACH_MS are ignored so the reader stays put.
  const lastUserScrollRef = useRef(0);
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBroadcastAtRef = useRef(0);

  const sharedFrac = mesh.scrollSync[key]?.frac;
  const sharedAt = mesh.scrollSync[key]?.at;

  // Apply the room's scroll to our element. Wrapped so both the
  // snapshot-changed effect AND the content-reflowed ResizeObserver
  // can call the same logic.
  const applyShared = useCallback(() => {
    const el = ref.current;
    if (el == null || sharedFrac == null) return;
    if (Date.now() - lastUserScrollRef.current < DETACH_MS) return;
    const range = el.scrollHeight - el.clientHeight;
    if (range <= 0) return;
    const target = sharedFrac * range;
    if (Math.abs(el.scrollTop - target) < 4) return;
    // Record what we're applying so the resulting scroll event is
    // recognized as ours, not re-broadcast as a fresh user scroll.
    lastAppliedFracRef.current = sharedFrac;
    el.scrollTop = target;
  }, [ref, sharedFrac]);

  // Re-apply on any snapshot change. `sharedAt` is in the deps
  // (alongside `sharedFrac`) so a peer re-emitting the same frac
  // — e.g. tapping the same scroll position — still bumps us back
  // into sync after a detach window has elapsed.
  useEffect(() => {
    applyShared();
  }, [applyShared, sharedAt]);

  // Re-apply when the scrollable area resizes — covers the common
  // case of a window opening empty and content streaming in later
  // (transcript / chat / notes editor). Without this, the freshly
  // mounted reader would never catch up to the room's existing
  // position once their content finally lands.
  //
  // The observer holds a ref to the latest applyShared so it's set
  // up exactly once on mount and torn down on unmount — no churn.
  const applyRef = useRef(applyShared);
  applyRef.current = applyShared;
  useEffect(() => {
    const el = ref.current;
    if (el == null) return;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => applyRef.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  // Outgoing scroll handler. Returned so the caller can wire it into
  // their <div onScroll={...}> directly, or compose with their own
  // handler if they already have one (e.g. chat's stick-to-bottom).
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el == null) return;
    const range = el.scrollHeight - el.clientHeight;
    const frac = range > 0 ? el.scrollTop / range : 0;
    // Our own follow-scroll? Swallow it — no echo.
    if (lastAppliedFracRef.current != null && Math.abs(frac - lastAppliedFracRef.current) < FRAC_EPSILON) {
      return;
    }
    // Genuine user scroll → detach + broadcast (throttled).
    lastUserScrollRef.current = Date.now();
    const fire = () => {
      lastBroadcastAtRef.current = Date.now();
      mesh.setScrollSync(key, { frac, at: Date.now() });
    };
    if (throttleRef.current != null) clearTimeout(throttleRef.current);
    const sinceLast = Date.now() - lastBroadcastAtRef.current;
    if (sinceLast >= THROTTLE_MS) {
      fire();
    } else {
      throttleRef.current = setTimeout(fire, THROTTLE_MS - sinceLast);
    }
  }, [mesh, key, ref]);

  // Cleanup any pending throttle on unmount so a delayed broadcast
  // doesn't fire after we've gone.
  useEffect(() => {
    return () => {
      if (throttleRef.current != null) clearTimeout(throttleRef.current);
    };
  }, []);

  return onScroll;
}

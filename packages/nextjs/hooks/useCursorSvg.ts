"use client";

import { useEffect, useState } from "react";
import type { CursorKind } from "./useLocalCursor";

const SRC: Record<CursorKind, string> = {
  pointer: "/cursors/six_finger_pointer_exact_band_masks_no_bleed.svg",
  grab: "/cursors/six_finger_open_grab_dynamic_bands.svg",
  grabbing: "/cursors/six_finger_grabbing_fist_dynamic_bands_clean.svg",
  text: "/cursors/text_cursor_ibeam_clean.svg",
};

export type CursorSvg = { markup: string; viewBox: string };

const cache: Partial<Record<CursorKind, CursorSvg>> = {};
const inflight: Partial<Record<CursorKind, Promise<CursorSvg>>> = {};

/**
 * Pull the viewBox + inner content out of a fetched cursor SVG.
 *
 * - `:root { --band-X: ... }` is stripped so the SVG defaults don't cascade
 *   to <html> when we inline it; the wrapper element provides the per-cursor
 *   band colors via inline style instead.
 * - The outer `<svg>` tags are stripped so the body can be injected via
 *   `dangerouslySetInnerHTML` into a parent `<svg>` element which we control.
 * - The viewBox is read off the original `<svg>` so each cursor renders at
 *   its native aspect ratio (the grabbing fist is 253x372, not 1024x1024).
 */
function processSvg(text: string): CursorSvg {
  const vbMatch = text.match(/<svg[^>]*viewBox=["']([^"']+)["']/i);
  const viewBox = vbMatch ? vbMatch[1] : "0 0 1024 1024";
  let t = text;
  t = t.replace(/:root\s*\{[^}]*\}/g, "");
  t = t.replace(/^[\s\S]*?<svg[^>]*>/, "");
  t = t.replace(/<\/svg>\s*$/, "");
  return { markup: t, viewBox };
}

async function loadOne(kind: CursorKind): Promise<CursorSvg> {
  if (cache[kind]) return cache[kind] as CursorSvg;
  if (inflight[kind]) return inflight[kind] as Promise<CursorSvg>;
  const p = fetch(SRC[kind])
    .then(r => r.text())
    .then(text => {
      const out = processSvg(text);
      cache[kind] = out;
      delete inflight[kind];
      return out;
    });
  inflight[kind] = p;
  return p;
}

/** Eagerly fetch + parse all four cursor SVGs. Idempotent. */
export function preloadCursorSvgs() {
  (Object.keys(SRC) as CursorKind[]).forEach(k => loadOne(k));
}

export function useCursorSvg(kind: CursorKind): CursorSvg | null {
  const [svg, setSvg] = useState<CursorSvg | null>(cache[kind] ?? null);
  useEffect(() => {
    if (cache[kind]) {
      setSvg(cache[kind] as CursorSvg);
      return;
    }
    let cancelled = false;
    loadOne(kind).then(out => {
      if (!cancelled) setSvg(out);
    });
    return () => {
      cancelled = true;
    };
  }, [kind]);
  return svg;
}

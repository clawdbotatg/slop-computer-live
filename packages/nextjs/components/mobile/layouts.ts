// Layout math for MobileStage — pure functions, no React. The stage
// renders a portrait viewport and decides which of 5 hard-coded
// arrangements to use based on what's currently being published. See
// ops/PLAN-mobile-mode.md for the rationale.
//
// Audio-only publishers are first-class tiles — they get the same
// vertical slot as a camera, rendered as avatar + waveform. The
// rationale: a clip with one talking head on cam and a remote guest on
// mic should show BOTH at 50/50, not the cam huge with the mic shoved
// into a footnote pill.
import type { Publication } from "~~/hooks/usePeerMesh";

export type LayoutKind = "idle" | "all-people" | "screen-hero" | "interview" | "panel-w-screen" | "multi-screen";

/** Alternate arrangements the operator can flip through with [ / ].
 *  Each variant either reinterprets the publication set OR layers a
 *  secondary overlay (music ticker, wallet pill) on top of the default
 *  layout. Order matters — it's the cycle order. */
export type LayoutVariant = "default" | "music" | "wallet" | "focus" | "people-only";

export const LAYOUT_VARIANTS: LayoutVariant[] = ["default", "music", "wallet", "focus", "people-only"];

/** Per-tile render dispatch. `video` = live camera frame; `audio` =
 *  audio-only publication OR a camera that flipped cameraOff (render
 *  the avatar instead); `screen` = screen share (letterbox). */
export type TileKind = "video" | "audio" | "screen";

export type Box = {
  /** Publication this box renders. Null only for the `idle` placeholder. */
  pub: Publication | null;
  /** What kind of tile this is — drives the MobileStage render dispatch. */
  kind: TileKind;
  /** Top-left position inside the video area (NOT the viewport). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** `cover` for cameras (fill, crop edges), `contain` for screen shares
   *  (letterbox so demo content survives). Audio tiles ignore this. */
  fit: "cover" | "contain";
};

export type LayoutResult = {
  kind: LayoutKind;
  /** Tiles to draw inside the video area, in render order. */
  boxes: Box[];
  /** Y coordinate (relative to the top of the video area) where the
   *  caption band should sit. Picked to land in the seam between tiles
   *  whenever possible, so words don't cover a talking head's face.
   *  Falls back to the bottom of the video area when there's no seam
   *  (single tile / idle). The band is rendered centered on this Y by
   *  the consumer — not anchored above or below. */
  captionY: number;
};

/** Categorise pubs into screen / video-camera / audio (incl. cameraOff). */
function partition(pubs: Publication[]): {
  screens: Publication[];
  videos: Publication[];
  audios: Publication[];
} {
  const screens = pubs.filter(p => p.kind === "screen");
  const videos = pubs.filter(p => p.kind === "camera" && !p.cameraOff);
  const audios = pubs.filter(p => p.kind === "audio" || (p.kind === "camera" && p.cameraOff));
  return { screens, videos, audios };
}

/** Decide which layout best fits the current publisher set. People
 *  (video cameras + audio publications) are counted together since
 *  each gets an equal stage slot. */
export function pickLayout(pubs: Publication[]): LayoutKind {
  const { screens, videos, audios } = partition(pubs);
  const people = videos.length + audios.length;
  if (screens.length === 0 && people === 0) return "idle";
  if (screens.length === 0) return "all-people";
  if (people === 0) return "screen-hero";
  if (screens.length === 1 && people === 1) return "interview";
  if (screens.length === 1 && people >= 2) return "panel-w-screen";
  return "multi-screen";
}

function boxFor(pub: Publication, x: number, y: number, w: number, h: number): Box {
  const kind: TileKind = pub.kind === "screen" ? "screen" : pub.kind === "audio" || pub.cameraOff ? "audio" : "video";
  return { pub, kind, x, y, width: w, height: h, fit: kind === "screen" ? "contain" : "cover" };
}

/** Filter publications per variant before they enter the layout
 *  dispatcher. Overlays (music/wallet) are pure layering and don't
 *  change the publisher set, so they pass through unchanged. */
function applyVariant(pubs: Publication[], variant: LayoutVariant): Publication[] {
  if (variant === "focus") {
    // Pick the first publisher in canonical order (video > screen > audio).
    // Falls back to the original list if no pubs at all.
    const { videos, screens, audios } = partition(pubs);
    const first = videos[0] ?? screens[0] ?? audios[0];
    return first ? [first] : pubs;
  }
  if (variant === "people-only") {
    return pubs.filter(p => p.kind !== "screen");
  }
  return pubs;
}

/** Compute tile boxes for a given viewport and publisher set. */
export function layoutFor(
  pubs: Publication[],
  videoArea: { width: number; height: number },
  variant: LayoutVariant = "default",
): LayoutResult {
  const filtered = applyVariant(pubs, variant);
  const { screens, videos, audios } = partition(filtered);
  // Video cameras first, then audio publications — keeps a stable
  // visual order across layout changes (a new audio guest doesn't push
  // an existing talking head out of slot 0).
  const people = [...videos, ...audios];

  // Decide the layout based on the FILTERED set so "people-only" picks
  // all-people instead of trying to render a hidden screen.
  const kind = pickLayout(filtered);
  const { width: W, height: H } = videoArea;

  if (kind === "idle") {
    return { kind, boxes: [], captionY: H / 2 };
  }

  if (kind === "all-people") {
    // Equal vertical stack. 1 person → fullscreen; 2 → 50/50; N → 100/N.
    const h = H / people.length;
    // Caption sits at the first seam (between tile 0 and tile 1) so
    // the words don't cover the top talker's face. Single tile has no
    // seam — drop it at the bottom edge instead.
    const captionY = people.length >= 2 ? h : H;
    return {
      kind,
      boxes: people.map((pub, i) => boxFor(pub, 0, i * h, W, h)),
      captionY,
    };
  }

  if (kind === "screen-hero") {
    const h = H / screens.length;
    return {
      kind,
      boxes: screens.map((pub, i) => boxFor(pub, 0, i * h, W, h)),
      captionY: screens.length >= 2 ? h : H,
    };
  }

  if (kind === "interview") {
    // 1 person + 1 screen. Screen is hero, person thumbnail on top.
    const personH = H * 0.25;
    return {
      kind,
      boxes: [boxFor(people[0], 0, 0, W, personH), boxFor(screens[0], 0, personH, W, H - personH)],
      // Seam between the cam strip and the screen — out of the cam,
      // not covering the screen's prime real estate either.
      captionY: personH,
    };
  }

  if (kind === "panel-w-screen") {
    // N people side-by-side top row (30%), screen below (70%).
    const topH = H * 0.3;
    const colW = W / people.length;
    const boxes: Box[] = people.map((pub, i) => boxFor(pub, i * colW, 0, colW, topH));
    boxes.push(boxFor(screens[0], 0, topH, W, H - topH));
    // Seam between cams row and screen.
    return { kind, boxes, captionY: topH };
  }

  // multi-screen: 2+ screens. People strip top (20%), screens stacked
  // in remaining 80%.
  const topH = people.length > 0 ? H * 0.2 : 0;
  const boxes: Box[] = [];
  if (people.length > 0) {
    const colW = W / people.length;
    people.forEach((pub, i) => boxes.push(boxFor(pub, i * colW, 0, colW, topH)));
  }
  const screenH = (H - topH) / screens.length;
  screens.forEach((pub, i) => boxes.push(boxFor(pub, 0, topH + i * screenH, W, screenH)));
  // Seam between the people strip and the first screen. When there's
  // no people strip (audios=0, videos=0, but screens are all that's
  // here — caught by screen-hero above actually) drop to first screen
  // seam.
  const captionY = topH > 0 ? topH : screenH;
  return { kind, boxes, captionY };
}

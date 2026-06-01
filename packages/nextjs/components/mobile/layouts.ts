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
export type LayoutVariant = "default" | "music" | "wallet" | "focus" | "people-only" | "with-apps";

export const LAYOUT_VARIANTS: LayoutVariant[] = ["default", "music", "wallet", "focus", "people-only", "with-apps"];

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

// Synthetic "open-window" pubs wear this streamId prefix (set in
// MobileStage). They look like kind=camera but they're a separate
// tier: they always stack BELOW real people, and they're dropped
// from the default layout when a screen/browser is hero so the
// clip isn't cluttered. Keep in sync with MobileStage.tsx.
const APP_STREAM_PREFIX = "mobile-app-";

/** Categorise pubs into screen / video-camera / audio / app. App
 *  pubs masquerade as kind=camera so the existing layout dispatcher
 *  can route them through the people path, but we split them out
 *  here so callers can control whether they're shown. */
function partition(pubs: Publication[]): {
  screens: Publication[];
  videos: Publication[];
  audios: Publication[];
  apps: Publication[];
} {
  const screens = pubs.filter(p => p.kind === "screen");
  const apps = pubs.filter(p => p.kind === "camera" && p.streamId.startsWith(APP_STREAM_PREFIX));
  const videos = pubs.filter(p => p.kind === "camera" && !p.cameraOff && !p.streamId.startsWith(APP_STREAM_PREFIX));
  const audios = pubs.filter(
    p => p.kind === "audio" || (p.kind === "camera" && p.cameraOff && !p.streamId.startsWith(APP_STREAM_PREFIX)),
  );
  return { screens, videos, audios, apps };
}

/** Decide which layout best fits the current publisher set. People
 *  (video cameras + audio publications) are counted together since
 *  each gets an equal stage slot. */
export function pickLayout(pubs: Publication[]): LayoutKind {
  const { screens, videos, audios, apps } = partition(pubs);
  // Apps count as people for layout decisions IF the caller decided
  // to include them — applyVariant filters them out of `pubs` when
  // they shouldn't appear. Here we trust whatever's in the bucket.
  const people = videos.length + audios.length + apps.length;
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

/** Filter + REORDER publications per variant before they enter the
 *  layout dispatcher. The returned order matters — it's the stack
 *  order tiles will appear in. Apps always trail cams + audios so
 *  talking heads sit on top and the chat/todo/etc. tiles fall to
 *  the bottom. Music/wallet variants are pure overlays — they
 *  follow the default partition rules. */
function applyVariant(pubs: Publication[], variant: LayoutVariant): Publication[] {
  const { videos, audios, apps, screens } = partition(pubs);
  switch (variant) {
    case "focus": {
      // First publisher in canonical order (video > screen > audio > app).
      const first = videos[0] ?? screens[0] ?? audios[0] ?? apps[0];
      return first ? [first] : [];
    }
    case "people-only":
      // Cams + audio + apps, no screens. Apps stay in the people stack
      // (no screen present means the "drop apps when a screen is
      // hero" rule doesn't apply).
      return [...videos, ...audios, ...apps];
    case "with-apps":
      // Everything. Apps included even when a screen/browser is the
      // hero — operator opted in via [ ] cycle.
      return [...videos, ...audios, ...apps, ...screens];
    default: {
      // default / music / wallet (pure overlays): cams + audios
      // always; apps included ONLY when there's no screen/browser
      // competing for hero attention (otherwise clip gets cluttered).
      // Then screens at the end so the layout dispatcher places them
      // as the hero tier.
      const showApps = screens.length === 0;
      return [...videos, ...audios, ...(showApps ? apps : []), ...screens];
    }
  }
}

/** Compute tile boxes for a given viewport and publisher set. */
export function layoutFor(
  pubs: Publication[],
  videoArea: { width: number; height: number },
  variant: LayoutVariant = "default",
): LayoutResult {
  const filtered = applyVariant(pubs, variant);
  const { screens, videos, audios, apps } = partition(filtered);
  // Stack order: real cams → audio publications → open-window apps.
  // Apps always trail so talking heads sit on top and chat/todo/etc.
  // tiles fall to the bottom of the people stack. Inclusion of apps
  // is already decided by applyVariant — if it didn't put them in
  // `filtered`, the apps bucket here is empty.
  const people = [...videos, ...audios, ...apps];

  // Decide the layout based on the FILTERED set so "people-only" picks
  // all-people instead of trying to render a hidden screen.
  const kind = pickLayout(filtered);
  const { width: W, height: H } = videoArea;

  if (kind === "idle") {
    return { kind, boxes: [], captionY: H / 2 };
  }

  // Single-tile cap: when only one publisher is on the stage, don't
  // let the tile fill the entire video area. That used to push the
  // caption chip off the bottom of the viewport and left zero room for
  // the desktop-icon backdrop to peek through. Cap at the smaller of
  // 60% of available height OR a 16:9 frame at viewport width, so
  // both portrait phones and squat OBS windows look sane.
  const singleTileH = Math.min(H * 0.6, (W * 9) / 16);

  // For the single-tile case we also center the tile vertically so the
  // icon backdrop peeks through ABOVE and below — "tiny floating
  // video on the desktop" vibe. yOffset is 0 for stacks (tile 0 at
  // the top), recentred for the single-tile case.
  if (kind === "all-people") {
    const single = people.length === 1;
    const h = single ? singleTileH : H / people.length;
    const yOffset = single ? (H - h) / 2 : 0;
    const captionY = yOffset + h;
    return {
      kind,
      boxes: people.map((pub, i) => boxFor(pub, 0, yOffset + i * h, W, h)),
      captionY,
    };
  }

  if (kind === "screen-hero") {
    const single = screens.length === 1;
    const h = single ? singleTileH : H / screens.length;
    const yOffset = single ? (H - h) / 2 : 0;
    return {
      kind,
      boxes: screens.map((pub, i) => boxFor(pub, 0, yOffset + i * h, W, h)),
      captionY: yOffset + h,
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

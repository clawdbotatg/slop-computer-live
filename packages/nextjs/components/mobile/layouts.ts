// Layout math for MobileStage — pure functions, no React. The stage
// renders a portrait viewport and decides which of 5 hard-coded
// arrangements to use based on what's currently being published. See
// ops/PLAN-mobile-mode.md for the rationale.
import type { Publication } from "~~/hooks/usePeerMesh";

export type LayoutKind = "idle" | "all-cameras" | "screen-hero" | "interview" | "panel-w-screen" | "multi-screen";

export type Box = {
  /** Publication this box renders. Null only for the `idle` placeholder. */
  pub: Publication | null;
  /** Top-left position inside the video area (NOT the viewport). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** `cover` cameras (fill, crop), `contain` screens (letterbox demos). */
  fit: "cover" | "contain";
};

export type LayoutResult = {
  kind: LayoutKind;
  /** Tiles to draw inside the video area. */
  boxes: Box[];
  /** Audio-only publishers that get attribution pills below the video
   *  area. Not rendered as tiles. */
  audioOnly: Publication[];
};

/** Decide which layout best fits the current publisher set. */
export function pickLayout(pubs: Publication[]): LayoutKind {
  const screens = pubs.filter(p => p.kind === "screen").length;
  // Audio-only treated as audioOnly publication kind === "audio", OR a
  // camera publication that flipped cameraOff (publisher dropped video
  // but kept mic). The cameraOff case still has a stream we COULD show
  // (it'd be a blank video + avatar), but for clip layout we route them
  // into the audio-pill row instead so video tiles only show actual faces.
  const videos = pubs.filter(p => p.kind === "camera" && !p.cameraOff).length;
  if (screens === 0 && videos === 0) return "idle";
  if (screens === 0) return "all-cameras";
  if (videos === 0) return "screen-hero";
  if (screens === 1 && videos === 1) return "interview";
  if (screens === 1 && videos >= 2) return "panel-w-screen";
  return "multi-screen";
}

/** Compute tile boxes for a given viewport and publisher set. */
export function layoutFor(pubs: Publication[], videoArea: { width: number; height: number }): LayoutResult {
  const cameras = pubs.filter(p => p.kind === "camera" && !p.cameraOff);
  const screens = pubs.filter(p => p.kind === "screen");
  const audioOnly = pubs.filter(p => p.kind === "audio" || (p.kind === "camera" && p.cameraOff));

  const kind = pickLayout(pubs);
  const { width: W, height: H } = videoArea;

  if (kind === "idle") {
    return { kind, boxes: [], audioOnly };
  }

  if (kind === "all-cameras") {
    // Vertical stack, equal heights. 4+ cams still all visible, just smaller.
    const h = H / cameras.length;
    const boxes: Box[] = cameras.map((pub, i) => ({
      pub,
      x: 0,
      y: i * h,
      width: W,
      height: h,
      fit: "cover",
    }));
    return { kind, boxes, audioOnly };
  }

  if (kind === "screen-hero") {
    // Screens stacked vertically, full-width. Letterbox each.
    const h = H / screens.length;
    const boxes: Box[] = screens.map((pub, i) => ({
      pub,
      x: 0,
      y: i * h,
      width: W,
      height: h,
      fit: "contain",
    }));
    return { kind, boxes, audioOnly };
  }

  if (kind === "interview") {
    // 1 cam + 1 screen. Screen is the hero, cam thumb on top (25/75).
    const camH = H * 0.25;
    const boxes: Box[] = [
      { pub: cameras[0], x: 0, y: 0, width: W, height: camH, fit: "cover" },
      { pub: screens[0], x: 0, y: camH, width: W, height: H - camH, fit: "contain" },
    ];
    return { kind, boxes, audioOnly };
  }

  if (kind === "panel-w-screen") {
    // N cams side-by-side top row (30%), screen below (70%).
    const topH = H * 0.3;
    const colW = W / cameras.length;
    const boxes: Box[] = cameras.map((pub, i) => ({
      pub,
      x: i * colW,
      y: 0,
      width: colW,
      height: topH,
      fit: "cover",
    }));
    boxes.push({
      pub: screens[0],
      x: 0,
      y: topH,
      width: W,
      height: H - topH,
      fit: "contain",
    });
    return { kind, boxes, audioOnly };
  }

  // multi-screen: 2+ screens. Cams horizontal strip top (20%), screens
  // stacked in remaining 80%.
  const topH = cameras.length > 0 ? H * 0.2 : 0;
  const boxes: Box[] = [];
  if (cameras.length > 0) {
    const colW = W / cameras.length;
    cameras.forEach((pub, i) => {
      boxes.push({
        pub,
        x: i * colW,
        y: 0,
        width: colW,
        height: topH,
        fit: "cover",
      });
    });
  }
  const screenH = (H - topH) / screens.length;
  screens.forEach((pub, i) => {
    boxes.push({
      pub,
      x: 0,
      y: topH + i * screenH,
      width: W,
      height: screenH,
      fit: "contain",
    });
  });
  return { kind, boxes, audioOnly };
}

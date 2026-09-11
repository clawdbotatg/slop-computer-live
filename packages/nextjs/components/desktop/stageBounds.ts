// The shared frame every peer is guaranteed to see: the live-stream
// (god-mode / OBS) viewport that the dashed guide draws, falling back to
// the 1920×1080 OBS target when no spectator is live — the same rule the
// "Arrange for X" layouts use in Desktop.tsx.
//
// Window restore placement clamps to it. The host's own screen is often
// TALLER than a guest's (or than the streamed frame), and every
// un-minimize path that has no saved rect — pull a pill up, click a pill
// after a reload / keyboard minimize, double-click the app icon — used to
// place the re-inflated window against the HOST's bottom edge. On a tall
// display that is below a guest's viewport, so the guest saw the pill
// disappear and nothing come back ("I minimized it and brought it back
// and the guest can't see it any more").
export type StageBounds = { width: number; height: number };

export const DEFAULT_STAGE: StageBounds = { width: 1920, height: 1080 };

export const stageBoundsFor = (godViewport: StageBounds | null | undefined): StageBounds =>
  godViewport ?? DEFAULT_STAGE;

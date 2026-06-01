import { HEADLINES_HEIGHT } from "./HeadlinesBar";
import { TICKER_HEIGHT } from "./TickerBar";
import { TIMELINE_HEIGHT } from "./TimelineBar";

// Combined height of the always-present bottom bar stack — timeline (top),
// headlines (middle), ticker (bottom) — each `position: fixed` and pinned
// to bottom:52 / bottom:28 / bottom:0 at zIndex 60. A minimized window's
// docked "pill" must sit ABOVE this stack; docked flush to the viewport
// bottom (as it was) it renders behind the opaque ticker (z 60 > slot z)
// and vanishes. ChyronBar's STACK_BOTTOM is the same number — the chyron
// stacks directly on top of these three bars.
export const BOTTOM_BAR_STACK_HEIGHT = TICKER_HEIGHT + HEADLINES_HEIGHT + TIMELINE_HEIGHT;

import { HEADLINES_HEIGHT } from "./HeadlinesBar";
import { TICKER_HEIGHT } from "./TickerBar";
import { TIMELINE_HEIGHT } from "./TimelineBar";
import { TITLEBAR_HEIGHT } from "~~/components/ui/Window";

// Combined height of the always-present bottom bar stack — timeline (top),
// headlines (middle), ticker (bottom) — each `position: fixed` and pinned
// to bottom:52 / bottom:28 / bottom:0 at zIndex 60. ChyronBar's
// STACK_BOTTOM is the same number — the chyron stacks directly on top of
// these three bars.
export const BOTTOM_BAR_STACK_HEIGHT = TICKER_HEIGHT + HEADLINES_HEIGHT + TIMELINE_HEIGHT;

// z-index of the three bars above (each hardcodes 60 in its own file).
// Passed to Window's dockUnderZ so a docked pill caps its z just below the
// bars and the tucked portion genuinely hides behind them — slot z grows
// unboundedly with focus clicks, so without the cap a long session ends
// with pills painting on top of the ticker.
export const BOTTOM_BAR_Z = 60;

// A minimized window's docked "pill" tucks BEHIND the bar stack with only
// this much of its 36px titlebar peeking above the stack's top edge — the
// "sheet sticking out from behind the ticker" look. The sliver is the
// click/drag target for restore, so keep it big enough to hit. (The pill
// previously rested fully ABOVE the stack, which read as floating over the
// ticker; before that it docked flush to the viewport bottom and vanished
// behind the opaque bars entirely. This is the middle ground.)
export const DOCK_PILL_PEEK = 16;

// What the slop desktop passes as Window's dockBottomInset (gap from the
// viewport bottom to the pill's bottom edge): the pill overlaps the stack
// by (TITLEBAR_HEIGHT - PEEK) px — hidden behind the ~opaque timeline bar
// — leaving PEEK px visible above the stack's top edge.
export const DOCKED_PILL_BOTTOM_INSET = BOTTOM_BAR_STACK_HEIGHT - (TITLEBAR_HEIGHT - DOCK_PILL_PEEK);

// Plain left-click without modifiers should be intercepted and routed
// into the shared slop-desktop browser. Cmd / Ctrl / Shift / Alt fall
// through to the normal anchor behavior (real new tab) so users keep
// their usual escape hatch. Middle-click fires `auxclick`, not
// `click`, so it's naturally exempt.
export function shouldInterceptClick(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
}

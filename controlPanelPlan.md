# control panel plan

Browsers require a fresh user click for `getDisplayMedia`, so reloading
the main desktop loses screen share. Same for camera permission in some
private modes. Solution: separate the **publisher** from the **viewer**.

## Idea

A small popup window (`/control` route, opened via `window.open`) is the
ONLY thing that calls `getUserMedia` / `getDisplayMedia`. It maintains
its own WebRTC peer connections to the relay and publishes the streams
on the user's behalf. It stays open as long as the user wants to be
"on the show".

The main `/desktop` page is just a viewer/compositor: connects to the
relay, reads `publications`, renders windows. Reloading it does not
touch any MediaStream — the popup is still publishing. The reloaded
desktop just re-subscribes to the relay's snapshot and the streams flow
back via the still-open peer connections.

## What the user sees

- Sign in on `/admin` or `/join`.
- Click "Open control panel" → small popup (~400×500) titled
  "Slop Control Panel".
- Inside the popup:
  - Start camera / Stop camera
  - Start screen share / Stop screen share
  - Mute mic
  - Status: "publishing 2 streams to slop.computer"
  - Close button warns: "this will end your share"
- Main desktop tab can now be closed/reloaded freely. The popup stays.

## Implementation sketch

### New route `/control` (Next.js page)
- Tiny UI: 4 buttons, small status text.
- Uses the same `usePeerMesh` hook — gets its own peerId, opens its own
  WebRTC connections, publishes its own streams.
- Persists "I am the publisher for owner-XYZ" in `localStorage` so the
  main desktop can detect that a control panel exists.

### Multi-peer same-owner
- Currently each tab is a separate peer. The control panel and the main
  desktop tab would both appear in `peers`, both with the same wallet
  address. That's fine — they're effectively two browser sessions for
  the same user.
- The control panel publishes; the main desktop does not. Both render
  the same shared windows.

### Window open / close behavior
- "Open control panel" button on `/admin` (and `/join`?) calls
  `window.open('/control', 'slop-control', 'width=420,height=540,...')`.
- The opener's `useEffect` watches for the popup; if the popup closes
  unexpectedly, show a "control panel disconnected" toast in the menu
  bar.
- The popup, on close, calls unpublish for any active streams (so the
  shared windows vanish for everyone).

### Reload semantics
- Main desktop reloads: streams keep flowing because the popup's PCs
  are unchanged. Slot positions still load from the relay.
- Control panel reloads: ALL streams die. (Tradeoff. We tell the user
  not to reload that one.) Could add "re-acquire" buttons here too.

### Cross-tab pitfalls
- `BroadcastChannel('slop-control')` between popup and desktop so they
  can coordinate: e.g. desktop tells popup "go ahead and start camera"
  if user clicks a button on desktop instead of popup.
- Or just keep all controls in the popup for v1.

## Why not just auto-resume?

Browser security. `getDisplayMedia` MUST be triggered by a fresh user
gesture. There's no way around it for screen share. Camera is
auto-resume-able but inconsistent across browsers and exposes the user
to "permission persistence" criticism.

The popup approach uses the browser's own session model — popups
persist independently of their opener — to keep the publish session
alive across opener reloads.

## Out-of-scope

- Picture-in-picture for control panel (could be cool but adds complexity).
- Native desktop "control center" app (would require Electron).

## When to build

Not now. Capture the idea here and revisit once the show has actually
gone live a few times and we know whether the reload pain shows up in
practice.

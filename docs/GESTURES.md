# Hand gestures — "the eye" (2026-08-31, controls + strict fist 2026-09-08)

Hand gestures made on camera trigger drawn effects (lobster claw, spinning
eth, the slop computer logo) rendered live on every screen in the room and
on the broadcast. **Anyone visible on the show can trigger them — host and
guests — with zero setup on their end.** This doc is the complete handoff:
architecture, operations, debugging, tuning, and the design history that
must not be relitigated.

## The mental model (read this before touching anything)

A gesture is an **observation of the show**, not a message from a user
account. Three architectures failed before this one because they treated
gestures as authenticated user actions (see History). The shipped design
puts one detector where the whole show is visible and lets the relay figure
out whose hands are whose. Nothing is configured per user, per room, or per
show.

## The pipeline

```
 guests' + host's cameras (WebRTC, normal room windows)
        │
        ▼
 👁 "eye" window — god machine; run-show.sh opens it (same URL + &fx=0,
   same bounds as the god window, behind it), or the 👁 menu-bar button
   live.slop.computer/<slug>?fx=0  (god-mode session)
   · renders NO gesture layer (no feedback loop)
   · renders its OWN stage (EyeStage.tsx): every live camera, uncropped,
     as large as the viewport allows, on top of the desktop. The stream's
     layout is irrelevant to detection — see "Why the eye has its own
     layout" below
   · never runs the viewport-resize slot clamp (a smaller eye used to
     shove windows around on the stream)
   · titles itself SLOP-EYE (reasserted 1/s — page rewrites titles)
   · reports eye_geometry over its WS every 500ms:
       viewport + each eye tile's <video> rect + videoWidth/Height
        │ (captured as pixels)
        ▼
 slop-detector — native Swift, launchd agent on the god machine
   (slop-computer-background/slop-detector.swift)
   · ScreenCaptureKit captures any Chrome window titled SLOP-EYE (10fps)
   · Apple Vision hand-pose, up to 6 hands, MediaPipe landmark order
   · POST https://live.slop.computer/v1/hands   (no slug!)
       body {hands:[{chirality,lm:[[x,y]x21]}], w, h}   (capture px dims)
       header X-Gesture-Key: <god password>
        │
        ▼
 relay GestureEngine (packages/relay/src/gestures.ts, wired in index.ts)
   · slug-less hands route to whichever room has the freshest eye_geometry
     (exactly one eye exists; ?slug= still forces a room)
   · capture px → eye CSS px (ratio = capW/vw; extra height = title bar)
   · hand's palm center inside a camera rect → that peer owns the gesture
   · invert object-fit:cover → normalized in-frame coords → virtual
     1280x720 "frame space" (so px-tuned thresholds keep meaning)
   · classifier + state machine ported from the old OBS foreground:
       fist ✊ → eth releases every 150ms — after a 300ms hold, and only
         when all four fingers are clearly curled (see "Fist strictness")
       horns 🤘 → eth held on the hand
       claw 🦞 (thumb+index+middle, signed thumb-out > 0.10) → held claw,
         jaw opens with thumb-index pinch
       two Ls 📐 in the SAME camera window → the slop computer logo
       heart 🫶 (two hands, SAME window: index tips together on top, thumb
         tips together below, palms apart — geometric test on the tips, not
         per-hand poses; palm-apart check rejects prayer hands) → held
         heart + little hearts stream out the top; on release the big
         heart floats away. Relay-only — no OBS-foreground original.
       everything else → nothing; every pose needs stability before it
       fires (hold-to-activate): 150ms for horns/claw/L, 300ms for a fist
   · ✋ switch: a person with gestures OFF is dropped right here (their
     holds/releases never leave the relay) — see "Controls" below
   · broadcasts gesture_hold (~10Hz while held) / gesture_release (+seed)
     with from=<peerId>, x/y/s normalized to that peer's camera frame
        │
        ▼
 every client's GestureLayer (packages/nextjs/components/ui/GestureLayer.tsx)
   · held gestures render LIVE at the hand on the sender's camera window
     (position smoothed between updates; sized to the window)
   · release → eth/claw fly outward from screen center through the launch
     point (seeded, deterministic per client); computer logo zooms "at"
     the screen (grows ~4.5x, fades, <1s); hearts rise with a sideways
     sway and fade (~3.2s)
   · sender's camera window closed/docked/camera-off → nothing renders
   · canvas sits just under the cursor layer, pointer-events:none
   · god mode renders it too → that's what puts effects on the stream —
     EXCEPT while the god operator is in the green room: the layer is not
     mounted on god-mode views then, so nothing flies over the standby card.
     Participants in the real room still see each other's effects backstage
```

## Controls (2026-09-08)

**The ✋ switch** — every camera window has a hand button in its top-right
control row. Default is ON for everyone (fun first). Click it and that
person's gestures stop: the relay's engine drops their holds/releases at the
source, so nothing renders anywhere, stream included. Who can flip whose:

- the person themself (any of their tabs — it's keyed by owner key, not
  peer id, so a reload doesn't turn it back on);
- the host (slop.atg.eth, or any admin address running as host);
- god mode (the streaming box / operator monitor).

Everyone else sees a dimmed ✋ on that window only while it's off — so a
guest whose eth stopped flying can see why. State lives on the relay per
room (`Room.gesturesOff`, persisted to `gestures-off.json` so a deploy
doesn't silently unmute anyone), reaches clients in `hello.gesturesOff[]`
and `gestures_off {ownerKey, off}`; the verb is `set_gestures_off {ownerKey,
off}` (relay rejects anyone but self/host/spectator with `forbidden`).

**Green room** — god-mode views don't mount the GestureLayer while
`greenRoom` is on (same gate the peer cursors use in `Desktop.tsx`).
Detection keeps running (the eye is unaffected), and normal participants
still see effects among themselves backstage; the stream sees a clean
standby card. Nothing is buffered — when the curtain lifts, only new
gestures render.

**Fist strictness** — two changes in `gestures.ts`, after a show where eth
flew off a guest's neck/shoulder (Vision's hand-pose hallucinates a "hand"
there for a frame or two, and a fist used to fire on frame one):

- `isFist()`: all four fingertips must sit inside `FIST_CURL` (0.85) × their
  own PIP-to-wrist distance. The old rule was "≤ 1 finger extended" — a thumb
  out, a half-curled hand, or a mis-tracked blob all read as a fist. Those
  are "none" now; only `isFist()` makes a fist.
- `FIST_HOLD_MS` 300: a fist has to survive three consecutive detector frames
  (10fps) before the first eth. Other poses keep `HOLD_MS` 150. A fist that
  flickers away for a frame restarts its hold.

`gestures.test.ts` pins all of this and is the working synthetic-hands
recipe (a 21-point hand builder with per-finger curl).

## Why the eye has its own layout (2026-09-03)

Before EyeStage the eye rendered the shared desktop at a fixed 1280×760
popup while the god window ran ~1706×958. Same absolute-px layout, smaller
viewport: the camera tile hung off the eye's right/bottom edge and hands
there simply didn't exist to the detector. Worse, the eye also ran the
slot clamp on load, which pulled off-screen windows back in — and broadcast
that to everyone, moving windows on the live stream.

None of that was necessary. The relay normalizes every hand to the
sender's *video frame* (inverting object-fit:cover on the rect the eye
reports), and every viewer re-projects frame coords onto *its own* camera
window. So the eye's layout only has to be good for detection: each tile
sized to the video's aspect (cover crops nothing), as big as fits. A hand
now gets a viewport-sized tile instead of a 440px window, nothing can be
off-screen, and stream layout changes can't affect detection. One
trade-off: a hand in a region the stream's tile crops out renders its
effect just outside that tile.

Don't "zoom out" the eye instead: browser zoom shrinks its CSS viewport,
and the relay assumes capture-px / CSS-px is only the display DPR.

## Operations

**One-time install (god machine, in its own Terminal — never plain ssh):**
```
git clone https://github.com/clawdbotatg/slop-computer-background
cd slop-computer-background && ./slop-eye-install.sh
```
Prompts for the god password (→ gitignored `.slop-eye.env`), builds the
detector, triggers the macOS Screen Recording prompt (must be approved by a
human, which is why ssh won't do), installs
`~/Library/LaunchAgents/com.slop.eye.plist` (KeepAlive, logs to
`/tmp/slop-eye-detector.log`). The detector then idles forever printing
"no match yet" until an eye window exists.

**Per show (god machine):** `run-show.sh '<show url>'` in clawd-slop-obs
opens the eye itself (same Chrome, same bounds as the god window, stacked
behind it, Chrome launched with occlusion flags so it keeps painting) and
ends by POSTing an empty hands frame to `/v1/hands` and logging the eye
viewport + camera rects the relay sees. Fallback: click **👁** in the
god-mode menu bar (opens the eye at the god window's viewport size).
The relay follows the eye to whatever room it's open in.

**Kill switch (mid-show, zero stream impact):** close the 👁 window.
Detector loses its target, engine's stale sweep (700ms) releases any held
effects, done. Nuclear: `launchctl unload ~/Library/LaunchAgents/com.slop.eye.plist`.

**Single-machine / manual alternative:** `slop-eye.sh '<room-url-with-invite>'`
in slop-computer-background opens a dedicated eye Chrome
(`~/.slop-eye-chrome`, occlusion-throttling flags) + a detector aimed at it
with an explicit ?slug. Used for testing without the god machine.

## Debugging

- `/v1/hands` (god-key-authed) **echoes the geometry** the engine is
  mapping against: `{vw, vh, ageMs, cams:[{peerId, rect, videoW, videoH}]}`.
  "no eye open anywhere" = no fresh eye_geometry in any room (eye window
  closed, or its WS died). "no eye geometry yet" (with ?slug) = eye page
  loaded but not reporting — check it got past the room gate.
- Logs: `/tmp/slop-eye-detector.log` (detector: "Capturing: …",
  "hands: N" once/sec, "no match yet" loop), `/tmp/slop-eye-chrome.log`.
- **Synthetic hands** let you test everything without a camera or detector:
  POST a fake fist positioned over a camera rect, at least twice ≥300ms
  apart (a fist needs the hold now; a real empty frame in between resets
  it). Working recipe: the `hand()` builder in
  `packages/relay/src/gestures.test.ts` — 21 `[x,y]` normalized to the
  capture, every fingertip well inside its PIP's wrist radius. Watch broadcasts by opening a WS to `/signal?slug=<room>` with a
  room-authed session and filtering `type.startsWith('gesture')`.
- Client side: `window.__slopGestures` (in any room tab) = `{live, flights,
  drawnAt}` updated per animation frame.
- **Testing trap:** a hidden/occluded Chrome tab freezes
  requestAnimationFrame — the GestureLayer never draws there and
  screenshots show nothing even when everything works. Check
  `document.visibilityState` before trusting a "nothing renders" result.

## Tuning knobs

- `gestures.ts`: HOLD_MS 150 (accidental-trigger guard, non-fist poses),
  FIST_HOLD_MS 300 + FIST_CURL 0.85 (fist strictness — raise/lower these
  first when a show reports false eth or a fist that won't fire),
  EMIT_INTERVAL 150 (fist eth cadence), FRAME_HOLD_MS 200, THUMB_OUT 0.10
  (claw vs peace), HANDS_STALE_MS 700, maximumHandCount 6 (detector).
- `GestureLayer.tsx`: sizes are `s × displayed-video-height` (eth ×0.5);
  outward flight speed 0.10–0.22 viewport-widths/s; COMPUTER_LIFE_MS 900;
  SMOOTH_RATE 14 (hold tracking chase).
- Detector FPS 10 (slop-detector.swift) — raise for snappier holds at CPU
  cost.

## Known limits

- Detection quality scales with the camera window's on-screen size — a
  guest in a tiny window detects worse than the host in a big one.
- Guest hold-effects trail their hands ~300ms (their video must reach the
  god machine first). Invisible on releases.
- The eye is a god-mode session: its presence counts toward the room's
  spectator-presence logic (stream-active), same as the real god window.
- Legacy path: the relay still accepts gesture_hold/release over a live
  peer's WS (from the abandoned session-transport iteration). Unused;
  harmless; a per-peer rate limit is the TODO if it's ever kept.

## History — do NOT regress into these (each failed in production)

1. **Room-scoped agent tokens + HTTP POST from the rig** (`/v1/gesture`,
   deleted): 7-day per-room tokens, an `anchor` identity in env. Broke the
   moment Austin changed rooms or identities (he runs shows as
   slop.atg.eth, NOT austingriffith.eth — anchoring to the wrong one
   silently rendered nothing).
2. **Page reads detector via localhost** (`useRigGestures`, deleted):
   Chrome's Local Network Access permission blocks public-site→localhost
   with a scary per-profile prompt (`slop-server.py` still answers the
   PNA/CORS preflights, harmlessly). Also only ever covered one person.
3. **Permanent "stream key" on the rig**: fixed the token pain but still
   modeled gestures as one user's messages — guests would have needed a
   phase 2 that the eye makes unnecessary.

Rebuild caution: recompiling slop-detector.swift changes its signature and
macOS silently revokes Screen Recording — every rebuild needs a human
re-approval on that machine. Don't rebuild the night of a show.

## Files

- slop-computer-live: `packages/relay/src/gestures.ts` (engine) +
  `gestures.test.ts`, `room.ts` (gesturesOff set, persisted),
  `index.ts` (/v1/hands, eye_geometry + set_gestures_off WS cases, the
  ✋ filter in `gestureEngineFor`, spectator allow-list),
  `VideoView.tsx` (the ✋ button),
  `packages/nextjs/components/ui/GestureLayer.tsx` (renderer),
  `usePeerMesh.ts` (gesture/liveGesture state, eye_geometry sender),
  `Desktop.tsx` (👁 button, fx=0/isEye behavior, eye reporter),
  `MenuBar.tsx` (👁), `public/gesture-computer.png`.
- slop-computer-background: `slop-detector.swift`, `slop-eye-install.sh`,
  `slop-eye.sh`, `.slop-eye.env` (gitignored, god password). The old
  foreground.html/background.html OBS overlay is retired but kept as the
  classifier's reference implementation.

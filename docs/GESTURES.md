# Hand gestures — "the eye" (2026-08-31)

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
 👁 "eye" window — god machine, opened by the 👁 menu-bar button
   live.slop.computer/<slug>?fx=0  (god-mode session, popup)
   · renders the room WITHOUT the gesture layer (no feedback loop)
   · titles itself SLOP-EYE (reasserted 1/s — page rewrites titles)
   · reports eye_geometry over its WS every 500ms:
       viewport + each camera window's <video> rect + videoWidth/Height
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
       fist ✊ → eth releases every 150ms (fires instantly)
       horns 🤘 → eth held on the hand
       claw 🦞 (thumb+index+middle, signed thumb-out > 0.10) → held claw,
         jaw opens with thumb-index pinch
       two Ls 📐 in the SAME camera window → the slop computer logo
       heart 🫶 (two hands, SAME window: index tips together on top, thumb
         tips together below, palms apart — geometric test on the tips, not
         per-hand poses; palm-apart check rejects prayer hands) → held
         heart + little hearts stream out the top; on release the big
         heart floats away. Relay-only — no OBS-foreground original.
       everything else → nothing; non-fist poses need 150ms stability
       (hold-to-activate) before firing
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
   · god mode renders it too → that's what puts effects on the stream
```

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

**Per show (god machine):** click **👁** in the god-mode menu bar (next to
🔊). Keep the eye window at least partially visible — a fully occluded
Chrome window can stop painting and the capture goes stale. That's the
whole ritual; the relay follows the eye to whatever room it's open in.

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
  POST a fake fist positioned over a camera rect (fist fires instantly, so
  interleaved real empty frames can't suppress it). Working recipe in the
  session that built this; shape: 21 `[x,y]` normalized to the capture, all
  fingertips closer to the wrist than their PIPs, thumb tip on the palm
  axis. Watch broadcasts by opening a WS to `/signal?slug=<room>` with a
  room-authed session and filtering `type.startsWith('gesture')`.
- Client side: `window.__slopGestures` (in any room tab) = `{live, flights,
  drawnAt}` updated per animation frame.
- **Testing trap:** a hidden/occluded Chrome tab freezes
  requestAnimationFrame — the GestureLayer never draws there and
  screenshots show nothing even when everything works. Check
  `document.visibilityState` before trusting a "nothing renders" result.

## Tuning knobs

- `gestures.ts`: HOLD_MS 150 (accidental-trigger guard), EMIT_INTERVAL 150
  (fist eth cadence), FRAME_HOLD_MS 200, THUMB_OUT 0.10 (claw vs peace),
  HANDS_STALE_MS 700, maximumHandCount 6 (detector).
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

- slop-computer-live: `packages/relay/src/gestures.ts` (engine),
  `index.ts` (/v1/hands, eye_geometry WS case, spectator allow-list),
  `packages/nextjs/components/ui/GestureLayer.tsx` (renderer),
  `usePeerMesh.ts` (gesture/liveGesture state, eye_geometry sender),
  `Desktop.tsx` (👁 button, fx=0/isEye behavior, eye reporter),
  `MenuBar.tsx` (👁), `public/gesture-computer.png`.
- slop-computer-background: `slop-detector.swift`, `slop-eye-install.sh`,
  `slop-eye.sh`, `.slop-eye.env` (gitignored, god password). The old
  foreground.html/background.html OBS overlay is retired but kept as the
  classifier's reference implementation.

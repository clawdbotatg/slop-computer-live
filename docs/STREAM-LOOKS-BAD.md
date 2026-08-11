# The stream looks bad — start here

Symptom-keyed runbook. If Austin says *"my video looks like shit on the
stream"*, read this file **before** touching any code, and before asking
him to run anything.

Companion docs: [`VIDEO-QUALITY.md`](VIDEO-QUALITY.md) (encoder tiering,
the `degradationPreference` trap, ffmpeg forensics on a recording),
[`BROADCAST-AUDIO-ROUTING.md`](BROADCAST-AUDIO-ROUTING.md) (a voice
missing entirely), [`AUDIO-LEVELING.md`](AUDIO-LEVELING.md) (levels).

---

## The bar

These are the expectations. Anything short of this is a bug, not a
tuning opportunity.

1. He goes live and it looks great. **No fiddling, no settings, no
   pre-flight.**
2. **The hardware is never the excuse.** A dedicated 24 GB interface
   machine, a second machine doing nothing but OBS, a Sony a6400 through
   a Cam Link 4K. If the picture is bad, our software is wrong.
3. **Screen sharing must work.** "Don't screen share" is a workaround,
   not a fix.
4. **He never debugs during a show.** Reading `/eq` numbers aloud mid
   broadcast is itself the failure.
5. **When it breaks: read this file and fix it.** Do not re-derive the
   chain, do not re-run experiments already recorded here, do not make
   him re-explain his own rig.
6. **Answers are short.** He has said so repeatedly. Lead with the fix.
7. **It stays fixed.** See "Regression traps" at the bottom.

---

## The chain (this is the whole map)

Every arrow is a place quality can be lost. Most bad-looking shows are
lost in the **first three**, not on the network.

```
Sony a6400
   └─ HDMI, fixed frame rate set in the CAMERA menu (24p/30p/60p)
        └─ Cam Link 4K (USB 3.0 — a USB 2 port or hub drops frames)
             └─ OBS "Rig2" profile, canvas resolution  ← was 1280x720
                  └─ OBS Virtual Camera  (outputs the CANVAS size)
                       └─ Chrome getUserMedia, app camera-res pref  ← default was 854x480
                            └─ WebRTC encoder, per-peer caps (usePeerMesh.ts)
                                 └─ FULL MESH: one encode per recipient
                                      └─ building uplink (shared with OBS's RTMP push)
                                           └─ clawd-gut (god mode) renders composite
                                                └─ OBS on clawd-gut → 1920x1080 → viewers
```

**Two consequences that keep getting missed:**

- **The local preview proves nothing.** What Austin sees on his own
  screen is the raw DSLR feed and will *always* look stunning. The only
  number that matters is the `in` line on `/eq` at the god-mode machine.
- **clawd-gut can only show what the interface machine sends it.** If
  the mesh delivers 480p, the composite upscales it into a 1080p canvas
  — 5× the pixel area invented from nothing. That is the "mush". No
  change on clawd-gut can fix it.

---

## First: read `/eq` on the god-mode machine

Ask for a paste of the whole video section. It answers everything.

| Line | Healthy | What it means if not |
|---|---|---|
| `composite` | ~30 fps, worst < 50ms, no `TAB HIDDEN` | god-mode machine is stalling — **not** a feed problem. Chrome throttles a hidden/occluded tab to ~0. |
| per-feed `in` resolution | 1280×720 or better | this is literally what the broadcast has to work with |
| per-feed `in` fps | ~30 | below 30 with no badge → **source** framerate (camera menu), not network |
| `CPU` badge | absent | encoder starved — usually the screen share, one encode per peer |
| `NET` badge | absent | bandwidth/loss limited — uplink, or the mesh tax |
| `TURN` badge | absent | media is being relayed instead of peer-to-peer |
| `stream` row | 1920×1080, 30fps, `drop` not climbing | `drop` climbing = clawd-gut's uplink to prod is congested |

**The single most diagnostic comparison:** put Austin's row next to a
remote guest's row. On 2026-08-10 they were at *identical bitrate* —
`731k` vs `737k` — and the guest turned it into `854×480 @ 30fps` while
Austin got `318×180 @ 13fps`. Same bits, 7× the pixels. That instantly
ruled out bandwidth and pointed at the source chain.

---

## Ruled out — do not re-investigate without new evidence

Each of these cost real time. They are settled.

| Theory | Verdict | Evidence |
|---|---|---|
| Prod box (AWS) is overloaded | **No** | load 0.27, all services active, during a bad show |
| clawd-gut / OBS can't keep up | **No** | `composite` 30–60 fps, worst 35ms; OBS `outputSkippedFrames` **0**, render 30.0 fps, CPU 0.4% |
| The recording/publish path re-encodes | **No** | container is native 1920×1080 30.00fps 7 Mbps; published VOD is byte-identical to the recording |
| Composite is upscaled from a smaller canvas | **No** | FFT of horizontal scanlines shows energy smooth to Nyquist — natively 1920 wide |
| Low light is capping camera framerate | **No** (for this rig) | true of cheap UVC webcams, **false** for a DSLR — HDMI output rate is fixed by a camera menu setting. 23 fps was 23.976 = 24p. |
| RAM / the 24 GB machine | **No** | never the constraint; `NET`, not `CPU` |

---

## Confirmed causes, in the order they bit

### 1. `degradationPreference: "maintain-resolution"` (fixed, `7688abf`)

`d5d59ad` set it on every broadcast leg. It leaves a squeezed encoder
exactly one lever — framerate — and Chrome will walk a camera to 2 fps
rather than drop a single pixel. Measured on the 08-07 recording: guest
camera **6.5 fps**, screen share **0.6 fps**, against a 08-04 baseline of
a steady 27–30. Cameras are now `balanced`; only the screen broadcast
leg stays pinned. **Full detail in [`VIDEO-QUALITY.md`](VIDEO-QUALITY.md).**

### 2. The resolution chain was throwing away most of the picture (fixed 2026-08-10)

Two independent downscales *before the network*:

- **OBS canvas was `1280×720`.** The Virtual Camera can only ever output
  the canvas size, so 1080p was unreachable no matter what the app asked
  for. Now `1920×1080` (see "OBS control" below).
- **The app's camera-res default was `854×480`.** Even a perfectly
  healthy feed shipped 480p into a 1080p broadcast.

### 3. Screen share costs N× and starves everything (partially fixed)

Full mesh means every recipient gets their own private full-quality
encode. Measured live on 2026-08-10 with 3 people in the room:

```
sharing screen:      cam  318×180  7fps    67k    NET
                     screen 1256×1058 9fps  66k
stopped sharing:     cam  318×180  13fps  737k    (11× recovery)
```

Stopping the screen share was the single largest recovery of the night.
Guest tiles are cosmetic — only the god-mode leg feeds the broadcast —
so guest tiers should be far cheaper than they are.

### 4. macOS Local Network permission — the `TURN` badge, and the single biggest quality cliff

`/eq` showed a **`TURN`** badge on the host's feed: two machines sitting
next to each other were relaying video through a TURN server in AWS and
back — `960x540 @ 19fps / 226k` out, **4 fps** in, 46 ms RTT to a box
three feet away. That relay is a hard ceiling no encoder tuning can lift.

**The cause is a macOS privacy toggle, not the network.** macOS attributes
TCC permissions to the **responsible process** — the app that *launched*
the app. `slop-setup.sh` runs inside **iTerm** and starts Chrome with
`open -ga`, so **Chrome inherits iTerm's grants**. Chrome's own Local
Network toggle being ON is irrelevant; if iTerm is denied, that whole
Chrome instance is denied.

Denied Local Network means Chrome can reach the gateway and the entire
internet, but **not one other device on the LAN**. Every ICE host and
srflx pair fails, and relay is all that is left. Silent — no error, no
log, nothing in `chrome://webrtc-internals` that names the cause.

**iTerm therefore needs every permission the Chrome it spawns will use:**
Local Network, **Camera**, **Microphone**, and Screen Recording (that
last one was already required — `slop-obs-patch.py` uses
`CGWindowListCopyWindowInfo`, which is why the launcher uses iTerm and
not Terminal.app in the first place).

**Diagnosis in one move: ping a LAN peer as a normal user, then under
`sudo`.** Root bypasses TCC. Different results = TCC, full stop.

The giveaway that cost hours here: `tcpdump` showed the ICMP echo
request AND the reply both on the wire, while `ping` in the same shell
reported 100% loss. Packets arrive; the *process* is not allowed to see
them.

```
20:44:55.923042 IP 192.168.10.134 > 192.168.10.133: ICMP echo request
20:44:55.923395 IP 192.168.10.133 > 192.168.10.134: ICMP echo reply
--- 100.0% packet loss          <- same host, same moment, unprivileged
```

After granting iTerm Local Network, the same ping returned **0% loss at
1.3 ms**, on plain ethernet, with no other change.

**Ruled out along the way — do not re-investigate:** client isolation on
the Bell GPON gateway (no such setting exists on it; IP Filter disabled
with zero rules; firewall default policy Accept; all four LAN ports in
Route Mode), different subnets (both machines are on `192.168.10.0/24`),
macOS application firewall (disabled on both), and `pf` (Status:
Disabled, only the stock `com.apple` anchors). A Thunderbolt cable
between the two minis was tried and **failed identically**, which is
what finally proved it could not be the network: a point-to-point cable
has nothing in between to drop a packet.

**After any permission change, Chrome must be fully quit (⌘Q) and
relaunched** — a running process keeps the grants it started with.

### 5. OBS's RTMP push competes with the mesh on the same uplink

The OBS box was pushing **8.1 Mbps** out of the same building. Dropping
it to 3500 produced an immediate **4× jump** in every WebRTC feed
(218k → 911k for a guest, 290k → 1207k for Austin). Both machines share
one pipe.

---

## Open — the things that will bite next

- **Full mesh is the ceiling.** Upload scales with guest count. At 3
  people plus a screen share it collapses. At 5 it is unusable no matter
  how the caps are tuned. **The real fix is an SFU** (LiveKit or
  mediasoup): send one copy, the server fans out. Everything else is
  buying time.
- **~~RTT between two machines in the same room was 48–191 ms.~~**
  **Answered 2026-08-10: macOS Local Network permission, inherited from
  iTerm — see confirmed cause 4.** Fixed; plain ethernet now measures
  1.3 ms heart↔gut. No cable or switch needed.
- **The god-mode composite stall at 08-07 `t=3652`** — both cameras *and*
  the locally-rendered news ticker dipped together, which rules out the
  network. Instrumented by the `composite` line; never root-caused.
- **The audio chop** was never independently confirmed. Suspected same
  cause as the composite stall.

---

## OBS control (this machine, profile `Rig2`)

obs-websocket v5 on `127.0.0.1:4455`. The password lives in OBS's own
config — **read it from there, never copy it anywhere**:

```
~/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json
```

If `server_enabled` is `false`, Austin must turn it on by hand:
**Tools → WebSocket Server Settings → Enable**.

Useful requests: `GetVideoSettings`, `SetVideoSettings`,
`GetStats` (`outputSkippedFrames`, `activeFps`, `cpuUsage`),
`GetVirtualCamStatus`, `GetSceneItemList`, `SetSceneItemTransform`.

**Two traps:**

1. **`SetVideoSettings` fails while any output is active** — code 500,
   "Video settings cannot be changed while an output is active." Stop
   the Virtual Camera first, resize, then start it again. The Virtual
   Camera also negotiates its size with Chrome at start, so it must be
   restarted for a resolution change to reach the browser at all.
2. **Changing the canvas does not move scene items**, and rescaling them
   is not uniform. Transforms are in canvas pixels, so a 720p→1080p
   resize leaves everything bunched in the top-left. The correct per-item
   math, which cost one round of "the scenes look all fucked up":

   - `positionX/Y` — **always** scale (×1.5 for 720p→1080p).
   - `boundsType != OBS_BOUNDS_NONE` — OBS sizes the item from the bounds
     box and treats `scale` as derived. Scale **`boundsWidth/Height`
     only** and leave `scaleX/Y` alone. Scaling both applies the factor
     twice — on the Rig2 collection 9 of 11 items are bounded, so
     "uniformly scale everything" visibly wrecks nearly the whole layout.
   - `boundsType == OBS_BOUNDS_NONE` — scale `scaleX/Y`.
   - `crop*` — **never** scale. Crop is in source pixels, not canvas
     pixels.

   Rebuild from a pristine backup rather than scaling in place, so the
   operation is idempotent if it has to be re-run.

3. **The checked-in template has drifted from the live collection.**
   `Rig2.json.template` records `bounds_type: 0` for items that are
   bounded live — scenes have been edited by hand since the last
   install. Treat the live collection as the source of truth and
   regenerate the template from it (re-substituting `__HOME__`) rather
   than hand-patching, the next time the layout is known-good.

### The rig is generated from a template — patch both

`~/clawd/slop-computer-background/install.sh` regenerates the profile
and scene collection from:

```
rig/obs/profiles/Rig2/basic.ini        ← canvas resolution
rig/obs/scenes/Rig2.json.template      ← every scene item transform
```

A live OBS change is **reverted by a re-install** unless the template is
updated too, and updating only one of the two leaves 720p coordinates on
a 1080p canvas. `SLOP.app` runs `slop-setup.sh`, which does *not* touch
these — only `install.sh` does.

---

## Regression traps

Things that look like improvements and are not:

- **`maintain-resolution` on a camera.** Reads as "protect quality",
  actually means "drop to 2 fps before giving up one pixel". See
  `degradationFor()` in `usePeerMesh.ts` and the comment above it.
- **60 fps anywhere.** The broadcast composites at 30. Every frame above
  that is paid for and binned.
- **Raising resolution without checking the mesh cost.** 1080p is free
  solo and expensive with guests, because it is encoded once per person.
- **Trusting a local preview, a screenshot, or a `uiprobe` render.**
  Measure the `in` line on `/eq`, or the recording with ffmpeg.

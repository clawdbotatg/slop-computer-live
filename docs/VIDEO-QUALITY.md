# Why the show looked bad — and how to find out instead of guessing

Companion to `docs/AUDIO-LEVELING.md`. Read this before changing
`packages/nextjs/hooks/usePeerMesh.ts` (`applySenderCaps`,
`preferEfficientVideoCodecs`) or the capture constraints in
`packages/nextjs/hooks/useLocalMedia.ts`.

Video quality has now regressed twice from changes that looked correct
in review and were "verified end-to-end" by a probe that measured the
wrong thing. The fix for that is at the bottom: **measure the recording,
don't reason about the pipeline.**

## The pipeline, and where it is NOT the problem

```
 publisher machine            god-mode machine              prod box
 ┌────────────────┐  WebRTC   ┌──────────────────┐  RTMP   ┌──────────┐
 │ camera + screen│──────────▶│ Chrome composites│────────▶│ mediamtx │
 │ N encodes, one │  (full    │ the desktop      │  (OBS)  │ HLS + mp4│
 │ per peer       │   mesh)   │ 1920x1080        │         │ recording│
 └────────────────┘           └──────────────────┘         └──────────┘
```

Measured on the 2026-08-07 episode, the **right-hand two thirds were
fine**: the recording is a native 1920x1080, 30.00 fps, 7.0 Mbps H.264 /
160 kbps AAC file with a flat bitrate the whole hour (no dips below 45%
of median in any 5s window), and an FFT of a frame shows horizontal
energy running smoothly to Nyquist — i.e. the composite is captured at
1:1, not upscaled from a smaller window.

So when the show looks bad, **suspect the WebRTC leg first.** OBS and
the encode settings are almost never it.

## The two failure modes, and how to tell them apart

They look identical on the broadcast and have opposite fixes.

|                          | starved feed                                                 | stalled composite                                      |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------ |
| what                     | one publisher's encoder is CPU/bandwidth limited             | the god-mode machine can't paint                       |
| tell                     | _one_ window degrades, others fine                           | _every_ window degrades **at the same instant**        |
| the tell that settles it | locally-rendered chrome (news ticker, clock) stays at 30 fps | the ticker drops too — it has no network path to blame |
| fix                      | publisher-side: capture caps, encoder tiers, fewer peers     | the broadcast machine: CPU, GPU, occluded window       |

`/eq` reports both. The **composite** line at the top of the video
section is the god-mode tab's own `requestAnimationFrame` rate — read it
first. If it has dipped, every feed below will look starved whether or
not it is. Per-feed rows carry `CPU` / `NET` / `TURN` badges from the
publisher's own `getStats`.

`hidden` on the composite line is worth knowing about: Chrome throttles
rendering to ~0 in a hidden or fully-occluded tab, so a window dropped
over the captured Chrome window kills the broadcast silently.

## The `degradationPreference` trap

This is the knob that has bitten us, and it is counter-intuitive enough
to be worth stating flatly:

**`maintain-resolution` does not mean "stay sharp". It means "hold
resolution and destroy everything else."** It leaves a constrained
encoder exactly one lever — framerate — and Chrome will walk a camera
down to 2 fps rather than give up a single pixel.

Commit `d5d59ad` (2026-08-06) set `maintain-resolution` on every
broadcast leg, reasoning that "blur is what viewers notice". The next
episode (2026-08-07) is the measurement:

| episode    | policy                      | guest camera on the broadcast         |
| ---------- | --------------------------- | ------------------------------------- |
| 2026-08-04 | Chrome default (`balanced`) | steady 27–30 fps all hour             |
| 2026-08-07 | `maintain-resolution`       | oscillating 2–20 fps, mostly under 10 |

Full-resolution frames arriving at 2 fps read as smeared hands and
macroblock mush — strictly worse than the soft-but-fluid feed the same
constraint would have produced under `balanced`.

The rule now, in `degradationFor()`:

- **cameras: always `balanced`, both tiers.** The composite draws a
  camera window ~660px wide in a 1920px frame, so 640x360@30 is
  visually indistinguishable from 720p at that size _and_ fluid.
  Pinning resolution buys nothing and costs everything.
- **screens: `maintain-resolution` only on the broadcast leg.**
  Downscaled text really is unreadable at any framerate — but only the
  leg OBS captures needs to be readable. Guests read a shared screen in
  a tile.

## Cap capture at the source, not just per sender

A full mesh runs **one encoder per recipient**. Per-sender caps help,
but anything you can cut upstream of the fan-out gets multiplied by N.

`getDisplayMedia({ video: true })` hands Chrome the display's native
surface — on a Retina Mac that is 3456x2234 or larger, at up to 60 fps —
and then encodes a copy of it for every peer. That single unconstrained
call was the dominant CPU cost on a publisher's machine and it starves
every other encoder that machine owns, its own camera included.
`SCREEN_CONSTRAINTS` in `useLocalMedia.ts` now caps it at 1920x1080@15,
matching what the senders would transmit anyway. Cameras are likewise
capped at 30 fps at capture — plenty of webcams volunteer 60.

## Measuring a bad episode (the part worth keeping)

Do not eyeball a screenshot. A screenshot cannot distinguish "low
framerate" from "low bitrate", and those have different fixes. Pull the
recording apart instead. All of this runs on the prod box against
`/home/ubuntu/recordings/live/<date>.mp4`.

**Always use per-span `-ss` input seeking.** A `-filter_complex` with
`trim` branches decodes from t=0 and buffers unboundedly — that is what
froze the box twice in August 2026 (`ops/2026-08-06-freeze-postmortem.md`).

### 1. Is the container even the problem?

```bash
ffprobe -v error -show_entries format=duration,bit_rate \
  -show_entries stream=codec_name,width,height,avg_frame_rate,bit_rate \
  -of default=noprint_wrappers=0 <recording>.mp4
```

Want: 1920x1080, `avg_frame_rate` ≈ 30/1, ~7 Mbps. If that holds, stop
looking at OBS.

### 2. Per-region effective framerate — the money measurement

Extract real frames at 30 fps for a window, crop each on-screen feed,
and count how many consecutive frames actually changed. A feed updating
at 6 fps inside a 30 fps composite is a starved encoder, full stop.

```bash
ffmpeg -v error -nostdin -ss 3645 -t 12 -i <recording>.mp4 \
  -vf "fps=30,scale=480:270" -q:v 6 /tmp/fps/%04d.jpg
```

Then per crop rectangle, `mean(|frame[i] - frame[i-1]|)` over the
sequence and count the samples above a small threshold (~0.5 on a 0–255
grey scale). Include a **locally-rendered** region — the news ticker at
the bottom is ideal — as the control. That control is what separates the
two failure modes in the table above.

### 3. Layout-agnostic sweep

Window positions move during a show, so fixed crops don't transfer
between episodes. For a first look, compute the same update rate over an
18x30 grid of blocks and print it as an ASCII heat map; camera windows
show up as solid blocks and their character tells you the framerate at a
glance. Sampling 4-second bursts at a handful of timestamps is enough to
find the bad stretch, then go dense around it.

### 4. Compare against a known-good episode

The single most useful control is the _previous_ episode's recording,
same measurement. That is how the `maintain-resolution` regression was
pinned in minutes once the harness existed: 2026-08-04 steady, 2026-08-07
oscillating, one commit in between.

## Known-remaining

- **Full mesh is the architectural ceiling.** Every publisher encodes
  one copy per viewer; cost is O(peers) per publisher and the caps here
  are damage control, not a fix. An SFU (LiveKit / mediasoup) is the
  real answer if rooms keep growing.
- **H.264-first (`preferEfficientVideoCodecs`) is a bet on hardware
  encode.** It is right for Apple Silicon and most Windows boxes. On a
  Linux Chrome with no VA-API H.264 encode it falls back to OpenH264
  software, which is worse than the VP9 it replaced. If a specific guest
  looks bad and everyone else is fine, check their `codec` in `/eq`
  before assuming it's their uplink.
- **The god-mode machine has no profiler.** The composite line tells you
  _that_ it stalled, not _why_. Chrome's own `chrome://tracing` on that
  box is the next step.

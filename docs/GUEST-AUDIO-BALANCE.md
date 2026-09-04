# Guest-side audio balance ("the music is loud and I can't hear you")

Status: **documented, not built.** Written 2026-09-04 after a pre-show
report. Companion to `docs/AUDIO-LEVELING.md` (the god-mode mix) and
`docs/BROADCAST-AUDIO-ROUTING.md` (a voice missing entirely).

## The report

Before the show, with the green room up, the host put music on in
Slopamp. One guest (Mac Safari) said the music was very loud for them
and they could not hear the host, even after the host dragged the
Slopamp volume way down.

## What was ruled out

- **Music bleeding into the host's mic.** Host was on headphones, and
  the god-mode box next to the host has its output volume at zero.
  Nothing acoustic reaches the mic.
- **The shared volume not propagating.** Slopamp volume is room state.
  A drag broadcasts through the relay (`music_state`), and every
  client sets its own `<audio>` element volume from it
  (`MusicPlayerWindow.tsx`, the `shownVolume` effect). Verified by
  reading the code, not by measuring the guest.
- **A Safari "ignores element volume" bug.** Searched; nothing found.
  Known Safari issues with `createMediaElementSource` (which the
  guest music graph uses) are about silence or distortion, not level.
  On iOS Safari the element volume property really is a no-op, but
  this guest was on a Mac.

## What is left

### 1. Guests hear the host's voice raw and cold (certain mechanism, unmeasured on a guest)

Published mics go through the RNNoise worklet and come out as a
synthetic `MediaStreamDestination` track (`utils/noiseSuppression.ts`).
That path skips Chrome's outgoing adaptive gain, so the voice leaves the
sender quiet. `AUDIO-LEVELING.md` measured it at about -30 LUFS, roughly
20 dB under the mix target.

The god-mode box fixes this with the auto-leveler in `audioBus.ts`.
**Guests get none of that.** A guest's browser plays each peer through a
bare `<audio>` element in `AudioVisualizer.tsx` (the `busActive` mute
only applies on the bus owner). No gain, no leveling. Music, by
contrast, is a mastered mp3 at around -10 to -14 LUFS, played at the
slider value.

So a guest turns their headphones up to hear the host. Now the music is
loud. Turning the slider down helps less than expected because even at
0.2 (about -14 dB) the music is still near or above the voice.

This is the explanation that survived. It applies to every guest on
every browser, not only Safari.

### 2. Something Safari-specific (open, unconfirmed)

Only one guest complained and they were on Mac Safari. That may be
coincidence or may be real. Nothing in the code or the search supports a
Safari-only cause yet. What would settle it:

- Ask the Safari guest to look at their own Slopamp slider while the
  host drags it. It mirrors the shared value. If it moves and the music
  does not, Safari is not applying element volume through the Web Audio
  graph and this becomes a real bug to file and work around.
- Repeat the same session with a Chrome guest and compare.

## How to measure before building

Do not build on the story above alone. Join the room as a guest in a
headless browser (see `ops/probes/` and the fake-device notes in
`docs/BROADCAST-AUDIO-ROUTING.md`), tap the incoming host audio track
and the Slopamp `<audio>` element with an `AnalyserNode`, and log RMS
for both over 30 seconds of talking with music on. Expect voice around
0.03 RMS and music several times that at slider 0.7. If the voice is
already near music level, this doc is wrong.

## How the fix would work (when we decide to build it)

Two small pieces, independent of each other.

### A. Level incoming voices on the guest side

In `AudioVisualizer.tsx`, for remote streams when the audio bus is not
active, route the stream through a per-peer Web Audio chain instead of
a bare element:

    MediaStreamSource -> GainNode -> destination

Drive the gain with the same loop shape as `tickAuto` in `audioBus.ts`:
read post-gain RMS at ~10 Hz, lerp gain toward
`AUTO_TARGET_RMS / rms`, freeze below `AUTO_NOISE_FLOOR`, cap at
`AUTO_GAIN_MAX`. Reuse the constants; keep the invariant
`AUTO_GAIN_MAX = AUTO_TARGET_RMS / AUTO_NOISE_FLOOR`.

Simplest way to get there: let non-god participants own a bus instance
scoped to peer streams only (`useAudioBusOwner` today is gated on
`isGodMode`). Music must stay on the shared slider and off that bus,
otherwise the slider becomes a no-op the way it did on the god box
before `setSourceTargetScale` existed.

Traps carried over from `AUDIO-LEVELING.md`:

- Chrome autoplay: the chain needs an `AudioContext` resumed on the
  `slop:activated` gesture, same as the visualizer's existing handler.
- The `<audio>` element must be muted once the chain is live, or the
  voice plays twice.
- A track hot-swap (`replaceTrack`) hands out a new `MediaStream`
  object under the same id. Rebuild the source node on stream identity
  change, not on id.

### B. Music volume through a GainNode

`MusicPlayerWindow.tsx` already builds
`MediaElementSource -> StereoPanner -> Analyser -> destination` for
guests. Insert a `GainNode` after the panner and set its gain from
`shownVolume` instead of setting `audio.volume`. Every browser honors a
GainNode, including iOS Safari, so this removes the whole class of
"element volume is ignored" questions at zero cost. Keep `audio.volume`
pinned at 1 in that mode.

### Not doing

- Ducking music automatically when a guest talks. Different feature,
  and the god-mode box already balances the broadcast.
- Boosting the host's outgoing mic gain. That would raise the noise
  floor into the denoiser and change what the god box has been tuned
  for since `e126389`.

## Why not built yet

One report, one guest, one browser, no measurement. The mechanism in
section 1 is real, but it has been true for every show and only one
person has complained. Measure first. If the numbers match, piece B is
a five-line change and piece A is an afternoon.

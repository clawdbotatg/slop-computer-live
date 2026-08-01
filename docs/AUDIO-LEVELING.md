# Audio leveling on the broadcast mix ("The Equalizer")

How the god-mode stream's audio gets balanced, how it failed on the
2026-08-01 show, what was changed, and how to diagnose/re-tune it next
time levels sound wrong. Companion to `docs/STREAMING.md` (how the
stream itself gets out).

## Architecture in one paragraph

In god mode (the spectator tab OBS captures — see STREAMING.md flow A),
every audio source in the tab — peer voices (WebRTC MediaStreams),
the SlopAmp music player, file previews — is routed through a shared
Web Audio mixer in `packages/nextjs/utils/audioBus.ts`: per-source
GainNode → 6-band master EQ → master gain → destination. A 10 Hz loop
(`useAudioBusOwner` in `hooks/useAudioBus.ts`) reads each source's
post-gain RMS and runs the **auto-leveler** (`tickAuto`), which drives
each source's gain toward a shared loudness target so voices and music
come out balanced. The `/eq` popup (`app/eq/page.tsx`) is a remote
control + meter view over BroadcastChannel. Non-god-mode visitors never
touch any of this.

Key constants (top of `audioBus.ts`, all deliberately code-not-knobs):

| Constant | Value | Meaning |
| --- | --- | --- |
| `AUTO_TARGET_RMS` | 0.3 | Post-gain RMS every source is driven toward (× `userTargetScale`) |
| `AUTO_NOISE_FLOOR` | 0.015 | Input RMS below this = "silence": gain frozen, no boost |
| `AUTO_GAIN_MAX` | 20 | Per-source gain cap, = TARGET/FLOOR — see invariant below |
| green-room music scale | 0.55 | `MusicPlayerWindow` pins music's target while the green room is up |

**Invariant: `AUTO_GAIN_MAX = AUTO_TARGET_RMS / AUTO_NOISE_FLOOR`.**
Any source loud enough to get past the silence gate can be lifted all
the way to target. Break this (cap too low) and you create a dead zone:
a source needing more boost than the cap stays quiet *forever*. If you
change one constant, recompute the other.

## The 2026-08-01 incident (why these values)

Symptom: green-room music sounded right; once live, both hosts' voices
were far too quiet and the auto-leveler "didn't work."

Measured from the show recording (see "Diagnosing" below):

- Green-room music: **-16.8 LUFS** — almost exactly the coded
  0.55-scale target, proving the auto-leveler was ON and converging.
- Live voices: **~-30 LUFS** short-term — i.e. raw incoming WebRTC
  level, zero boost applied.

Root cause: voices arrived at ~0.03 RMS, **below the then-floor of
0.05** — the silence gate classified the hosts as silence all night and
froze their gain at 1×. Even past the gate, the then-cap of 4× (+12 dB)
couldn't close the ~20 dB gap to target. (The cap had already been
raised 2→4 once for a milder version of the same symptom.)

Fix (commit `e126389`): floor 0.05 → 0.015, cap 4 → 20, cap exported
so the /eq popup's manual sliders share the scale.

Why voices arrive that cold in the first place: mic AGC is on at
capture, but published mics are rerouted through the RNNoise worklet
(`utils/noiseSuppression.ts`) into a synthetic
MediaStreamDestination track, which likely bypasses Chrome's
sender-side adaptive digital gain. Upside: denoised mics have
near-zero ambience between words, which is what makes the low 0.015
floor safe.

## Diagnosing "levels were wrong" after a show

mediamtx records every stream on the prod box. Measure, don't guess:

```bash
ssh slopcomputer 'ls -lt /home/ubuntu/recordings/live/ | head -3'

# RMS per 10s chunk — find segment boundaries (silence / green room / live):
ssh slopcomputer 'nice -n 15 ffmpeg -hide_banner -loglevel error -i /home/ubuntu/recordings/live/<FILE>.mp4 \
  -vn -af "asetnsamples=480000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-" \
  -f null - 2>/dev/null' | grep RMS_level

# Perceptual loudness of a segment (green room vs live):
ssh slopcomputer 'nice -n 15 ffmpeg -hide_banner -ss <START> -t <LEN> -i /home/ubuntu/recordings/live/<FILE>.mp4 \
  -vn -af ebur128=peak=none -f null - 2>&1 | tail -8'
```

Reading the tea leaves:

- Music lands on its target (-16..-17 LUFS in green room) but voices
  sit ~-30: the gate is above the incoming voice level → lower
  `AUTO_NOISE_FLOOR` (and recompute the cap).
- Voices lifted but plateau short of target: cap is binding → the
  invariant is broken, fix `AUTO_GAIN_MAX`.
- Music *also* off-target: auto is likely OFF (see trap #1) or the
  bus/AudioContext never engaged.
- Constant loud hiss/hum on a source: the floor is *below* that
  source's ambience and the auto is amplifying noise → raise the floor
  (or fix the source's denoise path).

## Traps (learned the hard way)

1. **Any manual gain-slider drag in /eq flips auto OFF and persists it
   off** (`localStorage` key `slop-audio-bus-auto-v1` in the streaming
   Chrome profile) — every later show in that profile starts with no
   auto-leveling. Re-check the "auto" checkbox in /eq to re-engage.
   The EQ bands + master gain persist too (`slop-audio-bus-eq-v1`).
2. **"Music ducks when the green room drops" is your live proof that
   auto is on.** That duck flows through `userTargetScale`, which only
   the auto loop reads — if the duck doesn't happen, auto is off.
3. The green room **solo-silences** all non-music sources on the mix
   (`setSoloMusic`) and skips their auto ticks; voices join the mix
   with whatever gain they had. Give the auto a couple seconds of
   talking after going live to settle.
4. Pre-show sanity check: god mode + music playing + talk, open /eq —
   the voice meter should climb to roughly the music meter's height.

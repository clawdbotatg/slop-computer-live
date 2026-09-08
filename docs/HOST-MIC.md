# The host's mic ("the Yeti doesn't sound deep / real")

Status: **measured 2026-09-08, one open thread** (analyze the first episode
recorded with these settings and propose a god-mode EQ). Companion to
`AUDIO-LEVELING.md` (god-mode mix), `GUEST-AUDIO-BALANCE.md` (guest side)
and `BROADCAST-AUDIO-ROUTING.md` (a voice missing entirely). This doc is
about the **capture side of Austin's own mic**, before any of those.

## What was measured (with the recording, not by ear)

Rig: Blue **Yeti X**, USB into the Mac mini, on a boom arm, **cardioid**
(the icon Austin calls "a Pac-Man facing down"), knob/meter side toward
him, ~1 ft away — he will not talk closer, that is how he speaks; design
around it. A thick green foam windscreen is on the capsule.

| Fact | Evidence |
|---|---|
| The macOS **input slider is the mic gain**. | Room noise -62 dBFS at 57, -37 at 100 (+25 dB). Slider now **75**. |
| At 75: normal talk peaks -17..-12 dBFS, shout -7, whisper ~-28. | `steps.wav` structured take. Healthy headroom. |
| Room floor ≈ -54 dBFS at that gain, no 50/60 Hz hum, only <120 Hz rumble. | room-tone takes, bandpass sweep. |
| **No compressor/AGC anywhere on the Mac.** | whisper→shout spans 22 dB; snap at mic vs arm's length differs 10 dB; no G HUB installed. |
| The foam has **no measurable effect**. | identical band energy with/without. |
| Distance barely moved the numbers. | He self-levels by ear when close (normal). Not a fault. |
| "Presence (2-6 kHz) 8 dB under body" is a **normal voice spectrum**, not a defect. | every take, every position. |
| **The site chain is tone-neutral.** Chrome `noiseSuppression+autoGainControl` adds ~+12 dB evenly across all bands (peaks land ≈ -4 dBFS); RNNoise preserves tone; god-mode leveler is pure gain. | headless-Chrome chain probe, same utterance recorded raw / DSP-off / DSP / DSP+RNNoise simultaneously. |

Conclusion: the "deep, real" Yeti sound he remembers is **proximity
effect** (mouth within ~4-6 in). At 1 ft the Yeti is a clean, neutral mic
and nothing downstream can add what was never captured. Two levers remain:
bring the boom to mouth height (he still stands how he stands, the mic
comes to him), or fake warmth with a god-mode EQ (low-shelf lift, high-pass
the rumble).

## Tooling (local to the Mac mini, outside the repo: `~/mic-lab/`)

- `bgrec.sh <label> <secs>` — Glass chime → sox `rec` → Basso buzz. **Use
  sox**: ffmpeg's avfoundation input stops after ~3 s when run from the
  harness. Austin cannot tell when a recording is running; the chime is
  load-bearing, and he must read AFTER it. Always check the per-second
  loudness timeline before trusting a take (several were silence).
- `measure.sh <wav> [ss] [t]` — peak/RMS/LUFS + 5-band RMS + spectrogram.
- `chain/` — headless Chrome (playwright-core from `~/clawd-harness/tools`,
  chromium-1234, `--use-fake-ui-for-media-stream`, captures the REAL Yeti)
  recording raw / DSP-off / site DSP / site DSP+RNNoise at once; RNNoise
  assets symlinked from `packages/nextjs/public/noise` and the lib's ESM
  dist. `bgchain.sh <label> <secs>` wraps it with the chimes plus a sox raw
  track. Static server on **127.0.0.1:8931** (8765 = clawd-browser bridge,
  8791 = the harness; both silently 404 you).
- Takes from 2026-09-08 are in `~/mic-lab/` and `~/mic-lab/chain/`
  (`take2_*.wav` is the four-way comparison).
- The Cam Link cannot be grabbed for a setup photo while OBS holds it.

## Open thread / next steps

1. Austin records an episode on 2026-09-08 afternoon with the settings
   above. Get the recording (prod box, see `AUDIO-LEVELING.md` for the
   ffmpeg recipe) and measure the host voice: level vs music, band
   balance, rumble.
2. Propose an EQ: roughly high-pass ~80 Hz, low shelf +3 dB around
   150 Hz, maybe +2 dB near 3 kHz. **Check first** whether the god-mode
   EQ in `packages/nextjs/utils/audioBus.ts` is master-only (`bands` on the
   bus) — if so it hits the music too and a per-source EQ would be new work.
3. Only if he agrees to move: boom arm to mouth height, re-measure with
   `bgrec.sh`; expect +6..10 dB and a visible low-end rise.

# Window geometry log — status & runbook

Make the relay record every shared-desktop window's exact rect over an episode
into a `geometry.jsonl`, pin it at finalize, and reference it from the manifest
— so the clipper's **9:16 vertical** crop can read window positions
**deterministically** instead of recovering them from the flat OBS recording
with computer vision.

This pairs with the server-side clips pipeline (`ops/clips.md`): the geometry
log is the input that makes the auto-generated vertical clips precise. The two
are complementary — geometry is consumed *inside* the clipper's `--vertical`
layout step, not in the publish step, so the clips route / `publish.ts` need no
changes.

The cross-repo design spec lives in the clipper repo:
`clawd-clipper/docs/window-geometry-log.md`. This file is the slop-computer-live
side: what shipped, what's left, and how to operate it.

```
relay (this repo)                         clipper (clawd-clipper)
─────────────────                         ───────────────────────
slot moves / window show / hide           [REMAINING] read manifest.geometry.cid,
  → GeometryLog → geometry.jsonl            fetch geometry.jsonl, replay to the
finalize: prepend header(videoStartMs),     clip's videoSec, emit DetectedWindow[]
  pin, set manifest.geometry  ──────────►   else → CV pixel pipeline (src/pixels.ts)
                                            → composeLayout() (unchanged)
```

## What shipped (producer half — DONE, deployed-pending)

All three commits are pushed to `main`.

- **`packages/relay/src/geometry-log.ts`** (new) — `GeometryLog`: append-only
  writer for `./.slop-data/rooms/<slug>/geometry.jsonl`. `recordMove` (throttled
  to ≤1 line/slot/150ms with a trailing flush), `recordShow`, `recordHide`,
  `readArchive`.
- **`packages/relay/src/desktop.ts`** — `GeometryLog` is owned by `DesktopState`,
  so the one chokepoint covers **both** the `slot_update` WS path and the HTTP
  `POST /v1/slots` route, plus disconnect cleanup, with no scattered wiring:
  - `applySlotUpdate` → `recordMove`
  - `publish` → `recordShow`; `unpublish` / `clearPeerPublications` → `recordHide`
  - Added `slotIdFor()` (mirrors the frontend `Desktop.tsx`) and `getSlot()`.
- **`packages/relay/src/room.ts`** — constructs the log (`geometry.jsonl` path)
  and passes it into `DesktopState`; keeps a `room.geometry` ref for finalize.
- **`packages/relay/src/recordings.ts`** — `finalizeRecording` snapshots the log,
  prepends a `{ v:1, kind:"header", videoStartMs }` line (for `ts → videoSec`
  alignment), pins `geometry.jsonl`, emits `{ phase: "pinning-geometry" }`, and
  sets `manifest.geometry = { cid, sampleCount, format }`. `index.ts` passes
  `room.geometry.readArchive()`. Additive — no existing pin or on-chain
  reference changes.

**Design note:** identity is NOT duplicated into the log. The slot `id`
(`owner-<ownerKey>-<kind>[-<streamId>]`) already encodes owner + kind, so the
relay stays decoupled from the roster — the clipper parses owner/kind from the
id and joins `ownerKey → handle` via `manifest.participants` (which it already
loads for speaker attribution). Only media slots (`owner-…`) are logged;
browser/app windows are skipped to keep the log tiny.

Manifest type carried through in both `clawd-clipper/src/resolve.ts` and
`slop-computer-frontpage/.../types/episode.ts`. All three repos typecheck clean.

## What's left

| Piece | Where | Status |
|---|---|---|
| `GeometryLog` + `DesktopState` wiring | relay | ✅ shipped |
| finalize pin + `manifest.geometry` | relay | ✅ shipped |
| `manifest.geometry` type carry-through | clipper + frontpage | ✅ shipped |
| Fetch + replay → `DetectedWindow[]` adapter | clipper (`src/geometry.ts`) | ✅ built |
| Branch geometry-or-CV into the vertical path | clipper (`src/index.ts`) | ✅ built |
| **Verify coordinate-space calibration on a real clip** | — | ⬜ **needs a recorded episode** |

### How the clipper consumes it (built)

1. `clawd-clipper/src/geometry.ts`: given `manifest.geometry.cid`, fetch
   `geometry.jsonl`, replay events to a clip's mid-frame wall-clock time, take
   the visible windows' rects, parse `ownerKey`/`kind` from each slot id, join
   `handle` via `manifest.participants`, and emit `DetectedWindow[]`.
2. `src/index.ts` (the `missing`-windows loop): if `ep.manifest.geometry?.cid`
   exists, replay it per clip; only fall back to `detectClipWindows()` (the CV
   pixel pipeline) for clips the log yields nothing for. Both paths produce the
   same `DetectedWindow[]` that `composeLayout()` consumes.
3. **Time alignment** reuses the `offsetMs` the clipper already recovers from the
   transcript (`alignToVideo`) — geometry events share the live transcript's
   wall clock — falling back to the header's `videoStartMs`.

Replay logic verified on a synthetic log (visibility, last-write-wins geometry +
z order, id parsing, audio→camera, handle join, off-frame filtering). The only
thing not yet verified is the spatial calibration below.

### The one open risk — coordinate-space calibration

Slot rects are in the shared-desktop layout coord space the frontend renders in;
OBS captures that browser (possibly scaled/cropped) into the recorded frame
(typically 1920×1080). The relay does **not** know the capture viewport, so the
header omits it. The consumer maps with a single affine transform
(`scale = recordedFrame.height / layout.height`, plus an x/y offset if cropped).
For a 1:1 capture this is identity — but **nobody has confirmed it's 1:1.** The
first integration test must overlay a replayed rect on a real captured frame and
read off the calibration constant. Can't be known until a real `geometry.jsonl`
exists. There's also a t=0 subtlety: the clipper already recovers an `offsetMs`
between transcript wall-clock and video seconds for speaker attribution; the
geometry replay likely needs the same alignment rather than trusting
`videoStartMs` from the filename alone.

## Operating it

There is **no new toggle** — geometry logging is always on (it's a tiny
append-only file). The only operational requirements:

1. **Deploy this relay build** (pull + `yarn build` + restart the service —
   pushing GitHub does NOT deploy it, same as `ops/clips.md`). Until then, no
   episode produces a `geometry.jsonl` and the clipper silently uses CV.
2. Once shipped, the clipper consumption build needs a `git pull` on the box's
   `CLIPPER_DIR` checkout (the same checkout the clips route spawns) — but only
   after step "remaining" above is built.

Order of operations to get end-to-end value:
1. Deploy this relay build.
2. Run a show → finalize → confirm `manifest.geometry.cid` is present (and that
   `.slop-data/rooms/<slug>/geometry.jsonl` has lines).
3. Build the clipper consumption path against that real artifact (resolves the
   calibration question at the same time).
4. `git pull` the box's clipper checkout. From then on, `/admin/generate-clips`
   produces geometry-driven vertical layouts, CV only as fallback.

## Verify (after deploy)

- During a show, drag/open/close some windows, then finalize.
- On the box: `.slop-data/rooms/<slug>/geometry.jsonl` exists and has `shown` /
  geometry / `removed` lines.
- The finalize stream emits a `pinning-geometry` phase; the resulting manifest
  JSON has a `geometry` field with a CID and `sampleCount > 0`.
- Fetch the CID from the gateway → first line is the header with `videoStartMs`,
  rest are events.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| No `geometry` in manifest | relay not on this build, or no windows were shown | deploy the build; confirm media windows were live during the show |
| `geometry.jsonl` empty | only browser/app windows (no `owner-…` media slots) were used | expected — only media slots are logged |
| Clipper still uses CV despite a geometry CID | consumption path not built/deployed yet | build `src/geometry.ts` + the `index.ts` branch, then `git pull` the box checkout |
| Vertical crop misaligned | coordinate-space calibration not yet verified | overlay a replayed rect on a real frame, derive the scale/offset constant |

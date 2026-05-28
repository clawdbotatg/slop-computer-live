# PLAN — `?mobileMode=` recording layout

**Status:** design doc, not implemented
**Goal:** a URL-secret-gated spectator session that renders a portrait,
clip-friendly stage instead of the full desktop. For OBS / phone capture
of interviews and demos.

## TL;DR

```
https://live.slop.computer/<room>?invite=<roomPassword>&mobileMode=<MOBILE_MODE_PASSWORD>
```

- Mints a **hidden spectator** (filtered out of every guest list — free,
  inherits the existing `spectator: true` filter at
  `usePeerMesh.ts:3304`).
- Renders a brand-new `<MobileStage>` component (NOT a conditional
  branch deep inside Desktop) — title bar, video tiles with hard-coded
  positions, subtitle band, audio-only attribution row.
- Picks one of 5 layouts based on what's currently published. Snap on
  publisher-set change, no CSS transitions.
- Subtitle source reuses `mesh.liveCaption` / `mesh.latestTranscriptSeg`
  — no new STT pipeline needed.

## Why a separate stage and not "Desktop with `if (mobileMode)`"

The desktop tree (`Desktop.tsx`, ~2700 lines) is the single biggest
conditional surface in the codebase. Threading a "no icons, no menus,
no draggable windows, different layout function, different chrome"
mode through it would mean a dozen `if (mobileMode)` branches that
will rot the moment someone adds a new desktop feature. A dedicated
`MobileStage` component that pulls from the same `mesh` and reuses
`<VideoView>` keeps the mobile surface legible and the desktop surface
unchanged.

The cost is duplicating ~50 lines of glue (title bar, mesh wiring,
subtitle positioning). Worth it.

## Existing scaffolding we reuse

| What | Where | Why it matters |
|------|-------|----------------|
| `?godMode=` URL read + scrub | `Desktop.tsx:375-391` | Same pattern for `?mobileMode=` — read, POST, delete from URL bar |
| `/auth/godmode` endpoint | relay | Template for `/auth/mobilemode` (separate password) |
| `Session.spectator` flag | `useSession.ts:33-37` | Mobile sessions inherit `spectator: true` — relay-side publish block, hidden from peer list |
| `peers.filter(p => !p.spectator)` | `usePeerMesh.ts:3304` | Free: mobile spectator never appears in `WhosHere`, `PinnedPeers`, or anywhere else |
| `<VideoView>` | `components/desktop/VideoView.tsx` | Reused for each tile — mic/audio routing stays intact |
| `mesh.liveCaption` + `latestTranscriptSeg` | already broadcast by publishers' in-browser STT | Mobile spectator reads the existing stream, no god-STT needed |
| `MenuBar` `brand` prop | `ui/MenuBar.tsx:92-109` | If we ever want to share menubar chrome; otherwise we render our own simpler strip |

## Relay changes

`packages/relay/`

1. New env var `MOBILE_MODE_PASSWORD` (separate from
   `GOD_MODE_PASSWORD`). Rationale: the mobile link will get handed
   out for clipping; we don't want it to also unlock god-tier
   capabilities (audio mixer ownership, server-STT, god viewport).
2. New endpoint `POST /auth/mobilemode` mirroring `/auth/godmode`.
   Validates the password, mints a session with:
   ```ts
   { authenticated: true, spectator: true, mobileMode: true }
   ```
3. Extend `Session` type with `mobileMode?: boolean`. Threaded through
   `selfHint` like `spectator` is.
4. **No change to publish blocking** — spectator already can't publish.

## Frontend changes

`packages/nextjs/`

1. **`Desktop.tsx`** — extend the URL-param effect (`:375-391`) to
   also extract `?mobileMode=`, POST to `/auth/mobilemode`, scrub from
   the URL.
2. **`Desktop.tsx`** — after session resolves, if
   `session.mobileMode === true`, early-return
   `<MobileStage mesh={...} session={...} />`. Skip ALL desktop tree
   rendering (no MenuBar, no icons, no windows, no PinnedPeers, no
   chyron, no timeline).
3. **New file** `components/MobileStage.tsx` (and a few small
   sub-components in `components/mobile/`):
   - `MobileStage.tsx` — root: title strip + video area +
     audio-pill row + subtitle band. Computes layout kind from
     publisher set.
   - `mobile/layouts.ts` — `pickLayout()` decision table +
     pure functions returning `{ id, x, y, width, height }` boxes
     for each tile given a viewport.
   - `mobile/AudioPillRow.tsx` — slim row showing audio-only
     publishers as avatar+handle pills, for STT attribution.
   - `mobile/MobileSubtitleBand.tsx` — same data source as
     `SubtitleCaption` but positioned in our bottom strip, not the
     desktop chyron stack.

## Layout decision table

```ts
// publishers = { screens: N, videos: N, audioOnly: N }
function pickLayout(p): LayoutKind {
  if (p.screens === 0 && p.videos === 0)   return "idle";
  if (p.screens === 0)                      return "all-cameras";    // A
  if (p.videos === 0)                       return "screen-hero";    // B
  if (p.screens === 1 && p.videos === 1)    return "interview";      // C
  if (p.screens === 1 && p.videos >= 2)     return "panel-w-screen"; // D
  return "multi-screen";                                              // E
}
```

### Viewport sizing

Portrait viewport `100vw × 100vh`. Reserved strips:

- Top: `48px` — `SLOP.COMPUTER` single-line wordmark, centered
- Bottom: `96px` — subtitle band
- Audio-pill row: `40px` if `audioOnly > 0` else `0`

Remaining height = `videoArea`, split per layout:

| Layout | Composition |
|--------|-------------|
| **A — all-cameras** | N tiles, full-width, each `videoArea / N` tall. Equal shrink for any N (4+ tiles get small but stay visible — no caps, no active-speaker swapping). |
| **B — screen-hero** | M screens, full-width, each `videoArea / M` tall. |
| **C — interview** | Cam thumbnail top `25%`, screen hero bottom `75%`. Screen is the focus (demos, code, slides). |
| **D — panel-w-screen** | 2 cams side-by-side top `30%`, screen bottom `70%`. Extra cams beyond 2 shrink into the top row (3rd cam → 1/3 wide each, etc.). |
| **E — multi-screen** | Cams horizontal strip top `20%`, screens stacked in remaining `80%`. |

### Tile rendering

- Cameras: `object-fit: cover` — fill the tile, crop edges. Talking
  heads look fine cropped.
- Screen shares: `object-fit: contain` — letterbox to preserve aspect.
  Cropping a code demo defeats the point.
- No window chrome, no titlebar buttons, no resize handles. Tile is
  just the video element + a small bottom-left handle/name overlay
  for clipping attribution.

### Layout transition

Snap. When the publisher set changes (someone joins/leaves/starts a
share), `pickLayout` recomputes and tiles repaint at new positions in
one frame. No CSS transitions — they leave half-state during a clip
cut. Behaves like an OBS scene cut.

## Subtitles

- Data source: `mesh.liveCaption` (in-browser STT, ~200ms-1s) and
  `mesh.latestTranscriptSeg` (server STT if any god peer is also in
  the room, ~3-5s). Same lanes that `SubtitleCaption.tsx:7-23` uses.
- Rendering: fixed bottom band, `96px` tall, full-width. Format:
  `Speaker: "their quote"`. Single global strip, not per-tile.
- No chyron, no timeline.
- v2 idea (out of scope): per-tile captions where the speaker's
  recent words overlay their own video tile, like a TV interview
  lower-third per face.

## Audio-only publishers

A guest who shares only their microphone (no camera, no screen) still
needs to be visible somewhere for STT attribution — otherwise the
viewer sees a quote with a name they can't place. Render them in a
slim `40px` row above the subtitle band as `[avatar] handle` pills,
one per audio-only publisher. The row hides itself when there are no
audio-only publishers.

## Visual sketches

```
A. all-cameras          B. screens only         D. panel-w-screen
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│ SLOP.COMPUTER│        │ SLOP.COMPUTER│        │ SLOP.COMPUTER│
├──────────────┤        ├──────────────┤        ├──────────────┤
│   camera 1   │        │              │        │  cam1 │ cam2 │
│              │        │              │        ├───────┴──────┤
├──────────────┤        │              │        │              │
│   camera 2   │        │   screen 1   │        │              │
│              │        │              │        │    screen    │
├──────────────┤        │              │        │              │
│   camera 3   │        │              │        │              │
│              │        │              │        │              │
├──────────────┤        ├──────────────┤        ├──────────────┤
│ audio guests │        │ audio guests │        │ audio guests │
├──────────────┤        ├──────────────┤        ├──────────────┤
│  subtitles   │        │  subtitles   │        │  subtitles   │
└──────────────┘        └──────────────┘        └──────────────┘
```

## Implementation order

1. Relay: `MOBILE_MODE_PASSWORD` env var + `/auth/mobilemode` endpoint
   + `Session.mobileMode` field + thread through `selfHint`.
2. `Desktop.tsx`: URL read for `?mobileMode=`, POST to new endpoint,
   early-return `<MobileStage>` when session has the flag.
3. `MobileStage.tsx` + `mobile/layouts.ts`: title bar, layout
   dispatcher, all 5 layout renderers.
4. `mobile/AudioPillRow.tsx` + `mobile/MobileSubtitleBand.tsx`.
5. Test matrix:
   - idle (no publishers)
   - 1 cam
   - 2 cams
   - 3 cams
   - 4+ cams (overflow shrink)
   - 1 screen
   - 1 screen + 1 cam (interview)
   - 1 screen + 2 cams (panel-w-screen)
   - 2 screens
   - mid-stream layout change (cam joins → publish starts → screen
     starts → screen stops — verify snap behavior, no half-state)
   - audio-only publisher attribution in subtitle band

## Out of scope (flagged for follow-ups)

- **Per-tile captions** (TV interview lower-third per face). Bottom
  strip first; upgrade if clips feel weak.
- **Active-speaker reorder** — tiles render in publisher-join order.
  No promotion of the current speaker. Easy to add later as a sort
  key in `pickLayout`.
- **Admin link helper** — the admin page generates godMode links
  (`admin/page.tsx:564-574`). A mobileMode link generator there would
  be nice but you can hand-craft the URL for v1.
- **CSS transitions between layouts** — explicitly rejected; reconsider
  if snap looks jarring in real clips.
- **Caps / hiding overflow guests** — explicitly rejected; everyone
  stays visible even if tiles get small.

## Security notes

- `MOBILE_MODE_PASSWORD` is a separate secret from
  `GOD_MODE_PASSWORD`. Both live in relay env. Mobile leak doesn't
  unlock god capabilities.
- Mobile session has `spectator: true`, so the relay's existing
  publish block applies — mobile peer can never accidentally
  broadcast cam/mic/screen.
- URL scrubbing (existing `Desktop.tsx:375-391` pattern) ensures the
  password disappears from the address bar after first load, so
  screenshots of the browser don't leak it.
- The mobile spectator IS authenticated to the room — they can
  observe all publishers. Treat the mobile link as equally sensitive
  to the room's `invite` password.

# How a voice reaches the broadcast mix (and how it silently doesn't)

Companion to `docs/AUDIO-LEVELING.md`. That doc is about **gain** — how
loud a source is once it's in the mix. This doc is about **membership** —
whether a source is in the mix *at all*.

The two failure modes look nothing alike and have nothing in common.
"Someone is too quiet" is a leveling problem. "Someone is completely
absent while music plays fine" is a membership problem, and membership
is the fragile one: it depends on two independent channels agreeing on
a string, with no reconciliation anywhere in the system.

Written 2026-08-07 after the god-mode-has-no-audio incident, at
`7688abf`. Line numbers below drift — grep the symbol names.

---

## The chain: five links, all one-shot

For a remote peer's voice to reach the stream, every one of these must
succeed. There is **no retry and no reconciliation** on any of them.

| # | Link | Where |
| --- | --- | --- |
| 1 | Publisher announces the pub over the relay WS | `usePeerMesh.ts` `publish()` → `send({type:"publish", streamId: stream.id, …})` |
| 2 | WebRTC delivers the media; god box files it under the MSID | `usePeerMesh.ts` `pc.ontrack` → `setRemoteStreams` keyed `event.streams[0].id` |
| 3 | Desktop joins (1) and (2) **by exact string match** | `Desktop.tsx` `streamFor()` → `mesh.remoteStreams.get(pub.streamId)` |
| 4 | A `<Window>` renders with a non-null stream, mounting `VideoView` / `AudioVisualizer` | `Desktop.tsx` `windows.map(...)`, `{stream ? … : fallback}` |
| 5 | The mounted component's effect registers the stream on the bus | `useAudioBus.ts` `useAudioBusStream()` → `audioBus.registerStream()` |

**Link 3 is the fragile core.** Signaling and media are separate
transports that happen to carry the same id. When they disagree,
`streamFor` returns `null`, the window renders its empty fallback, the
audio component **never mounts**, and the voice is absent from the
broadcast. No error. No console warning. No visual cue on the mix.

**Link 4 is the architectural smell.** Membership in a *broadcast* is a
side effect of a *React render*. Anything that stops the component
rendering — a null stream, a changed key, an unmount — silently removes
a human being from the show.

---

## Confirmed defect: MSID drift after a device hot-swap

**Status: proven from code. Not yet proven to be the cause of any
specific incident.** See the next section.

`replaceTrack()` in `usePeerMesh.ts` deliberately builds a **new**
`MediaStream` object so React consumers re-bind (a `MediaStreamAudio\
SourceNode` and `HTMLMediaElement.srcObject` both latch onto a track at
hookup time, and `addtrack` doesn't fire for script-initiated
mutations — so handing back a new object is the only reliable signal).
It then stores that new object under the **original** key:

```js
const fresh = new MediaStream([...keepTracks, newTrack]);
…
// Map key is the ORIGINAL publication streamId, not fresh.id
localStreamsRef.current.set(streamId, { stream: fresh, kind: pubKind });
```

That comment is correct about the key and blind to the value. The map
now holds `key = "abc"` → `stream.id = "xyz"`.

For **already-established** peer connections this is harmless:
`sender.replaceTrack()` swaps the track without touching the MSID on
the wire. Peers keep seeing `abc`.

For **every peer connection formed afterwards** it is fatal.
`createPeerConnection()` iterates the map's *values*:

```js
for (const { stream, kind } of localStreamsRef.current.values()) {
  for (const track of stream.getTracks()) {
    pc.addTrack(track, stream);   // ← stream is `fresh`; MSID becomes "xyz"
  }
```

`addTrack`'s second argument is what sets the `msid` in the SDP. So the
new leg goes out tagged `xyz`, while the relay still advertises the pub
as `abc` (the re-announce on reconnect correctly uses the map **key** —
see the `for (const [streamId, { kind }] of localStreamsRef.current)`
loop in `ws.onopen`). Link 3 fails. That peer is off the mix.

### Blast radius

Anyone who joins, reloads, or re-establishes ICE **after** a publisher
swaps a device gets a broken join to that publisher. Because god mode is
usually the tab that gets reloaded when something looks wrong, this bug
is *anti-correlated with the obvious fix*: reloading god mode reproduces
it, reloading the publisher clears it.

### Symptom signature (this is how you identify it)

- The affected peer's window on the god box is **blank** — the empty
  fallback, no video and no avatar. Not "video fine, no sound."
- Reloading **god mode does not help**.
- Reloading the **publisher's** page fixes it immediately.
- `/eq` shows no source row for that peer at all (as opposed to a row
  sitting at zero level).

### Triggers

Only the gear-icon edit dialog. All three call sites are in
`Desktop.tsx`: `swapAudioTrack`, `swapVideoTrack`,
`swapCameraAudioTrack`. **Nothing swaps automatically** — this was
checked. Commit `6aec5e2` ("never silently swap the user's mic for the
OS default") removed the last automatic path. So this bug requires a
human to have changed a mic or camera device mid-session.

---

## The 2026-08-07 incident — what is and isn't established

**Do not record this as solved. It isn't.**

### Observed

- God mode was getting no peer audio at all. Slop Tube (a local
  `<audio>` element, registered via `useAudioBusElement`, which bypasses
  links 1–4 entirely) was audible throughout.
- Reloading god mode did **not** restore peer audio.
- Reloading the publisher's page **did**.

### Established

That reload asymmetry is a real signal. Slop Tube being audible proves
the bus itself was healthy: `bus.active === true`, the `AudioContext`
was running (not suspended awaiting a gesture), and the master/EQ/
destination chain worked. So the failure was specific to the
`registerStream` path — peer voices — not the mixer.

### NOT established

Whether the MSID bug caused it. That requires someone to have used the
gear dialog to change a device beforehand, which was never confirmed.
The reload asymmetry is consistent with the MSID bug but does not prove
it uniquely.

### The one question that settles it

**Was the affected peer's window on the god box blank, or was it showing
video/avatar normally with no sound?**

- **Blank** → MSID mismatch. Link 3 failed. Fix is the MSID stability
  change below.
- **Video fine, no sound** → link 5 failed, not link 3. The MSID fix
  would be the wrong fix and would not help. Go read the competing
  hypotheses.

This was asked and not answered. Ask it first thing next time — before
writing any code.

---

## Competing hypotheses for a silent peer

Keep this table honest; add rows as you rule things in or out.

| Hypothesis | Signature | Status |
| --- | --- | --- |
| MSID drift after device swap (above) | Window **blank**; publisher reload fixes; god reload doesn't | Real bug, unproven as any incident's cause |
| Late audio track, first-mount-wins | Window shows **video fine**, no sound | Patched by `fbaa689` (`addtrack` listener). Verify the patch actually fires before re-blaming it |
| `registerStream` returned false, never retried | Window fine, no sound, no `/eq` row | **Unmitigated.** Returns false if `!bus.active` or `createMediaStreamSource` throws. `registered` stays false and *nothing ever retries* |
| Child-effect-before-parent ordering | Same as above, only on first paint | React runs child effects before parent. `VideoView`'s register can run before Desktop's `useAudioBusOwner` calls `bus.activate()`. Unlikely in practice (WebRTC takes seconds; peer windows can't mount in the first commit) but not impossible |
| AudioContext suspended (no gesture) | **Everything** silent including music | Ruled out for 08-07 — Slop Tube was audible |

### A trap worth knowing

`audioBus.registerStream()` returns **`true`** when it no-ops on an
already-known id:

```js
if (this.sources.has(id)) return true;
```

So callers cannot distinguish "registered successfully" from "skipped,
your stream was never attached." `fbaa689` works around this locally by
calling `unregister(id)` before re-registering. Any *new* caller will
walk straight into it.

---

## How to settle it empirically

Don't reason about this from static reading again — it produced a
confident-but-unproven answer once already. Reproduce it.

Use the headless three-browser probe (the `verify` skill, extended per
the `headless-webrtc-probe` recipe). The critical bits for this
repro, which have burned previous runs:

- `--use-fake-device-for-media-capture` is **ignored on this Mac**.
  Override `navigator.mediaDevices.getUserMedia` via
  `context.addInitScript` to return `canvas.captureStream(30)` plus an
  oscillator → `MediaStreamDestination` for audio.
- God-mode spectator: forge the `slop_room_<slug>` cookie (HMAC, see
  `room-auth.ts signRoomCookie`) on the **relay** origin, run the relay
  with `GOD_MODE_PASSWORD`, navigate to `/<slug>?godMode=<pw>`.
- `page.bringToFront()` on the publisher before asserting anything
  timing-dependent — background tabs get throttled.

**The assertion that proves or kills the MSID hypothesis:**

1. Publisher joins, publishes audio. Note the announced `streamId`.
2. Publisher swaps mic via the gear dialog (`swapAudioTrack`).
3. **A new peer joins** (or god mode reloads) — this is the step that
   matters; an existing connection won't show the bug.
4. On the new peer, read `event.streams[0].id` in `ontrack` and diff it
   against the publication's `streamId`.

If they differ, the bug is real and reproducible. Also assert the
downstream consequence: `audioBus.snapshot().sources` should be missing
a `peer-<streamId>` row.

---

## Proposed fixes

None of these are applied yet. Ordered by value.

### 1. Keep the MSID stable (fixes the confirmed defect)

`addTrack`'s stream argument is only an MSID token — **the track does
not need to be a member of that stream**. So keep the original
`MediaStream` object alive purely as an identity token and always pass
*it* to `addTrack`, while continuing to hand the `fresh` object to React
consumers:

```js
localStreamsRef.current.set(streamId, { stream: fresh, wireStream, kind });
…
pc.addTrack(track, wireStream);   // MSID stays === publication streamId
```

Contained to `usePeerMesh.ts`. Preserves the reason `fresh` exists.

### 2. Reconciliation sweep (fixes the whole class)

The structural fix. Periodically (or on any pub/stream change) diff the
set of publications that *should* be on the bus against
`audioBus.snapshot().sources`, and register anything missing.

This converts every failure in this doc — including ones not yet
discovered — from "silent until a human notices and reloads" into
"self-heals in about a second." It would have covered both this incident
and the one `fbaa689` chased. **This is the change that actually makes
the system not brittle**; #1 only closes one hole.

Do it at the bus/mesh level, not inside a component. The current design's
core mistake is that registration is owned by whichever component happens
to be rendering; the reconciler should not care about the view tree.

### 3. Make `registerStream` honest

Return a discriminated result (`"registered" | "already" | "failed"`)
instead of a boolean that says `true` for two very different outcomes,
and have it rebuild rather than no-op when the stream identity differs
from the one currently attached to that id.

---

## Invariants — don't regress these

- **A publication's `streamId` is stable for its whole life. The
  `MediaStream` object backing it is not.** Any code that assumes
  `someStream.id === pub.streamId` is wrong after a hot-swap. Always key
  off the publication id.
- **Never pass a post-`replaceTrack` stream object to `addTrack`.** That
  is exactly the defect above.
- **Slop Tube / music / file previews are not a control group.** They go
  through `useAudioBusElement` (a DOM element) and bypass links 1–4. "Music
  works, voices don't" narrows the fault to the peer path — it does *not*
  mean the bus is fine end-to-end for peers.
- **Reloading god mode is not a diagnostic.** For MSID drift it
  reproduces the bug rather than clearing it. Reload the *publisher* to
  distinguish.

---

## Related commits

| Commit | Relevance |
| --- | --- |
| `6aec5e2` | Removed automatic mic swapping — narrowed the MSID trigger to deliberate gear-dialog edits |
| `fbaa689` | Patched the late-audio-track race with an `addtrack` listener. Correct but symptomatic — it treats one link, not the missing reconciliation |
| `d5d59ad` | Per-recipient encoder tiers + H264-first. Investigated and **cleared** — `preferEfficientVideoCodecs` correctly skips non-video transceivers, `applySenderCaps` early-returns on `kind === "audio"` |
| `7688abf` | Video quality fix. Verified not to touch `replaceTrack` / `addTrack` / `streamId` |

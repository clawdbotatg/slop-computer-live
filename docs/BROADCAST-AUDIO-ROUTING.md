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

**Status: reproduced end-to-end and FIXED (2026-08-07).** Verified by
`ops/probes/audio-membership-probe.mjs` — see "Reproducing it" below for
the exact before/after numbers. Still *not* proven to be the cause of the
08-07 outage; see "what is and isn't established".

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

- **Blank** → MSID mismatch. Link 3 failed. Now **measured**, not
  inferred: the pre-fix probe run rendered the window with no bound
  media at all (`mediaEls: []`).
- **Video fine, no sound** → link 5 failed, not link 3. A different bug.

This was asked and never answered, so 08-07 stays formally unattributed.
It matters less now than it did: both links are covered — link 3 by the
MSID fix, links 4–5 by the reconciler — so whichever it was, it should
not recur silently. Ask the question anyway next time; it still tells you
which half of the system to look at, and there will be a next bug.

---

## Competing hypotheses for a silent peer

Keep this table honest; add rows as you rule things in or out.

| Hypothesis | Signature | Status |
| --- | --- | --- |
| MSID drift after device swap (above) | Window **blank** (signature now MEASURED); publisher reload fixes; god reload doesn't | **FIXED** 2026-08-07 (wireStream). Still unproven as 08-07's cause |
| Late audio track, first-mount-wins | Window shows **video fine**, no sound | Patched by `fbaa689` (`addtrack` listener); now also covered by the reconciler |
| `registerStream` returned false, never retried | Window fine, no sound, no `/eq` row | **FIXED** by the reconciler — verified by forcing `createMediaStreamSource` to throw on first mount: without the reconciler the voice never returns, with it the next tick rebuilds |
| Child-effect-before-parent ordering | Same as above, only on first paint | Same class as the row above, so the reconciler covers it. React runs child effects before parent, so `VideoView`'s register can run before Desktop's `useAudioBusOwner` calls `bus.activate()` |
| AudioContext suspended (no gesture) | **Everything** silent including music | Ruled out for 08-07 — Slop Tube was audible. NOT covered by the reconciler (registration succeeds against a suspended context) |

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

## Reproducing it — `ops/probes/audio-membership-probe.mjs`

Don't reason about this from static reading. It produced a
confident-but-unproven answer once already; the probe settled it in one
run. Bring the stack up per the `verify` skill (relay :8180, next :3210)
and run the probe from a dir with `playwright-core` linked.

Four assertions: publish works → a new leg advertises the published
streamId (the MSID fix) → god mode's mix contains the voice → the
reconciler heals a registration that failed on first try.

**Measured 2026-08-07**, same probe, toggling each fix off via `git stash`:

| Build | MSID advertised on the new leg | god window | bus sources |
| --- | --- | --- | --- |
| Pre-fix | `8000c6d1…` — the **post-swap** id | **blank** (`mediaEls: []`) | `[]` |
| Fixed | `8c465aa3…` = the **published** id | media bound, 1 audio track | `["peer-8c465aa3…"]` |

The pre-fix run also logged the app noticing and failing to help itself:
`[mesh] stream watchdog: pub … missing for 8005ms — rebuilding pc`.

**This settles the symptom signature empirically: MSID drift renders the
peer's window BLANK.** That is now measured, not inferred — which makes
the diagnostic question below decisive rather than suggestive.

Gotchas that burned runs here (beyond the `headless-webrtc-probe` recipe):

- `--use-fake-device-for-media-capture` is **ignored on this Mac**.
  Override `navigator.mediaDevices.getUserMedia` in an init script.
  The chromium binary is under `chrome-mac-arm64/`, not `chrome-mac/`.
- **`?godMode=` must be the navigation AFTER auth, never before a
  reload** — the app strips the param the moment it reads it, so a
  `reload()` silently downgrades the tab to an ordinary guest and you
  end up testing the wrong thing. Symptom: `isGodMode` false, no
  BroadcastChannel traffic at all, empty `sources` that look like a bug.
- `/auth/godmode` 403s with `room-auth-required` unless a valid
  `slop_room_<slug>` cookie is present — forge it (HMAC, dev secret in
  `packages/relay/src/config.ts`) on `domain: "localhost"`. `/debug`
  being passwordless in the UI does **not** exempt it.
- Desktop icon labels are uppercased by CSS; the DOM text is lowercase,
  so match case-insensitively. The share button is `Share Audio`, the
  gear is `aria-label="audio settings"` (matching `/gear|edit/i` hits
  the menu bar's "Edit ▾" instead), and the edit dialog's submit is
  `Save`.
- Submitting the edit dialog with **no device change still swaps the
  track** — `handleAudioSubmit` calls `swapAudioTrack` unconditionally
  in edit mode. That is the cheapest way to trigger the bug.

---

## Fixes applied (2026-08-07)

**They cover different links and neither subsumes the other — this is the
one thing to understand before touching either.** The probe proved it:
with the reconciler in place but the MSID fix reverted, the mix was still
empty. The reconciler cannot register a stream that never arrived under
the publication's id in the first place. Link 3 has to be right; the
reconciler only covers links 4–5.

### 1. Keep the MSID stable — fixes link 3

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
`wireStream`'s own tracks are stopped and stale after a swap — only ever
read its `.id`.

### 2. Reconciliation sweep — fixes links 4–5 as a class

`useAudioBusReconciler` in `useAudioBus.ts`, owned by Desktop (always
mounted), fed a `busPeerSources` memo derived from the two authoritative
sources: the relay's publication list and the streams WebRTC actually
delivered. Once a second it registers anything missing and prunes
anything under the `peer-` prefix that is no longer wanted.

This converts *unknown* failures in links 4–5 — including ones nobody has
thought of — from "silent until a human notices and reloads" into
"self-heals in about a second". It is what makes the remaining fragility
survivable rather than show-ending.

Deliberately owned by an always-mounted component, not the per-peer
leaves: the original design's mistake was that mix membership was a side
effect of whatever happened to be rendering. Registration stays
idempotent (`isStreamRegistered` compares stream identity, not just the
id), so the sweep does not churn the auto-leveler's per-source state.

### 3. `registerStream` is still dishonest — NOT fixed

It still returns `true` when it no-ops on a known id, so callers cannot
distinguish "registered" from "skipped". The reconciler routes around
this by asking `isStreamRegistered` first and unregistering before it
re-registers. A *new* caller will walk straight into the trap. Worth
returning a discriminated result (`"registered" | "already" | "failed"`)
next time this file is open.

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
- **The reconciler is not a licence to break link 3.** It cannot
  register a stream that never arrived under the publication's id.
  Measured, not assumed — see the fixes section.
- **Run `ops/probes/audio-membership-probe.mjs` after touching
  `replaceTrack`, `createPeerConnection`, `registerStream`, or the
  reconciler.** All four assertions should pass; each one has a verified
  failing control, so a pass means something.

---

## Adjacent: the double-offer race (`ops/probes/negotiation-trace-probe.mjs`)

Not an audio bug, but it surfaced while tracing these and it is the
thing most likely to produce the *next* "a peer has no media" report, so
it lives here until it has a better home.

`createPeerConnection` adds our local tracks, and every `addTrack`
queues a `negotiationneeded`. But every caller that creates a pc
(`peer_join`, bootstrap, the stream watchdog) *also* calls
`initiateOffer` immediately after. Both fire, and because `createOffer`
is async they both observe `signalingState === "stable"` before either
`setLocalDescription` lands — so Chrome mints a second offer with a
fresh set of mids and applying it throws:

```
32129ms pc2 createOffer  mid=[0,1,2]
32140ms pc2 createOffer  mid=[3,4,5]   <- second caller
32141ms pc2 setLocal     mid=[0,1,2]  -> have-local-offer
32145ms pc2 setLocal     mid=[3,4,5]  !! InvalidAccessError: order of m-lines
```

**It needs 2+ m-lines to bite** — with a single publication both offers
are identical and Chrome tolerates it. That is why it looks rare in
testing and is constant on a real show, where the host publishes camera
+ screen + mic.

Fixed with a per-pc `makingOffer` flag (perfect-negotiation style) in
`initiateOffer`. Measured over 3 runs each: pre-fix `concurrentOffers`
= 0, 2, 1; post-fix 0, 0, 0.

Mostly self-limiting — the first offer wins, so negotiation completes
and it reads as noise. **Unproven:** whether it also causes the
receiver-side variant (`handleOffer failed … setRemoteDescription …
order of m-lines`), which was seen once alongside a `stream watchdog …
rebuilding pc` and DOES mean no media arrives. Same error class, no
trace captured. If a "peer stuck on waiting for stream" report shows
up, start here.

Also visible in the trace and left alone: a redundant full offer/answer
round on every connection, because the queued `negotiationneeded` fires
the moment the answer completes. Wasteful, not broken.

---

## Related commits

| Commit | Relevance |
| --- | --- |
| `6aec5e2` | Removed automatic mic swapping — narrowed the MSID trigger to deliberate gear-dialog edits |
| `fbaa689` | Patched the late-audio-track race with an `addtrack` listener. Correct but symptomatic — it treats one link, not the missing reconciliation |
| `d5d59ad` | Per-recipient encoder tiers + H264-first. Investigated and **cleared** — `preferEfficientVideoCodecs` correctly skips non-video transceivers, `applySenderCaps` early-returns on `kind === "audio"` |
| `7688abf` | Video quality fix. Verified not to touch `replaceTrack` / `addTrack` / `streamId` |

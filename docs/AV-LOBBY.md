# The A/V Lobby — first-visit audio/video onboarding

Shipped 2026-09-01 (`887437c`). Read this before touching
`MediaLobby.tsx`, the hint arrow, the `HAS_BEEN_HERE` /
`AV_LOBBY_DONE` flags, or `lobby_report` — the flag choreography is
deliberate and easy to "fix" into a regression.

## Why it exists

Nearly every first-time guest struggled to get audio/video shared: they
landed on a full desktop, missed the share icons, and fought browser /
macOS permission prompts with no guidance. Austin's ask (2026-09-01):
a lobby that is the ONLY thing a first-timer sees — one question
("video or just audio?"), device pickers with live feedback, permission
hand-holding — and once they've shared successfully once, it never
appears again.

## The user journey

1. **Visit 1** (fresh browser): sign-in gates as usual, then the
   full-screen lobby instead of the desktop.
   - Choice step: "Are you sharing your video, or just your audio?" —
     two cards (same icons as the desktop share icons) + a small
     "just here to watch — skip" link.
   - Setup step: camera preview ("✓ this is what the room will see"),
     camera/resolution/mic pickers, amplitude ball, a mic level meter
     that latches to "✓ we can hear you!", denoise toggle, and a
     troubleshooting panel keyed off the actual getUserMedia error.
   - "Share video & enter →" / "Share audio & enter →" starts the real
     publication and drops them into the desktop, already live.
2. **Visit 2**: no lobby. The pre-existing hint arrow (`/hint.png`,
   icons filtered to Chat + share×3) shows once — 15s
   (`HINT_TIMEOUT_MS`) or until they double-click a share icon.
3. **Visit 3+**: nothing. Normal desktop.

While anyone is in the lobby, the whole room sees a pulsing amber
"🚪 lobby" badge on their row in the PinnedPeers guest list — "someone
is here, working on their A/V, not all the way in yet."

## Flag choreography (the part people will get wrong)

Two localStorage flags, logic in Desktop.tsx's hint-init effect:

| state (been-here / lobby-done) | result |
|---|---|
| unset / unset | **lobby** (visit 1, or a prior skip) |
| unset / set   | **hint arrow** (visit 2) |
| set / either  | nothing (incl. every pre-lobby visitor — no retro lobby) |

- `slop-av-lobby-done-v1` is written **only on a successful share from
  the lobby** (`handleLobbyCommit`, after `startCamera`/`startAudio`
  resolves true).
- `slop-has-been-here-v1` **deliberately stays unset through the lobby
  visit.** Do NOT write it in the lobby path — that's what reserves the
  hint arrow for visit 2. It's written only by `dismissHint` (timeout
  or share-icon double-click), exactly as before.
- **Skip is session-only** — writes nothing, lobby returns next visit,
  by design (they still haven't shared).
- God-mode/spectator sessions never see the lobby (`lobbyVisible`
  requires `!isGodMode`); spectators also never send `lobby_report`.
- The lobby renders at z 9990, under the auth gates (z 10000), so
  sign-in always completes first.

## Wire protocol (same contract as viewport_report)

- Client → relay: `{ type: "lobby_report", lobby: bool }`
- Relay: stores `lobby` on the peer entry (`peers.ts` PeerInfo), fans
  out `{ type: "peer_lobby", from, lobby }` to everyone else. The
  `hello` peers list carries it to late joiners automatically
  (`Room.listPeers()` spreads the entry).
- Client (`usePeerMesh`): `peerLobby: Record<peerId, boolean>` seeded
  from hello, updated on `peer_lobby`, cleaned on `peer_leave`.
  `reportLobby(bool)` dedupes on `lobbyRef` and writes our own row
  locally (the broadcast excludes the sender). **Reconnect:** the hello
  handler re-announces from `lobbyRef` — the relay's copy died with the
  old socket. Desktop drives it from one effect on `lobbyVisible`,
  with a cleanup that reports false.

## Files

- `packages/nextjs/components/MediaLobby.tsx` — the whole lobby UI:
  choice + setup steps, `PermissionHelp` (error-name-keyed fix steps,
  macOS/iOS-aware), `MicCheck` (analyser meter + latch), preview
  lifecycles copied from the share dialogs. Writes the same
  `MEDIA_PREF_KEYS` the dialogs write (ids + labels + denoise), so the
  real capture uses exactly what was previewed.
- `packages/nextjs/components/Desktop.tsx` — flag constants + init
  effect, `lobbyVisible`, `handleLobbyCommit`/`handleLobbySkip`,
  reportLobby effect, `<MediaLobby>` render (search "AV_LOBBY").
- `packages/nextjs/hooks/usePeerMesh.ts` — `peerLobby`, `reportLobby`,
  `lobbyRef`, hello seeding/re-announce, `peer_lobby` handler.
- `packages/nextjs/components/desktop/PinnedPeers.tsx` — the badge.
- `packages/relay/src/index.ts` (`case "lobby_report"`) +
  `packages/relay/src/peers.ts` (`lobby?: boolean`).

## Traps / invariants

1. **Never write HAS_BEEN_HERE from the lobby path** (see above).
2. `commit()` stops the preview tracks BEFORE `onCommit` — some
   cameras refuse a second simultaneous client. Keep that ordering.
3. On commit failure the lobby stays up, shows the error, and bumps
   `retryNonce` to re-acquire previews. Don't close it on failure —
   getting them shared IS the feature.
4. `startCamera`/`startAudio` return booleans; `handleLobbyCommit`
   relies on that to gate the done-flag. If useLocalMedia's contract
   changes, this breaks silently.
5. The lobby writes device prefs itself (copy of the dialogs' save
   logic, labels included for heal-by-label). If MEDIA_PREF_KEYS
   handling changes in the dialogs, change it here too.
6. `PermissionHelp` matches DOMException names
   (NotAllowedError/NotFoundError/NotReadableError/…) — a browser
   renaming these degrades to the generic message, not a crash.

## Testing

Manual first-timer reset (or just use incognito):

```js
localStorage.removeItem('slop-has-been-here-v1');
localStorage.removeItem('slop-av-lobby-done-v1');
```

Headless probes in `ops/probes/` (start the local stack per
`.claude/skills/verify/SKILL.md` first, then `node <probe>` from a dir
with the playwright-core symlink):

- `av-lobby-probe.mjs` — audio path end-to-end: fresh browser sees
  lobby, observer sees/loses the 🚪 badge, share publishes + writes the
  done flag (and NOT has-been-here), reload shows hint not lobby.
- `av-lobby-video-probe.mjs` — video path + back button + skip
  (skip must NOT write the done flag) + screenshots.

Both use the fake-gUM canvas/oscillator recipe (real fake-device flags
don't work on this Mac — see `ops/probes/audio-membership-probe.mjs`
header and docs/BROADCAST-AUDIO-ROUTING.md history).

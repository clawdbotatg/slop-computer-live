# Streaming slop.computer — two paths

There are two supported ways to get the live show out to viewers as an
HLS stream at `media.slop.computer/hls/live/index.m3u8`. Both end at the
same `mediamtx` ingest on the prod box — they differ in where the
browser is rendered and where ffmpeg encodes. This doc explains how each
works, the tradeoffs, and how to enable/disable the server-side variant.

```
                          ┌──────────────────────┐
                          │  mediamtx  (RTMP→HLS) │
                          │  ingest :1935        │
                          │  HLS    :8888        │
                          └──────────▲───────────┘
                                     │ RTMP push
                ┌────────────────────┴────────────────────┐
                │                                         │
       (A) godMode + your machine            (B) server-side broadcast
       OBS captures Chrome locally           Xvfb + Chrome + ffmpeg
       pushes RTMP over the public           on the EC2 box (loopback)
       internet to mediamtx                  next to mediamtx
```

## (A) godMode + your own machine — current default

1. Open `https://live.slop.computer/<room>?invite=…&godMode=<GOD_PASSWORD>`
   in a Chrome window on a streaming machine.
2. The relay mints a **spectator** session: it receives audio/video and
   chat, has no entry in the guest list, no cursor broadcast, and is
   silently rejected if it tries to publish or chat. (Relay enforces
   this — see `packages/relay/src/index.ts:3121` for the allow-list
   filter; client-side suppression is at `Desktop.tsx`.)
3. Size the window to **1568×888** — the desktop renders a faint
   dashed guide rectangle at that footprint so you can drag the
   bottom-right corner flush. That's the dimension the audience-side
   crop and chrome layout are tuned for.
4. Capture the Chrome window in OBS (or equivalent) and push RTMP to
   `rtmp://media.slop.computer:1935/live?user=live&pass=<MEDIAMTX_PUBLISH_PASS>`.

### Pros

- **Beefy local hardware.** Mac M-series and most desktops have
  hardware video encoders that outclass anything we'd reasonably put
  on the box. Smooth 30 fps, no dropped frames.
- **Real-time monitoring.** You see the encode in OBS as the audience
  sees it; can adjust scenes, levels, etc. live.
- **Simple deps.** Chrome + OBS, no Xvfb / PulseAudio / sudoers dance.

### Cons

- **Higher end-to-end latency.** The packet path is:
  EC2 → your ISP → your machine → encode → your ISP → mediamtx → HLS.
  Two extra public-internet hops vs. server-side.
- **Needs your machine on.** No "set it and forget it" — if your
  laptop sleeps, the stream dies.
- **Sensitive to upstream bandwidth.** ~3–6 Mbps required from
  whatever residential connection you're on.

## (B) Server-side broadcast — `slop-broadcast.service`

> ⚠️ **DORMANT — DO NOT START.** The unit is **masked** on the prod box
> (since 2026-06-11). Shows stream via flow (A) — OBS on a second
> machine. On 2026-06-11 a session restarted this unit after a deploy
> and it streamed a dead goblin room for 10 hours, putting a ghost
> stream on slop.computer right before a show and leaving a 13 GB junk
> recording. If you genuinely need it (and you almost certainly don't):
> `sudo systemctl unmask slop-broadcast` first, and **mask it again
> when done** — never leave it merely `stopped` or `disabled`.

A systemd unit on the prod box that boots `Xvfb` + a `PulseAudio` null
sink + `Chromium --app` (joined as godMode, same as flow A) + `ffmpeg`,
and pushes the captured window + sink-monitor to mediamtx over loopback
RTMP.

See `deploy/slop-broadcast.{sh,service,env.example}` and
`broadcastPlan.md` for the full pipeline.

### Pros

- **Lower latency.** Everything is loopback inside the EC2 box —
  Chrome → Xvfb → ffmpeg → mediamtx never leaves the machine. Saves
  the round-trip to your house.
- **Zero host involvement.** Runs 24/7, survives reboot if `enabled`,
  no laptop fans, no audio-routing nightmare on your side.
- **Reproducible.** Same env file every show; no "did I configure OBS
  right" drift.
- **Recording is automatic.** mediamtx writes fragmented MP4 to
  `/home/ubuntu/recordings/live/` on the same box — `/admin/finalize`
  pins the newest segment to IPFS.

### Cons

- **CPU-bound on the current box.** Encoder is `libx264 -preset
  ultrafast` and we still drop frames on the t3.xlarge under load —
  the show looks choppy. This is the dealbreaker today.
- **No visible display.** Xvfb is headless, so when something looks
  wrong you're debugging via `journalctl -u slop-broadcast` and
  blind screenshots, not a live preview.
- **Stop-the-world updates.** Changing rooms / godMode passwords
  rewrites the env file (`/admin/broadcast/url`) and restarts the
  unit; ~10 s of dead air.

**Future:** moving slop-broadcast to a beefier instance (more cores,
hardware nvenc, or just a c-class CPU box) likely solves the
choppiness. The latency win is real — once the encoder isn't the
bottleneck, server-side becomes the default.

## Switching between (A) and (B)

Both can coexist as systemd services — only one publishes to mediamtx
at a time (the second push gets refused). Today we run (A) by hand
when there's a show and leave (B) installed but stopped.

### From the admin panel

`https://live.slop.computer/admin` → **Server-side broadcast** section.
Buttons hit `/admin/broadcast/start | stop | restart` on the relay,
which shells out to `sudo -n systemctl …` (whitelisted in
`deploy/slop-broadcast.sudoers`). The panel polls
`/admin/broadcast/status` every 4 s and displays `active`, `enabled`,
uptime, and the tail of the journal.

To switch the broadcaster to a different room, edit the URL field at
the top of the panel and hit save — it rewrites `SLOP_URL` in the env
file and restarts the unit.

### From ssh

> ⚠️ The unit is **masked** in prod — every start/restart below will
> fail with "Unit slop-broadcast.service is masked" until you
> deliberately `sudo systemctl unmask slop-broadcast`. That's the
> point. Re-mask when you're done.

```bash
# state
ssh slopcomputer 'systemctl is-active slop-broadcast'
ssh slopcomputer 'systemctl is-enabled slop-broadcast'
ssh slopcomputer 'journalctl -u slop-broadcast -n 50 --no-pager'

# now (doesn't affect boot behavior)
ssh slopcomputer 'sudo systemctl start slop-broadcast'
ssh slopcomputer 'sudo systemctl stop slop-broadcast'
ssh slopcomputer 'sudo systemctl restart slop-broadcast'

# boot behavior (doesn't affect the current run)
ssh slopcomputer 'sudo systemctl enable slop-broadcast'    # auto-start on reboot
ssh slopcomputer 'sudo systemctl disable slop-broadcast'   # don't auto-start

# combined: do both at once
ssh slopcomputer 'sudo systemctl enable --now slop-broadcast'
ssh slopcomputer 'sudo systemctl disable --now slop-broadcast'
```

`stop` ≠ `disable`. `stop` kills the current run. `disable` removes it
from the boot-time set. They're orthogonal. The admin panel only
exposes start/stop/restart (the sudoers file at
`deploy/slop-broadcast.sudoers:10` whitelists only those three verbs);
enable/disable is ssh-only by design.

### When you stop it, what gets killed

The unit is `KillMode=mixed` with `TimeoutStopSec=10` — systemd
SIGTERMs the wrapper script, then SIGKILLs the whole cgroup. All four
children — `Xvfb`, `chromium`, the PulseAudio null sink, and `ffmpeg`
— exit within ten seconds. No orphan processes.

The unit is `Restart=on-failure`, so a clean stop won't trigger a
respawn. It stays stopped until you start it again.

### What stays running

`mediamtx.service` is intentionally **not** linked to slop-broadcast's
lifecycle. The broadcast unit has `Requires=mediamtx.service`, which is
a start-order dependency, not a stop dependency. mediamtx keeps
serving HLS / accepting RTMP so flow (A) continues to work when
slop-broadcast is stopped.

The other unrelated services (`slop-live`, `slop-relay`,
`slop-browser-host`) are also untouched.

## Quick decision table

| Situation                              | Use   |
| -------------------------------------- | ----- |
| Live show today, you're at your desk   | A     |
| Smoothness matters more than latency   | A     |
| 24/7 unattended broadcast              | B     |
| Latency matters (e.g. interactive)     | B (once box is beefier) |
| Recording for IPFS finalize            | Either — recording is on the mediamtx side |
| You don't trust your local upload      | B     |

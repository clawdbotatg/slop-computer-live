# Server-side Broadcast Pipeline

Replace host-side capture (OBS/SCK/ffmpeg) with a Chromium + ffmpeg pipeline
running on the EC2 box right next to mediamtx and the relay. Server-side
capture eliminates the host audio-routing nightmare (no human ears to protect),
removes a redundant network round-trip, and makes the broadcast reproducible.

Confidence on first working draft within 4–8 focused hours: **~85%**.

## Architecture

```
slop.computer peers (WebRTC)
        │
        ▼
EC2 box (already running):
  ├─ slop-relay         (signaling, auth, admin endpoints)
  ├─ slop-browser-host  (Puppeteer/Chrome — already deployed)
  ├─ mediamtx           (RTMP :1935 ingest, HLS :8888 playback, recording)
  └─ NEW: slop-broadcast
        │
        ├─ Xvfb :99                       (virtual framebuffer, 1280x720)
        ├─ PulseAudio null sink "slop"    (Chrome writes audio here)
        ├─ Chromium --app                 (joins live.slop.computer w/ godMode)
        │     renders slop UI, plays peers' audio to slop sink
        └─ ffmpeg
              -f x11grab     :99             (video)
              -f pulse       slop.monitor    (audio)
              -c:v libx264   -preset veryfast
              -c:a aac
              -f flv         rtmp://localhost:1935/live?user=...&pass=...
              │
              ▼
        mediamtx → HLS (mpegts variant — Chrome-compatible)
              │
              ├─ media.slop.computer/hls/live/index.m3u8  (viewers, via Caddy)
              └─ /home/ubuntu/recordings/live/…           (recording → IPFS via /admin/finalize)
```

Nothing crosses the public internet inside the pipeline — RTMP push is loopback,
HLS pull is loopback-to-Caddy. The host machine and the VM are out of the loop.

## Stages

### Stage 1 — Manual proof on the EC2 box (1–2h)

Goal: produce a 10-second mp4 with both video and audio, pulled back to the
host and visually/aurally verified. No streaming yet.

```bash
# Most deps likely present from slop-browser-host; install gaps:
sudo apt-get install -y xvfb pulseaudio ffmpeg chromium-browser

# Virtual display
Xvfb :99 -screen 0 1280x720x24 &

# Audio: null sink for Chrome to write into; ffmpeg reads its monitor
pulseaudio --start
pactl load-module module-null-sink sink_name=slop \
  sink_properties=device.description=slop

# Chromium pointed at the sink + joined as god-mode spectator
PULSE_SINK=slop DISPLAY=:99 chromium \
  --app="https://live.slop.computer/jarjar?invite=…&godMode=…" \
  --no-sandbox \
  --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream \
  --window-position=0,0 --window-size=1280,720 \
  --user-data-dir=/tmp/slop-broadcast-profile &

sleep 5   # let Chrome paint and join the room

ffmpeg -framerate 30 -f x11grab -video_size 1280x720 -i :99 \
       -f pulse -i slop.monitor \
       -t 10 \
       -c:v libx264 -preset veryfast -pix_fmt yuv420p \
       -c:a aac -b:a 160k \
       /tmp/proof.mp4
```

**Exit gate:** scp `/tmp/proof.mp4` to host, open it, confirm both tracks
present, video shows the slop UI, audio has the room sound. If yes → Stage 2.
If no → diagnose at this stage (don't move forward until proof.mp4 is right).

### Stage 2 — Push to mediamtx (30m)

Replace the file output with the loopback RTMP. Reuse our existing mediamtx
publish credentials (`MEDIAMTX_PUBLISH_PASS` already in relay env).

```bash
ffmpeg … \
  -c:v libx264 -preset veryfast -b:v 6000k -maxrate 6000k -bufsize 12000k \
  -g 60 -keyint_min 60 \
  -c:a aac -b:a 160k -ar 48000 \
  -f flv "rtmp://localhost:1935/live?user=live&pass=$MEDIAMTX_PUBLISH_PASS"
```

**Exit gate:**
- `curl https://media.slop.computer/hls/live/index.m3u8` returns a valid manifest
  with `CODECS="avc1.…,mp4a.…"`, `RESOLUTION=1280x720`.
- Stream plays in Chrome desktop natively (mpegts variant is already set in
  `deploy/mediamtx.yml`).
- Recording lands under `/home/ubuntu/recordings/live/<timestamp>…`.

### Stage 3 — systemd unit + admin controls (1–2h)

Convert the manual stack into a supervised, env-driven service. Mirror the
pattern used by `slop-relay.service`, `slop-live.service`,
`slop-browser-host.service`, `mediamtx.service`.

`deploy/slop-broadcast.service`:
- `Type=simple`, `Restart=on-failure`
- ExecStart points at a wrapper script that boots Xvfb + pulse + Chromium + ffmpeg
  in the right order and tears them down on exit
- EnvironmentFile reads `SLOP_URL`, `SLOP_GOD_MODE_PASSWORD`, `MEDIAMTX_PUBLISH_PASS`,
  output resolution/bitrate
- Runs as the `ubuntu` user (matches mediamtx for recordings dir permissions)

Wrapper script `deploy/slop-broadcast.sh`:
- One bash script orchestrating all four processes with traps + cleanup
- Logs to journald via stdout/stderr

Relay endpoints (extend the existing `/admin/*` surface):
- `POST /admin/broadcast/start` — `systemctl start slop-broadcast`
- `POST /admin/broadcast/stop`  — `systemctl stop slop-broadcast`
- `GET  /admin/broadcast/status` — `systemctl is-active` + parse last
  journalctl entries
- Admin panel adds Start/Stop buttons next to the existing service rows.

**Exit gate:**
- `sudo systemctl restart slop-broadcast` brings up a working stream within ~15s
- Kill Chromium manually → service auto-restarts → stream recovers
- Admin panel can start/stop without ssh

### Stage 4 — Polish (open-ended, do after stage 3 is solid)

- Health endpoint reflecting "stream up, last frame at T-Ns" — surface to admin
  status row
- Per-show URL switching: relay endpoint that updates the env file +
  `systemctl restart`. Hot-swap from `/jarjar` to `/ep0` without redeploying.
- Chrome crash recovery beyond `Restart=on-failure`: detect "Chrome quit but
  ffmpeg still alive" and force the whole stack to cycle.
- Investigate GPU/vaapi encoding if the instance type supports it. Probably
  not worth it — libx264 veryfast on a modest instance handles 720p30 with
  plenty of headroom.
- Multiple concurrent broadcasts (would need multiple Xvfb displays, multiple
  null sinks, multiple mediamtx paths). Defer until needed.

## Risks (named)

1. **PulseAudio on a system user**: needs system-wide daemon or
   `systemctl --user`. Standard pattern, plenty of docs. Most likely first-day
   debugging.
2. **WebRTC quirks in software-rendered Chromium**: autoplay + fake-media
   flags cover the common ones. `slop-browser-host` already runs Chromium
   server-side, so the rough edges are likely already known to the team.
3. **CPU headroom**: 720p30 libx264 veryfast ~10–20% of one core on m5.xlarge.
   Verify on the actual instance under load. Mitigation if low: drop preset
   (`ultrafast`) or bitrate (4500 kbps is plenty for the slop UI).
4. **Slop site code path under headless-ish Chromium**: tested in Stage 1.
   Highest-uncertainty unknown but contained — if it breaks, we'll see in
   the first mp4 proof, not in production.

## What gets retired

- `slop-computer-container/` — the entire VM is dead weight once server-side
  works. tart VM, OBS provisioner, host-side capture script all gone.
- `slop-stream.sh` + `slop-stream-capture.swift` (host pipeline) — host machine
  no longer touches the broadcast.

## First step

SSH to the EC2 box, run the Stage 1 script, pull `/tmp/proof.mp4` back. If the
file has clean video + audio of the slop room, we know the whole architecture
works and the rest is plumbing.

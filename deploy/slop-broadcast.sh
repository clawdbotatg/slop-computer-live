#!/usr/bin/env bash
# slop-broadcast — server-side broadcaster for slop.computer.
#
# Boots Xvfb + a PulseAudio null sink + a Chromium --app pointed at the
# live room (with godMode so it joins as a silent spectator), then captures
# the X display and the sink's monitor with ffmpeg and pushes the result
# to mediamtx over loopback RTMP.
#
# Designed to run under systemd (see deploy/slop-broadcast.service). All
# four child processes get cleaned up on signal so `systemctl restart`
# cycles the whole stack atomically.
#
# Env:
#   SLOP_URL              — Chrome --app URL (the live room, with godMode)
#   MEDIAMTX_PUBLISH_USER — RTMP basic-auth user      (default: live)
#   MEDIAMTX_PUBLISH_PASS — RTMP basic-auth password  (required)
#   RTMP_URL              — full push URL (overrides the constructed one)
#   OUT_W, OUT_H          — capture/encode size       (default: 1280x720)
#   FPS                   — frame rate                (default: 30)
#   VBITRATE_K            — video bitrate, kbps       (default: 4500)
#   ABITRATE_K            — audio bitrate, kbps       (default: 160)
#   CHROME_BIN            — path to chromium binary   (default: puppeteer cache)
#   AUTO_ENTER            — synth-click center after Chrome boots (default: 1)

set -euo pipefail

SLOP_URL="${SLOP_URL:?SLOP_URL is required}"
RTMP_USER="${MEDIAMTX_PUBLISH_USER:-live}"
RTMP_PASS="${MEDIAMTX_PUBLISH_PASS:?MEDIAMTX_PUBLISH_PASS is required}"
RTMP_DEFAULT="rtmp://localhost:1935/live?user=${RTMP_USER}&pass=${RTMP_PASS}"
RTMP_URL="${RTMP_URL:-$RTMP_DEFAULT}"

OUT_W="${OUT_W:-1280}"
OUT_H="${OUT_H:-720}"
FPS="${FPS:-30}"
VBITRATE_K="${VBITRATE_K:-4500}"
ABITRATE_K="${ABITRATE_K:-160}"
AUTO_ENTER="${AUTO_ENTER:-1}"

DISPLAY_NUM=":99"
PULSE_SINK_NAME="slop"
PROFILE_DIR="/tmp/slop-broadcast-profile"
PULSE_RUNTIME="/tmp/slop-broadcast-pulse"

# Default Chromium = the one Puppeteer already pulled for slop-browser-host.
DEFAULT_CHROME="$(ls -d /home/ubuntu/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome 2>/dev/null | head -1 || true)"
CHROME_BIN="${CHROME_BIN:-$DEFAULT_CHROME}"
if [[ -z "$CHROME_BIN" || ! -x "$CHROME_BIN" ]]; then
  echo "[broadcast] no chromium binary found (set CHROME_BIN)" >&2
  exit 1
fi

PIDS=()

log()  { printf '[broadcast] %s\n' "$*"; }
fail() { printf '[broadcast] ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  log "shutting down…"
  # Kill in reverse order: ffmpeg → chrome → pulse → xvfb
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Hard-kill anything still alive after a beat
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
  # Stop pulse explicitly — it daemonised, so it's not in PIDS
  PULSE_RUNTIME_PATH="$PULSE_RUNTIME" pulseaudio --kill 2>/dev/null || true
  pkill -f "user-data-dir=$PROFILE_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── 1. Xvfb ───────────────────────────────────────────────────────────
log "starting Xvfb ${DISPLAY_NUM} (${OUT_W}x${OUT_H}x24)"
Xvfb "$DISPLAY_NUM" -screen 0 "${OUT_W}x${OUT_H}x24" -nolisten tcp &
PIDS+=($!)
# Wait for the socket to exist (a couple hundred ms in practice)
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ]] && break
  sleep 0.2
done
[[ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ]] || fail "Xvfb did not come up"

# ── 2. PulseAudio + null sink ─────────────────────────────────────────
log "starting PulseAudio (runtime=$PULSE_RUNTIME)"
mkdir -p "$PULSE_RUNTIME"
chmod 700 "$PULSE_RUNTIME"
# --exit-idle-time=-1 keeps it alive without active clients.
# --daemonize=yes  — we don't supervise it directly; cleanup() kills it.
PULSE_RUNTIME_PATH="$PULSE_RUNTIME" pulseaudio \
  --daemonize=yes \
  --exit-idle-time=-1 \
  --log-target=stderr \
  --disallow-exit \
  --disable-shm \
  --high-priority=no \
  --realtime=no
# Confirm pulse is up
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if PULSE_RUNTIME_PATH="$PULSE_RUNTIME" pactl info >/dev/null 2>&1; then break; fi
  sleep 0.2
done
PULSE_RUNTIME_PATH="$PULSE_RUNTIME" pactl info >/dev/null 2>&1 \
  || fail "pulseaudio did not come up"

PULSE_RUNTIME_PATH="$PULSE_RUNTIME" pactl load-module module-null-sink \
  sink_name="$PULSE_SINK_NAME" \
  sink_properties=device.description="$PULSE_SINK_NAME" >/dev/null
log "null sink \"$PULSE_SINK_NAME\" loaded"

# ── 3. Chromium ───────────────────────────────────────────────────────
log "launching Chromium --app at ${OUT_W}x${OUT_H}"
rm -rf "$PROFILE_DIR"
mkdir -p "$PROFILE_DIR"
env \
  DISPLAY="$DISPLAY_NUM" \
  PULSE_SINK="$PULSE_SINK_NAME" \
  PULSE_RUNTIME_PATH="$PULSE_RUNTIME" \
  PULSE_SERVER="unix:$PULSE_RUNTIME/native" \
  "$CHROME_BIN" \
    --app="$SLOP_URL" \
    --no-sandbox \
    --no-first-run \
    --no-default-browser-check \
    --disable-features=NotificationTriggers \
    --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream \
    --window-position=0,0 \
    --window-size="${OUT_W},${OUT_H}" \
    --user-data-dir="$PROFILE_DIR" \
  &
PIDS+=($!)

# Give Chrome a few seconds to render the room and connect.
sleep 6

# The slop site shows a "click to enter" modal because the browser
# autoplay policy requires a user gesture before <audio> elements can
# unmute. Chromium's --autoplay-policy flag opens the gate for the
# browser, but the site's own modal needs a synthetic click.
if [[ "$AUTO_ENTER" == "1" ]]; then
  if command -v xdotool >/dev/null 2>&1; then
    log "synth-click center of window to dismiss enter-modal"
    DISPLAY="$DISPLAY_NUM" xdotool mousemove "$((OUT_W/2))" "$((OUT_H/2))" || true
    sleep 0.3
    DISPLAY="$DISPLAY_NUM" xdotool click 1 || true
  else
    log "xdotool not installed; skipping auto-enter click"
  fi
fi

# ── 4. ffmpeg → RTMP ──────────────────────────────────────────────────
# Log a redacted form of the RTMP URL — the journal is world-readable
# on the box and we don't want the publish password in plaintext there.
RTMP_LOG="${RTMP_URL//pass=$RTMP_PASS/pass=****}"
log "starting ffmpeg → $RTMP_LOG"
env \
  DISPLAY="$DISPLAY_NUM" \
  PULSE_RUNTIME_PATH="$PULSE_RUNTIME" \
  PULSE_SERVER="unix:$PULSE_RUNTIME/native" \
  ffmpeg -hide_banner -loglevel warning \
    -framerate "$FPS" -f x11grab -video_size "${OUT_W}x${OUT_H}" -i "$DISPLAY_NUM" \
    -f pulse -i "${PULSE_SINK_NAME}.monitor" \
    -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
      -b:v "${VBITRATE_K}k" -maxrate "${VBITRATE_K}k" \
      -bufsize "$((VBITRATE_K * 2))k" \
      -g "$((FPS * 2))" -keyint_min "$((FPS * 2))" \
    -c:a aac -b:a "${ABITRATE_K}k" -ar 48000 -ac 2 \
    -fps_mode cfr \
    -f flv "$RTMP_URL" \
  &
PIDS+=($!)
FFMPEG_PID=${PIDS[-1]}

log "broadcast up. pids: xvfb=${PIDS[0]} chrome=${PIDS[1]} ffmpeg=$FFMPEG_PID"

# When ffmpeg exits (mediamtx died, RTMP got disconnected, etc.) we
# want systemd to restart the whole thing. So we wait on ffmpeg
# specifically, not the whole job. The `trap` above handles teardown
# of chrome+xvfb+pulse when this shell exits.
wait "$FFMPEG_PID"
EXIT=$?
log "ffmpeg exited with code $EXIT"
exit "$EXIT"

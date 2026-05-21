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
FPS="${FPS:-24}"
VBITRATE_K="${VBITRATE_K:-3000}"
ABITRATE_K="${ABITRATE_K:-160}"
AUTO_ENTER="${AUTO_ENTER:-1}"
# libx264 preset. ultrafast is ~2x faster than veryfast but with larger
# files for the same quality. On a t3.xlarge with heavy CPU-steal we
# need the headroom — choppy output is much worse than fatter segments.
X264_PRESET="${X264_PRESET:-ultrafast}"
# Crop pixels off the top of the chrome window before encoding —
# Puppeteer's "Chrome for Testing" build always shows a ~80px yellow
# automation-warning infobar at the top that we don't want in the
# stream. Chrome's `--app` mode would normally hide all browser chrome
# but this specific infobar is hardcoded on. Rendering the window
# CROP_TOP px taller and discarding the top band gets clean output
# at OUT_W x OUT_H without messing with aspect ratio.
CROP_TOP="${CROP_TOP:-80}"

# Internal Xvfb / chrome render size = output + crop band.
WIN_H=$((OUT_H + CROP_TOP))
WIN_W="$OUT_W"

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
log "starting Xvfb ${DISPLAY_NUM} (${WIN_W}x${WIN_H}x24, crop top ${CROP_TOP})"
Xvfb "$DISPLAY_NUM" -screen 0 "${WIN_W}x${WIN_H}x24" -nolisten tcp &
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
log "launching Chromium --app at ${WIN_W}x${WIN_H}"
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
    --window-size="${WIN_W},${WIN_H}" \
    --user-data-dir="$PROFILE_DIR" \
    --enable-logging=stderr --v=0 \
  2>/dev/null &
# Chrome on headless Linux fills the journal with dbus/UPower/GCM/gpu
# errors that mean nothing to us. Discard chrome's stderr so the
# admin-panel log view is actually useful. We still see the
# broadcaster's own [broadcast] lines + ffmpeg warnings.
CHROME_PID=$!
PIDS+=("$CHROME_PID")

# Give Chrome a few seconds to render the room and connect.
sleep 6

# The slop site shows a "click to enter" modal because the browser
# autoplay policy requires a user gesture before <audio> elements can
# unmute. Chromium's --autoplay-policy flag opens the gate for the
# browser, but the site's own modal needs a synthetic click.
if [[ "$AUTO_ENTER" == "1" ]]; then
  if command -v xdotool >/dev/null 2>&1; then
    log "synth-click center of window to dismiss enter-modal"
    DISPLAY="$DISPLAY_NUM" xdotool mousemove "$((WIN_W/2))" "$((WIN_H/2))" || true
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
    -thread_queue_size 64 \
    -framerate "$FPS" -f x11grab -video_size "${WIN_W}x${WIN_H}" -i "$DISPLAY_NUM" \
    -thread_queue_size 64 \
    -f pulse -i "${PULSE_SINK_NAME}.monitor" \
    -vf "crop=${OUT_W}:${OUT_H}:0:${CROP_TOP}" \
    -c:v libx264 -preset "$X264_PRESET" -tune zerolatency -pix_fmt yuv420p \
      -b:v "${VBITRATE_K}k" -maxrate "${VBITRATE_K}k" \
      -bufsize "$((VBITRATE_K * 2))k" \
      -g "$((FPS * 2))" -keyint_min "$((FPS * 2))" \
    -c:a aac -b:a "${ABITRATE_K}k" -ar 48000 -ac 2 \
    -fps_mode cfr \
    -f flv "$RTMP_URL" \
  &
FFMPEG_PID=$!
PIDS+=("$FFMPEG_PID")

log "broadcast up. pids: xvfb=${PIDS[0]} chrome=$CHROME_PID ffmpeg=$FFMPEG_PID"

# Supervise BOTH ffmpeg and chrome. If chrome dies but ffmpeg keeps
# reading the (now-frozen) x11 framebuffer we'd silently publish a
# stuck frame forever — which already happened once during testing
# (see broadcastPlan.md "Chrome crash recovery"). Exiting on either
# child's death trips systemd's Restart=on-failure and cycles the
# whole stack.
while kill -0 "$FFMPEG_PID" 2>/dev/null && kill -0 "$CHROME_PID" 2>/dev/null; do
  sleep 2
done

if ! kill -0 "$CHROME_PID" 2>/dev/null; then
  log "chromium exited unexpectedly — cycling whole stack"
  exit 1
fi
# ffmpeg exited — surface its exit code so systemd decides whether to retry.
wait "$FFMPEG_PID"
EXIT=$?
log "ffmpeg exited with code $EXIT"
exit "$EXIT"

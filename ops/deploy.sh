#!/usr/bin/env bash
# Local-build → rsync-to-prod deploy for slop-computer-live.
#
# Why local-build: prod is a 7.6GB EC2 box that has OOM'd during Next.js
# builds in the past (4G heap + Chromium + IPFS + everything else = no
# headroom). Building locally on a beefy Mac, then shipping the artifact,
# removes that whole failure mode.
#
# Concurrency: refuses to start if another deploy is already in flight
# (lockfile in /tmp). Two features can't fight over the same prod.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="/tmp/slop-deploy.lock"
PROD_HOST="slopcomputer"
PROD_PATH="/home/ubuntu/slop-computer-live"

# --- Concurrency lock --------------------------------------------------------

if [ -f "$LOCK_FILE" ]; then
  pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "✗ Another deploy is running (PID $pid). Yielding."
    echo "  Wait for it to finish, or force-clear with:  rm $LOCK_FILE"
    exit 1
  fi
  echo "⚠ Stale lock from PID $pid (process gone); clearing."
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# --- Pre-flight checks -------------------------------------------------------

cd "$REPO_ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Working tree is dirty. Commit or stash before deploying."
  git status --short
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "✗ Not on main (currently '$branch'). Refusing to deploy."
  exit 1
fi

git fetch origin --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "✗ Local main is not in sync with origin/main. Push or pull first."
  git log --oneline --left-right HEAD...origin/main | head -10
  exit 1
fi

echo "✓ Pre-flight clean — main @ $(git rev-parse --short HEAD)"

# --- Build (locally) ---------------------------------------------------------

echo ""
echo "→ Building Next.js…"
yarn next:build

echo ""
echo "→ Building relay…"
yarn relay:build

# --- Ship to prod (live keeps serving) ---------------------------------------
# Strategy: rsync the new build into a *sibling* directory while the live
# Next.js process keeps serving from the old .next. --link-dest hardlinks
# unchanged files from the existing .next (so transfer is incremental even
# though we're targeting a fresh dir). --exclude='cache/' skips webpack's
# incremental-build cache, which is hundreds of MB of pure waste on prod.

PROD_NEXT="$PROD_PATH/packages/nextjs"

echo ""
echo "→ Cleaning any stale staging/old dirs on ${PROD_HOST}…"
ssh "$PROD_HOST" "rm -rf $PROD_NEXT/.next.staging $PROD_NEXT/.next.old"

echo "→ Rsyncing Next.js build → .next.staging (incremental via --link-dest, no cache/)…"
rsync -az --delete \
  --link-dest="$PROD_NEXT/.next/" \
  --exclude='cache/' \
  packages/nextjs/.next/ \
  "$PROD_HOST:$PROD_NEXT/.next.staging/"

echo "→ Rsyncing relay build…"
rsync -az --delete \
  packages/relay/dist/ \
  "$PROD_HOST:$PROD_PATH/packages/relay/dist/"

echo "→ Syncing source + installing prod deps (live still serving)…"
# Mirror source on prod so what's on disk matches what we built.
# --ff-only refuses to rewrite history; --immutable verifies lockfile.
ssh "$PROD_HOST" "cd $PROD_PATH && git fetch origin --quiet && git pull --ff-only origin main && yarn install --immutable"

# --- Atomic swap + restart (downtime window) ---------------------------------
# This is the ONLY phase where slop-live is down. mv operations on the same
# filesystem are atomic. Cleanup of .next.old runs in the background so it
# doesn't extend the downtime window.

echo ""
echo "→ Atomic swap + restart…"
swap_start=$(date +%s)
ssh "$PROD_HOST" "
  set -e
  cd $PROD_NEXT
  sudo systemctl stop slop-live
  mv .next .next.old
  mv .next.staging .next
  sudo systemctl start slop-live
  ( rm -rf .next.old > /dev/null 2>&1 & )
"

# Poll HTTPS until live recovers, so we measure REAL HTTP downtime
# (systemd "started" returns before Next.js is actually serving).
echo "→ Waiting for HTTPS recovery…"
http_back=""
for i in $(seq 1 60); do
  if curl -s -m 2 -o /dev/null -w "%{http_code}" "https://live.slop.computer/" 2>/dev/null | grep -qE '^[23]'; then
    http_back="yes"
    break
  fi
  sleep 0.5
done
swap_end=$(date +%s)

if [ -z "$http_back" ]; then
  echo "  ⚠ HTTP did not recover within 30s — check journalctl on $PROD_HOST"
else
  echo "  ✓ HTTPS back after $((swap_end - swap_start))s"
fi

echo "→ Restarting relay (WS reconnect — no HTTP downtime)…"
ssh "$PROD_HOST" 'sudo systemctl restart slop-relay'

# --- Health check ------------------------------------------------------------

sleep 2
echo ""
echo "→ Health check…"

all_ok=true
for svc in slop-live slop-relay; do
  state="$(ssh "$PROD_HOST" "sudo systemctl is-active $svc" || echo failed)"
  if [ "$state" = "active" ]; then
    echo "  ✓ $svc: $state"
  else
    echo "  ✗ $svc: $state"
    all_ok=false
  fi
done

if ! $all_ok; then
  echo ""
  echo "✗ Deploy finished but a service is unhealthy. Check journalctl on $PROD_HOST."
  exit 1
fi

echo ""
echo "✓ Deploy complete — $(git rev-parse --short HEAD) live on prod"

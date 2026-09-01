#!/bin/bash
# DRY RUN ONLY - CONTAINS NO DELETE. Proves each source.mp4 is byte-recoverable:
#   1. derive CID from the file's own bytes (no external trust)
#   2. that CID is recursively pinned
#   3. its DAG is complete offline
#   4. content read BACK OUT of the blockstore sha256-matches the file
# Resumable: slugs already in RESULTS are skipped.
# Every step has a timeout -- one wedged kubo stream stalled the first run
# for 90 minutes (2026-08-31).
RESULTS=/home/ubuntu/verify-results.txt
TO=900
cd /home/ubuntu/clawd-clipper/out || exit 1
emit() { printf "%-22s %-8s %-10s %s\n" "$1" "$2" "$3" "$4" >> "$RESULTS"; }
for d in */; do
  s=${d%/}; f="$s/source.mp4"
  [ -f "$f" ] || continue
  grep -q "^$s " "$RESULTS" 2>/dev/null && continue
  sz=$(stat -c %s "$f"); gb=$(awk -v b="$sz" 'BEGIN{printf "%.1f", b/1073741824}')
  if pgrep -f "index\.ts $s( |$)" >/dev/null 2>&1; then
    emit "$s" KEEP "$gb" "clip job running"; continue
  fi
  cid=$(timeout $TO ipfs add -n -Q "$f" 2>/dev/null)
  [ -z "$cid" ] && { emit "$s" KEEP "$gb" "cid derive failed/timeout"; continue; }
  timeout 120 ipfs pin ls --type=recursive "$cid" >/dev/null 2>&1 || { emit "$s" KEEP "$gb" "NOT PINNED $cid"; continue; }
  timeout $TO ipfs refs -r --offline "$cid" >/dev/null 2>&1 || { emit "$s" KEEP "$gb" "DAG INCOMPLETE $cid"; continue; }
  fh=$(timeout $TO sha256sum "$f" 2>/dev/null | cut -d' ' -f1)
  ih=$(timeout $TO ipfs cat --offline "$cid" 2>/dev/null | sha256sum | cut -d' ' -f1)
  if [ -n "$fh" ] && [ "$fh" = "$ih" ]; then
    emit "$s" SAFE "$gb" "$cid"
  else
    emit "$s" KEEP "$gb" "ROUNDTRIP FAIL $cid"
  fi
done
echo "=== DONE $(date) ===" >> "$RESULTS"

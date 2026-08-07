# Post-mortem: the Aug 5 + Aug 6 2026 server freezes

Two total-outage freezes of the slop.computer EC2 box in two days.
Root-caused and fixed on 2026-08-07. Written as a handoff: everything
a future agent needs to re-diagnose something like this in minutes
instead of hours.

## TL;DR

`clawd-clipper`'s stitched-clip render built its ffmpeg command as ONE
full-file input with per-span `trim` branches inside `-filter_complex`.
That shape makes ffmpeg decode the whole 2-hour episode from t=0 and
buffer raw decoded frames for the later spans without bound: **130 MB →
8.8 GB RSS in 60 seconds** on a 15 GB box. The kernel never OOM-killed
it and never panicked — it just thrashed (constant page re-reads at the
EBS throughput cap) until userspace, including sshd and the network
stack's ability to answer pings, effectively stopped. Fixed in
clawd-clipper `165579e`: per-span `-ss/-t` input seeking (the shape
`cutClip` always used). Same stitch now renders in 511 MB / 22 s.

## Timeline (UTC)

- **Aug 5 (evening)** — freeze #1, after that day's episode +
  clipper run. Recovered by manual reboot at Aug 6 02:59.
- **Aug 6 20:36** — clipper run starts for the day's episode
  (`shawmakesmagic --vertical --publish --stitch`). Normal clip cuts
  render fine (they use `-ss` input seeking, ~130 MB each).
- **20:45** — the first *stitched* clip's ffmpeg starts.
- **20:51 → 20:52** — sysstat catches the detonation: memory 24% →
  76% used, commit 39% → 84% (17 GB), page cache 8.5 GB → 0.8 GB.
- **21:25 → 23:20** — EC2 "instance status check failed". Zero
  network. CPU flat ~34%. EBS reads pegged at exactly 125 MB/s (the
  gp3 throughput cap) — the kernel endlessly re-reading evicted pages.
  Cron jobs ran minutes late (userspace crawling, not dead).
- **~23:20** — the ffmpeg finally died/finished; box briefly
  answered again.
- **~00:10 Aug 7** — clipper moved on to the NEXT stitched clip →
  second detonation, box gone again.
- **00:24** — manual reboot. 01:0x: root cause identified, fix
  deployed + verified + pushed.

## The failure fingerprint (recognize it next time)

- Ping/SSH/HTTPS all dead, but **EC2 "instance status check" failed
  while "system status check" passed** → the OS inside is sick; AWS
  hardware is fine.
- **No kernel panic**: the kernel cmdline has `panic=-1`
  (instant reboot on panic) — if the box stays hung, it did NOT panic.
- **No OOM kill in `journalctl -b -1 -k`** — memory-thrash livelock
  often never trips the OOM killer.
- CloudWatch: CPU moderate-flat, network zero, **EBS read throughput
  pinned at the volume cap for hours** with ~zero stalled-IO. That
  combination = page-cache thrash, not a crashed kernel and not a disk
  fault.
- Journald gaps + cron sessions drifting minutes late during the
  window.

## Where the evidence lives (all still on the box)

- **`/var/log/proc-snapshot/YYYYMMDD.log`** — per-minute `top`-style
  snapshots (systemd timer `proc-snapshot.service`, script at
  `/usr/local/bin/proc-snapshot.sh`). This is what named the killer:
  the 20:52:12 snapshot shows PID 34660 ffmpeg at RSS 8,840,872 KB.
  Keep this service alive forever; it's the single best freeze
  forensics tool on the machine.
- **sysstat** (`sar -r -f /var/log/sysstat/saNN`) — 2-minute memory
  samples; shows the minute-scale detonation curve.
- `journalctl -b -1` — previous-boot journal survives reboots.
- EC2 console → instance screenshot + system log (serial console)
  — would show a panic if there ever was one.

## Root cause, precisely

`spliceSegments()` in `clawd-clipper/src/ffmpeg.ts` (the stitch
feature, added ~Aug 4 — which is why the freezes started then):

```
BAD  (before): ffmpeg -i whole-episode.mp4 -filter_complex \
       "[0:v]trim=A..B[v0]; [0:a]atrim=A..B[a0]; \
        [0:v]trim=C..D[v1]; [0:a]atrim=C..D[a1]; concat"
GOOD (after,  165579e): ffmpeg -ss A -t (B-A) -i ep.mp4 \
        -ss C -t (D-C) -i ep.mp4 \
        -filter_complex "[0:v][0:a][1:v][1:a]concat"
```

The BAD shape decodes the entire source once from t=0 and fans every
decoded frame to all trim branches; frames destined for later spans
queue in the filtergraph without bound while earlier spans encode.
Memory grows with source length × span spacing. The GOOD shape
keyframe-seeks each span independently (fast AND frame-accurate,
because re-encoding decodes-and-discards from the preceding keyframe
only) and was verified on the exact killer workload: 8.8 GB+/never
finished → **511 MB peak / 22 s**. There is a warning comment in the
function — do not "simplify" it back.

## Exonerated (checked, all flat through the incident)

kubo (~420 MB), Puppeteer/Chrome browser-host (~200 MB), mediamtx
(~30 MB), relay + next (~250 MB each), CPU credits (balance flat).
The relay-log flood of `/v1/rooms/health/auth` requests during the
hang was a *symptom* (a viewer page retry-polling a crawling server),
not a cause.

## Follow-ups (deliberate decisions + open items)

- Austin explicitly rejected auto-reboot-on-status-check-failure:
  **root causes get fixed, not band-aided.** Don't add that alarm.
- Open item: per-service systemd `MemoryMax` bulkheads so no single
  process can ever again drag the kernel into a thrash-coma that takes
  sshd down with it. (A leaking service should die alone.) Suggested
  starting point: `MemoryMax=6G` on the clipper's invocation path and
  browser-host; leave kubo generous.
- The interrupted `shawmakesmagic` clip run was never re-run.
- See `ops/storage-and-pinning.md` for the storage/resilience picture
  this incident exposed (sole-pinner risk, cleanup, pinner skill).

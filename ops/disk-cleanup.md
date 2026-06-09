# What to do when disk space is tight

The relay box (`slopcomputer`, EC2, **145 GB** root disk) fills up over time
because every show leaves multi-GB artifacts behind. Nothing here is automated —
this is the manual runbook for when `df -h /` creeps toward full.

> **RAM is not the constraint** — the box has 15 GiB and barely touches swap
> (see the bottom of `ops/window-geometry.md` discussion / `free -h`). Disk is
> the thing that sneaks up. If a build or service is failing, check disk first.

## 1. See where it's going

```bash
df -h /                                   # overall — act when >85%
sudo du -sh /home/ubuntu/recordings \
            /home/ubuntu/clawd-clipper/out \
            /home/ubuntu/.ipfs \
            /var/log/journal 2>/dev/null   # the four usual suspects
```

Typical breakdown (snapshot 2026-06-08, 77 GB used):

| Path | Size | What it is | Safe to delete? |
|---|---|---|---|
| `~/recordings/live/*.mp4` | ~23 G | Raw MediaMTX recordings | ✅ **once finalized** (pinned to IPFS) |
| `~/.ipfs` | ~17 G | IPFS pin store | ⚠️ **GC only — never `rm`** |
| `~/clawd-clipper/out/<slug>/` | ~9 G | Clipper working dirs (`source.mp4` ~2.3 G each + clips) | ✅ regenerable from IPFS |
| `/var/log/journal` | ~4 G | systemd logs | ✅ vacuum freely |

Clean up in the order below — safest + biggest wins first. Usually steps 1–3 are
plenty; you rarely need to touch IPFS.

## 2. Vacuum journald (safe, instant, ~4 G)

```bash
sudo journalctl --vacuum-time=7d      # keep last 7 days
# or hard cap:
sudo journalctl --vacuum-size=500M
```

No service impact. Logs older than the window are dropped.

## 3. Prune clipper working dirs (safe, ~2.3 G per old episode)

Each `out/<slug>/source.mp4` is just a **re-download** of the episode video from
IPFS — the clipper pulls it fresh on the next run. The cut clips + posters are
already pinned too. So the whole working dir is regenerable.

```bash
# Per-slug sizes:
sudo du -sh /home/ubuntu/clawd-clipper/out/* | sort -rh

# Safest big win — drop just the giant source mp4s (clips/json stay for reference):
find /home/ubuntu/clawd-clipper/out -name source.mp4 -mtime +3 -delete

# Or nuke an old episode's whole working dir (keep the most recent — see note):
rm -rf /home/ubuntu/clawd-clipper/out/<old-slug>
```

> Re-running `/admin → Generate clips` for that slug just re-downloads
> `source.mp4` (~3 GB, a few min) and re-cuts. Nothing is lost permanently.

## 4. Prune finalized recordings (biggest win, ~2–3 G each — CHECK FIRST)

`~/recordings/live/*.mp4` are the raw OBS captures. **After an episode is
finalized, the recording is pinned to IPFS and referenced by the on-chain
manifest** — so the raw file on disk is redundant and recoverable.

⚠️ **Only delete a recording whose episode has been finalized.** The newest file
is usually the live/just-ended show that may not be finalized yet — deleting an
un-finalized recording loses it permanently (it's not on IPFS until finalize
pins it).

```bash
ls -la --time-style=+%Y-%m-%d /home/ubuntu/recordings/live/   # newest = bottom

# Rule of thumb: keep the most recent 1–2; delete the rest IF finalized.
# Verify an episode is finalized = its slug page has a manifest / clips work.
# Then delete by name:
rm /home/ubuntu/recordings/live/2026-05-27_15-16-20-274850.mp4

# Bulk: everything older than 14 days (assumes those shows are long finalized):
find /home/ubuntu/recordings/live -name '*.mp4' -mtime +14 -delete
```

If unsure whether a recording is pinned, leave it — disk is cheaper than a lost
episode.

## 5. IPFS — garbage-collect, never `rm` (last resort)

`~/.ipfs` is the **pin store** — the actual home of every manifest, clip, and
recording slop.computer serves. **Never `rm -rf` it** and never delete files
inside it. The only safe reclaim is GC, which removes *unpinned* cached blocks
only (pins are untouched):

```bash
ipfs repo stat            # NumObjects / RepoSize vs StorageMax (currently 80 GB cap)
ipfs repo gc              # drop unpinned blocks — pinned content is preserved
```

GC typically frees little here because most content is intentionally pinned. If
the repo is genuinely the problem, the real fix is **raising the EBS volume size**
(it's a pin store that's supposed to grow), not deleting pins.

## 6. Still tight after all that?

Then it's genuinely a capacity problem, not cruft — **grow the EBS root volume**
(AWS console → the instance's volume → Modify → increase size → then on the box
`sudo growpart /dev/<root> 1 && sudo resize2fs /dev/root`). IPFS pin growth is
the legitimate driver; everything above is just keeping redundant copies from
piling up on top of it.

## Quick "I need space NOW" sequence

```bash
sudo journalctl --vacuum-size=500M
find /home/ubuntu/clawd-clipper/out -name source.mp4 -mtime +1 -delete
find /home/ubuntu/recordings/live -name '*.mp4' -mtime +14 -delete   # finalized only
df -h /
```

That reclaims ~10–20 GB without touching anything that isn't recoverable from
IPFS.

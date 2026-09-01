# What to do when disk space is tight

Manual runbook for when `df -h /` on `slopcomputer` creeps toward full.
Nothing here is automated.

> **Read `ops/storage-and-pinning.md` first.** It is the authority on which
> copy of an episode is the real one. This file is only the procedure; that
> file is the map. Where they disagree, it wins.

## Before you delete anything — three checks

This box is the **only IPFS pinner and the only gateway** for every episode.
There is no second copy anywhere. That makes three checks mandatory:

```bash
# 1. Is a show recording RIGHT NOW?
ls -la --time-style=+%H:%M /home/ubuntu/recordings/live | tail -3
#    A file whose mtime is within the last minute or two is LIVE.
#    The newest recording is un-finalized and NOT on IPFS. Deleting it
#    loses the episode permanently. Wait for finalize.

# 2. Is a clip job running?
ps aux | grep -E 'clipper|tsx src/index.ts' | grep -v grep
#    An in-flight job is mid-download into out/<slug>/source.mp4.
#    Deleting under it corrupts the run. Wait, or exclude that slug.

# 3. Is the box otherwise busy?
uptime      # load >4 usually means a show or a render is in progress
```

RAM is not the constraint — the box has 15 GiB and barely touches swap.
Disk is what sneaks up. If a build or service fails, check disk first.

## Where it's going

```bash
df -h /                                    # act when >85%
sudo du -sh /home/ubuntu/recordings \
            /home/ubuntu/clawd-clipper/out \
            /home/ubuntu/.ipfs \
            /var/log 2>/dev/null           # the four usual suspects
```

Snapshot 2026-08-31 — **871 GB volume, 743 GB used (86%), 129 GB free**:

| Path | Size | What it is | Safe to delete? |
|---|---|---|---|
| `~/.ipfs` | 266 G | Kubo blockstore — **the live copy** | ❌ **Never.** GC only |
| `~/clawd-clipper/out` | 225 G | 49 job dirs: 172 G `source.mp4` + 48 G clips | ✅ sources only, **verified per-file** |
| `~/recordings` | 213 G | Raw MediaMTX captures — archival master | ⚠️ **only after off-box backup** |
| `/var/log` | 6.8 G | systemd journal + syslog | ✅ vacuum freely |

Growth is roughly **150–200 GB/month** across all three big stores. Each
episode costs ~3 copies of itself: recording, kubo blocks, clipper source.

## 1. Vacuum journald (safe, instant, ~5 G)

```bash
sudo journalctl --vacuum-size=500M
```

No service impact. Also check `/var/log/syslog*` — uncompressed `syslog.1`
has reached 1.9 GB in the past, which means logrotate needs a look.

## 2. Prune clipper source caches (the big safe win, ~172 G)

`out/<slug>/source.mp4` is a **download cache**, not a master. The clipper
fetches the episode from the gateway by CID (`src/download.ts`) and skips
the download when the file is already present and non-empty — so deleting
it costs a re-download, nothing more. It never reads `~/recordings`.

**Do not use `find -name source.mp4 -delete`.** It proves nothing about
whether the bytes are recoverable, and it will delete an in-flight job's
download. Use the verified procedure from `ops/storage-and-pinning.md`,
per file:

```bash
for f in /home/ubuntu/clawd-clipper/out/*/source.mp4; do
  cid=$(ipfs add -n -Q "$f")                    # recompute CID from the bytes
  ipfs pin ls --type=recursive "$cid" >/dev/null 2>&1 \
    && ipfs refs -r --offline "$cid" >/dev/null 2>&1 \
    && { echo "SAFE   $f"; } \
    || { echo "KEEP   $f"; }
done
```

Run that as a **dry run first** and read the output. Only delete the `SAFE`
lines, and only for slugs with no running job. A `KEEP` means the exact
bytes are not fully in the blockstore — that file is the only copy.

Re-running `/admin → Generate clips` for a pruned slug just re-downloads
(~4 GB, a few minutes) and re-cuts. The clips and JSON stay on disk.

## 3. Raw recordings — NOT free to delete

`~/recordings/live/*.mp4` are the archival masters. They are **not** what
IPFS serves, but they are the disaster-recovery copy: re-adding one to a
fresh kubo reproduces the same CID.

Because this box is the sole pinner, the standing rule is **back up
off-box first, then reclaim**. That backup is still an open TODO
(`ops/storage-and-pinning.md`, resilience item 2). Until it exists, do not
bulk-delete recordings to free space — take it out of the source caches
instead.

> An earlier version of this runbook told you to
> `find ~/recordings/live -mtime +14 -delete`. That advice predated the
> 2026-08-06 audit that established the sole-pinner fact. Don't do it.

## 4. IPFS — GC only, never `rm`

`~/.ipfs` is the pin store: the actual home of every manifest, clip and
recording slop.computer serves. Never `rm -rf` it, never delete files
inside it.

```bash
ipfs repo stat --human     # RepoSize vs StorageMax
ipfs repo gc               # drops UNPINNED blocks only
```

GC frees very little here because nearly everything is intentionally
pinned. **Lowering `Datastore.StorageMax` does not free anything** — it
does not evict pins, it just sets the watermark at which kubo GCs unpinned
blocks, and on a sole-pinner box a low cap risks refusing writes. It is
currently 500 GB against an 871 GB disk.

## 5. Still tight? Grow the volume

Then it's capacity, not cruft. IPFS pin growth is the legitimate driver.
AWS console → the instance's volume → Modify → increase size, then:

```bash
sudo growpart /dev/<root> 1 && sudo resize2fs /dev/root
```

Needs the AWS console, so it needs Austin.

## Quick "I need space NOW"

```bash
# after confirming no live show and no running clip job:
sudo journalctl --vacuum-size=500M
# then the verified source-cache loop in step 2, deleting only SAFE lines
df -h /
```

That reclaims well over 100 GB without touching anything that isn't
recoverable. Everything beyond it needs the off-box backup or a bigger
volume.

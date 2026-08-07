# Storage & pinning: what's on the box, what must stay, what's a copy

The operational map of episode data on the slop.computer EC2 box
(`i-0d9b8eef7cced6d40`, Elastic IP 3.208.137.255 — the IP can never
change, DNS is safe). Written 2026-08-07, after the freeze post-mortem
(`ops/2026-08-06-freeze-postmortem.md`) forced a full audit.

## The one fact that dominates everything

**This box is the only IPFS pinner AND the only gateway for every
episode.** bgipfs has nothing: the relay used to upload there but
switched to local-kubo-only over per-key quotas (see the comment at
the top of `packages/relay/src/recordings.ts`), and their gateway
404s all episode CIDs — verified 2026-08-06. Until a second pinner
exists, losing this box's disk = losing the archive (modulo any raw
recording backups). Everything below serves that fact.

## The three copies of each episode (and what each is for)

| Copy | Path | Role | Deletable? |
| --- | --- | --- | --- |
| Raw recording | `~/recordings/live/*.mp4` (fMP4 from MediaMTX) | Archival master. NOT what IPFS serves. | Yes, after backing up off-box — IPFS serving is unaffected. But it's the disaster-recovery master: re-adding it to a fresh kubo reproduces the same CID. |
| Kubo blockstore | `~/.ipfs` (flatfs; filestore is **disabled**, so these are full copies) | **The live copy.** What the gateway serves and pinners replicate. | **Never.** |
| Clipper source cache | `~/clawd-clipper/out/<slug>/source.mp4` | Download cache — the clipper streams the episode *from the gateway by CID* (`src/download.ts`); it never reads `~/recordings`. | Yes, freely — it re-downloads on demand. Verified-deleted 2026-08-07 (see procedure below). |

Also in `out/<slug>/`: rendered clips (`clips/`, published ones are
pinned to kubo by `--publish`), and small metadata (candidates,
captions, index.html — the per-episode review UI, which uses relative
paths and is therefore portable as a folder).

## Verified-delete procedure for source caches (ran 2026-08-07, 37/37 passed)

Never trust "it should be pinned" — prove the exact bytes are in the
blockstore, per file:

```
cid=$(ipfs add -n -Q "$f")                       # hash-only, kubo default chunking — matches how the relay added it
ipfs pin ls --type=recursive "$cid" &&           # recursively pinned
ipfs refs -r --offline "$cid" >/dev/null &&      # EVERY block present locally (not just the root)
rm "$f"
```

`ipfs add -n` reproduces the original CID because both the relay
(`/api/v0/add` defaults) and the CLI use the same defaults
(size-262144 chunker, CIDv0, sha2-256). If kubo ever changes its
defaults this check fails safe (hash mismatch → file kept).

## Kubo node facts

- PeerID `12D3KooWBQvWLRUZkzgPzCDEkMiTdmzGznmP5T6wY94LLyLU8T9v`,
  repo ~210 GB, `Datastore.StorageMax` 500GB (a second ceiling
  besides the disk — see clawd-clipper's 2026-07-03 note).
- **Port 4001 (tcp+udp) is BLOCKED in the EC2 security group**
  (`launch-wizard-14`). The node can dial out but can't be dialed —
  p2p fetching from it is unreliable. Open 4001 in the SG (one
  console click, needs AWS console = Austin) to make the origin a
  real DHT citizen. Nothing currently *depends* on it: replication
  and playback go over the HTTPS gateway.
- Gateway = `https://media.slop.computer/ipfs/<cid>` (caddy → local
  kubo). Supports `?format=car` — the trustless replication path.

## Becoming a second pinner (the fix for the sole-pinner risk)

`https://slop.computer/pinner-skill.md` — public skill, lives in
`slop-computer-frontpage/packages/nextjs/public/`. Zero-dep node
script: walks `episodes.json` → each manifest → every CID, fetches
each as a CAR (`?format=car`) piped into `ipfs dag import`
(hash-verified per block, root pinned only if the DAG is complete,
preserves the exact original DAG). Idempotent; re-run to sync new
episodes. Needs kubo + Node ≥18 + ~300 GB (archive ~200 GB, growing
a few GB/episode; default `StorageMax` is 10 GB — must be raised).
Tested end-to-end against production 2026-08-07 from a scratch repo.

The Mac (clawd's machine) has only ~94 GB free — it can only be a
full pinner via an external drive (`IPFS_PATH=/Volumes/<disk>/ipfs`).

## Disk ledger (2026-08-07, after cleanup)

871 GB volume. Major items: kubo blockstore ~210 GB (keep),
raw recordings ~165 GB (back up off-box, then delete), rendered
clips ~34 GB + small metadata (cheap, keep), `/var/log` ~5 GB.
Source caches (~122 GB) deleted after verification; only
`shawmakesmagic/source.mp4` kept for its interrupted clip re-run.

## Remaining resilience TODOs, in order of value

1. Second pinner running the pinner skill (any box, 300 GB).
2. Raw recordings backed up off-box (then reclaim the 165 GB).
3. Open 4001 in the security group.
4. Per-service `MemoryMax` bulkheads (post-mortem follow-up).

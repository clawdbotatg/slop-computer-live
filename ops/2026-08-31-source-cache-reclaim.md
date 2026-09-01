# Reclaiming 172 GB of clipper source caches — 2026-08-31

Record of a bulk deletion of `clawd-clipper/out/<slug>/source.mp4`, the
evidence it rested on, and the exact reasoning. Written **before** the
deletion ran, so the claims are falsifiable against the box afterwards.

Companion docs: `ops/storage-and-pinning.md` (the map of what's a copy)
and `ops/disk-cleanup.md` (the procedure).

## Why this was needed

871 GB volume at 86% (126 GB free), growing ~150-200 GB/month across the
kubo blockstore, raw recordings, and clipper working dirs. Roughly three
weeks of runway. Every episode costs about three copies of itself.

## What was deleted

49 files, 172 GB: every `out/<slug>/source.mp4` in the clipper working
tree. **Nothing else.** Rendered clips, transcripts, captions, the
per-episode `index.html` review UI, and all JSON metadata were left in
place. No recording, no blockstore data, and no log was touched.

## Why these files are recoverable — the four-part argument

**1. They are a cache by construction, not a master.**

`packages/…/clawd-clipper/src/download.ts` streams the episode from the
IPFS gateway to `source.mp4` and returns early if the file already exists
non-empty. The URL comes from `src/resolve.ts` → `gatewayUrl(videoCid)`,
and `videoCid` is read from the episode manifest, which is itself reached
through `resolveBySlug()` → a **mainnet contract call**
(`getEpisodeBySlug`). The clipper never reads `~/recordings`.

So the pointer to the real copy is on Ethereum, not in any file on this
box. Deleting the cache cannot orphan it.

**2. Content-addressing was validated empirically, not assumed.**

`ipfs add -n -Q <file>` was run against two files whose gateway CIDs were
known independently. Both reproduced the exact CID. This establishes that
a file's identity can be derived from its own bytes with no external
trust — no log, no manifest, no filename.

**3. Every file passed a byte-level round trip.**

Per file, in order, all with timeouts (`ops/verify-source-caches.sh`, copied to the box and run there):

```
cid=$(ipfs add -n -Q "$f")            # identity derived from the bytes
ipfs pin ls --type=recursive "$cid"   # pinned, so GC cannot reclaim it
ipfs refs -r --offline "$cid"         # every block present locally
sha256sum "$f"  ==  ipfs cat --offline "$cid" | sha256sum
```

The fourth line is the one that matters. `refs -r` proves blocks *exist*;
it does not prove they are *correct*, because kubo does not re-hash blocks
on read. Reading the content back out and hashing it is the only check
that proves the blockstore can actually reproduce the file.

**Result: 49 of 49 matched.** Full table below.

**4. The cache protected against nothing, and being wrong is cheap.**

`source.mp4` and `~/.ipfs` are on the **same filesystem** (`/dev/root`).
Any event that destroys the blockstore destroys the cache with it. The
cache was never redundancy — it was a second copy sitting beside the
first. Its entire value was saving a re-download.

And if a file were somehow not recoverable, the next `generate-clips` run
re-downloads it automatically (~4 GB, a few minutes). No manual step, no
permanent loss.

## What this does NOT prove — read before citing this doc

- **It is a point-in-time result.** It proves the blockstore could
  reproduce these files on 2026-08-31. It says nothing about silent block
  corruption next month. (But the cache would not have helped there
  either — see argument 4.)
- **It says nothing about `~/recordings`.** Those were NOT verified and
  were NOT touched. They are a different encoding (MediaMTX fMP4) from
  what IPFS serves, so they are a separate representation of an episode,
  not a spare copy of this artifact.
- **The archive still has exactly one copy, on one disk, on one box.**
  This deletion does not change that in either direction. The off-box
  backup (`ops/storage-and-pinning.md`, resilience item 2) remains the
  single most valuable open task on this box.

## The false negative, and why the test is trustworthy anyway

`lordofafew` failed the round trip on the first pass **after** passing
both the pin check and the DAG-completeness check — precisely the file the
older, weaker procedure would have deleted. Retested in isolation it
matched exactly (byte count, derived CID, and SHA-256 all identical);
the failure was contention during the run, not corruption.

The asymmetry that makes this safe: a false *failure* is possible (a
timeout or a wedged stream truncates the stream), but a false *pass* would
require two SHA-256 digests to collide. **The test can only err toward
keeping files.** Any KEEP verdict deserves a retest before being believed;
a SAFE verdict does not.

## Operational notes for whoever runs this next

- **Check for a running clip job and a live show first.** A job in flight
  is mid-download into `source.mp4`; the newest recording is un-finalized
  and is the one genuinely irreplaceable file on the box.
- **Put a timeout on every ipfs call.** The first run of this verification
  wedged for 90 minutes on a single `ipfs cat` whose HTTP stream to the
  daemon died under load. The file it hung on verified in 100 seconds once
  retried. `ionice -c3` (idle) made it worse — it starved to zero behind
  the clip render. `nice -n 10 ionice -c2 -n7` yields without starving.
- **Never `pkill -f` a script name from an ssh one-liner.** The pattern
  matches your own command and kills the session, orphaning children.
  Kill by PID.

## Verified inventory

Sizes in GB. Each CID was recursively pinned, DAG-complete offline, and
round-trip identical to the file at the time of deletion.

| Slug | GB | Video CID (re-downloadable) |
| --- | --- | --- |
| 0xdeployer | 4.8 | `QmWg3k4VGv747aDVBZQvwkBt1RciLSBttVv1cGLzK2Srzo` |
| 0xrcinus | 2.6 | `QmRETsnZb434r1XV4Bb3DFj1yqNRW2i8wNUJKcj8YjuRNV` |
| 0xsero | 4.5 | `QmPFmn4qyZtDrbKA2cB1up8qLVKHtEcRXwEy4QrvvkjsoU` |
| 0xyoussea | 2.8 | `Qmabffn3VgpHKK8Xw6C17KxW9zBETqtYQS72GGa36q5SxR` |
| 0xzak | 2.8 | `QmeK8bEUMeUafUviusTfJkZD7DPXujF92ZiwdB3rUj5rjg` |
| 13yearoldvc | 2.8 | `QmZdQ33jm99AdfwGHjMVemzvS989d6ci9zmBRZjtkzMMVF` |
| adrianleb | 3.3 | `QmSzhmyFTZBk6wGHo89YnfaEhwmhnXVWDUjdunACSCw4Sp` |
| annikasays | 2.6 | `QmcarmjnhHynWBASfat32P5ZDS2rj5KuHGHE7bfCEQ8JTC` |
| auryn-macmillan | 3.6 | `Qmb7cDz9v1oJ5M53ZD1kCDFmwFtCenFi923nJEkuv4jcir` |
| bc1beat | 2.9 | `QmZKv2EpHenSZ8pv5PiTo49X9DFnh6XbMXTPsPGX5FesmH` |
| billyrennekamp | 3.5 | `QmbN1tj1o96a1o8h1CrKBYvBEEonh2vJhm1MB5ZnPhBRyJ` |
| binji-x | 3.0 | `Qmaz933zAKAMMKUt4dkHhrGX1Up9y5fYLeFhERHDBBPx7K` |
| clawdbotatg | 2.1 | `Qmcf8xTkMxCtp7VK2jMwyA9Rwo3GaAtdBeGYW3n2ZBmZTA` |
| cryptomastery | 3.1 | `QmRbSxudBiYe3JTKjKYptvZxWJpuhGwek9MVg9U5N5pr52` |
| dabit3 | 3.5 | `QmZ3DUgJMscsyhVxGwq3VM1N9mUCgQjRaWaTgLjFYT2Dma` |
| dcbuilder | 3.8 | `QmUcZjy6VnqG4pPxWC9znHYJ6rbENA1UiSdmMAHmpLFAcV` |
| dennisonbertram | 3.7 | `QmemsLeEh844kXyZqCsRRvfo1yiNo152SA6B1HWzTmH1mm` |
| dwddao | 4.4 | `Qma2XtRqLV6m3mk6AxrVk4PoC8EUrgpVtgjSfDqnmREU4h` |
| econoar | 3.1 | `QmNTHaoYwGvAwmdbJNHznLo7bNVf7GH8xyB5Z6h4h4SG31` |
| evmpapi | 3.1 | `QmdTArDEnGPGy1zqe1duQkGS3e3HoPTrFFMJXDcxkTxLJW` |
| fricoben | 3.4 | `QmW33detkcJ9NUGvdr2uX2ajYUimrfyA9bpQKBFDFKMbhk` |
| fucory | 3.2 | `QmeUJsCaiWnvmH6e6yAkubp4SuYQUrb9NxGyMtd6ndGgZX` |
| haochizzle | 3.8 | `QmaigDjJtcxAcBNpzEUTtvD1pKoX6jhoe2noyfLcEj6uhV` |
| jalilwahdat | 3.6 | `QmS8zaLPoHdHbwTjLPXxpVUmfWfP3k3vpPsKK9YjwGq2Se` |
| josephdelong | 4.6 | `QmPjvr3VY8DAkBXyoeazv5UbNgheuaVQSaP1GS5mARMB3A` |
| kassandraeth | 3.9 | `QmV6UiyiMgnsRiWHrTKHZX7RhVucBoczrpv9rQoUT2xQ9U` |
| kentherogers | 3.0 | `QmaSwQCHbt9oE9RLbtQBicF58VNbowMhEtwNF9JeDuEkRU` |
| kevincodex | 3.4 | `QmVSFwG7QoQisYPrBZJ9t8QwKCF3FuqxaJKAUeXy7ezCos` |
| lex-node | 3.2 | `QmVEXJxx2WkjwisS7vic61SUxybbsi7XZJgEyPEkcyYhye` |
| lordofafew | 3.5 | `QmcgK58APo6VtxeqoXcLbJwvz3uGByEJWeMCogYzgST6LS` |
| ludamad | 3.2 | `QmdGc4AGd6jeWFWriwWA9dLsfVjLi1jjFVT4QqpRNSp915` |
| marcus-rein | 3.3 | `QmXJ4mF8DfvZHCCop2djtYUSvbJctqbJc1yx2HbGzPWNJW` |
| murrlincoln | 3.1 | `QmUUwt1tbjC66D6mcmYaxers7QBW3jWhg5eB2mtGTn5pxx` |
| must-be-ash | 3.5 | `QmWCZjEc3FE2HVTrxTbTHifqgrmJCaWEro6fbQyZNPeiRE` |
| nnnnicholas | 3.2 | `Qma5Mx1XGbKPen6Z7gxuMtZa89HcmR8gfogBV4Uwup7dkU` |
| omniharmonic | 2.9 | `QmUBPPQSCyj3XWCrFi5gGfdQivWFUZhAVSCS18XhBvNQo6` |
| pablosabbatella | 4.7 | `QmcnAE127b1nzJRjwmrqV7A1hnX65kcvZ7Ad3V7P4y52jp` |
| port-dev | 3.0 | `Qmer354gWCBdsPRcQQiXPKwHoFdQeNjt77XLpcM8eK4fzj` |
| ralexstokes | 4.3 | `QmWYa51NL7K8L4uaaKHVEzaxQdpRWWAT2rZ28DG6AkdjwH` |
| rhynotic | 3.5 | `QmfSkF1AeN2tCTt7HunQdRKXKpFQbSHM3f1pJUmeufNgB2` |
| sendmoodz | 4.7 | `QmXRbr26SALwWeoVVQwXHY3mMiuTDwLWAPEW4gvJQ8rrhi` |
| shafu0x | 3.1 | `QmfM7Sattvoaj1HQ4BF1DU1P62QibZF5m9MGrpdHqfiyXm` |
| shawmakesmagic | 5.4 | `QmZ3RkPYNA6Utij6yKkbxrJPwnzu53cNwuf2jwAR22YQkP` |
| sodofi | 3.1 | `Qmbr1KK1NXGmmjMLZLGfZB4GBQdgEumYkJBheoEC6VKaMU` |
| songadaymann | 3.3 | `QmefKGHQvSARcowdQMPz5vNQgqsMGZN4xo2TL5NUw6kEYa` |
| tbsocialist | 3.3 | `QmcS6TA2H6bqhoQoeDvsf1ujSTefLW2XnDs2FsWTerdMHv` |
| unforcedag | 3.5 | `QmURtGPSade3nWdgGXRZJgQyxqiGPZM1WR3K6HPYzdgNVv` |
| w1nt3r-eth | 4.4 | `QmRHZgRG6ocd81r4NJFZs6UA5Yez1DEKAgRp2bvuyMe5ko` |
| z0r0zzz | 5.1 | `QmeHfLxMkWnBjaXJt11JxBqj2tw62waaXR1v21PhmZiKSx` |

Total: 49 files, 172 GB.

## Outcome — ran 2026-09-01 00:09-00:20 UTC

`49 deleted, 0 skipped, 172 GB freed.` Log on the box:
`/home/ubuntu/reclaim-20260901-000942.log`, one line per file carrying its
recovery command (`ipfs get <cid>`).

Disk went **86% -> 66%** (126 GB free -> 298 GB free). At the observed
~150-200 GB/month burn that is roughly two months of runway, up from three
weeks.

Confirmed untouched afterwards: 48 `clips/` dirs, 49 transcripts, and all
120 raw recordings (211 GB). Zero `source.mp4` remain.

The deletion script (`/home/ubuntu/reclaim.sh`) re-checked the pin and the
DAG for every CID immediately before removing its file, refused any slug
containing a slash or a leading dot, refused any CID not starting with
`Qm`, and aborted outright if a clip job or an active recording appeared.
No file was removed on the strength of the earlier verification alone.

A drift check before the run confirmed no `source.mp4` had been modified
since verification began, so the round-trip proofs still described the
bytes actually on disk.

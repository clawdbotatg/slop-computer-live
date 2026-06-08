# Server-side clips — ops runbook

Turn on the `/admin` **Generate clips** button so an episode's 9:16 vertical
clips + suggested tweet copy get cut on the relay box, pinned to bgipfs, and
folded into the episode manifest — then rendered in an **admin-only** Clips
section at the bottom of `slop.computer/<slug>`.

Three repos are involved; all the code is already shipped. This doc is the
box-side setup that makes the button actually work.

```
/admin → Finalize → Save Manifest → [Generate clips] → Save Manifest (again) → done
                                          │                    │
              relay spawns clawd-clipper  │   new manifest CID streamed back,
              (--vertical --publish):     │   prefilled into the panel; you sign
              cut → pin to bgipfs →        │   setManifest (relay holds no key)
              fold `clips` into manifest ──┘
```

## What runs where

- **clawd-clipper** (`github.com/clawdbotatg/clawd-clipper`): does the work —
  resolves the slug on-chain, downloads the finalized mp4 from IPFS, cuts the
  clips (over a bundled slop-desktop background, no headless Chrome needed),
  writes tweet copy, pins each clip + a `clips.json` to bgipfs, folds a `clips`
  field into the manifest, pins the new manifest, and writes
  `out/<slug>/publish.json` with the result CIDs.
- **relay** (this repo): `POST /admin/generate-clips?slug=<slug>` (host-gated)
  spawns the clipper, streams its stdout as NDJSON progress, and on success
  reads `publish.json` and emits `done` with the new manifest CID. Holds **no
  signing key** — the host signs `setManifest` in the browser.
- **frontpage**: the "Generate clips" button (in the Finalize panel) and the
  admin-only Clips section on episode pages.

## Relay box setup (one-time)

1. **Deploy the relay** with the new route (pull + `yarn build` + restart the
   service — pushing GitHub does NOT deploy it). The route is inert until
   `CLIPPER_DIR` is set, so deploying early is safe.

2. **Check out clawd-clipper on the box** and install it:
   ```bash
   git clone https://github.com/clawdbotatg/clawd-clipper.git /home/ubuntu/clawd-clipper
   cd /home/ubuntu/clawd-clipper && yarn install
   ```

3. **Give it a `.env`** (`/home/ubuntu/clawd-clipper/.env`) — the clipper loads
   its own env from its cwd:
   ```
   ANTHROPIC_API_KEY=...     # clip ranking, judge, tweet copy
   OPENAI_API_KEY=...        # whisper transcription
   ALCHEMY_API_KEY=...       # resolve <slug> on mainnet (no public RPC)
   # IPFS_API_URL defaults to http://127.0.0.1:5001 — the same bgipfs node the
   # relay pins to. Override only if bgipfs's API is elsewhere.
   ```

4. **Install ffmpeg-full** (caption burning needs libass; the slim ffmpeg
   doesn't have it). The clipper looks for `CLIPPER_FFMPEG_FULL_BIN` (default
   `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` — set it to the box's path, e.g.
   `/usr/bin/ffmpeg` if that build has libass, or install a full ffmpeg).

5. **Point the relay at it** — set in the relay's env and restart:
   ```
   CLIPPER_DIR=/home/ubuntu/clawd-clipper
   ```
   Unset → `/admin/generate-clips` returns 501 and clips stay a local/manual
   flow (`yarn clip <slug> --vertical --publish` on a laptop).

## Frontpage setup (one-time)

Set in the Vercel project env and redeploy:
```
NEXT_PUBLIC_ADMIN_ADDRESSES=<clawdbotatg.eth address>   # comma-separated for more
```
The connected wallet sees the Clips section if it's the SlopComputer `owner()`
(austin — already covered) OR is in this list (clawdbot). Public viewers never
see it. (Mirrors the relay's `ADMIN_ADDRESSES` model; it's UI curation, not a
secret — the clips bundle is public on IPFS.)

## Resource notes

- The clipper **re-downloads the full episode mp4 (~3 GB)** from the gateway each
  run, then runs ffmpeg + a few LLM calls — a couple of minutes and some API
  spend per episode. Make sure the box has the disk + budget.
- One clip job per slug at a time (the relay guards it). Re-running re-pins and
  re-points the manifest; old artifacts stay pinned.

## Verify

1. `/admin` → Finalize panel on a finalized episode → **Generate clips** →
   progress streams → a new manifest CID appears → **Save manifest on-chain**.
2. `slop.computer/<slug>`, signed in as `austingriffith.eth` / `clawdbotatg.eth`
   → **Clips** section at the bottom with each clip's video + short/long tweet.
   Open it logged out (or as a non-admin) → the section is gone.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Button → 501 | `CLIPPER_DIR` not set on the relay | set it, restart the relay |
| `done` but no clips on page | manifest CID not saved on-chain, or you're not an admin wallet | hit Save Manifest again; check `NEXT_PUBLIC_ADMIN_ADDRESSES` / connected wallet |
| clipper exits non-zero | missing key in clipper `.env`, no ffmpeg-full, or disk full | check the streamed log lines; they're the clipper's stdout verbatim |
| clips have no captions | caption burn needs libass | set `CLIPPER_FFMPEG_FULL_BIN` to a libass build |

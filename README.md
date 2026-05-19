# slop-computer-live

The live, interactive Mac OS 9-style desktop at live.slop.computer. Host and guests appear as draggable webcam/screen-share windows with shared cursors. The desktop is captured by OBS and broadcast as the show.

See PLAN.md for the full plan and DESIGN.md for the visual system.

## Quickstart (after Phase 1 scaffold)

```bash
yarn install
yarn chain
yarn deploy
yarn start          # next.js
yarn relay          # signaling + auth server
```

## Deploying to production

```bash
./ops/deploy.sh
```

Builds Next.js + relay **locally** (prod is RAM-constrained — full
builds OOM there), rsyncs the artifacts into `.next.staging/` on the
box, then does an atomic swap and service restart. Live serves the old
build until the swap, so HTTPS downtime is ~2 seconds.

Pre-flight refuses to deploy a dirty tree, a non-`main` branch, or a
local that's out of sync with `origin/main` — push first.

Concurrency: holds a lockfile at `/tmp/slop-deploy.lock`. A second
deploy will yield instead of racing the first.

See `ops/deploy.sh` for the full flow.

License: MIT. Fully forkable.

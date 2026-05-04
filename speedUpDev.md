# speed up dev

The deploy loop on EC2 currently takes ~60-90s because every change does a
fresh `next build` (typecheck + bundle + ABI gen) on a t3.medium. Faster
options, ranked by effort/payoff:

## 1. Keep `.next` warm — DOING THIS NOW

Stop `rm -rf .next` before every build. Next 15 caches compiled chunks and
type results in `.next/cache`; wiping it forces a cold build every time.
With the cache intact, an incremental rebuild is typically ~15-25s instead
of 60-90s.

Default deploy command:

```bash
ssh slopcomputer "cd /home/ubuntu/slop-computer-live \
  && git pull --rebase origin main \
  && cd packages/nextjs && yarn build \
  && sudo systemctl restart slop-live"
```

If something gets weird (stale chunks, hydration mismatches, a wrong env
baked in), nuke the cache once:

```bash
ssh slopcomputer "cd /home/ubuntu/slop-computer-live/packages/nextjs \
  && rm -rf .next && yarn build \
  && sudo systemctl restart slop-live"
```

## 2. `next dev` in tmux for iteration

HMR refreshes in under a second. Good for active dev against a domain;
not identical to prod (no minification, no static prerender).

## 3. Move the frontend to Vercel

The relay + MediaMTX stay on EC2; only the Next.js app moves. Vercel
builds in parallel to local work, so a `git push` doesn't block. Point
`live.slop.computer` CNAME at Vercel.

## 4. Bigger EC2 — pending

User flagged this for later: scale up the slop-computer EC2 instance
from **t3.medium → t3.large** (doubles CPU, ~30% off build time, also
helps under live-show load). Stop instance in AWS console → change
instance type → start. Costs ~2x as long as it stays large.

## 5. CI-driven deploys

GitHub Actions on push runs the build remotely. We move on instead of
waiting synchronously on the local terminal.

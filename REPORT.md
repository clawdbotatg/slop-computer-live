# slop-computer — Status Report

Date: 2026-05-03

---

## What Exists

### Repos (both fully committed to GitHub)

**`clawdbotatg/slop-computer-live`** — the live interactive desktop app
- Mac OS 9 Platinum dark design system
- Pages: `/` (audience), `/admin` (host), `/join` (guest), `/desktop` (live view)
- WebRTC peer mesh (`usePeerMesh.ts`) — mesh topology, host-centric
- Cursor sync via relay WebSocket
- Draggable windows via react-rnd
- SIWE auth + password auth (guest path)
- Deployed to Vercel: `https://nextjs-omega-bay-42.vercel.app`
- Latest commit: `8b7f6e2` — fix: production relay URL + force-dynamic on /desktop

**`clawdbotatg/slop-computer-frontpage`** — the static marketing site
- Reads contract state (`liveEpisode()`, `getEpisodes()`)
- HLS player when live
- Ready to deploy
- Latest commit: `35105f4` — fix(rpc): switch back to Alchemy mainnet

### Contract (mainnet)
- `SlopComputer.sol` (episode registry) deployed at `0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886`
- Owner: `0x34aA3F359A9D614239015126635CE7732c18fDF3` (austingriffith.eth)
- Functions: `goLive(name, slug, liveSlug, manifest, contractAddr, datetime)`, `goOffline()`, `liveEpisode()`, `getEpisodes()`, `addEpisode()`, `setLive()`, `setName()`, `execute()`
- Going live is driven from the **slop.computer/admin** console (frontpage repo), not raw cast calls.
- ⚠️ Legacy `SlopComputerFrontpage.sol` (`0x94D987…7820`, owner clawdbotatg.eth, `goLive(title,hlsUrl)`) is **deprecated/unused** — superseded by the episode registry above. Note the owner changed: the new contract is owned by austingriffith.eth, not the bot.

### Relay (EC2 at 98.82.26.233)
- Node/Fastify WebSocket relay running on port 8080
- Health: `curl localhost:8080/health` → `{"ok":true,"service":"slop-relay","peers":0}`
- Handles: SIWE auth, password auth, WebRTC signaling (offer/answer/ice), cursor broadcast, window state
- Code at `/home/ubuntu/slop-relay/` on EC2

### DNS
- `slop.computer` → `98.82.26.233` (EC2)
- `live.slop.computer` → `98.82.26.233` (EC2)
- `media.slop.computer` → `98.82.26.233` (EC2)

---

## What's Done ✅

- Contract deployed to mainnet
- App scaffolded, designed, and deployed to Vercel
- WebRTC peer mesh built and wired
- Relay server built and running on EC2
- Mac OS 9 design system implemented
- GitHub repos clean and current

---

## What's Broken / Incomplete 🔴

### 1. WebSocket proxy through Caddy — UNVERIFIED
Caddy config proxies `/signal*` to `:8080`, but the WS upgrade behavior has not been confirmed working from outside the EC2 network. The last round of testing showed internal connectivity works but external WS routing may be broken due to how `proxy.web()` vs `proxy.ws()` was handled in the old proxy.js. **The relay itself is healthy, but the Caddy→relay WS tunnel needs an external test to confirm.**

### 2. Vercel env vars — NEED TO SET IN VERCEL DASHBOARD
The `.env.local` has the correct values locally:
```
NEXT_PUBLIC_RELAY_URL=wss://slop.computer/signal
NEXT_PUBLIC_RELAY_HTTP_URL=https://slop.computer
```
But these need to be set in the Vercel project environment variables dashboard, not just in the local file. The local `.env.local` is gitignored and won't affect the deployed app.

### 3. Frontpage not deployed
`slop-computer-frontpage` is ready but not live. Needs Vercel deployment + custom domain.

---

## What's Pending (Not Yet Built) 🟡

### Phase 1 — Make it bulletproof (this week)
1. **Confirm WS proxy works externally** — test `wss://slop.computer/signal` from outside EC2
2. **Set Vercel env vars** — `NEXT_PUBLIC_RELAY_URL`, `NEXT_PUBLIC_RELAY_HTTP_URL`, `NEXT_PUBLIC_ALCHEMY_API_KEY` (contract address is now hardcoded to the canonical `SlopComputer` registry in `externalContracts.ts` / the live-slug route)
3. **Deploy frontpage to Vercel** — `slop-computer-frontpage`, custom domain `slop.computer`
4. **EC2 fallback build** — `yarn build` slop-computer-live on the box, configure Caddy to serve it if Vercel is down
5. **Add custom domain to Vercel** — `slop.computer` → Vercel deployment

### Phase 2 — Media infrastructure
1. **MediaMTX** on EC2 (port 1935 RTMP ingest, port 8888 HLS output)
2. **OBS setup docs** — RTMP push → MediaMTX → HLS
3. **Set `NEXT_PUBLIC_HLS_URL`** — `https://media.slop.computer/hls/live/index.m3u8`
4. **Test HLS playback** through Cloudflare `.link` as fallback

### Phase 3 — On-chain go-live
1. Wire "Go Live" button on `/admin` to call `SlopComputer.goLive(name, slug, liveSlug, manifest, contractAddr, datetime)` on mainnet (this now lives in the slop.computer/admin console)
2. Verify frontpage picks up the state change
3. Set `ADMIN_ADDRESSES` env var on relay to Austin's wallet

### Phase 4 — polish
1. Invite link generation in `/admin`
2. Guest password rotation flow
3. Mobile audience view (read-only)
4. OBS Multi-RTMP restream docs
5. Recording pipeline (post-v1)

---

## Infrastructure Map (current)

| Service | URL | Points to | Status |
|---------|-----|-----------|--------|
| Contract (mainnet) | `0xf3ce36...4886` (SlopComputer) | Ethereum mainnet | ✅ live |
| Live app (Vercel) | `vercel.app/...` | Vercel edge | ✅ deployed |
| Relay (EC2) | `live.slop.computer:8080` | EC2 :8080 | ✅ running |
| Caddy (EC2) | `live.slop.computer` | → :3000 (old) | ⚠️ needs update |
| MediaMTX | `media.slop.computer` | EC2 | ❌ not installed |
| Frontpage | `slop.computer` | EC2 :3000 (old server) | ❌ wrong content |
| ETH link fallback | `slopcomputer.eth.link` | Cloudflare → EC2 | ⚠️ HTTP only, WS unreliable |

---

## Critical Action Items (do today)

1. **Set Vercel env vars** — 5 vars in the Vercel dashboard for slop-computer-live
2. **Add `slop.computer` domain to Vercel** — will give you a CNAME to set in DNS
3. **Update DNS** — point `slop.computer` CNAME to Vercel, keep `media.slop.computer` as A record to EC2
4. **Deploy slop-computer-frontpage** to Vercel as a separate project
5. **Test external WS** — `wss://slop.computer/signal` from a browser or curl outside EC2

---

## Owner Commands (when you go live)

Prefer the **slop.computer/admin** console (owner-gated UI). For raw cast calls against the new `SlopComputer` registry (owner must be austingriffith.eth):

```bash
# Go live — full episode signature
cast send 0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886 \
  "goLive(string,string,string,string,address,uint256)" \
  "Slop Computer Live" "slop-computer-live" "" "" \
  0x0000000000000000000000000000000000000000 $(date +%s) \
  --private-key <key>

# Go offline
cast send 0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886 \
  "goOffline()" --private-key <key>
```

---

## Key Files

| File | Purpose |
|------|---------|
| `slop-computer-live/PLAN.md` | Full architecture spec |
| `slop-computer-live/DESIGN.md` | Design system reference |
| `slop-computer-live/PROGRESS.md` | Live progress tracker |
| `slop-computer-live/packages/relay/src/index.ts` | Relay server |
| `slop-computer-live/packages/nextjs/hooks/usePeerMesh.ts` | WebRTC mesh |
| `slop-computer-live/packages/nextjs/contracts/externalContracts.ts` | Contract ABI |
| `slop-computer-frontpage/PLAN.md` | Frontpage spec |

---

## Alchemy Key (for RPC)

Do **not** commit API keys. Pull `ALCHEMY_API_KEY` from the relevant `.env`
(`packages/foundry/.env` in slop-computer-contracts, or the Vercel env for the
frontend) and build the URL as `https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY`.

> ⚠️ A live key was committed here on 2026-05-03 and was public for ~a month —
> treat it as compromised and rotate it in the Alchemy dashboard. (It still
> lives in git history at commit `553a1a0`; removing it here does not purge it.)

---

_Report generated 2026-05-03. Repo: github.com/clawdbotatg/slop-computer-live + github.com/clawdbotatg/slop-computer-frontpage_
# Slop-Computer Progress

## What's Done ✅

### Contract — DEPLOYED TO MAINNET
- **SlopComputer.sol** (episode registry) deployed at `0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886` on Ethereum mainnet
- Owner: `0x34aA3F359A9D614239015126635CE7732c18fDF3` (austingriffith.eth)
- Verified: `liveEpisode()` → empty (off air), `owner()` → confirmed
- ⚠️ Legacy `SlopComputerFrontpage.sol` (`0x94D987…7820`, owner clawdbotatg.eth) is deprecated/unused — superseded by the episode registry. Owner changed to austingriffith.eth on the new contract.

### slop-computer-live — LIVE ON VERCEL
- **URL: https://nextjs-omega-bay-42.vercel.app**
- SSO protection disabled — publicly accessible
- Env vars set: `NEXT_PUBLIC_ALCHEMY_API_KEY`, `NEXT_PUBLIC_FRONTPAGE_ADDRESS`, `NEXT_PUBLIC_RELAY_URL`, `NEXT_PUBLIC_RELAY_HTTP_URL`, `NEXT_PUBLIC_HLS_URL`
- ABI fixed: `liveTitle`/`liveHlsUrl` (was `currentTitle`/`currentHlsUrl`)
- Git push triggers auto-deploy

### slop-computer-frontpage
- Static site scaffold complete, reads contract state
- Three deploy surfaces ready (Vercel/IPFS/ENS)
- Contract code ready

## In Progress 🔄
- **WebRTC peer mesh** — sub-agent building `usePeerMesh.ts` + cursor rendering + video windows
- Relay server — needs deployment to EC2

## What's Pending 🔧

### Phase 2: Peer Mesh Completion
- `usePeerMesh.ts` hook (WebRTC RTCPeerConnection lifecycle)
- Wire remote streams into desktop page video elements
- Cursor rendering on desktop

### Phase 3: Relay Deployment (EC2)
- Fastify WebSocket relay server → `relay.live.slop.computer`
- systemd services (slop-live + slop-relay) in deploy/
- Update Vercel `NEXT_PUBLIC_RELAY_URL` → real URL after EC2 is up
- Allowlist peer's addresses in relay admin

### Phase 4: Admin + Join Pages
- `/admin`: host calls `goLive(name, slug, liveSlug, manifest, contractAddr, datetime)` or `goOffline()` via writeContract (now in the slop.computer/admin console)
- `/join`: SIWE connect + password handle entry for WebRTC auth

### Phase 5: MediaMTX (OBS → HLS)
- MediaMTX on EC2 for RTMP ingest → HLS output
- `media.slop.computer` HLS stream URL
- OBS browser capture → RTMP → MediaMTX → CDN

### Phase 6: Frontpage Deploy
- Deploy slop-computer-frontpage to Vercel
- Point slopcomputer.eth ENS to the Vercel deployment
- HLS player embed

### Phase 7: Custom Domain
- Point `live.slop.computer` → Vercel deployment
- SSL cert via Vercel

## Infrastructure Map

| Service | URL | Status |
|---------|-----|--------|
| Contract | [0xf3ce36...4886](https://etherscan.io/address/0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886) (SlopComputer) | ✅ mainnet |
| Live app | https://nextjs-omega-bay-42.vercel.app | ✅ Vercel |
| Relay | relay.live.slop.computer | ❌ pending |
| MediaMTX | media.slop.computer | ❌ pending |
| Frontpage | slopcomputer.eth | ❌ pending |

## Owner Commands (for when you go live)
Prefer the **slop.computer/admin** console. Raw cast against the new `SlopComputer` registry (owner = austingriffith.eth):
```bash
# Go live — full episode signature (name, slug, liveSlug, manifest, contractAddr, datetime)
cast send 0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886 "goLive(string,string,string,string,address,uint256)" "My Show Title" "my-show" "" "" 0x0000000000000000000000000000000000000000 $(date +%s) --private-key <key>

# Go offline
cast send 0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886 "goOffline()" --private-key <key>
```

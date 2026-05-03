# Slop-Computer Progress

## What's Done ✅

### Contract — DEPLOYED TO MAINNET
- **SlopComputerFrontpage.sol** deployed at `0x94D987a8057b7795522589E36383C87356217820` on Ethereum mainnet
- Owner: `0x11ce532845ce0eacda41f72fdc1c88c335981442` (clawd.atg.eth)
- Verified: `isLive()` → false, `owner()` → confirmed
- Deployed via `forge create --broadcast` with freshly funded wallet

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
- `/admin`: host calls `goLive(title, hlsUrl)` or `goOffline()` via writeContract
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
| Contract | [0x94D987a8...7820](https://etherscan.io/address/0x94D987a8057b7795522589E36383C87356217820) | ✅ mainnet |
| Live app | https://nextjs-omega-bay-42.vercel.app | ✅ Vercel |
| Relay | relay.live.slop.computer | ❌ pending |
| MediaMTX | media.slop.computer | ❌ pending |
| Frontpage | slopcomputer.eth | ❌ pending |

## Owner Commands (for when you go live)
```bash
# Go live
cast send 0x94D987a8057b7795522589E36383C87356217820 "goLive(string,string)" "My Show Title" "https://media.slop.computer/stream.m3u8" --private-key <key>

# Go offline
cast send 0x94D987a8057b7795522589E36383C87356217820 "goOffline()" --private-key <key>
```

# Slop-Computer Progress

## What's Done ✅

### Contract
- **SlopComputerFrontpage.sol** deployed to mainnet
- Address: `0x94D987a8057b7795522589E36383C87356217820`
- Owner: `0x11ce532845ce0eacda41f72fdc1c88c335981442` (clawd.atg.eth)
- Deployed via `forge create --broadcast` with a freshly funded wallet (0.0038 ETH)
- Contract verified onchain: `isLive()` returns false, `owner()` confirmed

### ABI Fix
- `externalContracts.ts` corrected: `currentTitle` → `liveTitle`, `currentHlsUrl` → `liveHlsUrl`
- Chain config targets mainnet (chain id 1)
- `owner()` added to ABI

### slop-computer-frontpage
- Static site scaffold complete
- Reads contract state for live status + episodes
- Three-surface deploy config (Vercel / IPFS / ENS)
- HLS player embed for `media.slop.computer`

### slop-computer-live
- Mac OS 9 Platinum design system built (Bevel, Window, TitleBar, MenuBar, Cursor, etc.)
- Relay server built (Fastify + WebSocket, SIWE/password auth, signaling, cursor broadcast)
- Desktop page shell with window manager
- `useSession.ts` and `useSignalSocket.ts` hooks exist
- Auth flow scaffold (`/join`, `/admin` pages exist as stubs)

## What's Pending 🔧

### Phase 1: WebRTC Peer Mesh
- `usePeerMesh.ts` — hook that manages RTCPeerConnection lifecycle
  - Subscribe to peer_join/peer_leave from useSignalSocket
  - Lower peerId creates offer, higher receives and answers
  - ICE candidates routed through relay signaling
  - Exposes `Map<peerId, MediaStream>`
- Wire it into the desktop page (add remote video elements)

### Phase 2: Cursor Rendering
- `Cursor` component exists but not rendered on desktop
- Add `useCursors` state → render each remote peer's cursor
- Smooth positioning

### Phase 3: Relay Deployment (EC2)
- MediaMTX on EC2 for RTMP → HLS
- Relay server deployment via systemd (slop-live + slop-relay services)
- `NEXT_PUBLIC_RELAY_URL` → `wss://relay.live.slop.computer`

### Phase 4: On-chain goLive / goOffline
- `/admin` page: host calls `goLive(title, hlsUrl)` or `goOffline()` on the contract
- Frontpage auto-reads live status — syncs when host goes live

### Phase 5: HLS Player
- `media.slop.computer` HLS embed on frontpage
- OBS → browser capture → RTMP to MediaMTX → HLS CDN

### Phase 6: Guest Auth
- SIWE connect flow for guests joining via WebRTC
- Password handle system via relay admin API

## Infrastructure

| Service | URL | Status |
|---------|-----|--------|
| Frontpage | slopcomputer.eth (ENS) | Not deployed |
| Live app | live.slop.computer | Vercel deploy pending |
| Relay | relay.live.slop.computer | Not deployed |
| MediaMTX | media.slop.computer | Not deployed |
| Contract | 0x94D987a8057b7795522589E36383C87356217820 | ✅ Live on mainnet |

## Next Immediate Action
Deploy slop-computer-live to Vercel with:
- `NEXT_PUBLIC_ALCHEMY_API_KEY=nteU3EvWxEqvzjViYPJ27`
- `NEXT_PUBLIC_FRONTPAGE_ADDRESS=0x94D987a8057b7795522589E36383C87356217820`
- `NEXT_PUBLIC_RELAY_URL=wss://placeholder` (relay not live yet)

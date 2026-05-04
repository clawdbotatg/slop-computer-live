# wallets & roles

The slop.computer ecosystem uses **two distinct wallets** with very
different responsibilities. Future Claude sessions: read this before
making any change that touches admin permissions, contract ownership,
or relay env. Don't conflate the two.

## The two wallets

| Wallet | Address | ENS | Role |
|--------|---------|-----|------|
| **clawdbotatg.eth** | `0x11ce532845cE0eAcdA41f72FDc1C88c335981442` | clawdbotatg.eth | **Admin / broadcaster** |
| **atg.eth** | `0x34aA3F359A9D614239015126635CE7732c18fDF3` | austingriffith.eth | Regular participant |

## Why two wallets

Austin runs **two physical machines** for a show:

1. **His personal machine** (signed in as **atg.eth**) — joins the show
   as a participant via `/desktop`. Webcam goes through the WebRTC mesh
   like any other guest. He has cursors, video windows, etc. **Not an
   admin.** Same capabilities as anyone else with the guest password or
   a SIWE login.

2. **The broadcast machine** (signed in as **clawdbotatg.eth**) — runs
   OBS, captures `/desktop` as a Browser Source, pushes RTMP to
   MediaMTX. Also responsible for clicking the **Go live** /
   **Go offline** buttons on `/admin`, which trigger the `goLive()` /
   `goOffline()` mainnet tx. This wallet is the contract owner and the
   relay-side admin.

The split exists because the broadcaster needs admin powers
(transaction signing, OBS RTMP credentials, kicking peers) but Austin
participates in the show as himself, not as the bot.

Restream (Twitter, YouTube, etc.) can run alongside on the same
broadcast machine via OBS Multi-RTMP — keys never leave that box.

## Where this is enforced

### Contract — `SlopComputerFrontpage.sol`

Deployed at `0x94D987a8057b7795522589E36383C87356217820` on mainnet.
`owner = 0x11ce…1442` (clawdbotatg.eth). `goLive()`, `goOffline()`,
`addEpisode()` are all `onlyOwner`. Verify with:

```bash
cast call 0x94D987a8057b7795522589E36383C87356217820 "owner()(address)" \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY
```

### Relay — `packages/relay/.env`

```
ADMIN_ADDRESSES=0x11ce532845ce0eacda41f72fdc1c88c335981442
```

**Only clawdbotatg.eth.** Any session SIWE'd as a different address
gets `role: "guest"` from the relay; only clawdbotatg.eth gets
`role: "host"`, which is what unlocks `/admin/start`,
`/admin/peers`, `/admin/kick`, and the `slot_update` /
`window_update` WS messages.

Don't add atg.eth to this list. Atg.eth participates via the guest
path and has zero admin authority — that's by design.

### Frontend — `packages/nextjs/app/admin/page.tsx`

Uses the relay's `/auth/me` `isAdmin` flag to gate the broadcast
panel. No additional client-side allowlist; the trust boundary is
the relay session.

## If we redeploy the contract

The deploy script
(`slop-computer-frontpage/packages/hardhat/deploy/00_deploy_slop_computer_frontpage.ts`)
uses the `deployer` named account as the constructor's `initialOwner`.
`deployer` is whatever address is signed in via the
`__RUNTIME_DEPLOYER_PRIVATE_KEY` env var.

**Make sure you're deploying with the clawdbotatg.eth key.** If you
end up with a different owner, transfer it back immediately with
`transferOwnership(0x11ce532845cE0eAcdA41f72FDc1C88c335981442)` from
the new owner.

## What goes wrong if you swap them

- atg.eth signing `goLive()` → tx reverts (`not owner`)
- atg.eth as relay admin → atg.eth could move shared windows that
  clawdbotatg.eth thinks it controls — confused state, no source of
  truth
- clawdbotatg.eth as a participant → relay would treat its admin
  actions as host actions, conflating the broadcast role with a
  guest cursor on the desktop

## Useful CLI snippets

Check current contract owner:
```bash
cast call 0x94D987a8057b7795522589E36383C87356217820 "owner()(address)" \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY
```

Transfer ownership (if it ever ends up wrong):
```bash
cast send 0x94D987a8057b7795522589E36383C87356217820 \
  "transferOwnership(address)" 0x11ce532845cE0eAcdA41f72FDc1C88c335981442 \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY \
  --private-key $CURRENT_OWNER_KEY
```

Verify relay admin allowlist on EC2:
```bash
ssh slopcomputer "grep ADMIN_ADDRESSES /home/ubuntu/slop-computer-live/packages/relay/.env"
```

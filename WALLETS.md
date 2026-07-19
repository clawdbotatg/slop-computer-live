# wallets & roles

The slop.computer ecosystem uses **two distinct wallets** with very
different responsibilities. Future Claude sessions: read this before
making any change that touches admin permissions, contract ownership,
or relay env. Don't conflate the two.

## The two wallets

| Wallet | Address | ENS | Role |
|--------|---------|-----|------|
| **clawdbotatg.eth** | `0x11ce532845cE0eAcdA41f72FDc1C88c335981442` | clawdbotatg.eth | **Relay broadcaster / admin** |
| **atg.eth** | `0x34aA3F359A9D614239015126635CE7732c18fDF3` | austingriffith.eth | Show participant **+ now the `SlopComputer` contract owner** (see Contract section) |

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

### Contract — `SlopComputer.sol` (episode registry)

> ⚠️ **Ownership changed with the registry migration.** The live contract is
> now `SlopComputer` at `0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886`, owned by
> **austingriffith.eth** (`0x34aA3F…fDF3`) — *not* clawdbotatg.eth. This is
> intentional: the contracts-repo deploy script reverts unless the owner is
> atg.eth on live networks. The old `SlopComputerFrontpage.sol`
> (`0x94D987…7820`, owned by clawdbotatg.eth) is deprecated/unused.
>
> Net effect: **the contract owner (registry writes: `goLive`, `addEpisode`,
> `setName`, `execute`) is now Austin's wallet**, while the *relay* broadcast
> admin below is still clawdbotatg.eth. Going live is driven from the
> slop.computer/admin console signing as austingriffith.eth.

`goLive()`, `goOffline()`, `addEpisode()`, `setName()`, `execute()` are all
`onlyOwner`. Verify with:

```bash
cast call 0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886 "owner()(address)" \
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

The `SlopComputer` registry now lives in the **slop-computer-contracts**
repo (Foundry) and its deploy script reverts unless the resulting owner is
**austingriffith.eth** on live networks. The constructor takes
`initialOwner`; the deploy guard enforces atg.eth.

**Deploy so the owner is austingriffith.eth (`0x34aA3F…fDF3`).** If you end
up with a different owner, transfer it back immediately with
`transferOwnership(0x34aA3F359A9D614239015126635CE7732c18fDF3)` from the new
owner. (The old clawdbotatg.eth-owned `SlopComputerFrontpage` is retired.)

## What goes wrong if you swap them

- ~~atg.eth signing `goLive()` → tx reverts (`not owner`)~~ — **no longer true**: atg.eth now owns the `SlopComputer` registry and is the one who must sign `goLive`/`addEpisode`/`setName`/`execute`. clawdbotatg.eth signing those would revert on the new contract.
- atg.eth as relay admin → atg.eth could move shared windows that
  clawdbotatg.eth thinks it controls — confused state, no source of
  truth
- clawdbotatg.eth as a participant → relay would treat its admin
  actions as host actions, conflating the broadcast role with a
  guest cursor on the desktop

## Useful CLI snippets

Check current contract owner:
```bash
cast call 0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886 "owner()(address)" \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY
```

Transfer ownership (if it ever ends up wrong — target austingriffith.eth):
```bash
cast send 0xf3ce3614fe8cd4294a0bf05d10cfda9d9cbc4886 \
  "transferOwnership(address)" 0x34aA3F359A9D614239015126635CE7732c18fDF3 \
  --rpc-url https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY \
  --private-key $CURRENT_OWNER_KEY
```

Verify relay admin allowlist on EC2:
```bash
ssh slopcomputer "grep ADMIN_ADDRESSES /home/ubuntu/slop-computer-live/packages/relay/.env"
```

## Privacy Wallet — the one place the box DOES hold user keys

Everything above upholds "no server-held user keys." The **Privacy Wallet**
app (Railgun via kohaku-cli — see `docs/PRIVACY-WALLET.md`) is the explicit,
documented exception: while a user's funds are inside its
deposit → shield → soak → withdraw lifecycle, the relay box holds the kohaku
HD seed that controls them. It is a custodial privacy service (unlinkability,
not trustlessness), gated to signed-in users and capped to small mainnet
amounts (`KOHAKU_MAX_DEPOSIT_WEI` / `KOHAKU_MAX_SEND_WEI`). The kohaku seed +
master password live in relay env / gitignored files on the box — never in
git, never in the browser. Don't extend server-side key custody to any other
feature without the same level of documentation and caps.

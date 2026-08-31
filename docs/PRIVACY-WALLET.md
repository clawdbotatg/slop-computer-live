# Shield (né Privacy Wallet) — Railgun via kohaku-cli

User-facing name: **Shield** (app id stays `privacy`). It is a shielded
pass-through, not a resident wallet — ETH in linked to you, ETH out clean.

The desktop app (label "Shield", id `privacy`) that walks one signed-in user
through: **deposit ETH → auto-shield into Railgun (mainnet) → soak while the
anonymity set grows → withdraw to a fresh unlinked address → send anywhere.**
The ETH you end up spending has no on-chain link to where it came from.

Relay module: `packages/relay/src/kohaku.ts`. UI:
`packages/nextjs/components/desktop/PrivacyWalletWindow.tsx`.

## ⚠️ The custody reality (read first)

Railgun proving needs the spend key, and kohaku-cli proves **server-side**.
While funds are anywhere in the lifecycle (deposited → shielded →
withdrawn-but-not-sent-out), **the slop box holds the keys**. This is a
custodial privacy service — like a mixer — *not* self-custody. It provides
*unlinkability*, not trustlessness. The user regains self-custody only when
they `send` the withdrawn funds to their own external address.

This is a deliberate departure from the repo's previous "no server-held user
keys" posture (see `WALLETS.md`). Mitigations baked in:

- **Mainnet, small amounts only**: `KOHAKU_MAX_DEPOSIT_WEI` (watcher refuses
  to shield over-cap deposits) and `KOHAKU_MAX_SEND_WEI` (per-op send cap).
- **Auth required**: every `/v1/kohaku/*` route needs a session with an
  address (SIWE or passkey) — anonymous sessions are rejected, so funds
  always have a durable owner.
- Seed + master password live in relay env / gitignored files on the box,
  never in git.

## Architecture: one box wallet, per-user accounting

One kohaku wallet (`slop`) for the whole app. Each user gets a distinct HD
public account for deposit and another for withdrawal
(`next-fresh-address`); all shielded funds **commingle in one Railgun
balance** — the best case for anonymity and one historical sync total. The
relay tracks per-user phase/amounts in `KOHAKU_STATE_PATH`
(`/var/lib/slop-relay/kohaku-state.json`); withdrawal is capped to the
user's accounted balance **app-side** (Railgun notes are fungible).
Trade-off: accounting-trust (a relay bug could misattribute) and one seed
(a box compromise drains the pool). Per-user seeds would still live on the
same box, so single-seed is operationally simpler and privacy-better.

## Lifecycle / endpoints (all cookie-authed, room-gate skipped)

| Endpoint | What it does |
|---|---|
| `GET /v1/kohaku/state` | Phase, addresses, amounts, soak progress, anonymity count, activity log. |
| `POST /v1/kohaku/open` | Derive a fresh deposit address; phase → `awaiting-deposit`. Also "start a new cycle" once a finished wallet is emptied. |
| `POST /v1/kohaku/withdraw` | Unshield to a fresh address. Only from `soaking` (i.e. POI-spendable). Uses `--amount-max` when the user is the pool's only accounted balance, else amount − 60 bps margin. |
| `POST /v1/kohaku/send` | Plain ETH transfer out of the withdrawal address via kohaku `transfer` (simulates before broadcast). Capped per-op. |
| `POST /v1/kohaku/settings` | Per-user mainnet RPC override (`{rpcUrl}`; empty = reset to box default). Validated hard server-side: https/http only, no private/LAN addresses, must answer `eth_chainId`=0x1 AND serve `eth_getLogs` (Railgun sync is logs-driven — the public BuidlGuidl RPC fails this with 429s, verified from two IPs 2026-07). The user's override drives all their ops; the shared pool sync stays on the box default. `defaultRpcUrl` in responses is origin-only — never the raw URL, which may embed an API key. |

The **deposit watcher** (30s tick) polls awaiting-deposit addresses; a
stable balance ≥ 0.002 ETH auto-shields (`shield --protocol railgun`,
leaving `KOHAKU_SHIELD_GAS_RESERVE_WEI` for the tx's own gas). Phase
`shielding` covers POI maturation (~30–45 min): a 5-min `balances --include
railgun --verbose` sync matches the user's note by value and flips to
`soaking` when it turns spendable (fallback: 45 min + pool-spendable check).
The **soak bar** runs `KOHAKU_SOAK_HOURS` (default 4h); the **anonymity
counter** counts real Railgun `Shield` events since the user's shield block
(viem `getLogs` against the proxy `0xFA7093…FA4b9`, chunked, incremental —
signature verified live 2026-07: ~85 shields/day baseline).

## Config (relay env)

```
KOHAKU_CLI_DIR=/home/ubuntu/kohaku-cli-next   # checkout the relay spawns via `npx tsx` (see "Upgrading")
KOHAKU_RPC_URL=https://...                    # mainnet RPC (must serve getLogs spans of 499)
KOHAKU_WALLET_PASSWORD=...                    # keystore master pw (written to a 0600 file, not argv)
KOHAKU_WALLET=slop                            # wallet name (default)
KOHAKU_DATA_DIR=                              # optional --dataDir (default ~/.kohaku-cli)
KOHAKU_MAX_DEPOSIT_WEI=50000000000000000      # 0.05 ETH
KOHAKU_MAX_SEND_WEI=50000000000000000         # 0.05 ETH
KOHAKU_SOAK_HOURS=4
KOHAKU_STATE_PATH=/var/lib/slop-relay/kohaku-state.json
KOHAKU_WITHOUT_TOR=1                          # kohaku ≥0.0.2 routes non-RPC HTTP over Tor by default
```

Unset `KOHAKU_CLI_DIR`/`KOHAKU_RPC_URL`/`KOHAKU_WALLET_PASSWORD` → the
feature degrades: routes 503, UI shows "not configured", watcher never
starts.

## Deploying to prod (not yet done — checklist)

1. Clone kohaku-cli on the box, `npm install`. Run via `npx tsx
   src/index.ts` — the packaged dist has an ESM dir-import bug in
   `@kohaku-eth/railgun`.
2. Import the slop wallet seed (`create-wallet slop --import`) or copy the
   whole kohaku data dir from the dev box.
3. **Ship the pre-synced `rg-storage.json`** (in the kohaku data dir,
   ~450 MB) so prod never does the cold Railgun historical sync — that scan
   starts at block 14,643,507 and needs an archive-grade RPC (Alchemy) once.
   After seeding, incremental syncs run against `KOHAKU_RPC_URL`.
4. Set the env above in the relay's env file; restart `slop-relay`.
5. Watch `journalctl -u slop-relay | grep kohaku` — the watcher logs every
   lifecycle transition.

## Upgrading kohaku-cli (pinned version + rollback)

**Prod runs kohaku-cli `v0.0.5` (`ad9c036`), upgraded 2026-08-31** from the
July `54d0ecc` (`v0.0.1`-era) build it shipped on — 41 commits.

The cutover is deliberately a **one-line env flip**, not a `git pull` in the
live checkout: the new version lives in its own directory and
`KOHAKU_CLI_DIR` chooses which one the relay spawns. The old checkout stays
on disk, so rollback is that same line plus a relay restart.

### The recipe (used for the 0.0.5 upgrade)

```bash
# 1. staging checkout — never touch the live one
ssh slopcomputer
git clone https://github.com/kassandraoftroy/kohaku-cli ~/kohaku-cli-next
cd ~/kohaku-cli-next && npm install

# 2. prove it against a COPY of the synced data dir (see the compat gate below)
cp -a ~/.kohaku-cli ~/.kohaku-cli-test
cd ~/kohaku-cli-next && RPC_URL=<mainnet> KOHAKU_WITHOUT_TOR=1 \
  npx tsx src/index.ts balances --wallet slop \
  --password /var/lib/slop-relay/kohaku.pw \
  --include railgun --verbose --non-interactive --dataDir ~/.kohaku-cli-test

# 3. flip + restart, then rm -rf ~/.kohaku-cli-test
sed -i 's|^KOHAKU_CLI_DIR=.*|KOHAKU_CLI_DIR=/home/ubuntu/kohaku-cli-next|' \
  ~/slop-computer-live/packages/relay/.env
sudo systemctl restart slop-relay
```

Rollback: point `KOHAKU_CLI_DIR` back at the old checkout, restart. Verified
2026-08-31 — the old CLI reads an `rg-storage.json` that 0.0.5 has written
and returns identical balances, so **the store is compatible in both
directions** and a rollback costs no re-sync.

### The compat gate — what an upgrade must clear

The dangerous failure is not a broken flag, it's a **cold Railgun re-sync**:
the pre-seeded `rg-storage.json` is ~450 MB and rebuilding it needs an
archive RPC and hours. So before flipping, run step 2 above and confirm it
returns in minutes, not hours. Checked for 0.0.5 (all passed):

| Check | Result |
|---|---|
| `rg-storage.json` written by alpha.28 readable by alpha.30 | ✅ incremental, ~4 min |
| Old CLI still reads the store 0.0.5 wrote (rollback) | ✅ ~2 min, identical output |
| Flags we spawn (`--wallet/--password <file>/--dataDir/--non-interactive`, `shield --protocol`, `unshield --amount-max/--to/--broadcast`, `transfer`, `transact-raw`, `next-fresh-address`) | ✅ all still present |
| JSON keys we parse (`private_balances.railgun[].raw_token_holdings/status`, `private_notes[].balance_raw/status`, `transactions[].type/hash`, `amountWei`, `explorerHash`) | ✅ unchanged |
| Status vocabulary (`spendable` on balance rows, `Valid` on notes) | ✅ unchanged — see `userNoteStatus()` |
| `next-fresh-address --non-interactive` still prints the bare address | ✅ |

### ⚠️ Tor is on by default from 0.0.2 — we turn it off

Upstream now routes **all non-RPC HTTP** (Pimlico bundler, proving-artifact
downloads, sync-cache snapshots) through Tor via `tor-js`/Arti. RPC stays
clearnet. That is a real privacy win and a bad thing to discover mid-show:
it adds an Arti bootstrap that can fail (`Bootstrap failed: tor: …`, fixed
with `clear-tor-cache`) and makes unshields slower.

We set **`KOHAKU_WITHOUT_TOR=1`** in the relay env. The relay spawns the CLI
with `{...process.env}` and config loads `dotenv/config`, so the env var
reaches the child with **no code change** — and dropping the line (plus a
relay restart) is all it takes to run the whole lifecycle over Tor.

### What 0.0.5 buys us

Faster protocol syncs and a `fetch-sync-cache` prefetch command (0.0.4);
`--amount-max` and `--skip-sim` on `shield`; unshield to a custom/ephemeral
recipient no longer mis-routes (0.0.4); `--tail-calls` on ERC-20 unshields;
ERC-5564 stealth addresses; ENS/`.gwei`/`.wei` name resolution; Tornado Cash
and Privacy Pools alongside Railgun; `reveal-seed-phrase`; pinned deps and
CI. The relay uses none of the new surface yet — the upgrade was taken for
sync speed, the unshield-recipient fix, and to stop running a four-releases-
old build of a CLI whose author comes on the show.

## ⚠️ Dev/prod share ONE seed — never run a kohaku-configured dev relay

Dev (`~/.kohaku-cli` on the Mac) and prod hold copies of the same wallet.
Their public-account index files drift independently, so `next-fresh-address`
on both sides derives THE SAME addresses (observed live: dev probe and prod
both derived `0x7B15…eB0F`). A kohaku-configured dev relay left running will
watch — and try to shield — addresses that belong to prod users, racing prod
with the same keys. Rule: local testing of the kohaku module only with the
relay shut down immediately after, and never while a prod cycle is active.
The UI probe suite is fine (it stops before any money moves), but kill the
local stack when done.

## Known risks / follow-ups

- **PPOI stuck-pending** (seen intermittently upstream): a change note can
  sit "pending" after a withdrawal. The pool sync surfaces
  spendable-vs-settling; if a note never matures, re-sync and escalate.
- **Pimlico public bundler**: unshields route through it (gas paid from the
  private balance, so the fresh address needs no ETH). If it's down,
  withdrawals fail with a surfaced error and the user stays in `soaking` —
  retry later.
- **One prover at a time**: kohaku ops are serialized in-process; concurrent
  withdrawals queue. Fine at slop scale.
- **Wallet-mode chat + holdings shipped 2026-07-19**: read-only Zerion
  holdings via the relay proxy, and `POST /v1/kohaku/chat` (Bankr LLM) where
  the model only PROPOSES sends — the UI confirm chip fires the capped
  `/v1/kohaku/send`. Destinations must be user-given (0x or ENS).
- **Per-room shields shipped 2026-07-20**: records are keyed
  `address::roomSlug` — the same user gets an independent cycle (deposit
  address, soak, clean wallet, chat history) in every room. The RPC
  override stays per-ADDRESS (user preference). Caps are per-cycle, so a
  user's total exposure is now cap × rooms — accounting-trust as before,
  fine at slop scale. Client sends `?slug=` already; no UI change.
  (A transitional legacy bare-address fallback existed for one day; the
  last pre-room record was drained and the fallback removed 2026-07-21.)
- **Full intent-engine chat shipped 2026-07-20**: in wallet phase the chat
  runs `runWalletIntent` (the Wallet app's brain — LI.FI swaps, ERC-20
  sends, wraps, simulation) against the clean address in `walletKind:"eoa"`
  mode with a SHIELD MODE system override (mainnet-only, per-op ETH cap,
  known-wallet privacy warning). The engine's transactions become a
  server-stored proposal (10 min TTL, one per owner); the UI confirm chip
  fires `POST /v1/kohaku/execute {id}` — calldata never crosses the wire
  inbound. Execution is per-step kohaku-cli invocations (`transfer` for
  plain sends, `transact-raw` otherwise) so each step's pre-broadcast
  simulation sees the prior step mined (approve → swap). Total ETH value
  per confirmed op stays under `KOHAKU_MAX_SEND_WEI`; ERC-20 amounts ride
  free (they entered via capped ETH). Earlier phases keep the lightweight
  Bankr Q&A. NOTE: post-swap the clean address holds ERC-20s — the Send tab
  is still ETH-only, so tokens leave via chat ("send my USDC to 0x…").
  "Send it all" is server-computed: each turn injects the exact spendable
  max (balance − 21000-gas reserve at 1.2× current max fee, the CLI's
  --amount-max math) into the system prompt — the first live drain showed
  the model otherwise invents a round buffer (stranded 0.00035, ~230× the
  actual fee).
- The de-risk run (2026-07, ~0.015 ETH end-to-end: shield `0x260ce0d2…`,
  unshield userOp `0x8541c55b…`) validated the whole mechanism on mainnet.

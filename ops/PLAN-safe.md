# PLAN: every multisig is a Gnosis Safe

2026-10-07. Replace our own `Multisig.sol` (slop-computer-wallet repo, v1–v4)
with Safe everywhere: room Bank wallets, personal passkey wallets, and every
feature that proposes through them. **No migration** (Austin, 10-07): old
multisigs are abandoned after a one-time dust sweep; legacy code is deleted,
not kept alongside.

Prior art we copy from, both Austin's: `clawdbotatg/instant-wallet`
(`web/lib/safe/{core,sign,send,wedgie}.ts`, relay at
`web/app/api/safe/relay/route.ts`) and `clawdbotatg/wedgie-dev`
(`src/safe/eth.ts`, `src/pages/safe.ts`).

## Contract set (verified present on all 7 chains, 2026-10-07)

Base, Ethereum, Optimism, Arbitrum, Polygon, Gnosis, Robinhood 4663 — all
have every address below, plus the P-256 precompile at `0x100` (checked with
a valid RIP-7212 vector, and a bogus address as negative control).

| role | address |
|---|---|
| SafeL2 1.5.0 | `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e` |
| SafeProxyFactory 1.5.0 | `0x14F2982D601c9458F93bd70B218933A6f8165e7b` |
| CompatibilityFallbackHandler 1.5.0 | `0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4` |
| MultiSendCallOnly 1.4.1 (all batches — the wedgie decodes this one) | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` |
| SafeWebAuthnSignerFactory (safe-modules passkey 0.2.1) | `0x1d31F259eE307358a26dFb23EB365939E8641195` |
| Daimo P-256 verifier (fallback) | `0xc2b78104907F722DABAc4C69f826a522B2754De4` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

Same choices as instant-wallet, so the Safe lib ports nearly verbatim.

**Verifier config is a constant: `(0x100 << 160) | DAIMO`, everywhere,
forever.** It's part of the signer proxy's CREATE2 address — change it (or
use precompile-only like wedgie.dev/safe does) and the same passkey becomes a
different owner. Note: a wedgie set up on wedgie.dev/safe therefore has a
different signer address there than here; that's fine, same key.

## Signer model

Every Safe owner is an address. Three kinds of signer map onto that:

- **EOA** (injected wallet) — owner is the address; signs the SafeTx EIP-712
  typed data (`eth_signTypedData_v4`). Replaces today's `personal_sign` of a
  raw hash — wallets now clear-sign.
- **Passkey** (`qx,qy` we already store per peer) — owner is the
  `SafeWebAuthnSignerProxy` address, computed offline by CREATE2. Signs with
  WebAuthn, challenge = safeTxHash; encoded as a v=0 contract signature
  (instant-wallet `sign.ts`). The **proxy must be deployed on a chain before
  its signature is valid there** → we deploy it (below).
- **Wedgie** (P-256 on a Trust M, USB WebSerial, desktop Chromium only) —
  same signer-proxy owner type as a passkey; the device forges the WebAuthn
  envelope with origin `https://wedgie.dev`. Port instant-wallet `wedgie.ts`.
  **Never the sole signer, never enough alone** (its firmware isn't locked —
  wedgie-dev `docs/PLAN-TRUST.md`); deploy/add-owner UI enforces it.

Peer identity stays `keccak(qx‖qy)` (the passkey address); owner ↔ peer
mapping is `signerProxy(qx,qy) ↔ passkeyAddr`, kept in the relay wallet
record. `room-auth.ts` `wallet-signers` gate and `Desktop.tsx` peer matching
read through that map, never raw `getOwners()`.

## Deploying on behalf of passkeys

Relay endpoint (sponsored, hot key = today's `PERSONAL_WALLET_DEPLOYER`):

- `POST /v1/safe/signer` `{qx,qy,chainId}` → `createSigner` if no code yet.
  Idempotent. Only for keys that belong to a known peer of the room, rate
  limited, L2s free; mainnet behind a cap (it's a real dollar or two).
- Called automatically: at Bank deploy for every passkey/wedgie owner on every
  chosen chain, when an owner is added, and when the Safe is deployed to a
  new chain. Execution also re-checks and batches `createSigner` via
  Multicall3 (allowFailure) if a proxy is somehow missing.

Bank deploy UI (`WalletWindow.tsx` `DeployTab`): signer list shows each
owner's kind and, per chain, "signer contract ✓ / deploying… / missing".
Deploy = one Multicall3 `aggregate3`: `createSigner`×N (allowFailure) +
`createProxyWithNonce(SafeL2, initializer, saltNonce)`. Payer: host's wallet
if they have one; **relay sponsors the whole deploy on L2s when the host is
passkey-only**.

## The traps (each one has a rule)

1. **No deadline.** Safe signatures never expire; a half-signed tx stays live
   until its nonce is consumed. Queue shows the nonce; "Cancel" = propose a
   0-value self-call at the same nonce. Relay drops queued txs whose nonce is
   below the Safe's current nonce.
2. **Delegatecall.** Batches are `operation=1` to MultiSendCallOnly 1.4.1.
   Relay + UI **reject `operation=1` to any other address**, from every
   source: Bank UI, shared-browser captures, `wallet-intent.ts`,
   `/v1/wallet/propose`.
3. **Owner list is a linked list.** `removeOwner(prev, owner, thr)` /
   `swapOwner(prev, …)` need `prevOwner` read at **build** time; if owners
   change before execution it reverts. Build these from a fresh `getOwners()`
   and invalidate queued owner-changes when owners change.
4. **Same address on a new chain.** Safe address = f(initializer, saltNonce).
   Deploying to another chain later only gives the same address with the
   **original** initializer (original owners), and then the owner set must be
   brought up to date by a tx the *original* owners sign there. Verified in
   SafeProxyFactory source (1.4.1, 1.5.0, main): `salt =
   keccak(keccak(initializer), saltNonce)`. An owner-free salt is only possible
   by letting one key (our relay) set owners on new chains — rejected.
   **Decision (10-07): a room's Safe is deployed on all 7 chains at creation,
   mainnet included.** "Add chain later" warns when owners have changed since
   genesis and shows the sync tx.
5. **Nested signing** (`wallet_nested_*`, a Safe as a signer of another
   Safe): Safe-as-owner signs via EIP-1271 through the fallback handler with
   the SafeMessage hash. Rebuild that flow; don't port the old attestation.
6. **app.safe.global escape hatch** works for EOA owners; passkey owners at
   threshold ≥ 2 may not work there (safe-wallet issue #8808). Don't promise it
   for passkey-only rooms.
7. **Wedgie request limit** is 6 KB of JSON — refuse big batches for it up
   front with a clear message instead of a "line too long" from the device.

## Personal passkey wallets

Safe, owners `[signerProxy(qx,qy), PLATFORM_COSIGNER]`, threshold 1,
`saltNonce = keccak("slop-personal-safe-v1")`. Address depends only on the
passkey (co-signer is a constant) — no longer on who deployed it. First spend:
relay Multicall3 `createSigner` + `createProxyWithNonce` + `execTransaction`
(instant-wallet's relay shape). Keep `PERSONAL_WALLET_MAX_SPEND_WEI` as a relay
guard; Zodiac Roles allowances are a later option, not v1.

## Queue

Our relay queue stays the source of truth (works on Robinhood, carries AI /
agent proposals). Stored per tx: full SafeTx (`to, value, data, operation,
safeTxGas=0, baseGas=0, gasPrice=0, gasToken=0, refundReceiver=0, nonce`),
safeTxHash, sigs by owner. Not mirrored to Safe's tx service in v1.

## Phases

0. **Sweep** the old multisigs with value (list below) — using the current UI,
   before anything is deleted.
1. ✅ 10-07 — `packages/nextjs/utils/safe.ts` (viem-only, loadable by relay + probes),
   proven by `ops/probes/safe-fork.mjs` on Base and Robinhood forks with a real
   Chrome passkey. Remaining: Safari + iOS assertions. Original scope —: address
   math (signer proxy, Safe), initializer, SafeTx hash, signature packing
   (sorted, contract sigs after heads), MultiSend encoding, passkey sign,
   EIP-712 EOA sign. Foundry fork tests on Base + Robinhood, including a
   **real** slop.computer passkey assertion from Chrome, Safari, and iOS
   (clientDataJSON field order differs by browser; Safe's signer rebuilds it
   from `type`+`challenge`+the rest — prove it on all three).
2. ✅ 10-07 (not deployed yet — nothing calls it until phase 3) — **Relay**:
   `packages/relay/src/safe-relay.ts` + routes in `index.ts`:
   `POST /v1/safe/deploy` (new Safe on all 7 chains, or empty body = retry
   missing chains; progress over WS `safe_deploy_status`), `GET
   /v1/safe/status`, `POST /v1/safe/signer`, `POST /v1/safe/exec`. Record has
   `kind:"safe"`, passkey owners carry `passkeyAddr` + `device`; txs carry
   `operation`; `wallet_tx_propose` re-derives the safeTxHash and blocks
   foreign delegatecall; executing a nonce cancels its siblings. Relay copies
   `nextjs/utils/safe.ts` at build. Proven by `ops/probes/safe-relay-fork.mjs`.
   Left for phase 4: escrow payout settle on `/v1/safe/exec` (today only the
   WS `wallet_tx_status` path settles it).
   **Needs Austin:** fund the payer `0xBa16e496574514A28b15e19c222c4d367c6C0FF0`
   on Optimism, Arbitrum, Polygon, Gnosis, Robinhood (has mainnet + Base only).
3. 🟡 10-07 **Bank UI** (pushed, NOT deployed — deploying hides every legacy
   multisig, so the phase-0 sweep must be finished first): Deploy tab =
   "Create Safe" → `/v1/safe/deploy`, per-chain live/deploying/failed + retry;
   TxCard signs Safe txs (EOA EIP-712 after a chain switch, passkey
   `signSafeTxWithPasskey`), Execute → `/v1/safe/exec`, Cancel = no-op at the
   same nonce. `usePeerMesh` drops non-Safe wallet records; relay refuses the
   legacy `wallet_deploy`. Batch proposers (SharedBrowser, WagerPanel, Assets
   send-all, header sweep) send `calls` and let the relay fill the hash.
   Still to do: add/remove owner + threshold UI, wedgie, SharedBrowser
   `wallet_sendCalls` status tracking (keyed by execHash, which the relay now
   picks), untested in a real browser.
4. **Consumers**: EnsWindow (reverse `setName` as a Safe tx on mainnet — Safe
   must be on mainnet), SharedBrowser + browser-host inject (batches →
   MultiSend; typed-data signing could now be allowed via 1271 — later),
   PrivacyWalletWindow, WagerPanel/Poker escrow, tips, room gate,
   `wallet-intent.ts` owner-change builders, `wallet-ai.ts` simulation,
   `/v1/wallet/propose`, `/v1/rooms/:slug/meta`, agent skill docs.
5. **Personal wallets** on Safe (`personal-wallet.ts`, `usePersonalWallet*`,
   `PasskeyWalletContext`).
6. **Wedgie** signer in Bank (desktop Chrome).
7. **Delete** `contracts/multisig.ts`, `utils/multisig.ts`, the
   Multisig/MultisigFactory ABIs, `computeExecHash`, old nested-attestation
   code; update `docs/PASSKEY-WALLET.md` and the ENS note in CLAUDE.md.

## Phase 0 — old multisigs holding value (scanned 2026-10-07)

Room multisigs from prod `rooms/*/wallet.json` + every `MultisigCreated` on
the Base v4 factory, native balance + USDC, all 7 chains. NFTs / other ERC-20s
not scanned.

| room | address | holdings |
|---|---|---|
| austingriffith | `0xa2cde0bd…58b881` | 0.0119 ETH (mainnet) |
| buidlguidl (4-of-n) | `0x557c3311…8ee142` | 0.0022 ETH + 1.56 USDC (Base), 0.0001 ETH (mainnet) |
| gregskril | `0x81a84064…39f3` | 0.0018 ETH (mainnet) |
| 0xrcinus | `0x30e1264d…6a10a8` | 0.03 xDAI (Gnosis), 0.001 ETH (Base) |
| pokernight | `0xbbaad0ca…0289b` | 0.003 ETH (Robinhood), 0.0023 ETH (Base) |
| binji-x | `0x9db965be…3f081` | 0.0008 ETH (Base) |
| rhynotic | `0x2e1e7924…33d4` | 0.19 USDC (Base) |
| (personal wallet, Base) | `0x2ba1bb84…1e18` | 0.0004 ETH |

Total ≈ 0.0235 ETH + 1.75 USDC + 0.03 xDAI. Each needs its own signers to
sign (`0x34aa…fDF3` appears in most rooms' wallet records; signer sets not
yet checked onchain).

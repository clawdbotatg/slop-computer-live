# Passkey Personal Wallets (smart-account mode for passkey sign-in)

> Status: **plan / not built.** This describes a new mode where signing in
> with a passkey gives you a real, spendable wallet address — a personal
> multisig the passkey controls — instead of the un-spendable raw passkey
> identifier. The raw passkey address keeps doing its existing job (signer
> on the main/room multisig); we just stop ever showing it as a place to
> receive funds.

## TL;DR

- **Problem.** The address a passkey user is "given" today is
  `keccak256(qx ‖ qy)[-20:]` — a P-256 (secp256r1) identifier. It is **not a
  spendable account**: no secp256k1 key, no contract code. ETH/ERC-20 sent
  there is **burned forever**. It's a username that looks like a wallet.
- **Fix.** On passkey sign-in, derive + show a **personal multisig** (a slop
  Multisig smart-account) whose address the user can safely receive into and
  spend out of. The passkey is the signer.
- **Recovery (accepted trust model).** The personal multisig is a **1-of-2**:
  signers = `[passkey, mainMultisig]`, threshold **1**. Either can act alone.
  This means **if the main multisig colludes it can sweep any passkey wallet** —
  that is an *accepted* tradeoff: the main multisig is already the custody root
  here, balances are small, and the upside is users never lose funds when they
  lose a passkey. (A trustless, rotate-only timelocked recovery module is the
  future hardening — see §9 — but is **explicitly out of scope for v1**.)
- **Cost to build.** **Zero new Solidity.** The v4 Multisig already does
  M-of-N, passkey signers, nested-multisig (ERC-1271) signers, add/remove
  signer, CREATE2 counterfactual addresses, and funding-before-deploy. The work
  is **UI + one new backend service: the facilitator** (a gas relayer that
  broadcasts threshold-met txs, since passkey users have no EOA/ETH).

## 1. Concepts / terminology

| Term | What it is | Spendable? | Shown to user? |
|------|-----------|------------|----------------|
| **Raw passkey address** | `keccak256(qx‖qy)[-20:]`, P-256 derived. Internal identity key (chat handles, `customNames`, participant keys, glossary). | ❌ never | ❌ hidden as a fund target |
| **Personal multisig** | A slop Multisig: `[passkey, mainMultisig]`, threshold 1. CREATE2-deterministic from the passkey. | ✅ via facilitator | ✅ **this is "your address"** |
| **Main multisig** | The shared/room multisig. The **passkey is a direct signer** on it. Also the 2nd (recovery) signer on the personal multisig. | ✅ | as the room/shared wallet |
| **Facilitator** | New relay-side service. Holds a funded hot EOA per chain; watches for txs that reached threshold signatures; broadcasts `execTransaction` and pays gas. | n/a | invisible |

Key separation: **identity ≠ custody.** The raw passkey id stays the
internal identity everywhere it's used today. The personal multisig is a new
*wallet* concept layered on top. Do **not** rip out the passkey-id keying.

## 2. What already exists (the leverage)

From the v4 contract (`packages/nextjs/contracts/multisig.ts`, factory
`0xfcdEe21865b60C2700C23Cd946316CEdA0F215B5`, live on Base/ETH/OP/Arb/Polygon/Gnosis):

- ✅ M-of-N threshold; `addAccountSigner` / `addPasskeySigner` / `removeSigner` / `changeThreshold`
- ✅ Signer kinds: Account (`sigType 0` = EOA / 7702 / Safe / **nested Multisig** via ECDSA-or-ERC1271) and Passkey (`sigType 1`, P-256/WebAuthn)
- ✅ `execTransaction` + `execBatchTransaction`, with `deadline` (replay/expiry) and on-chain nonce
- ✅ Passkey **signing** fully wired client-side (`utils/passkey.ts` `signMultisigExecWithPasskey`)
- ✅ Nested-multisig ERC-1271 attestation routing (`WalletWindow.tsx` collects inner sigs → blob → outer tx)
- ✅ CREATE2 counterfactual: `MultisigFactory.getMultisigAddress(deployer, salt)`, `salt = keccak256(label)` (`utils/multisig.ts`), **same address on every chain**
- ✅ **Funding before deploy works** — the UI already states it; you just can't *execute* on a chain until `createMultisig` runs there

The **only** gap is execution-without-an-EOA → the facilitator (§7).

## 3. Topology

```
        passkey (P-256, in the authenticator)
          │  signs execHash off-chain
          ├─────────────► PERSONAL MULTISIG  (1-of-2, threshold 1)
          │                  signers: [passkey, mainMultisig]
          │                  • the address shown to the user
          │                  • receive here, spend here
          │                  • mainMultisig is the recovery co-signer
          │                       (drainable — accepted)
          │
          └─────────────► MAIN / ROOM MULTISIG  (M-of-N)
                             • passkey is a DIRECT signer here
                             • shared custody / room pot
                             • also the recovery leg above

   FACILITATOR (relay) ── broadcasts any tx that reached threshold sigs,
                          pays gas from a hot wallet. Makes "spend" possible
                          for passkey-only users.
```

A poker room of all-passkey players is then: a room multisig that's
(say) 5-of-10 of passkeys, each player also holding their own personal
multisig, and the room multisig acting as each player's recovery leg.

## 4. Personal-multisig address derivation (counterfactual)

Deterministic so the **same passkey always lands on the same wallet**, no
server state needed:

```
deployer = <a fixed slop deployer/factory-caller address>   // constant
salt     = keccak256("slop-personal-v1:" ‖ rawPasskeyAddress) // commits to the passkey
address  = MultisigFactory.getMultisigAddress(deployer, salt)
```

- Show this `address` the moment the passkey authenticates. People can send
  to it immediately (funding-before-deploy).
- **Lazy deploy**: only call `createMultisig([passkey, mainMultisig], 1, salt)`
  on the **first spend** (or first recovery action) on a given chain. No gas
  spent on wallets that never get funded.
- Because `getMultisigAddress` keys on `(deployer, salt)` **only** (not the
  signer set), the address is stable regardless of who the recovery signer is.
  **Front-run-init note:** whoever initializes first picks the signers — so
  the salt must commit to the passkey (above) **and** initialization must go
  through the trusted facilitator/relay path, never an open call. (Optionally
  fold a hash of the intended signer set into the salt namespace.)
- **Per-chain**: the address is identical on all 6 chains; deploy on demand
  per chain on first spend there.

## 5. Identity vs custody (don't regress this)

- Keep the **raw passkey id** as the identity key in: `participants.ts`,
  `chat.ts`, `peers.ts`, `glossary.ts`, `customNames`, transcript speaker
  dedupe, `usePeerMesh` peer ids. **No change.**
- Add a **separate** `personalWallet` field alongside it (derived address +
  deploy status per chain). UI surfaces *that* as "your address / your funds."
- The raw passkey address is **never** rendered with a receive/QR/copy
  affordance again. Audit every place it's shown (see §11) and either hide it
  or relabel it as a non-receivable identity badge.

## 6. Receive & spend flows

**Receive** (works as soon as passkey connects, no deploy):
1. Passkey signs in → compute personal-multisig address (§4) → show it (QR/copy).
2. User/anyone sends ETH/ERC-20 to it. Funds sit at the counterfactual address.

**Spend** (needs deploy + facilitator):
1. User initiates a send (or buy-in) from the personal wallet in the UI.
2. If not yet deployed on this chain → the tx batch is prefixed with the
   `createMultisig` deploy (or facilitator deploys first), idempotently.
3. Passkey signs the `execHash` (`signMultisigExecWithPasskey`) → 1 signature,
   threshold met (1-of-2).
4. The signed tx + sigs land in relay wallet state (same path room/chess txs
   use today).
5. **Facilitator** sees threshold met → assembles `execTransaction(target,
   value, data, deadline, [sig])` → broadcasts from its hot wallet → pays gas →
   watches receipt → reports back to the room.

## 7. The facilitator (the one new backend service)

A relay-side module (new `packages/relay/src/facilitator.ts`), reusing the
existing viem + `config.alchemyApiKey` plumbing (`gas.ts`, `wallet-data.ts`).

**Responsibilities**
- Hold a **hot EOA per chain**, funded with a small ETH float (start: Base only).
- Subscribe to wallet-tx state (the relay already tracks `tx.signatures` +
  `threshold`). When `signatures ≥ threshold` for a tx it's allowed to serve:
  - deploy the personal multisig if needed (idempotent — check code at address),
  - assemble + sort sigs (port `sortSignatures` / the encode logic from
    `WalletWindow.tsx` to the relay; nested-1271 assembly already partly lives
    server-side),
  - `writeContract` / `sendTransaction` `execTransaction`,
  - watch the receipt, broadcast success/failure back to the room.

**Gas economics**
- On Base, an `execTransaction` is fractions of a cent → **subsidize for v1.**
- Phase-2 reimbursement: append a leg to the batch that refunds the
  facilitator's gas in ETH from the wallet (only when the wallet holds ETH).

**Guardrails (required, not optional)**
- **Allowlist:** only facilitate multisigs slop derived/knows (its own factory
  + salts it computed, and room multisigs). Never a stranger's arbitrary call.
- **Per-identity rate limit** (reuse `rate-limit.ts`) — a passkey is free to
  mint, so cap tx/min per passkey-id to stop gas-drain griefing.
- **Spend/size caps** per tx and per window; **min-balance** to deploy.
- **Key hygiene:** the hot-wallet private key lives **only** in the relay's
  gitignored env (the `.clawd-harness.env`-style file), **never committed**.
  (See repo rule on never committing private keys.)
- **RPC:** Alchemy only, per repo RPC rules — no public endpoints.
- On-chain replay/expiry is already handled by the contract's `deadline` +
  nonce; the facilitator just must not double-broadcast (track in-flight tx ids).

**Scope:** start with **one global slop-computer facilitator**. A per-room
facilitator is a later option (same module, room-scoped float + allowlist).

## 8. Room integration

- **Passkey is a direct signer on the room multisig** (unchanged from today's
  `createMultisig` signer arrays — passkeys already go in the `passkeyQxs/Qys/
  credentialIdHashes` arrays).
- **Buy-in** changes from `EOA → roomMultisig` (today's `WagerPanel.tsx`
  `sendTransactionAsync`) to `personalMultisig → roomMultisig`, executed via the
  facilitator. `verifyEthDeposit` (`wallet-data.ts`) still checks
  `tx.to === escrow.multisig`; `tx.from` becomes the personal multisig.
- **Payouts** (`escrow.ts` `settle()` → `execTransaction`/`execBatchTransaction`)
  pay back to **personal multisig** addresses, which are spendable — closing
  the loop. No funds ever routed to a raw passkey address.

## 9. Recovery — the accepted model (and the future option)

**v1 (this plan): 1-of-2 drainable.** signers `[passkey, mainMultisig]`,
threshold 1.
- Normal use: passkey signs alone. ✅
- Lost passkey: the main multisig (alone, at threshold 1) calls
  `addPasskeySigner(newKey)` + `removeSigner(oldKey)` — or just sweeps funds to
  a fresh wallet. ✅
- Tradeoff, **accepted**: the main multisig can do that *anytime*, i.e. it can
  rug any personal wallet. That's consistent with it already being the custody
  root.

**Future hardening (NOT v1): rotate-only timelocked module.** To remove the
drain power you'd add a guardian/recovery **module** (new Solidity): normal
threshold stays 1-of-1 (passkey only), and a guardian set can, **after a
timelock and only to rotate the signer**, swap the passkey — never move funds.
- Note: the v4 multisig is a fixed-impl clone, so retrofitting a module = a new
  impl + redeploy → **new wallet address**. Migration path from v1: because v1
  is drainable, the main-multisig + new passkey can simply sweep the v1 wallet
  into the v2 wallet. So shipping v1 first does **not** trap funds.

## 10. Phases / milestones

- **Phase 0 — spike (de-risk).** Derive the counterfactual personal-multisig
  address on passkey connect; prove funding-before-deploy round-trips on Base
  (send dust in, read balance, show it). No facilitator yet. *Proves the receive
  half and surfaces the spend/gas need concretely.*
- **Phase 1 — personal wallet, receive-only.** Identity-vs-custody split; show
  the personal address (QR/copy); hide the raw passkey address everywhere it's a
  fund target (§11 audit). Balance display via existing chain reads.
- **Phase 2 — facilitator + spend.** New `facilitator.ts`: lazy deploy +
  broadcast threshold-met txs on Base, subsidized gas, guardrails (§7). First
  real spend out of a passkey wallet.
- **Phase 3 — room integration.** Buy-in from personal wallet; payouts to
  personal wallets; passkey as room-multisig signer end-to-end.
- **Phase 4 — hardening.** Reimbursement, multi-chain facilitator, per-room
  facilitator option. (Trustless recovery module is a separate, later track.)

## 11. UI audit (Phase 1 must-do)

Grep every site that renders a passkey-derived address and confirm none of them
present it as receivable. Known surfaces to check:
`components/desktop/WalletWindow.tsx`, `components/ui/SlopAddress.tsx`,
JoinCard / `PasskeyChooserModal.tsx`, any "your address" badge, peer/participant
displays driven by `usePeerMesh`. Replace raw-passkey-address receive
affordances with the personal-multisig address; keep the raw id only as a
non-copyable identity token where needed.

## 12. Open decisions

1. **Deployer identity** for the CREATE2 salt — a single fixed slop deployer, or
   the facilitator's own address? (Affects address stability + who can init.)
2. **One global facilitator vs per-room** for v1. (Plan assumes global.)
3. **Reimbursement now or later** — subsidize-only is fine on Base for v1.
4. **Which chain(s)** for v1 — plan assumes **Base only**, expand later.
5. **Salt namespace** — fold the intended signer-set hash into the salt to make
   init front-running impossible, or rely on trusted-relay init only?

## 13. File touch-map (no new contracts)

| Area | Files | Change |
|------|-------|--------|
| Address derivation | `packages/nextjs/utils/multisig.ts`, `utils/passkey.ts` | personal-wallet salt + predicted-address helper |
| Identity/custody split | `hooks/useSession.ts`, `hooks/usePeerMesh.ts` | add `personalWallet` alongside passkey id |
| UI surfaces | `components/desktop/WalletWindow.tsx`, `components/ui/SlopAddress.tsx`, JoinCard, `PasskeyChooserModal.tsx` | show personal addr; hide raw addr as receive target |
| **Facilitator (new)** | `packages/relay/src/facilitator.ts` (+ wire in `index.ts`) | hot-wallet broadcast of threshold-met txs; guardrails |
| Relay sig assembly | port from `WalletWindow.tsx` `sortSignatures`/encode | server-side exec assembly |
| Room/escrow | `packages/relay/src/escrow.ts`, `wallet-data.ts`, `components/desktop/chess/WagerPanel.tsx` | buy-in from personal wallet; payouts to personal wallets |
| Config/secrets | relay env (gitignored) | facilitator hot-wallet key (per chain), **never committed** |
</content>
</invoke>

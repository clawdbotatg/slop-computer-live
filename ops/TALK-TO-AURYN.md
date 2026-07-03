# Things to talk to Auryn about (show: 2026-07-03)

Context for the conversation: we built a **Voting Booth** app into the
slop desktop on his stack — threshold BFV in the browser via the
`fhe-wasm` crate from his weft repo (which vendors gnosisguild/fhe.rs,
the same trbfv the Interfold ciphernodes run). Real DKG, real
client-side ballot encryption, real homomorphic tally, real 3-of-5
reveal ceremony. Plan + honest-framing details: `PLAN-private-voting.md`.

## 1. The bug report (lead with this — it's a good story)

**Browser DKG in fhe.rs is broken on wasm32.** In
`fhe/src/trbfv/shares.rs`, `generate_secret_shares_from_poly` asserts
`self.n < (*min_modulus).try_into().unwrap()` where the target type is
`usize`. On wasm32 usize is 32-bit and every real BFV modulus is
~50-60 bits, so the conversion panics and `dkg_round1` dies with a bare
`RuntimeError: unreachable` in **every browser** — while native 64-bit
builds (and therefore weft's own cargo tests) pass untouched.

- Our one-line fix (compare in u64) is at
  `packages/nextjs/public/fhe-wasm/build.patch`, plus we wired
  `console_error_panic_hook` into the crate's `init()` so future wasm
  panics say what they are.
- Ask: should we PR this to `gnosisguild/fhe.rs` (and the panic hook to
  weft)? Does weft-web's deployed demo hit this too, or does its DKG
  run through the mock engine?

## 2. Questions about doing it "for real" (phase 2)

1. **Hosted committee?** Is there a persistent Sepolia ciphernode
   committee that demos can lean on, or is it strictly
   bring-your-own-ciphernodes (via `interfold nodes`)? The Sepolia core
   contracts we found: Enclave `0x450015E41E1F6b6AfaEbf598E32a8d02a368c0A0`,
   CiphernodeRegistry `0xc8D2880c59D5e807eFFDee3451fb0Aa97f6aefDA`.
2. **Why only Sepolia — why not mainnet??** The docs and deployed core
   contracts are testnet-only. What's actually blocking a mainnet
   launch — ciphernode economics (FOLD staking/bonding not live?),
   audits, threshold-committee security assumptions, gas costs of
   posting ~350 KB ciphertexts on-chain? What's the timeline, and what
   does the mainnet trust model look like (who runs ciphernodes, what's
   slashable)? Follow-up for us specifically: slop computer is
   Base-native (passkey wallets, room multisigs, tips, escrow all on
   Base) — is Base/L2 on the roadmap so voters could be their real
   identities instead of testnet accounts?
3. **Blessed browser path?** Is `@interfold/sdk` (v0.2.3) the intended
   client story for input encryption + E3 lifecycle? It only exposes
   encryption + Greco circuit inputs — nothing exposes threshold
   *decryption* client-side, which is why we reached for weft's crate.
   Is client-side committee decryption something the SDK will ever do,
   or is that strictly ciphernode territory?
3. **CRISP's Noir ballot-validity circuit** — is it reusable standalone?
   Our demo's known gap: a hostile client could encrypt a non-one-hot
   vector and skew the tally. Greco proves "valid BFV encryption" —
   what proves "valid *ballot*"?
4. **Preset guidance:** we ship `SECURE_THRESHOLD_8192` (~354 KB per
   ballot, DKG ~3 s, all fine). For a ~50-voter room poll is that the
   right preset, or is something smaller acceptable for live demos?

## 3. Demo beats to hit on air

- Create a poll live → the "🔑 key ceremony" runs in *the browser*.
- Everyone in the room votes; flip to the **attacker view** panel —
  "this hex gibberish is literally everything our server stores."
- Close → reveal ceremony: homomorphic sum (no decryption), then
  committee members 1/3, 2/3, 3/3 contribute shares, tally animates.
- The kicker line: "individual ballots are ciphertext forever — even
  we can't go back and see who voted for what."
- The ⓘ panel is the honesty checkpoint: committee simulated in one
  browser, tally trusted from the creator, no ballot-validity ZK — and
  CRISP + on-chain E3s are exactly what closes each gap. Perfect
  segue for Auryn to explain the real protocol.

## 4. Stretch idea to float

Committee-of-the-room (v1.5 from the plan): first 5 browsers in the
room each run one DKG party, shares ferried through the relay — "it
takes 3 of the 5 of *you* to reveal this tally." Ask Auryn whether
DKG-over-an-untrusted-relay is sane with fhe.rs's mbfv primitives
as-is, or whether the share-encryption plumbing (ECDH-wrapping each
recipient's share) is where he'd point us.

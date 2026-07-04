# PLAN — Private Voting on slop computer (The Interfold / Enclave)

Context: Auryn Macmillan (Gnosis Guild) is a guest on slop computer
2026-07-03. Goal: a **private voting** demo app on the desktop, built on
the tech stack of [The Interfold](https://theinterfold.com) (the
protocol formerly known as **Enclave** — same team, same repos).

## What the tech is (research summary)

- **The Interfold** coordinates **E3s** (Encrypted Execution
  Environments): parties encrypt inputs under a committee's **threshold
  BFV** public key (FHE via `gnosisguild/fhe.rs`), computation runs
  homomorphically on ciphertexts (proved with RISC Zero zkVM), and a
  **ciphernode committee** threshold-decrypts *only the aggregate
  result*. ZK (Noir) circuits prove input validity.
- **CRISP** ("Coercion-Resistant Impartial Selection Protocol") is
  their canonical **private voting** protocol — reference impl at
  `github.com/theinterfold/interfold/examples/CRISP` (React frontend,
  Rust server, FHE program, contracts). Docs:
  https://docs.theinterfold.com/CRISP/introduction
- **Sepolia** has live core contracts:
  Enclave `0x450015E41E1F6b6AfaEbf598E32a8d02a368c0A0`,
  CiphernodeRegistry `0xc8D2880c59D5e807eFFDee3451fb0Aa97f6aefDA`,
  BondingRegistry `0x1323d235Cd040d64D01d3C2adf084F9A16a675aE`.
- **CLI**: `interfoldup` installer → `interfold` CLI (`interfold init`,
  `interfold program compile`, `pnpm dev:all` spins up local chain +
  ciphernodes + server + frontend). Install script verified clean
  (downloads a release binary from `gnosisguild/interfold`); install
  was left to the human (permission-gated).
- **npm packages** (fresh, v0.2.3, 2026-06-23, Auryn is a maintainer):
  `@interfold/sdk` (type-safe contract client + input encryption; deps
  include Noir/`@aztec/bb.js` + wasm — heavy, needs
  `vite-plugin-wasm`-style bundler care), `@interfold/wasm`,
  `@interfold/react` (hooks), `@interfold/contracts`. Older
  `@enclave-e3/*` equivalents also exist.
- **weft** (`github.com/auryn-macmillan/weft`) — Auryn's federated
  learning demo on the same stack. The gold mine is
  `examples/weft-web/crates/fhe-wasm`: a **wasm-bindgen wrapper of
  fhe.rs trbfv** exposing in-browser **DKG, encryptVector,
  aggregateCiphertexts, partialDecrypt, combineDecryptionShares**
  (~174 KB gzipped, no COOP/COEP headers needed, comlink workers, and a
  clean `CryptoEngine` TS interface with a mock fallback —
  `examples/weft-web/src/lib/crypto/engine.ts`). Its
  `docs/honest-framing.md` is the template for how to disclose what's
  real vs simulated.

**Voting = weft with a simpler payload.** Weft encrypts gradient
vectors and homomorphically sums them; a ballot is just a **one-hot
vector over K options** (no scale factor, no negatives). Sum of
ciphertexts = encrypted tally; threshold-decrypt reveals only totals.
Overflow bound is `voters < t/2 = 65,536` — a non-issue.

## Demo concept — "Voting Booth"

The stream-able one-liner: **the slop computer server collects every
ballot but cannot read a single one.** Ballots are encrypted in each
voter's browser under a threshold key; it takes a quorum of committee
members to decrypt, and the only thing that ever gets decrypted is the
final tally.

UX beats (steal weft-web's devices):
1. Create poll (question + options) → key ceremony runs → "🔑 committee
   key published".
2. Everyone in the room votes — big chunky ballot window.
3. **Attacker panel**: live ticker of what the relay/server actually
   stores — ciphertext gibberish, per ballot.
4. Close poll → homomorphic tally (ciphertext + ciphertext = tally
   ciphertext, still unreadable).
5. **Reveal ceremony**: committee members each contribute a decryption
   share (progress: 2/3…), then the tally animates out. Individual
   ballots remain undecryptable forever.

## Phase 1 (buildable in a day) — real crypto, in-room committee

Real threshold BFV end to end (same fhe.rs as production), no chain, no
RISC Zero.

- **Committee v1**: 5 web workers in the poll creator's browser,
  threshold 3 — exactly weft-web's model, zero distributed-DKG
  plumbing. Ship this first.
- **Committee v1.5 (the better story, do if time allows)**: committee =
  the **room** — first 5 distinct browsers each run one ciphernode
  worker; DKG messages ferried through the relay. "It takes 3 of the 5
  of *you* to reveal the tally — and nobody, including the server, can
  reveal an individual ballot." Caveat: DKG secret shares transit the
  relay in v1.5 → either disclose it, or wrap shares per-recipient with
  WebCrypto ECDH (stretch).
- **Relay is untrusted-by-design**: it stores/broadcasts opaque base64
  ciphertexts and enforces one-ballot-per-identity. BFV ciphertexts at
  the 8192 preset are a few hundred KB each — cap ballots per poll
  (say 64) so relay RAM stays trivial.

### Build checklist (slop repo)

1. **Icon first** (house rule): `yarn icon:add voting "A chunky retro
   ballot box icon with an encrypted envelope sliding into the slot,
   padlock badge."`
2. **WASM module**: vendor weft's `crates/fhe-wasm` (or its built
   `packages/fhe-wasm/pkg`) as a new `packages/fhe-wasm`; build with
   `wasm-pack build --release --target web`. LGPL-3.0-only — keep it a
   distinct dynamically-imported package, don't inline the source into
   our MIT code. Alternative: `@interfold/sdk` for encryption, but the
   threshold partial-decrypt/DKG in the browser is what weft's crate
   uniquely gives us. Load in a Web Worker via comlink (BFV ops are
   hundreds of ms).
3. **Relay** `packages/relay/src/voting.ts`, modeled on `todos.ts`
   (JSON snapshot per room + fanout): poll `{id, question, options[],
   status: keygen|open|closed|revealed, committeePubKey, ballots:
   {voterKey → ctB64}, shares, tally}`. WS handlers in `index.ts`
   switch: `vote_create`, `vote_dkg_msg` (opaque ferry), `vote_pubkey`,
   `vote_cast`, `vote_close`, `vote_share`, broadcast `vote_state`.
   One ballot per passkey-wallet address / anonId (same identity fields
   todos already records). Extend the `kind` union + `DEFAULT_APPS`
   (`index.ts:~1045/~1079`) with `kind: "voting"`.
4. **Mesh client**: `votingState` + senders in
   `packages/nextjs/hooks/usePeerMesh.ts` (mirror the todo section) +
   `PeerMeshState` type.
5. **UI**: `packages/nextjs/components/desktop/VotingWindow.tsx`; wire
   `case "voting"` in `activateApp` (`Desktop.tsx:~2590`, falls through
   to `focusApp`) + a `<SharedAppWindow id="voting">` in the render
   block (`Desktop.tsx:~3873`).
6. **Honest-framing blurb** in the window (an "ⓘ how private is
   this?" flip side), modeled on weft-web `docs/honest-framing.md`:
   real = BFV threshold encryption/decryption, client-side encryption,
   server can't read ballots; simulated = no on-chain E3, no RISC Zero
   proof of correct tally, no Noir ballot-validity proof (a hostile
   client could encrypt a non-one-hot vector — CRISP fixes this with ZK;
   we disclose it), committee is in-room browsers, not staked
   ciphernodes.
7. Deploy with `./ops/deploy.sh` (WASM is client-side; relay cost is
   just blob storage, fine on the 7.6 GB box).

## Phase 2 (with Auryn, on/after the show) — the real protocol

- Fork weft's `FLAggregator.sol` into a `VoteAggregator` IE3Program (or
  start from CRISP's contracts) and deploy to **Sepolia** against the
  live Enclave/CiphernodeRegistry contracts above.
- `interfold init` a project; run local ciphernodes via the CLI (or use
  whatever hosted testnet committee exists — ask Auryn: **is there a
  persistent Sepolia ciphernode committee demos can lean on?**).
- Relay becomes the coordinator (weft `coordinator/src/round.ts` is the
  crib sheet: `request()` → `activate()` → collect `publishInput`s →
  await `PlaintextOutputPublished` → decode).
- Slop wallets are Base-only; Sepolia txs go through a relay hot key
  (testnet, no real funds). Ballot-validity Noir proof via
  `@interfold/sdk` if CRISP's circuits drop in cleanly.

## Answered on the show (2026-07-03 — transcript in room auryn-macmillan)

- **Mainnet: "in a couple of weeks."** Interfold mainnet launch is
  imminent; Sepolia is the only network today. The PollAnchor track
  stays useful as the bridge.
- **There IS a live testnet committee**: "point it at the testnet…
  you're actually getting other people's nodes to run the DKG
  process." Phase 2 does NOT require running our own ciphernodes.
- **Committee filtering (pick-your-own trusted nodes): not yet**, but
  actively on their roadmap (trusted-subset, jurisdictional
  distribution, proof-of-personhood filters).
- **Room-as-committee (v1.5): Auryn endorses it as a demo** — "I like
  this idea of having the room be the committee… doesn't quite work
  with the economic model, but fun as a demonstration."
- **weft uses unreleased Interfold features** (evaluation keys for
  deeper multiplicative depth — incoming). Voting only needs additive
  ops, so this doesn't block us.
- **Auryn's build TLDR for a real voting app**: (1) input-validation
  logic — who can vote + client-side proof the ciphertext is
  well-formed; (2) the core FHE program; (3) the app↔Interfold glue
  (publish inputs, consume output).
- **The fhe.rs wasm32 DKG bug is already fixed on upstream main** (the
  panicking assert became a proper error). The show co-host agent filed
  **issue #1 on auryn-macmillan/weft** live on air documenting it (plus
  a second silent-truncation spot). So: **re-vendor fhe.rs instead of
  carrying build.patch**; no upstream PR needed.
- Their Aragon integration lives at **dao.theinterfold.com** (test
  deployment) — the reference production integration.
- Austin's stated ambition: **BuidlGuidl members running ciphernodes;
  buy + stake FOLD.**

## Phase-2 recon (2026-07-03, from the interfold repo + template)

**CRISP circuits — reusable, question closed.** Beyond Greco
("valid BFV encryption"), CRISP has a real ballot-validity circuit
(`examples/CRISP/circuits/bin/crisp/src/main.nr` +
`check_coefficient_values_with_balance` in lib/utils.nr): binary
coefficients, per-option decode, one-hot enforced at 2 options; for
3+ options set `balance = 1` and "vote splitting ≤ balance" degenerates
to one-hot. `num_options` is a runtime public input (≤ 10) — a K≤8
ballot needs **no circuit change**. It also proves ECDSA sig →
address + Poseidon-Merkle census membership (eligibility!). On-chain:
`CRISPProgram.publishInput` verifies the recursive fold proof via a
generated Noir `HonkVerifier`; final tally verified by RISC Zero
Groth16. Client side: 5 proofs via noir_js + bb.js UltraHonk, 2^21 SRS
(heavy — proving time undocumented).

**SDK decryption — confirmed ciphernode-only.** `@interfold/sdk`
exposes keygen/encrypt/encryption-proofs; threshold decryption lives
in the ciphernode crates. (Validates the weft-crate choice for the
phase-1 in-browser demo.)

**Live Sepolia deployment** (from `deployed_contracts.json` in the
repo): Interfold proxy `0x64Cd2d88537A18D8E599d786447F9a07Dd9C7f26`,
CiphernodeRegistry `0xDDd7e1eA2AD8195217D9B25B13fac667b6Fc4dD9`,
CRISPProgram `0x6DB95806c2292F9d164608C266BE69E694eAE05C`,
HonkVerifier `0x4838c1dbb33E1B0818d61f510048B5958A48f66d`,
Faucet `0x94FCD9b624baAf023c7F48C5E7200eAd85dc87Df`.
**E3 fees are paid in mock USDC** (faucet dispenses it; `interfold
faucet` CLI); FOLD is only for ciphernode bonding. `sdk.requestE3()`
targets the live testnet committee per
`docs/pages/tutorials/deploy-to-testnet.mdx`.

**Template scaffold** (`interfold init` → slop-voting-e3, in session
scratchpad): the default FHE program is already a ciphertext summer
(= a tally); `MyProgram.sol` is a generic IE3Program with a LazyIMT
input tree and a marked slot for validation logic; local dev stack =
anvil + 5 ciphernodes + express server + `@interfold/sdk`, no RISC
Zero needed in dev mode. Gotcha hit: template ships a stale Cargo.lock
vs the fhe.rs git dep — run `cargo update` before `interfold compile`.

## Phase-2 milestone: full local E3 round PASSING (2026-07-03)

`slop-voting-e3` (interfold-init template, in session scratchpad —
promote to a real repo next): `pnpm test:integration` green end to
end — E3 requested + fee paid → ciphernode sortition → **real
distributed DKG across 5 local ciphernodes over libp2p** → committee
key on-chain → two inputs encrypted client-side + publishInput →
input-deadline wait → FHE program sums ciphertexts → ciphernodes
verify decryption-share ZK proofs → threshold decrypt →
`PlaintextOutputPublished`, decoded 1 + 2 = 3.

Fixes needed to get there (candidates to upstream to
gnosisguild/interfold):
1. Template ships a stale `Cargo.lock` vs its pinned interfold rev —
   `interfold compile` dies on `--locked`. Fix: fresh lock +
   `cargo update`, then pin `alloy-sol-type-parser` back to 1.5.4
   (1.6.0 pulls winnow 1.x which breaks the locked alloy-dyn-abi).
2. Deadline race: the server publishes ciphertext output on a
   wall-clock timer while the contract enforces the *chain* input
   deadline → `InputDeadlineNotReached` revert with no retry kills the
   round. Fixed with retry-on-that-error in `handleWebhookRequest`
   (server/index.ts) — the same guard our production coordinator needs.
3. Local gotcha (ours): this machine's shell exports `PORT=8787`
   (clawd-harness), which the template server honors — set `PORT=8080`
   or the program-runner callback misses it.

## Phase 3: SEPOLIA MODE LIVE IN PROD (2026-07-03 late night)

Deployed (`f874b3c`). `VOTING_E3_CHAIN=sepolia` +
`VOTING_E3_WINDOW_SECS=300` set in prod `packages/relay/.env`; relay
restarted. **Every poll created in any slop room now runs as a real
Interfold E3** — the relay coordinator (`vote-e3.ts`) requests the E3,
the public Sepolia committee does DKG, browsers encrypt one-hot ballots
(512 preset), the facilitator publishes them on-chain (voters pay no
gas), the relay homomorphically sums in-process, and the committee
threshold-decrypts. UI: `VotingE3Panel.tsx` shows the full protocol
timeline (progress bar, stage stepper, committee addrs, per-tx
Etherscan links, live log). Legacy non-onchain polls purged on load
(the old auryn-macmillan poll is gone). Prod facilitator is the funded
`0xBa16…0FF0`. Wasm compat proven by E3 #27 ([1,1,2] from the public
committee); full UI round proven by E3 #28 headless.

Still dev-mode / to harden: compute proof is stubbed (digits of pi +
MockRISC0Verifier we deployed) → real RISC Zero via Boundless; no ZK
ballot-validity proof → CRISP's Noir circuit (reusable, balance=1);
testnet only until Interfold mainnet (~weeks). Mainnet PollAnchor
(notarize results on L1) still one funding step away (~0.02 ETH to the
facilitator).

## Phase-2 milestone 2: full E3 round on SEPOLIA against the live
## public committee — PASSING (2026-07-03 night)

E3 #26 on Sepolia: requested on the live Interfold
(0x64Cd2d88537A18D8E599d786447F9a07Dd9C7f26), fee paid in faucet mock
USDC, a **public 3-node ciphernode committee ran sortition +
distributed DKG** (~90s, 9,243-byte BFV key via the CommitteePublished
event), two client-encrypted numbers published on-chain to our
MyProgram (**0x095C187a5bAC36e1857ad2e3c1F5414c3C738511** — registered
permissionlessly), local server computed the homomorphic sum, and the
**public committee threshold-decrypted the aggregate: 1 + 2 = 3**.
~7 min/round. Facilitator (0xBa16…0FF0) funded with 1 Sepolia ETH by
Austin; used ~0.02 across 5 requests + deploys.

Hard-won operational facts (all encoded in the private-voting repo):
- `registerE3Program` on the live Interfold is **permissionless**.
- The committee key is NOT on-chain (only a 32-byte commitment via
  getE3PublicKey) — decode the registry's `CommitteePublished` log:
  `(address[] nodes, bytes publicKey, bytes32 hash, bytes extra)`,
  topic0 `0xbf0636a3…e67f`.
- `E3Requested` e3Id is in DATA word 0 (topics[1] is the program).
- Input window must be computed fresh at request time with ~120s lead
  (`InvalidInputDeadlineStart` otherwise).
- Retry `publishCiphertextOutput` on `InputDeadlineNotReached` AND its
  raw selector `0xbf1af280` (library-declared errors don't decode
  through the SDK ABI).
- RPC minefield: publicnode silently filters `eth_getLogs` (use
  **drpc.org** for event watching); 1rpc rate-limits
  `sendRawTransaction`; template's `publishInput` passes a bare
  address → viem falls back to `eth_sendTransaction` (dies on public
  RPCs — sign locally).
- SDK crypto (`encryptNumber`) fails under plain tsx
  (`initializeWasm is not a function`) — run under vitest.

Remaining to productize: push the repo (clawdbotatg/private-voting —
pending `gh repo create` by Austin), port the round driver into the
slop relay as a "Sepolia mode" coordinator, add K-option one-hot
ballots (encryptVector) + CRISP validity circuit, VotingWindow UI mode.

## Still open

1. Will `@interfold/sdk` ever expose client-side threshold decryption?
2. BFV preset guidance for room-scale polls.
3. Client-side proving time for CRISP's 5-proof chain on normal
   hardware (2^21 SRS) — measure before promising it in a live demo.

## Ballot-validity ZK: gate PASSED (2026-07-04)

The [500,0] hole (a client encrypting a non-one-hot ballot to inflate the
tally) needs a ZK proof that the ciphertext encrypts a valid one-hot
vote. Feasibility GATE now passes off-chain:

- **Preset matches exactly.** Interfold's Noir circuits' `default` config
  is auto-generated for `insecure-512` = OUR exact BFV params (N=512,
  t=100, moduli 0xffffee001/0xffffc4001). No crypto adaptation.
- **Witness maps directly.** `@interfold/wasm bfv_verifiable_encrypt_vector`
  on a real one-hot slop ballot produces the full Greco witness
  (ct0is, pk0is, u, e0, e0is, e0_quotients, k1, r1is, r2is) — the exact
  inputs interfold's `user_data_encryption_ct0` circuit takes. k1 is
  confirmed one-hot (1 nonzero coeff = field(-7)).
- **Proves + verifies, FAST.** nargo 1.0.0-beta.16 + bb 3.0.0-nightly.20260102:
  witness 0.2s, SRS(2^21) 2.4s, UltraHonk proof 1.5s (16 KB, 4 public
  inputs), VERIFIED. The feared "minutes of browser proving" is ~2s —
  browser-side is viable. Gate script: private-voting
  deploy/ballot-validity-gate.mjs.

Remaining to ship (all de-risked engineering, no unknowns):
1. Circuit for the FULL predicate: Greco (ct encrypts k1) + one-hot check
   on k1. Either reuse CRISP's crisp+fold recursive tree (5 proofs) or a
   minimal single circuit combining user_data_encryption_ct0/ct1 logic +
   the trivial one-hot assert. Minimal-single is less browser cost.
2. Browser: run the proving in the voting worker (bb.js UltraHonk + 2^21
   SRS download), attach the proof to vote_cast.
3. On-chain: codegen a HonkVerifier (bb write_vk + solidity codegen),
   deploy it, redeploy our program so publishInput verifies the proof
   (mirror CRISPProgram.sol) → rejects any non-one-hot ballot before it
   enters the tally.

## Ballot-validity ZK: circuit + ON-CHAIN VERIFIER working (2026-07-04)

Beyond the gate, the full ZK path is now built and proven on-chain:
- **Circuit** (private-voting `ballot-validity-circuit/`): single Noir
  circuit = in-circuit Greco (ct0+ct1) + one-hot assert on k1. Good
  one-hot ballot → 16 KB UltraHonk proof VERIFIED; bad [2,0]/[500,0] →
  REJECTED at witness gen. ~2s proving (nargo 1.0.0-beta.16, bb
  3.0.0-nightly). Toolchain: ~/.nargo/bin, ~/.bb.
- **On-chain verifier**: `bb write_solidity_verifier` → HonkVerifier
  (23,721 bytes at optimizer_runs=1, fits EIP-170). **Deployed Sepolia
  `0xEcc4D77e1761C6828FD4E65D0fe7f0b31FCE9336`.** Real EVM proof
  (verifierTarget:'evm', 9408 bytes, 2 public inputs) → verify() = true;
  tampered → reverts.

Remaining integration (de-risked, but real — the last mile):
1. **Browser proving** (task 20): bundle noir_js + bb.js into the voting
   worker, ship the compiled circuit (840 KB) + a one-time 2^21 SRS
   download, generate the proof at ballot time (~2s), attach to
   vote_cast. UX: SRS download + proving spinner in the E3 panel.
2. **On-chain publishInput binding** (task 21, the tricky one): redeploy
   our E3 program with the HonkVerifier; publishInput must (a) verify the
   proof AND (b) bind its 2 public-input commitments to the submitted
   ciphertext (recompute compute_ciphertext_commitment in Solidity, or
   restructure). Getting (b) subtly wrong breaks the guarantee — deserves
   careful, non-rushed work. Mirror CRISPProgram.sol's honkVerifier.verify.

## Ballot-validity: ALL crypto unknowns retired (2026-07-04)

Beyond circuit + on-chain verifier, two more gates passed:
- **Verifiable-encrypt is committee-compatible.** A Sepolia round using
  @interfold/wasm bfv_verifiable_encrypt_vector ballots (which yield the
  Greco witness), summed with weft homomorphic_add, decrypted by the live
  committee to [1,1,2]. So the browser can switch weft encrypt_vector ->
  verifiable_encrypt as a DROP-IN (committee decrypts identically, relay
  tally-decode unchanged). private-voting deploy/sepolia-verifiable-round.mjs.
- **Browser proving needs no COOP/COEP.** bb.js proves single-threaded
  (BackendType.Wasm, crossOriginIsolated=false) in a headless browser:
  SRS init 11s (one-time), prove 5s, verifies. No cross-origin isolation
  headers -> slop's desktop (cross-origin avatars/iframes) unaffected.
  private-voting ballot-validity-circuit/browser-prove-poc/.

Everything is de-risked. Remaining = productionization only:
- Bundle bb.js + noir_js + @interfold/wasm + circuit (840 KB) into the
  nextjs voting worker; switch Sepolia ballots to verifiable-encrypt;
  generate the proof at vote time (spinner: ~11s first SRS + 5s prove);
  attach proof to vote_cast; coordinator forwards to publishInput.
- On-chain binding (the delicate one): redeploy the E3 program with the
  HonkVerifier (0xEcc4D77e...9336); publishInput verifies the proof AND
  binds its 2 commitment public-inputs to the submitted ciphertext.

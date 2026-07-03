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

## Still open

1. Is `@interfold/sdk` the blessed browser path for input encryption +
   E3 lifecycle, or will client-side threshold decryption ever be
   exposed there?
2. CRISP's Noir ballot-validity circuit — reusable standalone?
3. BFV preset guidance for room-scale polls.

# The Cypherpunk Fork — minimal private circles (working title: "circle")

> Status: **plan only** (2026-07-01). Nothing extracted yet. This doc is the
> blueprint for a minimal fork of slop-computer-live: E2E-encrypted video
> calls circled around a multisig, forkable and runnable by anyone, anywhere.

## TLDR

A tiny, open-source, self-hostable app: **spin up a box, share a link and a
password, and your group gets un-snoopable video calls gathered around a
shared multisig wallet on Ethereum mainnet.** No accounts, no third parties,
no wallet software required — a passkey is enough to join, see friends, and
co-sign from the treasury. The server is deliberately worthless: it forwards
ciphertext and can be replaced mid-meeting. The frontend is a static bundle
pinned to IPFS behind an ENS name, so the client can't be taken down and the
servers don't matter. Every layer offers the same ladder — **good UX by
default, trust-a-friend in the middle, fully sovereign at the top** — and all
rungs coexist in one room: grandma joins with Face ID on a public RPC while
the group's sysadmin verifies everything against their own Ethereum node,
and the sysadmin's presence protects grandma. Most of the hard parts already
exist in slop-computer-live (P2P mesh video, passkey-native multisig, room
password gates); the work is extraction, three specific E2EE gaps, and the
trust-ladder plumbing.

**One sentence:** the call is the security layer — a civil society circled
up face to face around its own money, on infrastructure it owns.

---

## 1. Why

Groups that want to organize privately — a mutual-aid society, a dissident
book club, a DAO that doesn't want to be a spectacle — currently choose
between surveilled convenience (Zoom + a bank) and a pile of disconnected
tools (self-hosted Jitsi + a Safe + a group chat), none of which know about
each other. The combo also has real holes: Jitsi routes media through a
server and its E2EE is off by default; the Safe UI leans on Safe's hosted
transaction service — a centralized, censorable chokepoint; and nothing
connects "who's in the meeting" to "who controls the money."

Here the multisig **is** the room. Being a signer can be the door key. A
transaction proposed on a call pulls every screen to the same signing UI
while the proposer explains it face to face. And when a member's node
disagrees about the state of the chain, the room sees it together — a
lying-RPC attack that's silent in MetaMask becomes a conversation between
people looking at each other.

Cypherpunk rules of engagement:

- **The server knows nothing.** It forwards ciphertext between peers. Keys
  never touch it. Seizing the box yields connection metadata, not content.
- **The client is unstoppable.** Static build, pinned to IPFS, named by ENS.
  Fork it, pin it yourself, verify the CID.
- **Every trust is named and optional.** Nothing external is load-bearing:
  not our servers (there are none), not Alchemy, not Apple, not Waku, not
  even the group's own relay. Each is a rung you can climb off.
- **No cloud AI. No telemetry. No analytics.** v1 ships with zero AI; local
  (whisper.cpp-style) transcription can come later, opt-in, on-device.

## 2. The trust ladder (the product's identity)

Every layer offers the same three rungs, interoperable in one room, with a
visible badge showing which rung you (and each fact on screen) stand on:

| Layer | Good UX (default) | Trust a friend | Hardcore |
|---|---|---|---|
| Identity | passkey (Face ID, no wallet) | — | own wallet / hardware key |
| Gas | facilitator pays | a member broadcasts for you | own EOA, own ETH |
| RPC | public endpoint | a friend's node over the mesh | own node → quorum → +Helios |
| Transport | the group's disposable relay | a member's Waku node | copy-paste SDP |
| Frontend | any pinned gateway copy | a member's IPFS node | build + pin it yourself |

The key property: **sovereign members protect convenient ones.** Quorum
checks, honest tx broadcasts, and censorship resistance each need only *one*
member on the top rung. The least careful member is not the hole.

## 3. What we already have (inventory from the 2026-07-01 survey)

Carried over from slop-computer-live, mostly as-is:

- **P2P mesh video.** Full-mesh WebRTC, DTLS-SRTP, media never touches the
  server even today. `usePeerMesh.ts` (media parts), `useLocalMedia.ts`,
  `useMediaDevices.ts`, camera/screen/audio share dialogs, RNNoise denoise.
  Mesh tops out ~6–10 people — exactly circle-sized, and the reason we need
  no SFU (an SFU is a snooping point we simply don't build).
- **Room gates.** `room-auth.ts`: claim a slug, scrypt-hashed password,
  invite links — and a `wallet-signers` mode where **being a signer on the
  multisig is the door key**. That's the "circle up around a wallet"
  primitive, already written.
- **The multisig.** slop Multisig v4 — passkey (P-256/WebAuthn) signers
  native on-chain, EOA/ERC-1271/nested-multisig signers, M-of-N, CREATE2
  same-address on 6 chains, deployed and immutable. ABIs in
  `packages/nextjs/contracts/multisig.ts`; source in the separate
  slop-computer-contracts (Foundry) repo — **vendor it into the fork.**
- **Signing UX.** `WalletWindow` propose/sign/execute flow, client-side key
  material always (passkeys in the authenticator, EOAs in the user's
  wallet), exec-hash computed client-side, room-wide attention pull when a
  tx lands.
- **TURN.** coturn config with HMAC ephemeral creds (`deploy/turnserver.conf`).

**Decision: keep our multisig, not Safe contracts.** Ours is passkey-native
on-chain; Safe's passkey path is bolt-on and its practical UI depends on
hosted infrastructure. This is a prototype — the contract gets a real audit
before serious funds. (The audit should hit the P-256 verification and
nested-1271 paths hardest; they're the novel surface.)

## 4. What we cut

Everything below is out — not stubbed, **absent from the repo**:

- `packages/browser-host` (Puppeteer shared browser), broadcast/god-mode
  streaming, MediaMTX/RTMP/HLS, recordings.
- All games (poker, chess, worm, putt, pong), news/ticker/headlines, music,
  research, glossary, notes, todos, chyron, episode machinery.
- **Every cloud API**: OpenAI, Anthropic, Bankr LLM, Zerion, LI.FI,
  Coinbase onramp, Twitter, Jamendo, Polymarket, CoinGecko. Zero external
  calls at runtime except the RPC the user configures.
- Next.js server rendering — replaced by a static Vite build so the client
  can be pinned to IPFS.
- The god-mode/spectator role. In slop it's a feature (broadcast capture);
  here it is *precisely the attack we defend against*. It must not exist in
  the code, so it can't be quietly re-enabled.

## 5. Architecture

```
   ENS name ──► IPFS-pinned static client (Vite bundle, auditable CID)
                      │  user pastes/receives:  https://<server>/#<room-secret>
                      │  (fragment never leaves the browser)
                      ▼
   ┌────────────────────────────────────────────────────────────┐
   │ browser peers — full-mesh WebRTC                           │
   │  • media: DTLS-SRTP + insertable-streams frame encryption  │
   │    keyed from the #fragment secret (server-proof E2EE)     │
   │  • data channels: chat, tx propose/sign, RPC-over-mesh     │
   └───────────────┬────────────────────────────────────────────┘
                   │ signaling only (opaque encrypted envelopes)
                   ▼
        SignalTransport interface
        ├─ tier 1: the disposable relay (~1.5–2k LOC, stateless-ish,
        │          knows: who's connected, when. holds: nothing)
        ├─ tier 2: Waku (logos-delivery-js) on a multisig-derived topic
        └─ tier 3: copy-paste SDP (2-person emergency floor)

        optional: coturn (blind byte relay, any member runs it)
        optional: member Ethereum node(s)  ◄── quorum RPC over data channels
        anchor:   the multisig on Ethereum mainnet (identity + treasury +
                  rendezvous namespace — never a message transport)
```

### 5.1 The E2EE gaps to close (the real security work)

Slop's mesh is already peer-to-peer, but "encrypted in transit" is not
"can't be snooped." Three gaps, in priority order:

1. **Frame encryption keyed from a URL-fragment secret.** The signaling
   server relays SDP, so a malicious server can MITM DTLS by substituting
   key fingerprints. Fix: WebRTC insertable streams encrypting every
   media frame with a key derived from `#<room-secret>` — fragments never
   reach any server. The server proves you know the secret via a derived
   verifier but never sees key material. Even a fully hostile relay gets
   ciphertext. (Same technique as Jitsi's E2EE layer, but **on by
   construction, not opt-in.**)
2. **Room secret stays client-side.** Today the room password travels to
   the relay for scrypt verification. Here the secret is E2EE key material:
   send only a derived verifier (or a simple PAKE). The server can gate
   without ever holding what it gates.
3. **No spectator code path.** See §4. Additionally: the peer list must be
   authenticated by the E2EE layer (peers prove knowledge of the room
   secret to *each other*, not just to the server), so the server cannot
   inject a silent participant.

Accepted residual metadata: the relay sees IPs and timing; TURN sees IPs;
mesh peers see each other's IPs (offer relay-only mode; document onion
hosting for the paranoid tier). Say all of this plainly in the README.

### 5.2 Chain layer

- **Ethereum mainnet.** The sovereign default is members with real wallets,
  their own gas, and their own node — the instance takes any RPC URL,
  `http://localhost:8545` first-class. **No hard Alchemy dependency**
  (slop's relay currently refuses to boot without one; the fork must not).
- **Passkeys are the convenience rung, not the architecture.** For members
  without wallets: Face ID in, personal signer derived, done. EIP-7951
  (P256VERIFY precompile, 6,900 gas) shipped in Fusaka on mainnet
  2025-12-03, so passkey verification is now cheap on L1 — and **the
  deployed v4 already calls the precompile at `0x100`** (confirmed by
  bytecode analysis 2026-07-02; no Solidity fallback, so passkeys need a
  precompile-equipped chain — all 6 deployed chains qualify).
- **Facilitator = accepted fallback.** Passkey-only members can't broadcast
  or pay gas; the group's server can run a facilitator hot wallet (custody-
  safe: the contract rejects anything without valid signatures — it's a
  liveness dependency only). Documented fallback: any member with an EOA
  broadcasts for the group. Assume ≥1 such member.
- **The multisig is the rendezvous identity.** Room id, key namespace, and
  the Waku content topic all derive from the multisig address. The chain
  names the meeting place; it never carries the meeting. (On-chain
  signaling was considered and rejected: slow, expensive, and — fatally —
  a permanent public record of the group's meeting metadata.)

### 5.3 RPC ladder & quorum

- Rung 1: any public RPC URL (bootstrap convenience).
- Rung 2: **share your node into the room** — JSON-RPC over the already-
  E2EE data channel to a member-peer, who forwards to `localhost:8545`.
  No ports exposed, no server config; offered live, like sharing a camera.
- Rung 3: **quorum** — reads fan out to all shared nodes; accept on K
  matching answers. **Block-pinned comparison** (agree on a recent common
  block first, then query at that block) or chain-tip drift produces false
  alarms — this is the difference between a quorum that works and one
  that's abandoned in a week. Broadcasts go to *all* nodes: censorship
  requires every node-runner to collude; one honest node suffices.
  **Disagreement is a room event, not a silent failure** — banner to
  everyone: "Alice's node disagrees about the treasury balance." You are
  in a video call with Alice; sort it out face to face.
- Rung 4 (later): Helios in-browser light client verifying whichever node
  you use — upgrades "trust your friend" to "verify your friend."

The elegance: the RPC trust set = the signer set. The wallet already
assumes K-of-N honest members; quorum RPC extends that same assumption
from moving funds to knowing facts. No new trusted parties, ever.

### 5.4 Transport ladder & the async layer

- `SignalTransport` interface from day one: `send(envelope)`,
  `onMessage(cb)`, envelopes opaque and encrypted. Relay is impl #1.
- **Tier 1 — the disposable relay.** Small (~1.5–2k LOC target), blind,
  stateless-ish, run by any member, passed to the client as a URL param,
  swappable mid-meeting. The goal was never serverless; it's
  **server-doesn't-matter**.
- **Tier 2 — Waku.** Encrypted SDP on a multisig-derived content topic via
  `logos-messaging/logos-delivery-js` (the renamed js-waku — active,
  mid-rebrand into the Logos stack; treat as plug-in, not foundation).
  Bonus, and maybe the bigger prize: **Waku Store is the async layer** —
  meeting scheduling and multisig signature collection *between* calls,
  serverless (store retention ~weeks, best-effort: a queue, not an
  archive). Browser light clients lean on bootstrap fleets → removable by
  a member running nwaku (same pattern as everything else).
- **Tier 3 — copy-paste SDP.** Works for two people. The floor that makes
  "they took everything down" still not a total outage.
- **TURN is irreducible but optional and blind.** ~85–90% of pairs connect
  without it; a member runs coturn for the rest; it only ever relays
  ciphertext.

### 5.5 Frontend

Static Vite bundle (no server rendering, no Next.js), pinned to IPFS,
ENS contenthash pointing at it (the slop.computer front-end repo already
proves this pattern). The client takes the server URL + room secret from
the link. Reproducible builds so anyone can verify the CID matches the
source. HTTPS is mandatory for `getUserMedia` — Caddy auto-TLS on a domain,
or documented self-signed / onion rituals for the hardcore tier.

## 6. Threat model — honest edition (goes in the README)

What this protects, and from whom:

- **Server operator / server seizure:** sees ciphertext envelopes, IPs,
  timing. No content, no keys, no media — by construction (§5.1).
- **Network observer:** WebRTC traffic between members' IPs; TLS to the
  relay. Content protected; the *fact of a call* is not (onion tier helps).
- **Platform (Apple/Google):** passkey signing is local; sync is E2EE.
  They can't forge or observe signatures. Losing the platform account =
  losing that signer → thresholds must let remaining members rotate a lost
  key. Social recovery is a first-class flow, not an emergency procedure.
- **A lying RPC:** can deceive (balances, simulations, confirmations) and
  censor, but **cannot steal** — signatures are client-side over exec
  hashes computed client-side from calldata that arrives peer-to-peer.
  Quorum + room-visible disagreement bound the deception (§5.3).
- **What nothing here protects: the chain is public.** The signer graph,
  treasury balance, and every transaction are visible forever. Passkey-
  derived addresses are naturally pseudonymous — a real mitigation — but
  "private society" means private *communications*, not private
  *membership*, unless members keep those addresses unlinked from their
  identities. Loudest line in the README.

## 7. Phases

- **Phase 0 — extraction.** Fresh repo (extract, don't subtract). Carve the
  media-only mesh out of `usePeerMesh.ts` (~700 of 4,692 lines) + minimal
  relay (signal forward, room gate, TURN creds) + static Vite client.
  Milestone: two browsers, one password link, video call through a relay
  that never sees plaintext SDP contents beyond routing.
- **Phase 1 — E2EE hardening.** Fragment-derived keys, insertable-streams
  frame encryption, client-side room secret (verifier/PAKE), authenticated
  peer list, `SignalTransport` interface, trust badges in the UI.
  Milestone: a deliberately malicious relay demonstrably gets nothing.
- **Phase 2 — the circle.** Vendor the multisig contracts + signing UI.
  Passkey join, wallet-signers room gate, propose/sign/execute over data
  channels, facilitator (optional module), configurable RPC URL.
  Milestone: a passkey-only member receives, co-signs, and spends.
- **Phase 3 — the ladder.** Share-your-node RPC over data channels, quorum
  with block pinning + room-visible disagreement, IPFS/ENS deployment of
  the client, one-command server (docker compose: relay + coturn).
  Milestone: a circle runs with zero third-party dependencies.
- **Phase 4 — resilience & polish.** Waku tier (signaling + async store),
  Helios, onion documentation, contract audit + v5 (P256VERIFY), local
  opt-in transcription if wanted. Milestone: takedown drill — kill the
  server mid-call, group re-circles without us.

## 8. Open questions

1. Name. ("circle" is the working title — the verb is the product.)
2. Passkey personal wallets on mainnet: keep the 1-of-2 recovery model
   (main multisig as drainable co-signer) or simplify to signer-only
   passkeys for v1?
3. Quorum K policy: majority-of-responding with a floor of 2, or per-room
   configurable?
4. Relay license/packaging: single static binary (bun compile?) vs
   docker compose — what's the lowest-friction "anyone can run it"?
5. How much of the Mac OS 9 desktop aesthetic survives? (The soul of slop
   vs. the smallness of the fork.)
6. Audit scope/funding for contract v5, and whether v5 waits for real
   usage evidence.

## 9. Check-items (verify before building on them)

- [x] **RESOLVED 2026-07-02: v4 uses the precompile.** Bytecode analysis of
      the deployed impl (`0x5Be7…CE3A`, Base) shows two
      `PUSH2 0x0100 · GAS · STATICCALL` sequences and **no** P-256
      field-prime constants and **no** fallback verifier — it calls
      EIP-7951/RIP-7212 P256VERIFY at `0x100` exclusively. Mainnet passkey
      sigs cost ~6,900 gas post-Fusaka; **no v5 needed for gas.** Caveat:
      no fallback ⇒ passkeys only work on precompile-equipped chains
      (all 6 deployed chains qualify as of 2026); document it.
- [ ] Insertable streams / `RTCRtpScriptTransform` support matrix in 2026
      browsers (Safari story matters for passkey-first users). Expected
      all-green (Safari 15.4+, Firefox 117+, Chromium legacy+modern APIs);
      verify hands-on at Phase 1 start.
- [ ] Waku store retention/limits on the current network; nwaku
      self-host footprint.
- [ ] Helios browser (WASM) maturity + sync UX (weak-subjectivity
      checkpoint handling).
- [ ] Mainnet gas reality for M-of-N passkey execs (sets facilitator cap
      defaults — slop's 0.05 ETH cap reads differently on L1).

# P2P / Decentralized Slop

Research / design doc for a version of slop-computer-live with **no
central relay**. Room state replicates across every participant's
machine as a CRDT, content lives in IPFS, transport is peer-to-peer,
and every mutation is cryptographically signed by its author. The
slop.computer relay becomes one optional convenience peer among many,
not the source of truth — shutting it down would not shut a room down.

Status: **Research, not greenlit.** Captured 2026-05-28 from a design
chat. The current architecture is a single Node.js relay
(`packages/relay/src/index.ts`, ~6k LOC) owning ~30 subsystems per
Room (`packages/relay/src/room.ts`). This doc sketches the path from
that to a P2P fabric without throwing away the existing UX.

---

## What this fixes

Today the relay is a single point of failure AND control:

1. **Hosting censorship** — one VPS, one domain. Anyone with leverage
   over the host, registrar, or DNS provider can dark the entire
   system in minutes.
2. **State authority** — every subsystem's "truth" is a JSON file on
   the relay's disk. If the box dies and no backup exists, rooms are
   gone. If the operator becomes adversarial, they can rewrite
   transcripts, mint fake chat messages, or reassign agent tokens.
3. **Observability monopoly** — the relay sees every chat message,
   every wallet command, every action. There is no technical option
   for a private room.

A P2P version makes (1) and (2) cost a coordinated takedown of every
participant, and (3) becomes a policy knob (E2E room) instead of a
hard architectural ceiling.

---

## North star architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Peer A (browser)         Peer B (browser)      Peer C (…) │
│  ─────────────────        ─────────────────                 │
│  • signing key            • signing key                     │
│  • room CRDT replica   ⇆  • room CRDT replica   ⇆  • …      │
│  • IndexedDB cache        • IndexedDB cache                 │
│  • libp2p (WebRTC)        • libp2p (WebRTC)                 │
└──────────┬──────────────────────┬──────────────────────┬───┘
           │                      │                      │
           ▼                      ▼                      ▼
   ┌───────────────────────────────────────────────────────────┐
   │  IPFS pin set      libp2p DHT      gossipsub topic        │
   │  (snapshot CIDs)   (peer find)     (signed ops fanout)    │
   └───────────────────────────────────────────────────────────┘

   ┌─── optional volunteer services (any peer can host) ───┐
   │  • browser-host (Chromium)   • transcription worker   │
   │  • episode generator         • TURN relay             │
   │  • IPFS pinning service      • signaling fallback     │
   └───────────────────────────────────────────────────────┘
```

Three things stop being centralized: **storage**, **routing**, and
**authority**. Some things stay centralized — but become *replaceable*
and *optional*, not load-bearing.

---

## Core primitives

### 1. Identity = keypair

Every participant has a signing key (Ed25519 by default; secp256k1 as
an alternate so existing Ethereum wallets work as identities). Public
key = participant ID. Private key never leaves the device.

- **Browser keys** live in IndexedDB, optionally encrypted at rest by
  a passkey-derived secret (this repo already has a `passkey.ts`
  module to repurpose).
- **Wallet identity** — sign-in-with-Ethereum is the natural bridge.
  An SIWE message binds the room session to an Ethereum address; the
  Ed25519 device key is then proven-owned by that address via signature.
- **Identity recovery** is hard in a keyless world. Initial scope:
  losing your device key = losing your handle in that room, period.
  Out-of-scope for v1: social recovery, MPC.

### 2. All actions are signed events

Every mutation is a typed event:

```ts
type Event<T> = {
  room: string;          // room ID (also a pubkey or hash)
  author: PublicKey;     // who signed this
  seq: number;           // monotonic per-author counter (replay defense)
  ts: number;            // wall clock (advisory only, not load-bearing)
  type: string;          // "chat", "wallet_tx", "todo_add", …
  payload: T;
  sig: Signature;        // Ed25519(author, canonicalJson({room,seq,ts,type,payload}))
};
```

Verification is local: any peer can validate any event against the
author's pubkey, no quorum needed. Invalid signatures are dropped on
receipt. Per-author seq numbers stop replay; room ID stops cross-room
replay.

This replaces the relay's role as the trusted broadcaster. Today a
chat message is "trust the relay said it." Tomorrow it's "trust the
signature said it."

### 3. Room state = CRDT

Room state becomes one Yjs document per room (Automerge is the other
candidate; Yjs wins on browser ecosystem maturity, IndexedDB
persistence, and WebRTC provider availability).

Each existing subsystem maps to a Yjs sub-doc or collection:

| Today's subsystem (`packages/relay/src/`) | Yjs shape         |
|-------------------------------------------|-------------------|
| `chat.ts` ChatHistory                     | Y.Array of msgs   |
| `transcript.ts` Transcript                | Y.Array of segs   |
| `todos.ts` TodoList                       | Y.Array           |
| `notes.ts` NoteList                       | Y.Array           |
| `windows.ts` WindowSet                    | Y.Map             |
| `desktop.ts` DesktopState                 | Y.Map             |
| `music-state.ts` MusicState               | Y.Map             |
| `wallet.ts` WalletState                   | Y.Map (see notes) |
| `chess.ts` ChessState                     | Y.Map             |
| `participants.ts` Participants            | Y.Map             |
| … (~30 total)                             | …                 |

Mutations are local edits on the doc. Yjs encodes them as deltas. We
wrap each delta in a signed `Event` (see above) before broadcasting so
peers verify *who* authored the change before applying it. This is a
small extension to vanilla Yjs (which trusts all peers equally) — it's
been done before in projects like Y-Sweet's auth model.

**Wallet state is special.** Chain state is already a CRDT (the chain
itself). Off-chain wallet metadata (pending intents, narration,
labels) becomes Yjs like the rest. Private keys are NEVER in the CRDT.

### 4. Content storage = IPFS

CRDT operation logs grow forever; full replay on cold-start is slow.
Solution: periodic snapshots pinned to IPFS as content-addressed
blobs.

- **Snapshot cadence**: every N ops or every M minutes per subsystem,
  whichever first.
- **Snapshot identity**: CID is the snapshot. The current "head CID"
  for each subsystem is published into the CRDT itself (the doc points
  at IPFS, not the other way).
- **Late joiner**: fetch latest head CID(s) from any peer, hydrate the
  doc, then catch up via gossipsub deltas.
- **Files / blobs** (`files.ts`, `card.ts`, recordings, avatars) move
  to IPFS natively — they're already content-addressable by nature.
  This repo already has `packages/relay/src/ipfs.ts` to build on.
- **Pinning durability** is a real problem. Options, none perfect:
  - Each peer pins their own room snapshots locally.
  - A volunteer "archive peer" runs go-ipfs/Kubo and pins everything.
  - Paid pinning (Pinata, web3.storage, Filecoin) for rooms that want
    durability without trusting a single peer.

### 5. Transport = libp2p over WebRTC

libp2p-js is the obvious transport. Browser-compatible. Supports
WebRTC for direct peer connections, WebSocket as a fallback, and
gossipsub for room-scoped pub/sub.

- **Signed delta fanout**: gossipsub topic = room ID. Every signed
  event published to the topic. Peers verify on receipt, apply to
  local doc.
- **Peer discovery**: libp2p DHT (Kademlia). Bootstrap nodes from a
  static list (see §7).
- **NAT traversal**: WebRTC's STUN works for ~80% of peers;
  ~20% behind symmetric NAT need TURN. Any peer with a public IP can
  volunteer a TURN service. The current slop.computer box can run one.
- **TCP/QUIC** for desktop / server peers (browser-host, archive
  peers, AI workers) — gives those nodes a fixed-multiaddr presence
  the DHT can dial.

### 6. Optional volunteer services

Three things genuinely can't be P2P. Reframe them as opt-in services
any peer can volunteer, with results signed by the operator so peers
can trust-or-not as they choose.

- **browser-host (Chromium)** — `packages/browser-host`. A peer
  volunteers compute, advertises a service multiaddr in the room CRDT,
  and other peers send shared-browser commands directly to that peer.
  Multiple volunteers = redundancy. Zero volunteers = the
  shared-browser feature is unavailable for that room (graceful
  degrade, room itself still works).
- **AI transcription / episode generation / agents** — same pattern.
  Whisper, episode card generation, AI movers, glossary builders all
  become signed-output services. A peer with an OpenAI key (or local
  Whisper) volunteers and signs each segment. Other peers can choose
  to trust or run their own.
- **TURN / signaling** — for peers behind hostile NATs. Any peer with
  a public IP can run one; rooms list known endpoints in their CRDT.

The current slop.computer deployment becomes "the peer that volunteers
all the services" — convenient default, not the only option.

### 7. Bootstrap & discovery

The unavoidable chicken-and-egg: to find peers in a room you need to
find *some* peer first. There's no fully uncensorable answer here;
the best we can do is offer many independent options so no single
takedown silences a room:

1. **DNSLink on a domain** — `_dnslink.slop.computer` resolves to an
   IPNS record listing current bootstrap multiaddrs. Censorable by
   DNS, but trivially mirrorable.
2. **On-chain registry** — a small contract on Base (or wherever)
   storing room-ID → latest snapshot CID + bootstrap hints, updated
   periodically by anyone who pins. Censorship-resistant but slow and
   gas-costly.
3. **IPNS / IPFS pubsub** — bootstrap list is itself an IPFS document.
   Self-bootstrapping if you already have *some* IPFS node.
4. **Out-of-band invite links** — `slop://join?room=…&bootstrap=…`
   URLs shared via QR code, paper, Signal, whatever. Truly
   uncensorable but high friction.
5. **mDNS** for same-LAN discovery (free, useful for local meetings).

Ship at least #1, #2, #4. They cover different threat models and
back each other up.

---

## Mapping the existing subsystems

The ~30 subsystems in `Room` (room.ts:210-322) split into four
categories:

**Pure CRDT (most of them).** Chat, transcript, todos, notes,
windows, desktop, episode, clock, music, pong, worm, research, qr,
preview-media, scroll-sync, ui-state, chess, chyron, apps, wallet
metadata, walletChat, participants, jamendo. These all become Yjs
docs. The existing `.subscribe()` pattern in each subsystem becomes
"observe the Yjs doc."

**CRDT + service-backed (a few).** Files (CRDT index + IPFS blobs),
recordings (CRDT index + IPFS audio), card (CRDT index + IPFS images).

**Service-only (a few).** browser-host, AI movers, episode generator,
glossary AI, news digest, headlines, ticker. These become opt-in
signed services. Their *output* lands in the CRDT; their compute lives
wherever the volunteer hosts it.

**Auth (special).** `room-auth.ts`, agent tokens, passkey, SIWE.
These mostly go away — replaced by signature checks against per-peer
keys. The remaining ACL question is "who can join this room and what
ops are they allowed to author" — answered by a room policy
document (also in the CRDT, owned by the room creator's key).

---

## Migration phases

A useful property of CRDTs: a single room can exist both as a
relay-mediated doc AND a peer-replicated doc simultaneously during
the cutover, because Yjs's merge is associative and commutative. The
relay becomes one of the peers in its own room.

### Phase 0 — research spikes (1-2 weeks)

Pre-commit work. No production change.

- Yjs + WebRTC provider proof-of-concept with one toy subsystem
  (probably todos — small, well-bounded, low risk).
- libp2p-js bundle size audit (it's heavy — measure the cost).
- Signed-event wrapper around Yjs deltas (does the auth layer
  actually work in practice with Yjs's update format?).
- IPFS snapshot/restore loop for a Yjs doc.

Outcome: kill the plan, or shrink the unknowns enough to commit.

### Phase 1 — signed events alongside relay (2-3 weeks)

Every mutation gets signed by the author's device key before being
sent to the relay. The relay verifies signatures and rejects bad
ones. Storage still on the relay; transport still WebSocket.

This is pure plumbing — no behavior change visible to users — but it
establishes the identity layer and proves we can sign every action
type. Roughly: a `signEvent()` wrapper around every `ws.send()` in
the client, and a `verifyEvent()` in `packages/relay/src/peers.ts`
broadcast path.

**Risk if we stop here**: still single point of failure, but at least
the relay can't forge messages anymore.

### Phase 2 — one CRDT subsystem end-to-end (3-4 weeks)

Pick **chat** (small, observable, low-stakes if broken). Convert
`ChatHistory` to a Yjs Y.Array. Relay still hosts the canonical
replica, but peers replicate locally and merge bidirectionally. WS
fanout sends Yjs updates instead of full chat events.

Validates the full stack: signed-event-wrapped Yjs deltas, local
replica, persistence, late-joiner sync, idempotency.

**Definition of done**: chat keeps working with the relay offline for
60 seconds (peers exchange messages directly via WebRTC fallback),
reconciles when the relay comes back.

### Phase 3 — remaining CRDT subsystems (8-12 weeks)

Convert subsystems one at a time, in dependency order. Each one is a
~1-3 day chunk. Build a small adapter layer so subsystems can be
half-migrated (relay-canonical) or fully-migrated (CRDT-canonical)
behind a per-room feature flag.

Order suggestion (low risk → high):
todos → notes → windows → desktop → music → pong → worm → research →
chess → wallet (metadata only) → transcript → episode → files → card
→ recordings.

### Phase 4 — libp2p transport (4-6 weeks)

Add libp2p alongside the WebSocket transport. Peers prefer P2P, fall
back to relay-WS when P2P fails. Bootstrap initially only via the
relay (still a SPOF, but now optional for working rooms).

### Phase 5 — kill the SPOF (4-6 weeks)

- Multiple bootstrap mechanisms (DNSLink, on-chain registry, invite
  links).
- IPFS snapshots so cold-start doesn't require any specific peer.
- Volunteer-service registry in the room CRDT.
- Relay becomes optional — rooms work with it offline.

### Phase 6 — services as volunteers (ongoing)

Refactor browser-host, AI workers, etc., as signed-output services.
This is the longest tail because each service has its own protocol.

---

## Open problems / honest risks

Things that will hurt:

- **libp2p in the browser is expensive.** Bundle size is megabytes;
  CPU for crypto + DHT churn is real. Mobile peers will struggle.
  Need to measure before committing.
- **CRDT cold-start cost.** A long-lived room could have GB of ops.
  Snapshots help but snapshot delivery needs work — naive "fetch the
  whole CID" doesn't scale to a casual joiner on mobile data.
- **Spam / Sybil.** Pure P2P has no rate limiter. Anyone with a key
  can flood a room. Mitigations: invite-only room policies (room
  creator signs a member set), proof-of-work per message, stake-based
  (deposit ETH to participate). Pick one per room policy.
- **Storage griefing.** A peer could publish enormous payloads to a
  room's gossipsub topic. Size caps + reputation system per peer.
- **Causal vs real-time ordering.** CRDTs converge but they don't
  give you "this message arrived before that one for all observers."
  Wallet UX in particular needs to be careful — "did I see this tx
  before signing?" matters. Probably means wallet flows stay
  request/response with a service rather than free-form CRDT.
- **Time.** No trusted clock. Timestamps in events are advisory.
  Anywhere we currently sort by `ts`, we need to think about whether
  a malicious peer can backdate.
- **AI features die without volunteers.** A pure-P2P room has no
  Whisper, no episode generation, no agents. That's the cost of being
  uncensorable.
- **Discovery leaks existence.** A DHT advertises a room exists.
  Truly private rooms need invite-only discovery, not DHT presence.
- **Key UX is brutal.** Losing a device key = losing your identity.
  Existing wallets help (SIWE) but only if you have one.
- **The relay codebase is 6k LOC of imperative state mutation.** A
  CRDT rewrite touches every subsystem and every WS handler. The
  refactor surface is enormous. Phase 3 is going to feel like it's
  taking forever.

Things that make this *more* tractable than it looks:

- **Subsystems are already shaped like documents.** Each one has a
  JSON-file backing store and a `.subscribe()` event. That's nearly
  one-to-one with a Yjs doc + observer.
- **The relay is already a per-room actor.** Per-room migration
  shipped 2026-05-19 (Room class isolation). Each room can migrate
  independently — no global cutover.
- **WebRTC infra exists in the project.** The shared-browser feature
  already runs Chromium-driven streams; the client knows how to do
  WebRTC. Not starting from zero.
- **IPFS is already wired** for `files.ts` blobs. The pipe exists.

---

## Decisions still needed

Before Phase 0:

1. **Yjs vs Automerge.** Yjs is the default recommendation
   (ecosystem, IndexedDB, WebRTC provider) but worth a one-day
   spike on Automerge to confirm.
2. **Signing curve.** Ed25519 for device keys, secp256k1 only as an
   identity bridge to wallets? Or use secp256k1 throughout to reuse
   wallet infra?
3. **Bootstrap registry shape.** Contract on Base? IPNS? Both?
4. **Room policy format.** How does a room creator express "these
   pubkeys can author, these can read, this is the rate limit"? Probably
   a signed document in the CRDT but the schema needs design.
5. **Does the relay shrink to a service, or get rewritten as a peer?**
   Either way it stays useful (TURN, archive pinning, AI host) — but
   the code path differs a lot.

---

## What this is not

- **Not** a blockchain. The chain (Ethereum) shows up only because
  wallets do, and as an option for the bootstrap registry. Room state
  is *not* on a chain — chains are wrong for high-frequency mutable
  state.
- **Not** a private messenger. E2E encryption is orthogonal — could be
  layered on top once the P2P fabric exists. v1 ships with public-by-
  default rooms (signed but not encrypted) to match today's UX.
- **Not** a replacement for the relay overnight. The relay is
  *useful* (TURN, pinning, AI host, default bootstrap). The goal is to
  make it unnecessary, not unwanted.
- **Not** a small project. Realistic estimate at the phase
  granularity above is 6-12 months of focused work, assuming one
  developer. Could be shorter with two and ruthless scope cuts.

---

## First concrete step if greenlit

Start a `packages/p2p-spike/` directory. Build a standalone web page
that:

1. Generates an Ed25519 keypair on load.
2. Joins a Yjs doc over y-webrtc with a hardcoded room name.
3. Lets two browsers edit a shared todo list, see each other's edits.
4. Wraps every Yjs update in a signed `Event` envelope and rejects
   updates with invalid signatures.
5. Snapshots the doc to a local IPFS node every minute, pinning the
   CID.

If that POC works in a week, the rest of the plan is execution. If it
falls apart on bundle size, CPU, or libp2p browser quirks, we learn
that cheaply and either pick a different stack or shelve the plan.

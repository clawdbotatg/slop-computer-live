# PLAN — No-Limit Hold'em poker room (escrow-backed)

Status: **design only.** The generic escrow module (`packages/relay/src/escrow.ts`)
is built and powers chess; poker is the motivating "huge ask" that shaped
that module. This doc records how poker would plug in, and — more
importantly — what the *hard* parts actually are (hint: not the money).

## The money is the easy 10% — the escrow already covers it

Poker's money movement maps cleanly onto the generic `EscrowState`:

| Poker need | Escrow primitive |
| --- | --- |
| Each seat buys in (min/max range) | `open()` with one account per seat, `requiredWei` = min buy-in |
| Buy-in lands → chips | `recordDeposit()` (server-verified) credits `depositedWei` + `balanceWei` |
| Rebuy / top-up mid-session | `recordDeposit()` accumulates — `balanceWei` grows |
| Chips move each hand | `applyDeltas([{key,+win},{key,-loss}])` — zero-sum, balances stay ≥ 0 |
| Player cashes out (leaves) | `withdraw(key)` → propose a single tx for their `balanceWei`, zero the account, others keep playing |
| Table closes | `settle(payouts)` pays every remaining balance out in one batch |

The invariant the escrow enforces — **Σ balances ≤ Σ deposits ≤ on-chain
multisig balance** — is exactly the "the table can always cover every
stack" property poker needs. `applyDeltas` (zero-sum) and per-account
`withdraw` are the two methods poker adds on top of what chess uses;
they're in the module's design surface already (see escrow.ts notes).

**One escrow wrinkle:** the room multisig is the room's *general* wallet,
so its balance can exceed Σ poker balances (other funds sit there too).
That's fine for solvency (more than enough to cover), but a dedicated
per-table escrow multisig would make accounting auditable. Defer.

## The hard 90% — the engine + card privacy

Poker is a **real-time, imperfect-information** game. None of this is
escrow:

1. **Hand engine.** Blinds/antes, dealing, four betting rounds
   (pre-flop/flop/turn/river), check/call/bet/raise/fold, min-raise and
   all-in rules, **side pots** when players are all-in for different
   amounts, hand evaluation (7-card best-5), kickers, split pots. This is
   a meaty but well-trodden state machine — server-authoritative like
   chess, but with far more states and a per-seat action clock.

2. **Hole-card privacy — the real blocker.** Chess is perfect
   information: the relay broadcasts the whole board. Poker can't — each
   player's two hole cards must be visible *only to them*. So the relay
   deals and pushes each seat its own cards **over that seat's own
   socket** (never `broadcast`), revealing at showdown only the hands
   that go to war. This breaks the "one broadcast snapshot = truth"
   model every other slop subsystem uses; poker needs per-peer private
   frames. Spectators/the stream must see community cards + bets but
   never live hole cards (or the whole table is exploitable on-stream).

3. **Deal fairness.** Trusting the relay to shuffle honestly is fine for
   a friendly room (same trust as relay-rolled dice). A trustless upgrade
   is **commit-reveal** (relay commits to a shuffled deck hash up front,
   reveals at end for audit) or full **mental poker** (overkill). Start
   trusted; commit-reveal is a clean later add.

4. **Turn clock + disconnect handling.** A seat that times out auto-
   checks/folds; a disconnect mid-hand needs a sit-out/auto-fold policy
   so one player can't stall the table (and can't strand the pot — same
   class of problem as "don't let chess abort with money escrowed").

## Build order (when we take it on)

1. `poker.ts` engine — pure hand state machine + hand evaluator, unit-
   tested in isolation (no money, no privacy). This is the bulk.
2. Per-peer private dealing on the WS (hole cards to one socket).
3. Wire `room.escrow`: `open` on table create, `recordDeposit` on buy-in,
   `applyDeltas` at end of each hand from pot results, `withdraw` on
   cash-out, `settle` on table close.
4. UI: table felt, seats, community cards, bet controls, pot, your hand.
5. Later: commit-reveal deck, side-pot edge cases, tournament mode.

## Why the escrow generalization was worth doing first

Chess, pong, worm, and poker all reduce to: collect verified deposits →
let a server-authoritative game redistribute balances → pay balances out
through the multisig. Building that once (`escrow.ts`) means poker — and
every simpler money game — only writes its *game* logic, never its money
logic. See [[money_chess_wager]].

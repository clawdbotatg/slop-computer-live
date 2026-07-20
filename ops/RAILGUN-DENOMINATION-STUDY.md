# Shield — Railgun denomination study & withdrawal strategy

*30 days of mainnet Railgun ETH flows, read straight off our own node.
2026-07-19. Study window: 30 days (~216k blocks) ending block 25.6M.*

---

## 🐦 Tweet thread (copy/paste)

**1/**
We built a privacy tool on slop.computer that runs your ETH through Railgun and hands it back with no on-chain history. Then we asked the obvious question: to actually disappear into the crowd, what does the crowd *do*? So we read a month of Railgun off our own node. 🧵

**2/**
Setup, so nobody's confused: **Railgun** is the privacy pool (the vault). **Kohaku** is the Ethereum Foundation's wallet toolkit that knows how to drive Railgun. **Kohaku-CLI** is its command line. Our app ("Shield") is a thin layer that automates all three. We don't reinvent privacy — we ride Railgun's.

**3/**
The data: **2,627 ETH withdrawals in 30 days, 14,901 ETH total.** First gut-punch: **62% of exits are snowflakes** — a wei-precision amount that exactly ONE person withdrew that month. A unique number IS a fingerprint. Most people using a privacy tool are quietly de-anonymizing themselves on the way out.

**4/**
Our own first test was a snowflake too: we withdrew 0.0088483705 ETH. Cute, precise, and traceable — anyone can compute "that's 0.01 minus this specific app's fee stack" and link it right back to the deposit. Soak time doesn't save you if the *amount* is one of a kind.

**5/**
The 38% who blend in cluster on a handful of sizes. The single biggest crowd: **100 people who received exactly 0.009975 ETH.** Why the weird number? Because that's **0.01 minus Railgun's 0.25% fee.** They typed "0.01" into the official Railgun wallet; it took the fee off the top.

**6/**
This is the counterintuitive part. The anonymity-maximizing exit is NOT the clean round number. Withdrawing so you *receive* exactly 0.01 puts you in a crowd of 29. Withdrawing so you receive **0.009975** puts you in a crowd of **100** — 3.4× bigger. The "ugly" number is the disguise.

**7/**
So we rebuilt Shield to think like the dominant tool: snap every withdrawal to **round-gross-minus-fee** — 0.009975, 0.09975, 0.49875, 0.9975 — the exact byte-for-byte amounts the biggest Railgun crowds already emit. And the deposit screen pre-pads your deposit so you land there automatically.

**8/**
Deposits are even messier than exits — **88% snowflakes.** Barely anyone standardizes what they put IN. That's fine for us (the deposit side is already linked to you) but it means the withdrawal side is where all the real privacy is won or lost, and almost nobody optimizes it.

**9/**
Takeaway if you use ANY privacy pool, ours or not: **the amount is the leak.** Round to what the crowd rounds to — which is usually round-gross, i.e. a hair under a clean number. Soaking longer barely matters if your withdrawal is a unique snowflake. Match the herd or don't bother.

**10/**
All of this ran against a node we operate, reading public event logs — no special access, you can reproduce it. Shield is live on slop.computer. It's custodial while your funds are inside (a mixer, not self-custody); send the clean ETH to a fresh wallet to keep what you bought. /end

---

## TLDR — Railgun vs Kohaku vs Kohaku-CLI vs "Shield"

Four names, four distinct layers. From the metal up:

| Layer | What it is | Who made it | Our relationship |
|---|---|---|---|
| **Railgun** | The privacy protocol — smart contracts on Ethereum mainnet holding one big shielded pool of everyone's funds. This is where the actual privacy lives. | Railgun DAO | We use it. We don't touch the contracts directly. |
| **Kohaku** | A wallet toolkit/SDK that knows how to *operate* Railgun: encrypted seed, fresh-address hygiene, building the zero-knowledge proofs, scanning balances. | Ethereum Foundation | The engine we drive. |
| **Kohaku-CLI** | The command-line front-end to Kohaku (`shield`, `unshield`, `balances`, …), with a `--non-interactive` JSON mode built for automation. | EF (same project) | The exact binary our relay spawns, like it spawns ffmpeg. |
| **Shield** (our app) | The slop.computer desktop app: watches for your deposit, auto-shields, runs the soak timer + anonymity counter, withdraws to a fresh address, and gives you a holdings/chat/send screen. | us | The thin automation + UX layer over all of the above. |

**One sentence:** *Shield is our app; it drives EF's Kohaku-CLI; which operates the Railgun protocol.* If Railgun vanished there'd be no privacy; if Kohaku vanished we'd be hand-writing proofs; Shield is "the nice buttons."

---

## What we measured

Read via `eth_getLogs` against our own mainnet node — `Shield` and `Unshield`
events on the Railgun proxy `0xFA7093…FA4b9`, WETH/native only, 30 days.

### Exits (`Unshield`) — n = 2,627, 14,901 ETH

| Metric | Value |
|---|---|
| Total ETH withdrawals | 2,627 |
| Unique exact received amounts | 1,638 |
| **Snowflakes (an amount exactly one person used)** | **62%** |
| In a crowd (shared exact amount with ≥1 other) | 38% |
| Received a multiple of 0.1 ETH | 190 |
| Received a multiple of 0.01 ETH | 155 |
| …of 0.001 | 137 |
| Median received | 0.207 ETH · p25 0.012 · p75 1.74 · p95 13.2 |

**Top exact received-amount clusters:**

| Received | Crowd | = gross of | Convention |
|---|---|---|---|
| **0.009975** | **100** | 0.01 | round-gross (official Railgun) |
| 0.09975 | 45 | 0.1 | round-gross |
| 1.0 | 40 | ~1.0025 | round-received |
| 0.9975 | 40 | 1.0 | round-gross |
| 0.01 | 29 | 0.010025 | round-received |
| 0.49875 | 19 | 0.5 | round-gross |
| 0.0049875 | 19 | 0.005 | round-gross |
| 0.049875 | 19 | 0.05 | round-gross |
| 0.01995 | 18 | 0.02 | round-gross |

At sub-0.05 sizes (our range) **round-gross dominates round-received ~3:1** —
0.009975 (crowd 100) vs 0.01 (crowd 29). At whole-ETH sizes the two
conventions are roughly even (1.0 ×40 vs 0.9975 ×40).

### Entries (`Shield`) — n = 1,614, 15,255 ETH

| Metric | Value |
|---|---|
| Note values that are snowflakes | **88%** |
| Deposits whose *gross* was a round 0.001-multiple | 16% |
| Median note | 0.174 ETH |

Deposits are far less standardized than exits — which makes sense: the deposit
side is already linked to you, so there's nothing to hide there. **All the
privacy is on the exit.** And almost nobody optimizes it.

### Crowd-size distribution (exits sharing an exact amount)

`[100, 45, 40, 40, 29, 19, 19, 19, 18, 18, 18, 17, 17, 16, 15, 15, 14, 12, …]`

The head is small. Even the biggest crowd is 100/month; past the top ~15
denominations you're in crowds of single digits, then snowflakes. **There is
one clearly-best hiding spot at each order of magnitude, and it's the
round-gross amount.**

---

## Strategy — what Shield does about it

**Principle: emit the amount the biggest existing crowd already emits.** Don't
invent a denomination; join the largest one at your size.

1. **Withdrawals snap to round-gross-minus-fee.** For each 1-2-5 gross
   denomination `g` (0.001 … 50 ETH), the target *received* amount is
   `g × 0.9975`. We pick the largest such target the balance can afford that
   captures ≥85% of it. Result: our exits are byte-identical to the
   `0.009975 / 0.09975 / 0.49875 / 0.9975` clusters — the 100/45/19/40-strong
   crowds — instead of a unique snowflake.
   - *This corrected an earlier version that snapped to round-received (0.01),
     which would have put users in the 29-crowd, not the 100-crowd.*
2. **Deposits are pre-padded to land there.** The deposit screen suggests
   amounts (e.g. **0.0114 → receive 0.009975**) that, after the shield fee +
   both gas legs + the unshield fee, come out exactly on a big-crowd exit.
   Default is the 0.01-gross tier (the single biggest crowd).
3. **Crumbs stay in the pool.** The few hundred µETH between your balance and
   the denomination stay shielded as anonymity-set ballast — never withdrawn,
   so they can't re-fingerprint you.

### Trade-offs we accept

- **You don't receive a clean round number.** You receive 0.009975, not 0.01.
  That's the *point* — the clean number is the smaller crowd. UI says so.
- **A little value is left behind** each cycle (the sub-denomination crumb).
  It stays yours on the books; a host sweep can reclaim it later.
- **This is a snapshot.** Denomination fashion drifts with ETH price and whale
  cycles. The 1-2-5 gross series is a stable convention, but the *right tier*
  for "small" moves. Re-running this study quarterly (it's one script + the
  node) and re-tuning `WITHDRAW_DENOMS` is the maintenance ritual — same spirit
  as the naming-model re-benchmark.

### What we deliberately did NOT do

- **Fixed-denomination-only (Tornado-style):** refuse any deposit that isn't a
  canonical size. Maximal crowd, terrible UX, and Railgun's variable-amount
  design is the whole reason it's not Tornado. We pad instead of refuse.
- **Multi-hop / decoy withdrawals:** real technique, real cost (gas, time,
  complexity, more custody surface). Not worth it at slop scale; noted for a
  someday-v2.

---

## Reproduce it

One script, ~2 min against any mainnet archive-lite node that serves
`eth_getLogs`. Scan `Shield` + `Unshield` on `0xFA7093…FA4b9`, filter WETH +
native, bucket exact amounts, count crowds. (The throwaway script used for this
run lived at `packages/relay/analyze-railgun-month.mjs` — deleted after use to
keep it out of the build; the shape is in this doc's git history if we want it
back as a scheduled job.)

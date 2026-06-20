// Escrow tests. Run: yarn tsx --test src/escrow.test.ts
// Focus: the autoLock flag + dynamic addAccount() that back poker's
// buy-in window, plus a chess-style baseline so the default (auto-lock on
// full funding) stays intact.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EscrowState, mergePayouts, payoutAddrOf } from "./escrow.js";

let n = 0;
const tmp = () => new EscrowState(`/tmp/escrow-test-${process.pid}-${n++}.json`);
const addr = (c: string) => "0x" + c.repeat(40);
const MULTISIG = addr("a");

test("chess baseline: auto-locks once every account is funded", () => {
  const e = tmp();
  e.open({
    game: "chess",
    chainId: 8453,
    multisig: MULTISIG,
    accounts: [
      { key: addr("1"), label: "W", role: "white", requiredWei: "100" },
      { key: addr("2"), label: "B", role: "black", requiredWei: "100" },
    ],
    createdBy: addr("1"),
  });
  e.recordDeposit(addr("1"), { txHash: "0xaa", amountWei: "100" });
  assert.equal(e.get()!.status, "open"); // one side still owes
  e.recordDeposit(addr("2"), { txHash: "0xbb", amountWei: "100" });
  assert.equal(e.get()!.status, "locked"); // both funded → locked
});

test("poker: opens empty, autoLock false, accepts dynamic joins, stays open", () => {
  const e = tmp();
  const opened = e.open({
    game: "poker",
    chainId: 8453,
    multisig: MULTISIG,
    accounts: [],
    autoLock: false,
    meta: { chipValueWei: "1" },
    createdBy: addr("1"),
  });
  assert.equal(opened.ok, true);
  assert.equal(e.get()!.accounts.length, 0);

  // First player joins + funds.
  assert.equal(e.addAccount({ key: addr("1"), label: "P1", role: "0", requiredWei: "100" }).ok, true);
  e.recordDeposit(addr("1"), { txHash: "0x01", amountWei: "100" });
  assert.equal(e.get()!.status, "open"); // would have locked under chess rules — poker stays open

  // A latecomer joins mid-session — still allowed because we never locked.
  assert.equal(e.addAccount({ key: addr("2"), label: "P2", role: "1", requiredWei: "100" }).ok, true);
  e.recordDeposit(addr("2"), { txHash: "0x02", amountWei: "100" });
  assert.equal(e.get()!.status, "open");
  assert.equal(e.get()!.accounts.length, 2);
});

test("addAccount rejects duplicates and non-addresses", () => {
  const e = tmp();
  e.open({ game: "poker", chainId: 8453, multisig: MULTISIG, accounts: [], autoLock: false, createdBy: addr("1") });
  assert.equal(e.addAccount({ key: addr("1"), label: "P1", role: "0", requiredWei: "100" }).ok, true);
  assert.equal(e.addAccount({ key: addr("1"), label: "dup", role: "1", requiredWei: "100" }).ok, false);
  const bad = e.addAccount({ key: "not-an-address", label: "x", role: "2", requiredWei: "100" });
  assert.equal(bad.ok, false);
});

test("poker settles from an open session (never locked)", () => {
  const e = tmp();
  e.open({ game: "poker", chainId: 8453, multisig: MULTISIG, accounts: [], autoLock: false, createdBy: addr("1") });
  e.addAccount({ key: addr("1"), label: "P1", role: "0", requiredWei: "100" });
  e.recordDeposit(addr("1"), { txHash: "0x01", amountWei: "100" });
  e.addAccount({ key: addr("2"), label: "P2", role: "1", requiredWei: "100" });
  e.recordDeposit(addr("2"), { txHash: "0x02", amountWei: "100" });
  // P1 won everything (cash-out plan from final stacks).
  const res = e.settle([{ to: addr("1"), amountWei: "200" }], { settleKind: "cashout" });
  assert.equal(res.ok, true);
  assert.equal(e.get()!.status, "settling");
});

test("deposits are single-use: a replayed txHash is rejected (rebuy)", () => {
  const e = tmp();
  e.open({ game: "poker", chainId: 8453, multisig: MULTISIG, accounts: [], autoLock: false, createdBy: addr("1") });
  e.addAccount({ key: addr("1"), label: "P1", role: "0", requiredWei: "100" });
  assert.equal(e.recordDeposit(addr("1"), { txHash: "0xdupe", amountWei: "100" }).ok, true);
  assert.equal(e.isTxConsumed("0xdupe"), true);
  // Replaying the same hash (the rebuy inflation vector) is refused and
  // leaves the balance untouched.
  const replay = e.recordDeposit(addr("1"), { txHash: "0xdupe", amountWei: "100" });
  assert.equal(replay.ok, false);
  assert.equal((replay as { error: string }).error, "tx_already_used");
  assert.equal(e.accountOf(addr("1"))!.depositedWei, "100");
  // A genuinely new on-chain payment (distinct hash) still credits.
  assert.equal(e.recordDeposit(addr("1"), { txHash: "0xfresh", amountWei: "50" }).ok, true);
  assert.equal(e.accountOf(addr("1"))!.depositedWei, "150");
});

test("consumed txHashes survive clear() — no free re-entry next tournament", () => {
  const e = tmp();
  e.open({ game: "poker", chainId: 8453, multisig: MULTISIG, accounts: [], autoLock: false, createdBy: addr("1") });
  e.addAccount({ key: addr("1"), label: "P1", role: "0", requiredWei: "100" });
  assert.equal(e.recordDeposit(addr("1"), { txHash: "0xold", amountWei: "100" }).ok, true);
  e.clear(); // tournament ends, lobby reopens
  // New tournament, same room multisig + chain. The old buy-in hash can't
  // be replayed to enter without paying again.
  e.open({ game: "poker", chainId: 8453, multisig: MULTISIG, accounts: [], autoLock: false, createdBy: addr("1") });
  assert.equal(e.isTxConsumed("0xold"), true);
  e.addAccount({ key: addr("1"), label: "P1", role: "0", requiredWei: "100" });
  const replay = e.recordDeposit(addr("1"), { txHash: "0xold", amountWei: "100" });
  assert.equal(replay.ok, false);
  assert.equal((replay as { error: string }).error, "tx_already_used");
});

// ── Sponsored-AI seats: a non-address account key whose payout is redirected
// to the sponsor's (backer's) address. Underpins "sponsor an LLM in poker". ──

const AI_KEY = "ai:bankr-claude-haiku-4.5#abc123";

test("addAccount: a non-address key needs a valid backer; backer must be an address", () => {
  const e = tmp();
  e.open({ game: "poker", chainId: 8453, multisig: MULTISIG, accounts: [], autoLock: false, createdBy: addr("1") });
  // Non-address key with no backer → rejected.
  assert.equal(e.addAccount({ key: AI_KEY, label: "Bot", role: "0", requiredWei: "100" }).ok, false);
  // Non-address key with a non-address backer → rejected.
  assert.equal(e.addAccount({ key: AI_KEY, label: "Bot", role: "0", requiredWei: "100", backer: "nope" }).ok, false);
  // Non-address key with a valid backer → accepted, backer stored lowercased.
  const ok = e.addAccount({ key: AI_KEY, label: "Bot", role: "0", requiredWei: "100", backer: addr("1") });
  assert.equal(ok.ok, true);
  assert.equal(e.accountOf(AI_KEY)!.backer, addr("1"));
  // payoutAddrOf resolves to the backer for the AI seat, the key for a plain one.
  assert.equal(payoutAddrOf(e.accountOf(AI_KEY)!), addr("1"));
});

test("settle: an AI seat's prize is payable to its backer address (not its key)", () => {
  const e = tmp();
  e.open({ game: "poker", chainId: 8453, multisig: MULTISIG, accounts: [], autoLock: false, createdBy: addr("1") });
  // A sponsor funds a bot; the bot's key is non-address, backer = sponsor.
  e.addAccount({ key: AI_KEY, label: "Bot", role: "0", requiredWei: "100", backer: addr("9") });
  e.recordDeposit(AI_KEY, { txHash: "0xa1", amountWei: "100" });
  e.addAccount({ key: addr("2"), label: "P2", role: "1", requiredWei: "100" });
  e.recordDeposit(addr("2"), { txHash: "0xb2", amountWei: "100" });
  // Bot won everything → pool pays the sponsor's address.
  const res = e.settle([{ to: addr("9"), amountWei: "200" }], { settleKind: "tournament" });
  assert.equal(res.ok, true);
  // Paying to the raw AI key (not the backer) is rejected — it isn't a recipient.
  e.clear();
  e.open({ game: "poker", chainId: 8453, multisig: MULTISIG, accounts: [], autoLock: false, createdBy: addr("1") });
  e.addAccount({ key: AI_KEY, label: "Bot", role: "0", requiredWei: "100", backer: addr("9") });
  e.recordDeposit(AI_KEY, { txHash: "0xa2", amountWei: "100" });
  const bad = e.settle([{ to: AI_KEY, amountWei: "100" }], { settleKind: "tournament" });
  assert.equal(bad.ok, false);
  assert.equal((bad as { error: string }).error, "payout_to_non_participant");
});

test("mergePayouts: legs to the same address sum into one (sponsor placed + their bot placed)", () => {
  const merged = mergePayouts([
    { to: addr("9"), amountWei: "200" }, // sponsor's own seat
    { to: addr("9"), amountWei: "50" }, // sponsor's backed bot
    { to: addr("2"), amountWei: "30" },
  ]);
  assert.equal(merged.length, 2);
  const nine = merged.find(p => p.to === addr("9"))!;
  assert.equal(nine.amountWei, "250");
  // Σ preserved.
  assert.equal(merged.reduce((s, p) => s + BigInt(p.amountWei), 0n), 280n);
});

test("cancel: refunds an AI seat to its backer, merging a sponsor's multiple bots", () => {
  const e = tmp();
  e.open({ game: "poker", chainId: 8453, multisig: MULTISIG, accounts: [], autoLock: false, createdBy: addr("1") });
  // One sponsor (addr 9) backs two bots; each is its own deposit.
  e.addAccount({ key: "ai:m#1", label: "Bot1", role: "0", requiredWei: "100", backer: addr("9") });
  e.recordDeposit("ai:m#1", { txHash: "0xc1", amountWei: "100" });
  e.addAccount({ key: "ai:m#2", label: "Bot2", role: "1", requiredWei: "100", backer: addr("9") });
  e.recordDeposit("ai:m#2", { txHash: "0xc2", amountWei: "100" });
  const res = e.cancel();
  assert.equal(res.ok, true);
  assert.equal((res as { needsRefund: boolean }).needsRefund, true);
  const payouts = e.get()!.payouts!;
  // Both bots' buy-ins refund to the one sponsor, as a single merged leg.
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0]!.to, addr("9"));
  assert.equal(payouts[0]!.amountWei, "200");
});

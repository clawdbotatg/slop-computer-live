// Escrow tests. Run: yarn tsx --test src/escrow.test.ts
// Focus: the autoLock flag + dynamic addAccount() that back poker's
// buy-in window, plus a chess-style baseline so the default (auto-lock on
// full funding) stays intact.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EscrowState } from "./escrow.js";

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

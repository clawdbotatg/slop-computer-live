// Balance-visibility store tests. Run: yarn tsx --test src/balance-visibility.test.ts
//
// The store reads its persistence path from BALANCE_HIDDEN_FILE at module
// load and exports a singleton, so we point the env at a throwaway file
// BEFORE importing it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unlinkSync, readFileSync } from "node:fs";

const FILE = `/tmp/balance-hidden-test-${process.pid}.json`;
process.env.BALANCE_HIDDEN_FILE = FILE;

const { balanceVisibility } = await import("./balance-visibility.js");

const cleanup = () => {
  try {
    unlinkSync(FILE);
  } catch {
    /* not written yet */
  }
};

test("defaults to visible (false) for unknown ids", () => {
  assert.equal(balanceVisibility.get("0xABC"), false);
  assert.equal(balanceVisibility.get(null), false);
  assert.equal(balanceVisibility.get(undefined), false);
});

test("set(true) hides, set(false) reveals — case-insensitive key", () => {
  balanceVisibility.set("0xDeadBeef", true);
  assert.equal(balanceVisibility.get("0xdeadbeef"), true);
  assert.equal(balanceVisibility.get("0xDEADBEEF"), true);
  balanceVisibility.set("0xDEADBEEF", false);
  assert.equal(balanceVisibility.get("0xdeadbeef"), false);
});

test("all() lists only hidden ids, lowercased", () => {
  balanceVisibility.set("0xAAA", true);
  balanceVisibility.set("0xBBB", true);
  balanceVisibility.set("0xBBB", false);
  const all = balanceVisibility.all();
  assert.ok(all.includes("0xaaa"));
  assert.ok(!all.includes("0xbbb"));
});

test("subscribers fire only on actual change (no-op is skipped)", () => {
  const events: Array<[string, boolean]> = [];
  const unsub = balanceVisibility.subscribe((id, hidden) => events.push([id, hidden]));
  balanceVisibility.set("0xCCC", true);
  balanceVisibility.set("0xCCC", true); // no-op — same value
  balanceVisibility.set("0xCCC", false);
  unsub();
  balanceVisibility.set("0xCCC", true); // after unsub — not observed
  assert.deepEqual(events, [
    ["0xccc", true],
    ["0xccc", false],
  ]);
});

test("hidden ids persist to disk as a lowercased array", () => {
  balanceVisibility.set("0xPersisted", true);
  const onDisk = JSON.parse(readFileSync(FILE, "utf8")) as string[];
  assert.ok(Array.isArray(onDisk));
  assert.ok(onDisk.includes("0xpersisted"));
  cleanup();
});

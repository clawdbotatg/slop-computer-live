// Probe: the relay's sponsored Safe paths on a Base fork (ops/PLAN-safe.md phase 2).
//   deploySafeOn (EOA + passkey owner, one Multicall3 tx) → idempotent rerun →
//   checkSafePropose (good / bad hash / foreign delegatecall / batch mismatch) →
//   execSafeTx with an EOA signature → queue marks same-nonce txs cancelled.
// The passkey *signing* path is proven by safe-fork.mjs; this one proves the relay plumbing.
//
// Run from repo root: packages/relay/node_modules/.bin/tsx ops/probes/safe-relay-fork.mjs
//   (or `yarn workspace @slop/relay exec tsx ../../ops/probes/safe-relay-fork.mjs`)

import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const relayReq = createRequire(join(ROOT, "packages/relay/package.json"));
const viem = await import(relayReq.resolve("viem"));
const { privateKeyToAccount, generatePrivateKey } = await import(relayReq.resolve("viem/accounts"));
const { base } = await import(relayReq.resolve("viem/chains"));
const { p256 } = await import(relayReq.resolve("@noble/curves/p256"));

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const env = readFileSync(join(ROOT, "packages/nextjs/.env.local"), "utf8");
const key = env.match(/^NEXT_PUBLIC_ALCHEMY_API_KEY=["']?([^"'\n]+)/m)?.[1];
if (!key) throw new Error("no NEXT_PUBLIC_ALCHEMY_API_KEY");
const PORT = 8598;
const anvil = spawn("anvil", ["--fork-url", `https://base-mainnet.g.alchemy.com/v2/${key}`, "--port", String(PORT), "--silent"], {
  stdio: "ignore",
});
const RPC = `http://127.0.0.1:${PORT}`;
const transport = viem.http(RPC);
const pub = viem.createPublicClient({ chain: base, transport });
for (let i = 0; i < 60; i++) {
  try {
    await pub.getBlockNumber();
    break;
  } catch {
    await new Promise(r => setTimeout(r, 500));
  }
}

try {
  // The relay reads its key + RPC from env at import time.
  const deployerKey = generatePrivateKey();
  process.env.PERSONAL_WALLET_DEPLOYER_KEY = deployerKey;
  process.env.ALCHEMY_API_KEY = key;
  process.env.SAFE_RPC_8453 = RPC;
  const test = viem.createTestClient({ chain: base, transport, mode: "anvil" });
  await test.setBalance({ address: privateKeyToAccount(deployerKey).address, value: viem.parseEther("10") });

  const R = await import(join(ROOT, "packages/relay/src/safe-relay.ts"));
  const S = await import(join(ROOT, "packages/relay/src/safe.ts"));
  const { WalletState } = await import(join(ROOT, "packages/relay/src/wallet.ts"));

  const eoa = privateKeyToAccount(generatePrivateKey());
  const pk = p256.getPublicKey(p256.utils.randomPrivateKey(), false);
  const hex = b => "0x" + Buffer.from(b).toString("hex");
  const passkey = { qx: hex(pk.slice(1, 33)), qy: hex(pk.slice(33)) };
  const pkOwner = S.passkeyOwner(passkey.qx, passkey.qy);

  const spec = { owners: [eoa.address, pkOwner], threshold: 1, saltNonce: S.saltNonceFromLabel(`probe:${Date.now()}`), passkeys: [passkey] };
  check(R.validateSpec(spec) === null, "spec validates");
  check(R.validateSpec({ ...spec, threshold: 3 }) === "bad-threshold", "threshold > owners refused");
  const safe = R.predictSafe(spec);

  const first = await R.deploySafeOn(8453, spec);
  check(first.ok && !!first.txHash, `deploySafeOn deploys (${first.ok ? first.txHash : first.error})`);
  check((await pub.getCode({ address: safe }))?.length > 2, "Safe has code at predicted address");
  check((await pub.getCode({ address: pkOwner }))?.length > 2, "passkey signer created in the same tx");
  const owners = await R.safeOwners(8453, safe);
  check(owners.length === 2 && owners.includes(eoa.address) && owners.includes(pkOwner), "owners onchain match");
  const again = await R.deploySafeOn(8453, spec);
  check(again.ok && again.txHash === null, "rerun is a no-op");

  // fund the Safe, propose a send, sign as the EOA, relay executes
  await test.setBalance({ address: safe, value: viem.parseEther("1") });
  const to = privateKeyToAccount(generatePrivateKey()).address;
  const nonce = await R.safeNonce(8453, safe);
  const stx = S.toSafeTx([{ to, value: viem.parseEther("0.1"), data: "0x" }], nonce);
  const hash = S.safeTxHash(8453, safe, stx);
  const msg = { target: stx.to, value: stx.value.toString(), data: stx.data, operation: stx.operation, nonce: nonce.toString(), execHash: hash };
  check(R.checkSafePropose(msg, safe, 8453).ok, "propose check accepts a correct SafeTx");
  check(R.checkSafePropose({ ...msg, execHash: "0x" + "11".repeat(32) }, safe, 8453).error === "hash_mismatch", "wrong hash refused");
  check(R.checkSafePropose({ ...msg, operation: 1 }, safe, 8453).error === "delegatecall_blocked", "delegatecall to a non-MultiSend refused");
  const batch = S.toSafeTx(
    [
      { to, value: 1n, data: "0x" },
      { to, value: 2n, data: "0x" },
    ],
    nonce,
  );
  const bmsg = { target: batch.to, value: "0", data: batch.data, operation: 1, nonce: nonce.toString(), execHash: S.safeTxHash(8453, safe, batch) };
  const bcalls = [
    { target: to, value: "1", data: "0x" },
    { target: to, value: "2", data: "0x" },
  ];
  check(R.checkSafePropose(bmsg, safe, 8453, bcalls).ok, "MultiSend batch accepted");
  check(R.checkSafePropose(bmsg, safe, 8453, [bcalls[0], { ...bcalls[1], value: "999" }]).error === "calls_mismatch", "batch with lying calls refused");

  // queue: two txs at the same nonce; executing one cancels the other
  const ws = new WalletState(join(mkdtempSync(join(tmpdir(), "safe-probe-")), "w.json"));
  const base_ = { multisigAddress: safe, chainId: 8453, from: null, fromLabel: null, source: "manual", browserId: null, deadline: "0", nonce: nonce.toString(), operation: 0 };
  const t1 = ws.proposeTx({ ...base_, target: stx.to, value: stx.value.toString(), data: stx.data, execHash: hash });
  const cancel = S.cancelTx(safe, nonce);
  const t2 = ws.proposeTx({ ...base_, target: cancel.to, value: "0", data: "0x", execHash: S.safeTxHash(8453, safe, cancel) });

  const sig = await eoa.signTypedData(S.safeTxTypedData(8453, safe, stx));
  const stranger = privateKeyToAccount(generatePrivateKey());
  const strangerSig = await stranger.signTypedData(S.safeTxTypedData(8453, safe, stx));
  const bad = await R.execSafeTx(8453, safe, stx, R.toSafeSignatures([{ signer: stranger.address, sigType: 0, data: strangerSig }]), []);
  check(!bad.ok && /GS026|revert/i.test(bad.error), `non-owner signature fails before broadcast (${bad.ok ? "" : bad.error})`);
  const res = await R.execSafeTx(8453, safe, stx, R.toSafeSignatures([{ signer: eoa.address, sigType: 0, data: sig }]), [passkey]);
  check(res.ok, `relay executes the signed tx (${res.ok ? res.txHash : res.error})`);
  check((await pub.getBalance({ address: to })) === viem.parseEther("0.1"), "recipient got 0.1 ETH");
  ws.setTxStatus(t1.id, "executed", res.ok ? res.txHash : null);
  check(ws.findTx(t2.id).status === "cancelled", "same-nonce tx marked cancelled after exec");
} finally {
  anvil.kill();
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

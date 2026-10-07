// Probe: a REAL browser passkey controls a Safe, on a Base fork.
//
// Proves packages/nextjs/utils/safe.ts against the deployed Safe 1.5.0 +
// safe-modules passkey contracts (ops/PLAN-safe.md, phase 1):
//   1. headless Chrome makes a passkey (CDP virtual authenticator — Chrome's
//      own WebAuthn code, so clientDataJSON is exactly what users produce)
//   2. predicted passkey-owner + Safe addresses match what the chain deploys
//   3. 1-of-1 passkey Safe: single call executes
//   4. 2-of-2 passkey + EOA Safe: MultiSend batch executes (mixed sig packing)
//   5. a tampered passkey signature is rejected
//   6. cancelTx burns a nonce
//
// Run: [FORK=rh] node ops/probes/safe-fork.mjs        (needs anvil + NEXT_PUBLIC_ALCHEMY_API_KEY in packages/nextjs/.env.local)

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const nextReq = createRequire(join(ROOT, "packages/nextjs/package.json"));
const viem = await import(nextReq.resolve("viem"));
const { privateKeyToAccount, generatePrivateKey } = await import(nextReq.resolve("viem/accounts"));
const chains = await import(nextReq.resolve("viem/chains"));
const base =
  process.env.FORK === "rh"
    ? viem.defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } })
    : chains.base;
const S = await import(join(ROOT, "packages/nextjs/utils/safe.ts"));

const pwPath = [ROOT, process.env.HOME + "/clawd-harness/tools", process.env.HOME + "/clawd"]
  .map(d => {
    try {
      return createRequire(join(d, "package.json")).resolve("playwright-core");
    } catch {
      return null;
    }
  })
  .find(Boolean);
const pw = await import(pwPath);
const chromium = pw.chromium ?? pw.default.chromium;

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- anvil fork of Base
const env = readFileSync(join(ROOT, "packages/nextjs/.env.local"), "utf8");
const key = env.match(/^NEXT_PUBLIC_ALCHEMY_API_KEY=["']?([^"'\n]+)/m)?.[1];
if (!key) throw new Error("no NEXT_PUBLIC_ALCHEMY_API_KEY");
const PORT = 8599;
// FORK=rh runs the same checks on Robinhood Chain 4663 (Arbitrum Orbit — the odd one out).
const FORK = process.env.FORK === "rh" ? "https://rpc.mainnet.chain.robinhood.com" : `https://base-mainnet.g.alchemy.com/v2/${key}`;
const anvil = spawn("anvil", ["--fork-url", FORK, "--port", String(PORT), "--silent"], {
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
// fresh keys every run (no keys in the repo — gitleaks), funded by anvil
const deployer = privateKeyToAccount(generatePrivateKey());
const eoaOwner = privateKeyToAccount(generatePrivateKey());
await viem.createTestClient({ chain: base, transport, mode: "anvil" }).setBalance({ address: deployer.address, value: viem.parseEther("100") });
const wallet = viem.createWalletClient({ chain: base, transport, account: deployer });
const send = async c => {
  const hash = await wallet.sendTransaction({ to: c.to, value: c.value, data: c.data });
  return pub.waitForTransactionReceipt({ hash });
};

// ---------------------------------------------------------------- browser with a passkey
const http = createServer((_, res) => res.end("<!doctype html><title>safe-fork</title>")).listen(0);
const origin = `http://localhost:${http.address().port}`;
const pwCache = process.env.HOME + "/Library/Caches/ms-playwright";
const chromiumDir = readdirSync(pwCache)
  .filter(d => /^chromium-\d+$/.test(d))
  .sort()
  .pop();
const browser = await chromium.launch({
  executablePath: `${pwCache}/${chromiumDir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
});
const page = await browser.newPage();
await page.goto(origin);
const cdp = await page.context().newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
});

const cred = await page.evaluate(async () => {
  const c = await navigator.credentials.create({
    publicKey: {
      rp: { name: "slop", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "probe", displayName: "probe" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "required", residentKey: "required" },
    },
  });
  const spki = new Uint8Array(c.response.getPublicKey());
  return { id: Array.from(new Uint8Array(c.rawId)), pub: Array.from(spki.slice(-64)) };
});
const hex = a => "0x" + Buffer.from(a).toString("hex");
const x = hex(cred.pub.slice(0, 32));
const y = hex(cred.pub.slice(32));
const pkOwner = S.passkeyOwner(x, y);

async function passkeySign(hash) {
  const a = await page.evaluate(
    async ({ id, hash }) => {
      const challenge = new Uint8Array(hash.slice(2).match(/../g).map(b => parseInt(b, 16)));
      const r = await navigator.credentials.get({
        publicKey: {
          challenge,
          rpId: location.hostname,
          userVerification: "required",
          allowCredentials: [{ type: "public-key", id: new Uint8Array(id) }],
        },
      });
      return {
        authenticatorData: Array.from(new Uint8Array(r.response.authenticatorData)),
        clientDataJSON: Array.from(new Uint8Array(r.response.clientDataJSON)),
        signature: Array.from(new Uint8Array(r.response.signature)),
      };
    },
    { id: cred.id, hash },
  );
  const { r, s } = derToRS(Uint8Array.from(a.signature));
  return S.passkeySig({
    owner: pkOwner,
    hash,
    authenticatorData: Uint8Array.from(a.authenticatorData),
    clientDataJSON: Uint8Array.from(a.clientDataJSON),
    r,
    s,
  });
}

function derToRS(der) {
  let i = 2;
  const read = () => {
    const len = der[i + 1];
    const v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    return BigInt(hex(v));
  };
  return { r: read(), s: read() };
}

async function exec(safe, tx, sigs) {
  const rc = await send({ to: safe, value: 0n, data: S.execData(tx, S.encodeSignatures(sigs)) });
  return rc.status === "success";
}

// ---------------------------------------------------------------- 1-of-1 passkey Safe
console.log("1-of-1 passkey Safe");
const recipient = "0x000000000000000000000000000000000000dEaD";
const init1 = S.initializer([pkOwner], 1);
const salt1 = S.saltNonceFromLabel("probe:" + Date.now());
const safe1 = S.safeAddress(init1, salt1);
await send(S.deployBundle([{ x, y }], init1, salt1));
check((await pub.getCode({ address: pkOwner }))?.length > 2, `passkey owner deployed at predicted ${pkOwner}`);
check((await pub.getCode({ address: safe1 }))?.length > 2, `Safe deployed at predicted ${safe1}`);
const owners1 = await pub.readContract({ address: safe1, abi: S.safeAbi, functionName: "getOwners" });
check(owners1.length === 1 && owners1[0] === pkOwner, "owner is the passkey signer");

await wallet.sendTransaction({ to: safe1, value: viem.parseEther("1") });
const before = await pub.getBalance({ address: recipient });
const tx1 = S.toSafeTx([{ to: recipient, value: viem.parseEther("0.1"), data: "0x" }], 0n);
const sig1 = await passkeySign(S.safeTxHash(base.id, safe1, tx1));
console.log("    clientDataFields:", viem.decodeAbiParameters([{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }], sig1.data)[1]);
check(await exec(safe1, tx1, [sig1]), "passkey-signed single call executes");
check((await pub.getBalance({ address: recipient })) - before === viem.parseEther("0.1"), "recipient got 0.1 ETH");

// tampered: sign nonce 1, flip a byte in the signature payload
const tx1b = S.toSafeTx([{ to: recipient, value: 1n, data: "0x" }], 1n);
const good = await passkeySign(S.safeTxHash(base.id, safe1, tx1b));
const WA = [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }];
const [ad, fields, gr, gs] = viem.decodeAbiParameters(WA, good.data);
const bad = { ...good, data: viem.encodeAbiParameters(WA, [ad, fields, gr, gs ^ 1n]) };
let rejected = false;
try {
  rejected = !(await exec(safe1, tx1b, [bad]));
} catch {
  rejected = true;
}
check(rejected, "tampered passkey signature is rejected");

// cancel: burn nonce 1 with a self-call, then the signed tx1b is dead
const cancel = S.cancelTx(safe1, 1n);
check(await exec(safe1, cancel, [await passkeySign(S.safeTxHash(base.id, safe1, cancel))]), "cancel tx executes");
check((await pub.readContract({ address: safe1, abi: S.safeAbi, functionName: "nonce" })) === 2n, "nonce advanced past the cancelled tx");

// ---------------------------------------------------------------- 2-of-2 passkey + EOA, MultiSend batch
console.log("2-of-2 passkey + EOA Safe, batch");
const init2 = S.initializer([eoaOwner.address, pkOwner], 2);
const salt2 = S.saltNonceFromLabel("probe2:" + Date.now());
const safe2 = S.safeAddress(init2, salt2);
await send(S.deployBundle([{ x, y }], init2, salt2)); // passkey owner already exists: allowFailure path
check((await pub.getCode({ address: safe2 }))?.length > 2, "second Safe deploys even though the passkey owner already exists");
await wallet.sendTransaction({ to: safe2, value: viem.parseEther("1") });
const r2 = "0x000000000000000000000000000000000000bEEF";
const b2 = await pub.getBalance({ address: r2 });
const tx2 = S.toSafeTx(
  [
    { to: r2, value: viem.parseEther("0.2"), data: "0x" },
    { to: r2, value: viem.parseEther("0.3"), data: "0x" },
  ],
  0n,
);
check(tx2.operation === 1 && S.isSafeOperation(tx2), "batch is a MultiSendCallOnly delegatecall and passes the guard");
check(!S.isSafeOperation({ to: recipient, operation: 1 }), "guard rejects delegatecall anywhere else");
const h2 = S.safeTxHash(base.id, safe2, tx2);
const eoaSig = S.ecdsaSig(eoaOwner.address, await eoaOwner.signTypedData(S.safeTxTypedData(base.id, safe2, tx2)));
check(await exec(safe2, tx2, [await passkeySign(h2), eoaSig]), "passkey + EOA signatures execute the batch");
check((await pub.getBalance({ address: r2 })) - b2 === viem.parseEther("0.5"), "recipient got both transfers");

// owner change: add an owner, then remove it (linked-list prevOwner)
const extra = privateKeyToAccount(generatePrivateKey()).address;
const tx3 = S.toSafeTx([S.addOwnerCall(safe2, extra, 2)], 1n);
const h3 = S.safeTxHash(base.id, safe2, tx3);
check(
  await exec(safe2, tx3, [await passkeySign(h3), S.ecdsaSig(eoaOwner.address, await eoaOwner.signTypedData(S.safeTxTypedData(base.id, safe2, tx3)))]),
  "add owner executes",
);
const owners2 = await pub.readContract({ address: safe2, abi: S.safeAbi, functionName: "getOwners" });
const tx4 = S.toSafeTx([S.removeOwnerCall(safe2, owners2, eoaOwner.address, 2)], 2n);
const h4 = S.safeTxHash(base.id, safe2, tx4);
check(
  await exec(safe2, tx4, [await passkeySign(h4), S.ecdsaSig(eoaOwner.address, await eoaOwner.signTypedData(S.safeTxTypedData(base.id, safe2, tx4)))]),
  "remove owner (computed prevOwner) executes",
);
const owners3 = await pub.readContract({ address: safe2, abi: S.safeAbi, functionName: "getOwners" });
check(owners3.length === 2 && !owners3.includes(eoaOwner.address), "owner list is right after add + remove");

await browser.close();
http.close();
anvil.kill();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

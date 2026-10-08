// Probe: the whole Safe Bank flow through a REAL local relay, on a Base fork,
// with a real Chrome passkey (CDP virtual authenticator) and an EOA.
//   create Safe (2-of-2 passkey + EOA) → propose a send over WS (relay fills
//   nonce + hash) → EOA signs EIP-712, passkey signs WebAuthn → relay executes →
//   add an owner → remove it → threshold change → wedgie-alone refused.
// Other chains point at a dead RPC, so only Base deploys (that's expected).
//
// Run from repo root: packages/relay/node_modules/.bin/tsx ops/probes/safe-bank-e2e.mjs

import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const relayReq = createRequire(join(ROOT, "packages/relay/package.json"));
const viem = await import(relayReq.resolve("viem"));
const { privateKeyToAccount, generatePrivateKey } = await import(relayReq.resolve("viem/accounts"));
const { base } = await import(relayReq.resolve("viem/chains"));
const { p256 } = await import(relayReq.resolve("@noble/curves/p256"));
const WebSocket = (await import(relayReq.resolve("ws"))).default;
const S = await import(join(ROOT, "packages/relay/src/safe.ts"));

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = a => "0x" + Buffer.from(a).toString("hex");

const env = readFileSync(join(ROOT, "packages/nextjs/.env.local"), "utf8");
const key = env.match(/^NEXT_PUBLIC_ALCHEMY_API_KEY=["']?([^"'\n]+)/m)?.[1];
const children = [];
const cleanup = () => children.forEach(c => c.kill());
process.on("exit", cleanup);

// ---------------------------------------------------------------- fork + relay
const ANVIL = 8596;
children.push(spawn("anvil", ["--fork-url", `https://base-mainnet.g.alchemy.com/v2/${key}`, "--port", String(ANVIL), "--silent"], { stdio: "ignore" }));
const RPC = `http://127.0.0.1:${ANVIL}`;
const transport = viem.http(RPC);
const pub = viem.createPublicClient({ chain: base, transport });
for (let i = 0; i < 60; i++) {
  try {
    await pub.getBlockNumber();
    break;
  } catch {
    await sleep(500);
  }
}
const test = viem.createTestClient({ chain: base, transport, mode: "anvil" });
const deployerKey = generatePrivateKey();
await test.setBalance({ address: privateKeyToAccount(deployerKey).address, value: viem.parseEther("10") });

const PORT = 8097;
const secret = randomBytes(32).toString("hex");
const dead = "http://127.0.0.1:9";
const relayEnv = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  SIWE_SESSION_SECRET: secret,
  ALCHEMY_API_KEY: key,
  PERSONAL_WALLET_DEPLOYER_KEY: deployerKey,
  SAFE_RPC_8453: RPC,
  SAFE_RPC_1: dead,
  SAFE_RPC_10: dead,
  SAFE_RPC_42161: dead,
  SAFE_RPC_100: dead,
  SAFE_RPC_4663: dead,
};
const relayLog = [];
const relay = spawn(join(ROOT, "packages/relay/node_modules/.bin/tsx"), [join(ROOT, "packages/relay/src/index.ts")], {
  cwd: mkdtempSync(join(tmpdir(), "safe-e2e-")),
  env: relayEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(relay);
relay.stdout.on("data", d => relayLog.push(String(d)));
relay.stderr.on("data", d => relayLog.push(String(d)));
const R = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) {
  try {
    await fetch(`${R}/health`);
    break;
  } catch {
    await sleep(500);
  }
}

// debug room cookie + anon session (as the vote probe does)
const SLUG = "debug";
const payload = Buffer.from(JSON.stringify({ slug: SLUG, iat: Date.now() })).toString("base64url");
const roomCookie = `slop_room_${SLUG}=${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
const anon = await fetch(`${R}/auth/anon`, { method: "POST", headers: { cookie: roomCookie } });
const sess = /slop_session=([^;]+)/.exec(anon.headers.get("set-cookie") ?? "")?.[1];
check(anon.ok && !!sess, "anon session in the debug room");
const cookie = `slop_session=${sess}; ${roomCookie}`;
const api = async (method, path, body) => {
  const r = await fetch(`${R}${path}${path.includes("?") ? "&" : "?"}slug=${SLUG}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// WS: watch wallet + queue
let wallet = null;
let txs = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/signal?slug=${SLUG}`, { headers: { cookie, origin: "http://localhost:3000" } });
ws.on("message", raw => {
  const m = JSON.parse(String(raw));
  if (m.type === "wallet") wallet = m.current;
  if (m.type === "hello" && m.wallet !== undefined) wallet = m.wallet;
  if (m.type === "wallet_txs") txs = m.txs;
  if (m.type === "error") console.log("    ws error:", m.error);
});
await new Promise(r => ws.on("open", r));
const wsSend = m => ws.send(JSON.stringify(m));
const until = async (fn, ms = 60_000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
};

// ---------------------------------------------------------------- passkey in Chrome
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
const http = createServer((_, res) => res.end("<!doctype html><title>e2e</title>")).listen(0);
const pwCache = process.env.HOME + "/Library/Caches/ms-playwright";
const chromiumDir = readdirSync(pwCache).filter(d => /^chromium-\d+$/.test(d)).sort().pop();
const browser = await chromium.launch({
  executablePath: `${pwCache}/${chromiumDir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
});
const page = await browser.newPage();
await page.goto(`http://localhost:${http.address().port}`);
const cdp = await page.context().newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
});
const cred = await page.evaluate(async () => {
  const c = await navigator.credentials.create({
    publicKey: {
      rp: { name: "slop", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "e2e", displayName: "e2e" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "required", residentKey: "required" },
    },
  });
  return { id: Array.from(new Uint8Array(c.rawId)), pub: Array.from(new Uint8Array(c.response.getPublicKey()).slice(-64)) };
});
const qx = hex(cred.pub.slice(0, 32));
const qy = hex(cred.pub.slice(32));
const pkOwner = S.passkeyOwner(qx, qy);
const derToRS = der => {
  let i = 2;
  const read = () => {
    const len = der[i + 1];
    const v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    return BigInt(hex(v));
  };
  return { r: read(), s: read() };
};
async function passkeySign(hash) {
  const a = await page.evaluate(
    async ({ id, hash }) => {
      const r = await navigator.credentials.get({
        publicKey: {
          challenge: new Uint8Array(hash.slice(2).match(/../g).map(b => parseInt(b, 16))),
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
  }).data;
}

const eoa = privateKeyToAccount(generatePrivateKey());
// sign every pending Base tx with both owners, then have the relay execute it
async function signAndExec(tx) {
  const safe = wallet.address;
  const st = { to: tx.target, value: BigInt(tx.value), data: tx.data, operation: tx.operation, nonce: BigInt(tx.nonce) };
  check(S.safeTxHash(8453, safe, st).toLowerCase() === tx.execHash, `queued tx hash is the real safeTxHash (nonce ${tx.nonce})`);
  wsSend({ type: "wallet_tx_sign", id: tx.id, signer: eoa.address.toLowerCase(), sigType: 0, data: await eoa.signTypedData(S.safeTxTypedData(8453, safe, st)) });
  wsSend({ type: "wallet_tx_sign", id: tx.id, signer: pkOwner.toLowerCase(), sigType: 1, data: await passkeySign(tx.execHash) });
  await until(() => txs.find(t => t.id === tx.id)?.signatures.length === 2);
  const r = await api("POST", "/v1/safe/exec", { txId: tx.id });
  check(r.status === 200 && !!r.json.txHash, `relay executes (${r.json.txHash ?? r.json.error})`);
  return r;
}

try {
  // ---------------------------------------------------------------- create
  const d = await api("POST", "/v1/safe/deploy", {
    owners: [
      { qx, qy, label: "passkey" },
      { address: eoa.address, label: "eoa" },
    ],
    threshold: 2,
    label: "e2e",
  });
  check(d.status === 200, `create Safe (${d.json.address ?? d.json.error})`);
  await until(() => wallet?.deployments?.[8453]);
  check(!!wallet?.deployments?.[8453], "Base deployment recorded");
  check(wallet.kind === "safe" && wallet.signers.some(s => s.passkeyAddr), "record is a Safe with a passkey owner mapped to its peer");
  check((await pub.getCode({ address: wallet.address }))?.length > 2, "Safe has code on Base");
  const st = await api("GET", "/v1/safe/status");
  check(st.json.chains?.[1]?.state === "failed", "mainnet (dead RPC here) shows failed, not stuck");
  const dup = await api("POST", "/v1/safe/deploy", { owners: [{ address: eoa.address }], threshold: 1 });
  check(dup.status === 409, "second create refused while a Safe exists");

  // ---------------------------------------------------------------- send
  await test.setBalance({ address: wallet.address, value: viem.parseEther("1") });
  const to = privateKeyToAccount(generatePrivateKey()).address;
  wsSend({ type: "wallet_tx_propose", chainId: 8453, target: to, value: viem.parseEther("0.01").toString(), data: "0x", deadline: "0", nonce: "0", execHash: "0x", source: "manual" });
  const sendTx = await until(() => txs.find(t => t.target === to.toLowerCase() && t.status === "pending"));
  check(!!sendTx && sendTx.operation === 0, "plain proposal queued as a Safe tx");
  await signAndExec(sendTx);
  check((await pub.getBalance({ address: to })) === viem.parseEther("0.01"), "recipient got 0.01 ETH");
  check(txs.find(t => t.id === sendTx.id)?.status === "executed", "queue shows executed");

  // forged / foreign delegatecall rejected at propose
  const errs = [];
  ws.on("message", raw => {
    const m = JSON.parse(String(raw));
    if (m.type === "error") errs.push(m.error);
  });
  wsSend({ type: "wallet_tx_propose", chainId: 8453, target: to, value: "0", data: "0x", deadline: "0", nonce: "1", execHash: "0x" + "11".repeat(32), operation: 1, source: "manual" });
  await until(() => errs.length);
  check(errs.includes("delegatecall_blocked"), "delegatecall to a random address refused");

  // ---------------------------------------------------------------- owners
  const third = privateKeyToAccount(generatePrivateKey());
  const add = await api("POST", "/v1/safe/owners", { action: "add", owner: { address: third.address, label: "third" }, threshold: 2 });
  check(add.status === 200 && add.json.results?.find(r => r.chainId === 8453)?.txId, `add owner queued on Base (${JSON.stringify(add.json.results ?? add.json)})`);
  const addTx = txs.find(t => t.id === add.json.results.find(r => r.chainId === 8453).txId);
  await signAndExec(addTx);
  await until(() => wallet.signers.length === 3);
  check(wallet.signers.length === 3 && wallet.signers.some(s => s.label === "third"), "record picked up the new owner with its label");

  const wk = p256.getPublicKey(p256.utils.randomPrivateKey(), false);
  const wedgie = { qx: hex(wk.slice(1, 33)), qy: hex(wk.slice(33)), device: "wedgie" };
  const alone = await api("POST", "/v1/safe/owners", { action: "add", owner: wedgie, threshold: 1 });
  check(alone.status === 400 && /wedgie-alone/.test(alone.json.error), "wedgie with threshold 1 refused");
  const wOk = await api("POST", "/v1/safe/owners", { action: "add", owner: wedgie, threshold: 2 });
  check(wOk.status === 200, "wedgie owner at threshold 2 queued");
  const wTx = txs.find(t => t.id === wOk.json.results.find(r => r.chainId === 8453).txId);
  check((await pub.getCode({ address: S.passkeyOwner(wedgie.qx, wedgie.qy) }))?.length > 2, "wedgie signer contract created on Base");
  await signAndExec(wTx);
  await until(() => wallet.signers.some(s => s.device === "wedgie"));
  check(wallet.signers.some(s => s.device === "wedgie"), "record marks the wedgie owner");

  const rm = await api("POST", "/v1/safe/owners", { action: "remove", owner: { address: third.address }, threshold: 2 });
  const rmTx = txs.find(t => t.id === rm.json.results?.find(r => r.chainId === 8453)?.txId);
  check(!!rmTx, "remove owner queued");
  if (rmTx) await signAndExec(rmTx);
  await until(() => !wallet.signers.some(s => s.label === "third"));
  const owners = await pub.readContract({ address: wallet.address, abi: S.safeAbi, functionName: "getOwners" });
  check(owners.length === 3 && !owners.map(o => o.toLowerCase()).includes(third.address.toLowerCase()), "on-chain owners: passkey + eoa + wedgie");

  // cancel: propose two txs at the next nonce; executing the cancel kills the other
  wsSend({ type: "wallet_tx_propose", chainId: 8453, target: to, value: "1", data: "0x", deadline: "0", nonce: "0", execHash: "0x", source: "manual" });
  const victim = await until(() => txs.find(t => t.target === to.toLowerCase() && t.value === "1" && t.status === "pending"));
  const c = S.cancelTx(wallet.address, BigInt(victim.nonce));
  wsSend({ type: "wallet_tx_propose", chainId: 8453, target: c.to, value: "0", data: "0x", deadline: "0", nonce: victim.nonce, execHash: S.safeTxHash(8453, wallet.address, c), operation: 0, source: "manual" });
  const cancel = await until(() => txs.find(t => t.target === wallet.address.toLowerCase() && t.data === "0x" && t.status === "pending"));
  check(!!cancel && cancel.nonce === victim.nonce, "cancel queued at the same nonce");
  await signAndExec(cancel);
  await until(() => txs.find(t => t.id === victim.id)?.status === "cancelled");
  check(txs.find(t => t.id === victim.id)?.status === "cancelled", "the cancelled tx is marked dead");
} catch (e) {
  console.log("  FAIL  threw:", e?.message ?? e);
  failures++;
} finally {
  await browser.close();
  http.close();
  ws.close();
  cleanup();
}
if (failures) console.log(relayLog.join("").split("\n").filter(l => /safe|error/i.test(l)).slice(-20).join("\n"));
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

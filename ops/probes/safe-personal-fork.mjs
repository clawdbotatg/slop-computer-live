// Probe: personal passkey wallets as Safes (ops/PLAN-safe.md phase 5), through a
// REAL local relay on a Base fork, with a real Chrome passkey (CDP virtual
// authenticator) that signs in to the relay exactly like the site does.
//   predicted address (offline) == relay's → relay deploys it → passkey-signed
//   send + MultiSend batch via /personal-wallet/exec → spend cap (single and
//   batch) → someone else's passkey refused → per-wallet queue: propose over
//   WS (relay fills nonce + hash) → sign → execute.
//
// Run from repo root: packages/relay/node_modules/.bin/tsx ops/probes/safe-personal-fork.mjs

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
const N = p256.CURVE.n; // the relay's sign-in wants low-s

const env = readFileSync(join(ROOT, "packages/nextjs/.env.local"), "utf8");
const key = env.match(/^NEXT_PUBLIC_ALCHEMY_API_KEY=["']?([^"'\n]+)/m)?.[1];
if (!key) throw new Error("no NEXT_PUBLIC_ALCHEMY_API_KEY");
const children = [];
const cleanup = () => children.forEach(c => c.kill());
process.on("exit", cleanup);

// ---------------------------------------------------------------- fork + relay
const ANVIL = 8594;
children.push(
  spawn("anvil", ["--fork-url", `https://base-mainnet.g.alchemy.com/v2/${key}`, "--port", String(ANVIL), "--silent"], {
    stdio: "ignore",
  }),
);
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

const PORT = 8096;
const secret = randomBytes(32).toString("hex");
const CAP = viem.parseEther("0.05");
const relay = spawn(join(ROOT, "packages/relay/node_modules/.bin/tsx"), [join(ROOT, "packages/relay/src/index.ts")], {
  cwd: mkdtempSync(join(tmpdir(), "safe-personal-")),
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    SIWE_SESSION_SECRET: secret,
    ALCHEMY_API_KEY: key,
    PERSONAL_WALLET_DEPLOYER_KEY: deployerKey,
    PERSONAL_WALLET_MAX_SPEND_WEI: CAP.toString(),
    SAFE_RPC_8453: RPC,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(relay);
const relayLog = [];
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

// ---------------------------------------------------------------- Chrome passkey
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
const http = createServer((_, res) => res.end("<!doctype html><title>personal</title>")).listen(0);
const pwCache = process.env.HOME + "/Library/Caches/ms-playwright";
const chromiumDir = readdirSync(pwCache)
  .filter(d => /^chromium-\d+$/.test(d))
  .sort()
  .pop();
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
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "p", displayName: "p" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "required", residentKey: "required" },
    },
  });
  return { id: Array.from(new Uint8Array(c.rawId)), pub: Array.from(new Uint8Array(c.response.getPublicKey()).slice(-64)) };
});
const qx = hex(cred.pub.slice(0, 32));
const qy = hex(cred.pub.slice(32));
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
async function assertion(challengeHex) {
  const a = await page.evaluate(
    async ({ id, challengeHex }) => {
      const r = await navigator.credentials.get({
        publicKey: {
          challenge: new Uint8Array(challengeHex.replace(/^0x/, "").match(/../g).map(b => parseInt(b, 16))),
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
    { id: cred.id, challengeHex },
  );
  return { ...a, ...derToRS(Uint8Array.from(a.signature)) };
}

// sign in to the relay with the passkey, the same way utils/passkey.ts does
const SLUG = "debug";
const payload = Buffer.from(JSON.stringify({ slug: SLUG, iat: Date.now() })).toString("base64url");
const roomCookie = `slop_room_${SLUG}=${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
const { nonce } = await (await fetch(`${R}/auth/siwe/nonce`)).json();
const a0 = await assertion(nonce);
const pad32 = v => v.toString(16).padStart(64, "0");
const auth = await fetch(`${R}/auth/passkey`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: roomCookie },
  body: JSON.stringify({
    qx: qx.slice(2),
    qy: qy.slice(2),
    r: pad32(a0.r),
    s: pad32(a0.s > N / 2n ? N - a0.s : a0.s),
    authenticatorData: hex(a0.authenticatorData).slice(2),
    clientDataJSON: hex(a0.clientDataJSON).slice(2),
    nonce,
  }),
});
const authJ = await auth.json();
const sess = /slop_session=([^;]+)/.exec(auth.headers.get("set-cookie") ?? "")?.[1];
check(auth.ok && !!sess, `passkey sign-in to the relay (${authJ.address ?? authJ.error})`);
const cookie = `slop_session=${sess}; ${roomCookie}`;
const api = async (method, path, body) => {
  const r = await fetch(`${R}${path}${path.includes("?") ? "&" : "?"}slug=${SLUG}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

async function passkeySig(owner, hash) {
  const a = await assertion(hash);
  return S.passkeySig({
    owner,
    hash,
    authenticatorData: Uint8Array.from(a.authenticatorData),
    clientDataJSON: Uint8Array.from(a.clientDataJSON),
    r: a.r,
    s: a.s,
  }).data;
}

try {
  // ---------------------------------------------------------------- address
  const cfg = await api("GET", "/personal-wallet/config");
  const cosigner = cfg.json.cosigner;
  check(cosigner?.toLowerCase() === privateKeyToAccount(deployerKey).address.toLowerCase(), "cosigner defaults to the deployer");
  const p = S.personalSafe(qx, qy, cosigner);
  check(p.owners.length === 2 && p.owners.includes(p.owner), "owners = [passkey signer, cosigner]");
  await test.setBalance({ address: p.address, value: viem.parseEther("1") }); // funded before deploy

  // ---------------------------------------------------------------- deploy
  const d = await api("POST", "/personal-wallet/deploy", { qx, qy });
  check(d.status === 200 && d.json.address === p.address, `relay deploys the predicted address (${d.json.address ?? d.json.error})`);
  check((await pub.getCode({ address: p.address }))?.length > 2, "Safe has code");
  check((await pub.getCode({ address: p.owner }))?.length > 2, "passkey signer contract exists");
  const owners = await pub.readContract({ address: p.address, abi: S.safeAbi, functionName: "getOwners" });
  const thr = await pub.readContract({ address: p.address, abi: S.safeAbi, functionName: "getThreshold" });
  check(owners.length === 2 && thr === 1n, "on-chain: 2 owners, threshold 1");
  const d2 = await api("POST", "/personal-wallet/deploy", { qx, qy });
  check(d2.status === 200 && d2.json.alreadyDeployed === true, "second deploy is a no-op");

  // ---------------------------------------------------------------- send
  const to = privateKeyToAccount(generatePrivateKey()).address;
  const exec = async calls => {
    const nonce = await pub.readContract({ address: p.address, abi: S.safeAbi, functionName: "nonce" });
    const tx = S.toSafeTx(calls, nonce);
    const sig = await passkeySig(p.owner, S.safeTxHash(8453, p.address, tx));
    return api("POST", "/personal-wallet/exec", {
      qx,
      qy,
      tx: { to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation, nonce: tx.nonce.toString() },
      signatures: [{ sigType: 1, signer: p.owner, data: sig }],
    });
  };
  const waitTx = async h => (await pub.waitForTransactionReceipt({ hash: h })).status === "success";
  const e1 = await exec([{ to, value: viem.parseEther("0.01"), data: "0x" }]);
  check(e1.status === 200 && (await waitTx(e1.json.txHash)), `passkey-signed send executes (${e1.json.txHash ?? e1.json.error})`);
  check((await pub.getBalance({ address: to })) === viem.parseEther("0.01"), "recipient got 0.01 ETH");

  const e2 = await exec([
    { to, value: viem.parseEther("0.001"), data: "0x" },
    { to, value: viem.parseEther("0.002"), data: "0x" },
  ]);
  check(e2.status === 200 && (await waitTx(e2.json.txHash)), "MultiSend batch executes");
  check((await pub.getBalance({ address: to })) === viem.parseEther("0.013"), "batch delivered both calls");

  // ---------------------------------------------------------------- guards
  const big = await exec([{ to, value: CAP + 1n, data: "0x" }]);
  check(big.status === 400 && big.json.error === "value-exceeds-cap", "single send over the cap refused");
  const bigBatch = await exec([
    { to, value: CAP / 2n + 1n, data: "0x" },
    { to, value: CAP / 2n + 1n, data: "0x" },
  ]);
  check(bigBatch.status === 400 && bigBatch.json.error === "value-exceeds-cap", "batch summing over the cap refused");
  const other = p256.getPublicKey(p256.utils.randomPrivateKey(), false);
  const theirs = await api("POST", "/personal-wallet/exec", {
    qx: hex(other.slice(1, 33)),
    qy: hex(other.slice(33)),
    tx: { to, value: "1", data: "0x", operation: 0, nonce: "0" },
    signatures: [{ sigType: 1, signer: p.owner, data: "0x00" }],
  });
  check(theirs.status === 403 && theirs.json.error === "passkey-mismatch", "someone else's passkey refused");
  const nonceNow = await pub.readContract({ address: p.address, abi: S.safeAbi, functionName: "nonce" });
  const forged = S.toSafeTx([{ to, value: 1n, data: "0x" }], nonceNow);
  const wrongSig = await passkeySig(p.owner, S.safeTxHash(8453, p.address, { ...forged, value: 2n }));
  const bad = await api("POST", "/personal-wallet/exec", {
    qx,
    qy,
    tx: { to, value: "1", data: "0x", operation: 0, nonce: nonceNow.toString() },
    signatures: [{ sigType: 1, signer: p.owner, data: wrongSig }],
  });
  check(bad.status === 400, `signature over a different tx fails before broadcast (${bad.json.error})`);

  // ---------------------------------------------------------------- per-wallet queue
  let txs = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/signal?slug=${SLUG}`, {
    headers: { cookie, origin: "http://localhost:3000" },
  });
  const errs = [];
  ws.on("message", raw => {
    const m = JSON.parse(String(raw));
    if (m.type === "wallet_txs" && m.address === p.address.toLowerCase()) txs = m.txs;
    if (m.type === "error") errs.push(m.error);
  });
  await new Promise(r => ws.on("open", r));
  const send = m => ws.send(JSON.stringify(m));
  const until = async (fn, ms = 30_000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    return null;
  };
  send({
    type: "wallet_tx_propose",
    address: p.address,
    chainId: 8453,
    target: to,
    value: viem.parseEther("0.004").toString(),
    data: "0x",
    deadline: "0",
    nonce: "0",
    execHash: "0x",
    source: "manual",
  });
  const q = await until(() => txs.find(t => t.status === "pending"));
  check(!!q && q.operation === 0, `personal queue: relay filled a Safe tx (${errs.join(",")})`);
  const qtx = { to: q.target, value: BigInt(q.value), data: q.data, operation: q.operation, nonce: BigInt(q.nonce) };
  check(S.safeTxHash(8453, p.address, qtx).toLowerCase() === q.execHash, "queued hash is the real safeTxHash");
  const qsig = await passkeySig(p.owner, q.execHash);
  send({ type: "wallet_tx_sign", address: p.address, id: q.id, signer: p.owner.toLowerCase(), sigType: 1, data: qsig });
  await until(() => txs.find(t => t.id === q.id)?.signatures.length === 1);
  const qe = await api("POST", "/personal-wallet/exec", {
    qx,
    qy,
    tx: { to: q.target, value: q.value, data: q.data, operation: q.operation, nonce: q.nonce },
    signatures: txs.find(t => t.id === q.id).signatures,
  });
  check(qe.status === 200 && (await waitTx(qe.json.txHash)), "queued + signed tx executes via the relay");
  check((await pub.getBalance({ address: to })) === viem.parseEther("0.017"), "recipient got the queued 0.004");
  send({
    type: "wallet_tx_propose",
    address: p.address,
    chainId: 8453,
    target: to,
    value: "0",
    data: "0x",
    deadline: "0",
    nonce: "0",
    execHash: "0x" + "22".repeat(32),
    operation: 0,
    source: "manual",
  });
  await until(() => errs.includes("hash_mismatch"));
  check(errs.includes("hash_mismatch"), "personal queue refuses a SafeTx with a wrong hash");
  ws.close();
} catch (e) {
  console.log("  FAIL  threw:", e?.stack ?? e);
  failures++;
} finally {
  await browser.close();
  http.close();
  cleanup();
}
if (failures)
  console.log(
    relayLog
      .join("")
      .split("\n")
      .filter(l => /error|warn|safe/i.test(l))
      .slice(-15)
      .join("\n"),
  );
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

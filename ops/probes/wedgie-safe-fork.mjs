// Probe: a wedgie running the real Safe Signer app signs for a room Safe, on a Base fork.
//
// slop's own client (packages/nextjs/utils/wedgie.ts) talks over a fake navigator.serial to
// ops/probes/wedgie-emu.py, which runs the current clawdbotatg/wedgie-safe app (the screen
// reading, the hash, the WebAuthn envelope) with a software key. The Safe is built the way
// the Bank builds one (utils/safe.ts: the wedgie owner is passkeyOwner(x, y)):
//   owners [eoa1, eoa2, wedgie], threshold 2 (the wedgie rule)
//   1. a send signed by eoa1 + the wedgie executes
//   2. a MultiSend batch over one USB line goes in pieces and executes
//   3. red on the wedgie = "Refused on the wedgie."
//
// Run from repo root (needs anvil, python3 + cryptography, NEXT_PUBLIC_ALCHEMY_API_KEY in packages/nextjs/.env.local):
//   packages/relay/node_modules/.bin/tsx --tsconfig packages/nextjs/tsconfig.json ops/probes/wedgie-safe-fork.mjs [<wedgie-safe checkout>]

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const APP = process.argv[2] || join(homedir(), "clawd/wedgie-safe");
const nextReq = createRequire(join(ROOT, "packages/nextjs/package.json"));
const viem = await import(nextReq.resolve("viem"));
const { privateKeyToAccount, generatePrivateKey } = await import(nextReq.resolve("viem/accounts"));
const { base } = await import(nextReq.resolve("viem/chains"));
const S = await import(join(ROOT, "packages/nextjs/utils/safe.ts"));

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const children = [];
process.on("exit", () => children.forEach(c => c.kill()));

// ---------------------------------------------------------------- the wedgie on a fake serial port
globalThis.window = globalThis;
let port = null;
const EMU_KEY = generatePrivateKey().slice(2); // one wedgie for the whole run
let pages = [];
function plug(press = "yes") {
  const emu = spawn("python3", [join(ROOT, "ops/probes/wedgie-emu.py"), APP, press], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WEDGIE_EMU_KEY: EMU_KEY },
  });
  children.push(emu);
  emu.stderr.on("data", d => {
    for (const l of String(d).split("\n")) if (l.startsWith("pages: ")) pages.push(JSON.parse(l.slice(7)));
    if (/Traceback|Error/.test(String(d)) && !String(d).startsWith("pages: ")) console.log("    emu:", String(d).trim());
  });
  port = {
    getInfo: () => ({ usbVendorId: 0x2e8a }),
    open: async () => {},
    close: async () => {},
    writable: new WritableStream({ write: c => void emu.stdin.write(Buffer.from(c)) }),
    readable: new ReadableStream({
      start(ctl) {
        let open = true;
        emu.stdout.on("data", d => open && ctl.enqueue(new Uint8Array(d)));
        emu.stdout.on("end", () => open && ((open = false), ctl.close()));
        this.stop = () => (open = false);
      },
      cancel() {
        this.stop();
      },
    }),
  };
  return emu;
}
Object.defineProperty(globalThis.navigator, "serial", {
  value: { getPorts: async () => (port ? [port] : []), requestPort: async () => port },
});
const { withWedgie } = await import(join(ROOT, "packages/nextjs/utils/wedgie.ts"));

// ---------------------------------------------------------------- fork
const env = readFileSync(join(ROOT, "packages/nextjs/.env.local"), "utf8");
const key = env.match(/^NEXT_PUBLIC_ALCHEMY_API_KEY=["']?([^"'\n]+)/m)?.[1];
if (!key) throw new Error("no NEXT_PUBLIC_ALCHEMY_API_KEY");
const PORT = 8597;
children.push(spawn("anvil", ["--fork-url", `https://base-mainnet.g.alchemy.com/v2/${key}`, "--port", String(PORT), "--silent"], { stdio: "ignore" }));
const transport = viem.http(`http://127.0.0.1:${PORT}`);
const pub = viem.createPublicClient({ chain: base, transport });
for (let i = 0; i < 60; i++) {
  try {
    await pub.getBlockNumber();
    break;
  } catch {
    await new Promise(r => setTimeout(r, 500));
  }
}
const deployer = privateKeyToAccount(generatePrivateKey());
const eoa1 = privateKeyToAccount(generatePrivateKey());
const eoa2 = privateKeyToAccount(generatePrivateKey());
await viem.createTestClient({ chain: base, transport, mode: "anvil" }).setBalance({ address: deployer.address, value: viem.parseEther("100") });
const wallet = viem.createWalletClient({ chain: base, transport, account: deployer });
const send = async c => pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: c.to, value: c.value ?? 0n, data: c.data }) });

try {
  // ---------------------------------------------------------------- the Bank's Safe with the wedgie in it
  let emu = plug();
  const k = await withWedgie(w => w.key());
  const wOwner = S.passkeyOwner(k.x, k.y);
  check(/^0x[0-9a-f]{64}$/.test(k.x), `wedgie key read over serial (owner ${wOwner})`);
  emu.kill();

  const init = S.initializer([eoa1.address, eoa2.address, wOwner], 2);
  const salt = S.saltNonceFromLabel("wedgie-probe:" + Date.now());
  const safe = S.safeAddress(init, salt);
  await send(S.deployBundle([{ x: k.x, y: k.y }], init, salt));
  const owners = await pub.readContract({ address: safe, abi: S.safeAbi, functionName: "getOwners" });
  check(owners.includes(wOwner), "Safe deployed with the wedgie's signer contract as an owner");
  await wallet.sendTransaction({ to: safe, value: viem.parseEther("1") });

  const signBoth = async (tx, press = "yes") => {
    const h = S.safeTxHash(base.id, safe, tx);
    pages = [];
    const e = plug(press);
    try {
      const data = await withWedgie(w => w.sign(base.id, safe, tx, h));
      const eSig = S.ecdsaSig(eoa1.address, await eoa1.signTypedData(S.safeTxTypedData(base.id, safe, tx)));
      return [eSig, { signer: wOwner, data, kind: "contract" }];
    } finally {
      e.kill();
    }
  };
  const exec = async (tx, sigs) => (await send({ to: safe, data: S.execData(tx, S.encodeSignatures(sigs)) })).status === "success";

  // 1. a plain send
  const to = "0x000000000000000000000000000000000000dEaD";
  const before = await pub.getBalance({ address: to });
  const tx1 = S.toSafeTx([{ to, value: viem.parseEther("0.1"), data: "0x" }], 0n);
  check(await exec(tx1, await signBoth(tx1)), "send signed by eoa + wedgie executes");
  check((await pub.getBalance({ address: to })) - before === viem.parseEther("0.1"), "recipient got 0.1 ETH");
  console.log("    wedgie showed:", JSON.stringify(pages[0]));

  // 2. a batch too big for one USB line
  const calls = Array.from({ length: 40 }, (_, i) => ({ to: viem.getAddress(viem.pad(viem.toHex(0x1000 + i), { size: 20 })), value: 1n, data: "0x" }));
  const tx2 = S.toSafeTx(calls, 1n);
  check(tx2.data.length > 6000, `batch data is ${(tx2.data.length - 2) / 2} bytes (over one line)`);
  check(await exec(tx2, await signBoth(tx2)), "40-call batch, sent in pieces, executes");
  check((await pub.getBalance({ address: calls[39].to })) === 1n, "last call in the batch landed");
  console.log(`    wedgie showed ${pages[0]?.length} pages, first: ${JSON.stringify(pages[0]?.[0])}`);

  // 3. red on the wedgie
  const tx3 = S.toSafeTx([{ to, value: 1n, data: "0x" }], 2n);
  let msg = "";
  try {
    await signBoth(tx3, "no");
  } catch (e) {
    msg = e.message;
  }
  check(msg === "Refused on the wedgie.", `red press refuses (${msg})`);
} catch (e) {
  console.log("  FAIL  threw:", e?.message ?? e);
  failures++;
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

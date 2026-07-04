import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  http,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { config } from "./config.js";
import type { VotingBooth, VotePoll } from "./voting.js";

// Sepolia E3 coordinator for the Voting Booth. Runs one real Interfold
// round per poll: request an E3 on-chain (fee in testnet USDC), wait for
// the PUBLIC ciphernode committee to run sortition + distributed DKG,
// open voting under the committee's key, publish each browser-encrypted
// ballot on-chain (facilitator pays gas), homomorphically sum the
// ballots in-process via the same fhe.rs wasm the browsers use, publish
// the encrypted tally, and wait for the committee to threshold-decrypt
// it. The relay never holds key material — it cannot read a ballot or
// the tally; only the committee can, and only in aggregate.
//
// Battle-tested against Sepolia E3s #20-26 (see
// github.com/clawdbotatg/private-voting): all the operational quirks —
// e3Id lives in the event DATA, the full key rides the registry log,
// input windows need a lead, InputDeadlineNotReached surfaces as a raw
// selector, public RPCs lie about logs — are handled below.
//
// Enabled when VOTING_E3_CHAIN=sepolia and the facilitator key exists.

const INTERFOLD = (process.env.VOTING_E3_INTERFOLD ?? "0x64Cd2d88537A18D8E599d786447F9a07Dd9C7f26") as Hex;
const REGISTRY = (process.env.VOTING_E3_REGISTRY ?? "0xDDd7e1eA2AD8195217D9B25B13fac667b6Fc4dD9") as Hex;
const FEE_TOKEN = (process.env.VOTING_E3_FEE_TOKEN ?? "0x08260aE8970E3555E48caA547988bAD397786E6D") as Hex;
const E3_PROGRAM = (process.env.VOTING_E3_PROGRAM ?? "0x095C187a5bAC36e1857ad2e3c1F5414c3C738511") as Hex;
const TX_RPC = process.env.VOTING_E3_TX_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
// getLogs-honest RPC — publicnode silently filters log queries.
const LOG_RPC = process.env.VOTING_E3_LOG_RPC ?? "https://sepolia.drpc.org";
const WINDOW_SECS = Number(process.env.VOTING_E3_WINDOW_SECS ?? 300);
const WINDOW_LEAD_SECS = 120;

const E3_REQUESTED_TOPIC = "0x5090c9764b5cd13df7afc0013f733dfbe6eaf1b6ddc22a5e291fa387efd4c15e";
const COMMITTEE_PUBLISHED_TOPIC = "0xbf0636a312095f6c09c909823813b50e392323588d2d83432e7512c64041e67f";
const INPUT_DEADLINE_SELECTOR = "0xbf1af280";
// Dev-mode compute "proof" (digits of pi) — accepted by our program's
// MockRISC0Verifier. Real proofs come with the Boundless integration.
const DEV_PROOF = "0x0301040105090206050305" as Hex;

const interfoldAbi = parseAbi([
  "struct E3RequestParams { uint8 committeeSize; uint256[2] inputWindow; address e3Program; uint8 paramSet; bytes computeProviderParams; bytes customParams; bool proofAggregationEnabled; }",
  "function request(E3RequestParams params) returns (uint256)",
  "function getE3Stage(uint256 e3Id) view returns (uint8)",
  "function publishCiphertextOutput(uint256 e3Id, bytes ciphertextOutput, bytes proof) returns (bool)",
  "event PlaintextOutputPublished(uint256 indexed e3Id, bytes plaintextOutput, bytes proof)",
]);
const erc20Abi = parseAbi([
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
const programAbi = parseAbi(["function publishInput(uint256 e3Id, bytes data)"]);

export function votingE3Enabled(): boolean {
  return process.env.VOTING_E3_CHAIN === "sepolia" && Boolean(config.personalWalletDeployerKey);
}

export function votingE3Info(): { chain: string; interfold: string; program: string } {
  return { chain: "sepolia", interfold: INTERFOLD, program: E3_PROGRAM };
}

export function e3ExplorerTx(txHash: string): string {
  return `https://sepolia.etherscan.io/tx/${txHash}`;
}

// --- wasm (shared with the browsers: packages/nextjs/public/fhe-wasm) ------

type FheModule = {
  load_params_named: (name: string) => unknown;
  homomorphic_add: (params: unknown, a: Uint8Array, b: Uint8Array) => Uint8Array;
};
let fhePromise: Promise<{ fhe: FheModule; params: unknown }> | null = null;

function loadFhe(): Promise<{ fhe: FheModule; params: unknown }> {
  if (!fhePromise) {
    fhePromise = (async () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const pkgDir = process.env.FHE_WASM_DIR ?? join(here, "..", "..", "nextjs", "public", "fhe-wasm");
      const mod = await import(pathToFileURL(join(pkgDir, "fhe_wasm.js")).href);
      await mod.default(readFileSync(join(pkgDir, "fhe_wasm_bg.wasm")));
      const params = mod.load_params_named("INSECURE_THRESHOLD_512");
      return { fhe: mod as FheModule, params };
    })();
  }
  return fhePromise;
}

// --- per-room coordinator ----------------------------------------------------

export class VoteE3Coordinator {
  private account = privateKeyToAccount(config.personalWalletDeployerKey as Hex);
  private pub = createPublicClient({ chain: sepolia, transport: http(TX_RPC) });
  private logs = createPublicClient({ chain: sepolia, transport: http(LOG_RPC) });
  private wallet = createWalletClient({ account: this.account, chain: sepolia, transport: http(TX_RPC) });
  /** Serializes every facilitator tx — one nonce lane, no races. */
  private txQueue: Promise<unknown> = Promise.resolve();
  /** Ballot ciphertexts per poll, in publish order (for the tally sum). */
  private ballots = new Map<string, Uint8Array[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private booth: VotingBooth) {}

  private enqueueTx<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.txQueue.then(fn, fn);
    this.txQueue = next.catch(() => undefined);
    return next;
  }

  private note(pollId: string, patch: Parameters<VotingBooth["patchE3"]>[1], text: string, txHash?: string): void {
    this.booth.patchE3(pollId, patch, { text, txHash });
  }

  /** Kick off the full E3 lifecycle for a freshly created poll. */
  start(poll: VotePoll): void {
    this.run(poll.id).catch(err => {
      const message = err instanceof Error ? err.message : String(err);
      this.note(poll.id, { stage: "failed", error: message.slice(0, 300) }, `❌ E3 failed: ${message.slice(0, 160)}`);
    });
  }

  private async run(pollId: string): Promise<void> {
    // 1. Fee allowance (testnet USDC from the Interfold faucet).
    const allowance = (await this.pub.readContract({
      address: FEE_TOKEN,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, INTERFOLD],
    })) as bigint;
    if (allowance < 20_000_000n) {
      this.note(pollId, {}, "💸 approving fee token (testnet USDC) for the Interfold…");
      const hash = await this.enqueueTx(() =>
        this.wallet.writeContract({
          address: FEE_TOKEN,
          abi: erc20Abi,
          functionName: "approve",
          args: [INTERFOLD, 100_000_000n],
          account: this.account,
          chain: sepolia,
        }),
      );
      await this.pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
      this.note(pollId, {}, "💸 fee token approved", hash);
    }

    // 2. Request the E3. Window computed at send time with a lead so it
    // can't go stale while the tx mines (InvalidInputDeadlineStart).
    const nowChain = (await this.pub.getBlock()).timestamp;
    const windowStart = nowChain + BigInt(WINDOW_LEAD_SECS);
    const windowEnd = windowStart + BigInt(WINDOW_SECS);
    this.note(
      pollId,
      { windowStart: Number(windowStart), windowEnd: Number(windowEnd) },
      "📡 requesting an Encrypted Execution Environment on Sepolia…",
    );
    const reqHash = await this.enqueueTx(() =>
      this.wallet.writeContract({
        address: INTERFOLD,
        abi: interfoldAbi,
        functionName: "request",
        args: [
          {
            committeeSize: 0, // CommitteeSize.Minimum → 3 nodes
            inputWindow: [windowStart, windowEnd],
            e3Program: E3_PROGRAM,
            paramSet: 0, // INSECURE_THRESHOLD_512
            computeProviderParams: toHex(new Uint8Array(32)),
            customParams: "0x",
            proofAggregationEnabled: false,
          },
        ],
        account: this.account,
        chain: sepolia,
      }),
    );
    const receipt = await this.pub.waitForTransactionReceipt({ hash: reqHash, timeout: 300_000 });
    const reqLog = receipt.logs.find(
      l => l.address.toLowerCase() === INTERFOLD.toLowerCase() && l.topics[0] === E3_REQUESTED_TOPIC,
    );
    if (!reqLog) throw new Error("no E3Requested log on request receipt");
    const e3Id = BigInt(reqLog.data.slice(0, 66));
    this.note(
      pollId,
      { stage: "sortition", e3Id: e3Id.toString(), requestTx: reqHash },
      `🎲 E3 #${e3Id} requested — public ciphernodes are rolling sortition tickets…`,
      reqHash,
    );

    // 3. Wait for the public committee: stage 1=Requested (sortition),
    // 2=CommitteeFinalized (DKG running), 3=KeyPublished.
    let sawDkg = false;
    for (;;) {
      const stage = (await this.pub.readContract({
        address: INTERFOLD,
        abi: interfoldAbi,
        functionName: "getE3Stage",
        args: [e3Id],
      })) as number;
      if (stage === 6) throw new Error("E3 failed on-chain during committee formation");
      if (stage >= 3) break;
      if (stage === 2 && !sawDkg) {
        sawDkg = true;
        this.note(pollId, { stage: "dkg" }, "🔑 committee finalized — nodes are running distributed key generation…");
      }
      await sleep(10_000);
    }

    // 4. Full committee key rides the registry's CommitteePublished log.
    const keyLogs = await this.logs.getLogs({ address: REGISTRY, fromBlock: receipt.blockNumber, toBlock: "latest" });
    const keyLog = keyLogs.find(l => l.topics[0] === COMMITTEE_PUBLISHED_TOPIC && l.topics[1] && BigInt(l.topics[1]) === e3Id);
    if (!keyLog) throw new Error("CommitteePublished log not found");
    const [nodes, publicKeyHex] = decodeAbiParameters(
      [{ type: "address[]" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes" }],
      keyLog.data,
    ) as [readonly Hex[], Hex, Hex, Hex];
    const keyBytes = (publicKeyHex.length - 2) / 2;
    this.booth.openE3Poll(pollId, Buffer.from(publicKeyHex.slice(2), "hex").toString("base64"));
    this.note(
      pollId,
      { stage: "open", committee: nodes.map(n => n), keyBytes },
      `🗳 ${nodes.length}-node committee published a ${keyBytes}-byte threshold key — voting is OPEN`,
    );

    // 5. Close + tally at the on-chain deadline (+ small buffer).
    this.ballots.set(pollId, []);
    const msUntilClose = Number(windowEnd) * 1000 - Date.now() + 10_000;
    const timer = setTimeout(() => {
      this.timers.delete(pollId);
      this.finish(pollId, e3Id, receipt.blockNumber).catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        this.note(pollId, { stage: "failed", error: message.slice(0, 300) }, `❌ tally failed: ${message.slice(0, 160)}`);
      });
    }, Math.max(msUntilClose, 5_000));
    this.timers.set(pollId, timer);
  }

  /** A browser-encrypted ballot arrived — publish it on-chain. */
  castBallot(pollId: string, voterKey: string, ctB64: string): void {
    const ct = new Uint8Array(Buffer.from(ctB64, "base64"));
    const list = this.ballots.get(pollId);
    if (list) list.push(ct);
    const poll = this.booth.list().find(p => p.id === pollId);
    const e3Id = poll?.e3?.e3Id;
    if (!e3Id) return;
    this.enqueueTx(async () => {
      const hash = await this.wallet.writeContract({
        address: E3_PROGRAM,
        abi: programAbi,
        functionName: "publishInput",
        args: [BigInt(e3Id), toHex(ct)],
        account: this.account,
        chain: sepolia,
      });
      await this.pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
      const prior = this.booth.list().find(p => p.id === pollId)?.e3?.ballotTxs ?? [];
      this.note(
        pollId,
        { ballotTxs: [...prior, { voterKey, txHash: hash }] },
        `📥 encrypted ballot #${prior.length + 1} published on-chain (${ct.length} bytes of ciphertext)`,
        hash,
      );
    }).catch(err => {
      const message = err instanceof Error ? err.message : String(err);
      this.note(pollId, {}, `⚠ ballot tx failed: ${message.slice(0, 140)}`);
    });
  }

  private async finish(pollId: string, e3Id: bigint, fromBlock: bigint): Promise<void> {
    const cts = this.ballots.get(pollId) ?? [];
    if (cts.length === 0) {
      this.note(pollId, { stage: "failed", error: "no ballots" }, "🫥 window closed with zero ballots — nothing to tally");
      return;
    }
    this.note(pollId, { stage: "tallying" }, `∑ window closed — homomorphically summing ${cts.length} encrypted ballots (no decryption)…`);
    const { fhe, params } = await loadFhe();
    let sum = cts[0]!;
    for (const ct of cts.slice(1)) sum = fhe.homomorphic_add(params, sum, ct);

    this.note(pollId, { stage: "publishing" }, `📤 publishing the ${sum.length}-byte encrypted tally on-chain…`);
    let outputTx: Hex | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        outputTx = await this.enqueueTx(() =>
          this.wallet.writeContract({
            address: INTERFOLD,
            abi: interfoldAbi,
            functionName: "publishCiphertextOutput",
            args: [e3Id, toHex(sum), DEV_PROOF],
            account: this.account,
            chain: sepolia,
          }),
        );
        await this.pub.waitForTransactionReceipt({ hash: outputTx, timeout: 300_000 });
        break;
      } catch (err) {
        const message = String(err);
        if (attempt < 24 && (message.includes("InputDeadlineNotReached") || message.includes(INPUT_DEADLINE_SELECTOR))) {
          this.note(pollId, {}, `⏳ chain clock hasn't passed the deadline yet (attempt ${attempt}) — retrying in 10s`);
          await sleep(10_000);
          continue;
        }
        throw err;
      }
    }
    this.note(
      pollId,
      { stage: "decrypting", outputTx },
      "🗝 encrypted tally on-chain — waiting for the PUBLIC COMMITTEE to threshold-decrypt (only the aggregate, never a ballot)…",
      outputTx,
    );

    // 6. The committee's decryption lands as PlaintextOutputPublished.
    const plaintextEvent = interfoldAbi.find(x => x.type === "event" && x.name === "PlaintextOutputPublished");
    const deadline = Date.now() + 900_000;
    for (;;) {
      const plainLogs = await this.logs.getLogs({
        address: INTERFOLD,
        event: plaintextEvent as never,
        args: { e3Id } as never,
        fromBlock,
        toBlock: "latest",
      });
      if (plainLogs.length) {
        const raw = (plainLogs[0] as unknown as { args: { plaintextOutput: Hex } }).args.plaintextOutput;
        const bytes = Buffer.from(raw.slice(2), "hex");
        const poll = this.booth.list().find(p => p.id === pollId);
        const numOptions = poll?.options.length ?? 0;
        const tally: number[] = [];
        for (let o = 0; o + 8 <= bytes.length && tally.length < numOptions; o += 8) {
          tally.push(Number(bytes.readBigUInt64LE(o)));
        }
        this.booth.revealE3Poll(pollId, tally);
        this.note(
          pollId,
          { stage: "revealed" },
          `✅ committee threshold-decrypted the aggregate — tally revealed. Individual ballots stay ciphertext forever.`,
        );
        return;
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the committee's plaintext output");
      await sleep(15_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

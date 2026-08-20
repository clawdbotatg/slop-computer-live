import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeEventLog,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import { config } from "./config.js";
import type { VotingBooth, VotePoll } from "./voting.js";

// On-chain E3 coordinator for the Voting Booth. Runs one real Interfold
// round per poll: request an E3 on-chain (fee in the protocol's fee
// token — USDS on mainnet, faucet USDC on Sepolia), wait for the PUBLIC
// ciphernode committee to run sortition + distributed DKG, open voting
// under the committee's key, publish each browser-encrypted ballot
// on-chain (facilitator pays gas), homomorphically sum the ballots
// in-process via the same fhe.rs wasm the browsers use, publish the
// encrypted tally, and wait for the committee to threshold-decrypt it.
// The relay never holds key material — it cannot read a ballot or the
// tally; only the committee can, and only in aggregate.
//
// History: battle-tested against the ORIGINAL Sepolia deployment's E3s
// #20-28 (see github.com/clawdbotatg/private-voting). 2026-08-20:
// rewritten for the mainnet-generation contracts (also live as a new
// Sepolia deployment) — the request struct gained expectedFeeToken /
// expectedCryptoConfigId / maxFee (quoted via getE3Quote),
// publishCiphertextOutput gained a ciphertextCommitment, the
// E3Requested event changed shape, fee decimals differ per chain
// (mainnet USDS is 18, Sepolia mock USDC is 6 — every threshold is
// derived from the live quote, never hardcoded), and mainnet has no
// faucet. Operational quirks that carried over: e3Id lives in the
// event DATA, input windows need a lead, InputDeadlineNotReached
// surfaces as a raw selector (unchanged: 0xbf1af280), and public RPCs
// lie about logs.
//
// Enabled when VOTING_E3_CHAIN=sepolia|mainnet and the facilitator key
// exists. NOTE 2026-08-20: mainnet `requestsPaused()` is still true
// (operator onboarding) — the pre-flight surfaces that as the poll's
// failure message rather than a cryptic revert.

type ChainKey = "sepolia" | "mainnet";

const CHAIN_KEY = (process.env.VOTING_E3_CHAIN ?? "") as ChainKey;

const CHAIN_DEFAULTS: Record<
  ChainKey,
  {
    chain: Chain;
    interfold: Hex;
    registry: Hex;
    program: Hex;
    faucet: Hex | null;
    txRpc: string;
    logRpc: string;
    explorer: string;
  }
> = {
  // The NEW Sepolia deployment (same contract generation as mainnet).
  // The original deployment this coordinator was first built against
  // (Interfold 0x64Cd…7f26) speaks the old ABI and is no longer used.
  sepolia: {
    chain: sepolia,
    interfold: "0x38A8A686A420023568E995b57B4FBEA371555Ba7",
    registry: "0xa639b9a7AB05B787fFE258735Cf9541152a0E610",
    program: "0x3D3F84d5c9dd75027F8c9e0A2203bF6a82C972d2", // MockE3Program
    faucet: "0xCb350D89ACf8FC1720e4BF2cF59B70f30F8D2DbA",
    txRpc: "https://ethereum-sepolia-rpc.publicnode.com",
    logRpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
  mainnet: {
    chain: mainnet,
    interfold: "0x28cF63B459e6218C69EA97ea7D90541cf648c715",
    registry: "0xC927A5B2d8F68697bC28C0670df05178c93df2d7",
    program: "0x4976E5E47852eFCe6851d35B95A1A2E19456F3D7", // MockE3Program
    faucet: null,
    txRpc: "https://ethereum-rpc.publicnode.com",
    // getLogs-honest RPC — publicnode has silently filtered log queries.
    logRpc: "https://eth.drpc.org",
    explorer: "https://etherscan.io",
  },
};

const CFG = CHAIN_DEFAULTS[CHAIN_KEY] ?? CHAIN_DEFAULTS.sepolia;

const INTERFOLD = (process.env.VOTING_E3_INTERFOLD ?? CFG.interfold) as Hex;
const REGISTRY = (process.env.VOTING_E3_REGISTRY ?? CFG.registry) as Hex;
const E3_PROGRAM = (process.env.VOTING_E3_PROGRAM ?? CFG.program) as Hex;
const FAUCET = (process.env.VOTING_E3_FAUCET ?? CFG.faucet ?? "") as Hex | "";
const TX_RPC = process.env.VOTING_E3_TX_RPC ?? CFG.txRpc;
const LOG_RPC = process.env.VOTING_E3_LOG_RPC ?? CFG.logRpc;
const WINDOW_SECS = Number(process.env.VOTING_E3_WINDOW_SECS ?? 300);
const WINDOW_LEAD_SECS = 120;

const INPUT_DEADLINE_SELECTOR = "0xbf1af280"; // InputDeadlineNotReached(uint256,uint256)
// Dev-mode compute "proof" (digits of pi) — accepted because the
// protocol's ciphertext verifier is still a deployed mock on BOTH
// networks (DeployableMockCiphertextVerifier, checked 2026-08-20).
// Real proofs come with the Boundless integration.
const DEV_PROOF = "0x0301040105090206050305" as Hex;

// Mainnet-generation ABI. The E3 struct is positional — field order
// verified against interfaces/IE3.sol at theinterfold/interfold@main
// (2026-08-20). If upstream reshapes it, the decodeEventLog fallback in
// run() keeps e3Id extraction working via the simulated return value.
const E3_STRUCT =
  "struct E3 { uint256 seed; uint8 committeeSize; uint256 requestBlock; uint256[2] inputWindow; bytes32 encryptionSchemeId; address e3Program; uint8 paramSet; bytes customParams; address decryptionVerifier; address pkVerifier; bytes32 committeePublicKey; bytes32 ciphertextOutput; bytes plaintextOutput; address requester; bytes32 ciphertextCommitment; }";
const interfoldAbi = parseAbi([
  E3_STRUCT,
  "struct E3RequestParams { uint8 committeeSize; uint256[2] inputWindow; address e3Program; uint8 paramSet; bytes computeProviderParams; bytes customParams; address expectedFeeToken; bytes32 expectedCryptoConfigId; uint256 maxFee; }",
  "function request(E3RequestParams params) returns (uint256 e3Id, E3 e3)",
  "function getE3(uint256 e3Id) view returns (E3 e3)",
  "function getE3Stage(uint256 e3Id) view returns (uint8)",
  "function getE3Quote(E3RequestParams e3Params) view returns (uint256 fee)",
  "function activeCryptoConfigId() view returns (bytes32)",
  "function feeToken() view returns (address)",
  "function feeTokenDecimals() view returns (uint8)",
  "function requestsPaused() view returns (bool)",
  "function publishCiphertextOutput(uint256 e3Id, bytes ciphertextOutput, bytes32 ciphertextCommitment, bytes proof) returns (bool)",
  "event E3Requested(uint256 e3Id, E3 e3, bytes32 indexed cryptoConfigId)",
]);
// Emitted by the registry when a node publishes a serialized committee
// public-key candidate (may land a beat AFTER the Interfold stage flips
// to KeyPublished — the stage tracks the DKG *proof*, the key bytes ride
// this separate permissionless publish).
const committeePublishedAbi = parseAbi([
  "event CommitteePublished(uint256 indexed e3Id, address[] nodes, bytes publicKey, bytes32 pkCommitment, bytes proof)",
]);
const erc20Abi = parseAbi([
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const programAbi = parseAbi(["function publishInput(uint256 e3Id, bytes data)"]);
const faucetAbi = parseAbi(["function faucet()"]);

export function votingE3Enabled(): boolean {
  return (CHAIN_KEY === "sepolia" || CHAIN_KEY === "mainnet") && Boolean(config.personalWalletDeployerKey);
}

export function votingE3Info(): { chain: string; interfold: string; program: string } {
  return { chain: CHAIN_KEY, interfold: INTERFOLD, program: E3_PROGRAM };
}

export function e3ExplorerTx(txHash: string): string {
  return `${CFG.explorer}/tx/${txHash}`;
}

/** Mainnet-generation e3Ids are namespaced: (interfold address << 96) |
 *  counter. Narrate the human-sized counter, keep the full id for calls. */
function e3IdLabel(e3Id: bigint): string {
  return (e3Id & ((1n << 96n) - 1n)).toString();
}

function fmtFee(amount: bigint, decimals: number): string {
  const whole = amount / 10n ** BigInt(decimals);
  const frac = ((amount % 10n ** BigInt(decimals)) * 100n) / 10n ** BigInt(decimals);
  return `${whole}.${String(frac).padStart(2, "0")}`;
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
      // paramSet 0 — the only param set registered on BOTH networks
      // (checked 2026-08-20: paramSet 1 / SECURE_THRESHOLD_8192 reverts
      // in getE3Quote). Revisit if the protocol registers the secure set.
      const params = mod.load_params_named("INSECURE_THRESHOLD_512");
      return { fhe: mod as FheModule, params };
    })();
  }
  return fhePromise;
}

// --- per-room coordinator ----------------------------------------------------

export class VoteE3Coordinator {
  private account = privateKeyToAccount(config.personalWalletDeployerKey as Hex);
  private pub = createPublicClient({ chain: CFG.chain, transport: http(TX_RPC) });
  private logs = createPublicClient({ chain: CFG.chain, transport: http(LOG_RPC) });
  private wallet = createWalletClient({ account: this.account, chain: CFG.chain, transport: http(TX_RPC) });
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

  /** Self-heal on boot: any on-chain poll that isn't revealed but whose
   *  E3 already has a plaintext output on-chain (relay restarted, or a
   *  read hiccup stranded it) gets revealed from the chain. Polls still
   *  mid-flight are left for a fresh run / manual retry. */
  async resumePending(): Promise<void> {
    for (const poll of this.booth.list()) {
      if (poll.mode === "room" || !poll.mode || poll.status === "revealed") continue;
      const e3Id = poll.e3?.e3Id;
      if (!e3Id) continue;
      try {
        const e3 = (await this.pub.readContract({
          address: INTERFOLD,
          abi: interfoldAbi,
          functionName: "getE3",
          args: [BigInt(e3Id)],
        })) as { plaintextOutput: Hex };
        if (e3.plaintextOutput && e3.plaintextOutput.length > 2) {
          const bytes = Buffer.from(e3.plaintextOutput.slice(2), "hex");
          const tally: number[] = [];
          for (let o = 0; o + 8 <= bytes.length && tally.length < poll.options.length; o += 8) {
            tally.push(Number(bytes.readBigUInt64LE(o)));
          }
          this.booth.revealE3Poll(poll.id, tally);
          this.note(poll.id, { stage: "revealed" }, "✅ recovered from chain — committee tally revealed (relay had missed the read-back).");
        }
      } catch {
        /* transient — leave the poll as-is; a later boot retries */
      }
    }
  }

  /** Kick off the full E3 lifecycle for a freshly created poll. */
  start(poll: VotePoll): void {
    this.run(poll.id).catch(err => {
      const message = err instanceof Error ? err.message : String(err);
      this.note(poll.id, { stage: "failed", error: message.slice(0, 300) }, `❌ E3 failed: ${message.slice(0, 160)}`);
    });
  }

  private async run(pollId: string): Promise<void> {
    // 0. Pre-flight: live protocol config. Fee token, decimals, and the
    // crypto config are read from the contract each round so a protocol
    // reconfig (new fee token, rotated circuit config) can't silently
    // desync us — the request would otherwise revert on the expected*
    // fields we pin below.
    const [feeToken, feeDecimals, cryptoConfigId, paused] = await Promise.all([
      this.pub.readContract({ address: INTERFOLD, abi: interfoldAbi, functionName: "feeToken" }) as Promise<Hex>,
      this.pub.readContract({ address: INTERFOLD, abi: interfoldAbi, functionName: "feeTokenDecimals" }) as Promise<number>,
      this.pub.readContract({ address: INTERFOLD, abi: interfoldAbi, functionName: "activeCryptoConfigId" }) as Promise<Hex>,
      this.pub.readContract({ address: INTERFOLD, abi: interfoldAbi, functionName: "requestsPaused" }) as Promise<boolean>,
    ]);
    if (paused) {
      throw new Error(
        `Interfold ${CHAIN_KEY} has E3 requests PAUSED (operator onboarding) — nobody can request a round yet. Try again after the protocol team unpauses.`,
      );
    }

    // 1. Quote the fee for this round's exact parameters. The window in
    // the quote only matters for its duration (availability pricing);
    // the real window is recomputed at send time with a lead so it
    // can't go stale while the tx mines.
    const mkParams = (windowStart: bigint, windowEnd: bigint, maxFee: bigint) =>
      ({
        committeeSize: 0, // CommitteeSize.Minimum → 3 nodes
        inputWindow: [windowStart, windowEnd] as readonly [bigint, bigint],
        e3Program: E3_PROGRAM,
        paramSet: 0, // INSECURE_THRESHOLD_512 — see loadFhe()
        computeProviderParams: toHex(new Uint8Array(32)),
        customParams: "0x" as Hex,
        expectedFeeToken: feeToken,
        expectedCryptoConfigId: cryptoConfigId,
        maxFee,
      }) as const;
    const nowChain = (await this.pub.getBlock()).timestamp;
    const quote = (await this.pub.readContract({
      address: INTERFOLD,
      abi: interfoldAbi,
      functionName: "getE3Quote",
      args: [mkParams(nowChain + BigInt(WINDOW_LEAD_SECS), nowChain + BigInt(WINDOW_LEAD_SECS + WINDOW_SECS), 10n ** 33n)],
    })) as bigint;
    const maxFee = quote + quote / 10n; // 10% headroom for quote drift while we mine
    const feeStr = fmtFee(quote, feeDecimals);

    // 2. Fee balance. Sepolia: top up from the protocol faucet. Mainnet:
    // there is no faucet — fail loud with the address to fund.
    const feeBalance = (await this.pub.readContract({
      address: feeToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.account.address],
    })) as bigint;
    if (feeBalance < maxFee) {
      if (FAUCET) {
        this.note(pollId, {}, `⛽ fee balance below this round's ~${feeStr} quote — topping up from the testnet faucet…`);
        try {
          const hash = await this.enqueueTx(() =>
            this.wallet.writeContract({ address: FAUCET as Hex, abi: faucetAbi, functionName: "faucet", account: this.account, chain: CFG.chain }),
          );
          await this.pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
          this.note(pollId, {}, "⛽ fee tokens refilled", hash);
        } catch (err) {
          // Faucet may be dry or rate-limited; proceed and let request() report if truly empty.
          this.note(pollId, {}, `⚠ faucet top-up skipped (${err instanceof Error ? err.message.slice(0, 80) : "error"})`);
        }
      } else {
        throw new Error(
          `facilitator ${this.account.address} holds ${fmtFee(feeBalance, feeDecimals)} of the fee token but this round quotes ~${feeStr} — top it up (no faucet on ${CHAIN_KEY}).`,
        );
      }
    }

    // 3. Fee allowance — bounded to this round's maxFee (the requestor
    // guide says approve exact amounts, never unlimited).
    const allowance = (await this.pub.readContract({
      address: feeToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, INTERFOLD],
    })) as bigint;
    if (allowance < maxFee) {
      this.note(pollId, {}, `💸 approving ~${feeStr} fee for the Interfold…`);
      const hash = await this.enqueueTx(() =>
        this.wallet.writeContract({
          address: feeToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [INTERFOLD, maxFee],
          account: this.account,
          chain: CFG.chain,
        }),
      );
      await this.pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
      this.note(pollId, {}, "💸 fee approved", hash);
    }

    // 4. Request the E3. simulateContract first: it returns the e3Id the
    // request WILL get (belt for the event-decode braces below) and
    // turns any revert (pause raced us, fee moved past maxFee, params
    // rejected) into a readable error before gas is spent.
    const windowStart = (await this.pub.getBlock()).timestamp + BigInt(WINDOW_LEAD_SECS);
    const windowEnd = windowStart + BigInt(WINDOW_SECS);
    const reqParams = mkParams(windowStart, windowEnd, maxFee);
    this.note(
      pollId,
      { windowStart: Number(windowStart), windowEnd: Number(windowEnd) },
      `📡 requesting an Encrypted Execution Environment on ${CHAIN_KEY} (fee ~${feeStr})…`,
    );
    const sim = await this.pub.simulateContract({
      address: INTERFOLD,
      abi: interfoldAbi,
      functionName: "request",
      args: [reqParams],
      account: this.account,
    });
    const simulatedE3Id = (sim.result as readonly [bigint, unknown])[0];
    const reqHash = await this.enqueueTx(() =>
      this.wallet.writeContract({
        address: INTERFOLD,
        abi: interfoldAbi,
        functionName: "request",
        args: [reqParams],
        account: this.account,
        chain: CFG.chain,
      }),
    );
    const receipt = await this.pub.waitForTransactionReceipt({ hash: reqHash, timeout: 300_000 });
    // e3Id rides the E3Requested event data. Decode by ABI rather than a
    // pinned topic hash; if upstream reshaped the E3 struct (which
    // changes the topic), fall back to the simulated id.
    let e3Id: bigint | null = null;
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== INTERFOLD.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: interfoldAbi, data: l.data, topics: l.topics });
        if (ev.eventName === "E3Requested") {
          e3Id = (ev.args as { e3Id: bigint }).e3Id;
          break;
        }
      } catch {
        /* not E3Requested — keep scanning */
      }
    }
    if (e3Id === null) e3Id = simulatedE3Id;
    this.note(
      pollId,
      { stage: "sortition", e3Id: e3Id.toString(), requestTx: reqHash },
      `🎲 E3 #${e3IdLabel(e3Id)} requested — public ciphernodes are rolling sortition tickets…`,
      reqHash,
    );

    // 5. Wait for the public committee: stage 1=Requested (sortition),
    // 2=CommitteeFinalized (DKG running), 3=KeyPublished (same indices
    // as the old deployment — verified against the new E3Stage enum).
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

    // 6. The serialized committee key rides the registry's
    // CommitteePublished log — published permissionlessly by a node and
    // possibly a beat AFTER the stage flips (the stage tracks the DKG
    // proof; the key bytes are a separate publish). Poll for it.
    // Demo-grade honesty: we take the first non-empty candidate without
    // recomputing its pkCommitment (the UI's dev-mode banner covers
    // this class of shortcut).
    let publicKeyHex: Hex | null = null;
    let nodes: readonly Hex[] = [];
    const keyDeadline = Date.now() + 300_000;
    while (!publicKeyHex) {
      const keyLogs = await this.logs.getLogs({ address: REGISTRY, fromBlock: receipt.blockNumber, toBlock: "latest" });
      for (const l of keyLogs) {
        try {
          const ev = decodeEventLog({ abi: committeePublishedAbi, data: l.data, topics: l.topics });
          const args = ev.args as { e3Id: bigint; nodes: readonly Hex[]; publicKey: Hex };
          if (args.e3Id === e3Id && args.publicKey && args.publicKey.length > 2) {
            publicKeyHex = args.publicKey;
            nodes = args.nodes;
            break;
          }
        } catch {
          /* other registry event */
        }
      }
      if (!publicKeyHex) {
        if (Date.now() > keyDeadline) throw new Error("committee key not published within 5 min of KeyPublished stage");
        await sleep(5_000);
      }
    }
    const keyBytes = (publicKeyHex.length - 2) / 2;
    this.booth.openE3Poll(pollId, Buffer.from(publicKeyHex.slice(2), "hex").toString("base64"));
    this.note(
      pollId,
      { stage: "open", committee: nodes.map(n => n), keyBytes },
      `🗳 ${nodes.length}-node committee published a ${keyBytes}-byte threshold key — voting is OPEN`,
    );

    // 7. Close + tally at the on-chain deadline (+ small buffer).
    this.ballots.set(pollId, []);
    const msUntilClose = Number(windowEnd) * 1000 - Date.now() + 10_000;
    const timer = setTimeout(() => {
      this.timers.delete(pollId);
      this.finish(pollId, e3Id).catch(err => {
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
        chain: CFG.chain,
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

  private async finish(pollId: string, e3Id: bigint): Promise<void> {
    const cts = this.ballots.get(pollId) ?? [];
    if (cts.length === 0) {
      this.note(pollId, { stage: "failed", error: "no ballots" }, "🫥 window closed with zero ballots — nothing to tally");
      return;
    }
    this.note(pollId, { stage: "tallying" }, `∑ window closed — homomorphically summing ${cts.length} encrypted ballots (no decryption)…`);
    const { fhe, params } = await loadFhe();
    let sum = cts[0]!;
    for (const ct of cts.slice(1)) sum = fhe.homomorphic_add(params, sum, ct);

    this.note(
      pollId,
      { stage: "publishing" },
      `📤 publishing the ${sum.length}-byte encrypted tally on-chain (with a DEV-MODE proof — compute not yet cryptographically proven)…`,
    );
    // ciphertextCommitment is meant to be a SAFE commitment to the
    // decoded BFV ciphertext for the decryption circuit; the deployed
    // ciphertext verifier is a mock on both networks, so a keccak of
    // the serialized tally stands in (honest-framing: dev mode).
    const sumHex = toHex(sum);
    const commitment = keccak256(sumHex);
    let outputTx: Hex | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        outputTx = await this.enqueueTx(() =>
          this.wallet.writeContract({
            address: INTERFOLD,
            abi: interfoldAbi,
            functionName: "publishCiphertextOutput",
            args: [e3Id, sumHex, commitment, DEV_PROOF],
            account: this.account,
            chain: CFG.chain,
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

    // 8. The committee's decryption lands in the E3 struct's
    // plaintextOutput field. Read it via a contract call (getE3) rather
    // than eth_getLogs — public RPCs (drpc) intermittently reject the
    // getLogs event+args filter with "invalid parameters", and struct
    // reads have none of that fragility. Poll on the TX rpc, not the
    // log rpc.
    const poll = this.booth.list().find(p => p.id === pollId);
    const numOptions = poll?.options.length ?? 0;
    const deadline = Date.now() + 900_000;
    for (;;) {
      const stage = Number(
        await this.pub.readContract({ address: INTERFOLD, abi: interfoldAbi, functionName: "getE3Stage", args: [e3Id] }),
      );
      const e3 = (await this.pub.readContract({
        address: INTERFOLD,
        abi: interfoldAbi,
        functionName: "getE3",
        args: [e3Id],
      })) as { plaintextOutput: Hex };
      const raw = e3.plaintextOutput;
      if (raw && raw.length > 2) {
        const bytes = Buffer.from(raw.slice(2), "hex");
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
      if (stage === 6) throw new Error("E3 failed on-chain during decryption");
      if (Date.now() > deadline) throw new Error("timed out waiting for the committee's plaintext output");
      await sleep(15_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

import { createPublicClient, http } from "viem";
import { mainnet as mainnetBase } from "viem/chains";
import { config } from "./config.js";

// Ethereum gas tracker. Polled once every ~12s on the relay (one block
// avg), broadcast to all connected mesh peers. Single API surface for
// everyone — no per-client Alchemy calls, no API-key leakage.
//
// Numbers we expose:
//   - baseFeeGwei: predicted base fee of the *next* block (eth_feeHistory
//     pads the array with that prediction at the tail)
//   - slow/medium/fast Gwei: baseFee + 10th/50th/90th percentile of
//     recent priority fee tips, averaged over the last 5 blocks
//   - ethUsd: Chainlink ETH/USD oracle on mainnet, 8-decimal int → float
//
// The client multiplies these against op-specific gas units (21k, 65k,
// 184k, 250k, …) to render the "what does this cost" table.

const POLL_INTERVAL_MS = 12_000;
// On error, back off briefly before retrying. Keeps the log from
// drowning if Alchemy is briefly flaky.
const ERROR_RETRY_MS = 30_000;

// Chainlink ETH/USD aggregator on mainnet, 8 decimals.
// See https://docs.chain.link/data-feeds/price-feeds/addresses
const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const;

const chainlinkAggregatorAbi = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export type GasState = {
  baseFeeGwei: number;
  slowGwei: number;
  mediumGwei: number;
  fastGwei: number;
  ethUsd: number;
  /** ms-epoch when this snapshot was captured. */
  updatedAt: number;
};

let state: GasState | null = null;

type Subscriber = (state: GasState) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getState(): GasState | null {
  return state;
}

function weiToGwei(wei: bigint): number {
  // Fees fit easily in a JS number (max gwei ever ~10^4, max wei
  // ~10^13). Number conversion is safe at this magnitude.
  return Number(wei) / 1e9;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export function start(): void {
  if (started) return;
  started = true;

  if (!config.alchemyApiKey) {
    // No key configured (e.g. local dev without .env). Skip the loop —
    // the mesh state will just stay null and the client renders a
    // "no data" placeholder.
    return;
  }

  const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`;
  const mainnet = {
    ...mainnetBase,
    rpcUrls: { default: { http: [alchemyUrl] }, public: { http: [alchemyUrl] } },
  } as const;
  const client = createPublicClient({ chain: mainnet, transport: http(alchemyUrl) });

  const poll = async () => {
    try {
      const [feeHistory, oracleData] = await Promise.all([
        client.getFeeHistory({
          blockCount: 5,
          rewardPercentiles: [10, 50, 90],
        }),
        client.readContract({
          address: CHAINLINK_ETH_USD,
          abi: chainlinkAggregatorAbi,
          functionName: "latestRoundData",
        }),
      ]);

      // baseFeePerGas length = blockCount + 1; the last entry is the
      // *predicted* base fee for the next block — that's what users
      // actually care about when sending a tx right now.
      const baseFees = feeHistory.baseFeePerGas;
      const nextBaseFee = baseFees[baseFees.length - 1] ?? 0n;

      // reward shape: rewards[blockIndex][percentileIndex]. Some
      // blocks may have no transactions and Alchemy returns 0 — those
      // dilute the average toward zero, but that's fine for the
      // common case of a busy mainnet.
      const rewards = feeHistory.reward ?? [];
      const avgAt = (pIdx: number): bigint => {
        if (rewards.length === 0) return 0n;
        let sum = 0n;
        let count = 0n;
        for (const row of rewards) {
          const v = row[pIdx];
          if (typeof v === "bigint") {
            sum += v;
            count += 1n;
          }
        }
        return count === 0n ? 0n : sum / count;
      };

      const slowPriority = avgAt(0);
      const medPriority = avgAt(1);
      const fastPriority = avgAt(2);

      // answer is signed but Chainlink returns positive USD prices.
      const answer = oracleData[1] as bigint;
      const ethUsd = Number(answer) / 1e8;

      state = {
        baseFeeGwei: weiToGwei(nextBaseFee),
        slowGwei: weiToGwei(nextBaseFee + slowPriority),
        mediumGwei: weiToGwei(nextBaseFee + medPriority),
        fastGwei: weiToGwei(nextBaseFee + fastPriority),
        ethUsd,
        updatedAt: Date.now(),
      };

      for (const fn of subscribers) {
        try {
          fn(state);
        } catch {
          /* one bad sub shouldn't kill the rest */
        }
      }

      pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    } catch (err) {
      console.warn("[gas] poll failed", err);
      pollTimer = setTimeout(() => void poll(), ERROR_RETRY_MS);
    }
  };

  void poll();
}

export function stop(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  started = false;
}

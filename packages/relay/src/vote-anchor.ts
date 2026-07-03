import { createWalletClient, createPublicClient, http, keccak256, concatHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, hardhat, mainnet } from "viem/chains";
import { config } from "./config.js";

// Voting Booth → on-chain anchor. After a poll's reveal ceremony the
// relay posts one tx to PollAnchor.anchor() recording the question,
// options, tally, ballot count, and a keccak root committing to every
// ballot ciphertext. Ballots themselves never touch the chain — at
// ~350 KB of threshold-BFV ciphertext each they'd cost ~5-6M gas of
// calldata per vote on mainnet; the anchor makes the *outcome*
// permanent and checkable for the price of one small tx.
//
// Off unless VOTING_ANCHOR_CHAIN + VOTING_ANCHOR_ADDRESS are set (and
// the facilitator key exists). Fire-and-forget: anchoring failure never
// blocks the reveal — the poll just stays "unanchored" and the UI says
// nothing.

const POLL_ANCHOR_ABI = [
  {
    type: "function",
    name: "anchor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pollId", type: "bytes32" },
      { name: "question", type: "string" },
      { name: "options", type: "string[]" },
      { name: "tally", type: "uint256[]" },
      { name: "ballotCount", type: "uint256" },
      { name: "ballotsRoot", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const CHAINS = {
  mainnet: { chain: mainnet, explorer: "https://etherscan.io" },
  base: { chain: base, explorer: "https://basescan.org" },
  // Dev only: hardhat node on 127.0.0.1:8545, no explorer.
  local: { chain: hardhat, explorer: null },
} as const;

export type AnchorChainName = keyof typeof CHAINS;

const anchorChainName = (process.env.VOTING_ANCHOR_CHAIN ?? "") as AnchorChainName | "";
const anchorAddress = (process.env.VOTING_ANCHOR_ADDRESS ?? "") as Hex | "";
const anchorRpc = process.env.VOTING_ANCHOR_RPC ?? "";

export function anchoringEnabled(): boolean {
  return Boolean(anchorChainName && CHAINS[anchorChainName as AnchorChainName] && anchorAddress && config.personalWalletDeployerKey);
}

export function anchorExplorerTxUrl(chainName: string, txHash: string): string | null {
  const entry = CHAINS[chainName as AnchorChainName];
  return entry?.explorer ? `${entry.explorer}/tx/${txHash}` : null;
}

/** keccak256 of the concatenated keccak256 of each ballot ciphertext,
 *  in ballot order — the commitment PollAnchor records as ballotsRoot. */
export function ballotsRoot(ctsBase64: string[]): Hex {
  const leaves = ctsBase64.map(b64 => keccak256(Buffer.from(b64, "base64") as unknown as Uint8Array));
  return keccak256(concatHex(leaves));
}

export async function anchorPoll(input: {
  pollId: string;
  question: string;
  options: string[];
  tally: number[];
  ballotCts: string[];
}): Promise<{ chain: string; txHash: string; explorerUrl: string | null }> {
  if (!anchoringEnabled()) throw new Error("anchoring disabled");
  const { chain, explorer } = CHAINS[anchorChainName as AnchorChainName];
  const account = privateKeyToAccount(config.personalWalletDeployerKey as Hex);
  const transport = http(anchorRpc || undefined);
  const wallet = createWalletClient({ account, chain, transport });
  const pub = createPublicClient({ chain, transport });

  // Poll ids are 8 random bytes hex — right-pad into bytes32.
  const pollId = `0x${input.pollId.padEnd(64, "0")}` as Hex;
  const txHash = await wallet.writeContract({
    address: anchorAddress as Hex,
    abi: POLL_ANCHOR_ABI,
    functionName: "anchor",
    args: [
      pollId,
      input.question,
      input.options,
      input.tally.map(n => BigInt(n)),
      BigInt(input.ballotCts.length),
      ballotsRoot(input.ballotCts),
    ],
  });
  await pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  return { chain: anchorChainName, txHash, explorerUrl: explorer ? `${explorer}/tx/${txHash}` : null };
}

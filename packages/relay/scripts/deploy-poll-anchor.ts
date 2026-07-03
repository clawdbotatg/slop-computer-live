// Deploy PollAnchor from the facilitator hot key and print the env lines
// to add. Usage (from packages/relay, .env supplies the key):
//
//   npx tsx scripts/deploy-poll-anchor.ts mainnet
//   npx tsx scripts/deploy-poll-anchor.ts base
//   VOTING_ANCHOR_RPC=https://... npx tsx scripts/deploy-poll-anchor.ts mainnet
//
// Reads the compiled artifact from packages/hardhat — run
// `yarn hardhat:compile` at the repo root first.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, hardhat, mainnet } from "viem/chains";

const CHAINS = { mainnet, base, local: hardhat } as const;
const chainName = process.argv[2] as keyof typeof CHAINS;
if (!CHAINS[chainName]) {
  console.error("usage: tsx scripts/deploy-poll-anchor.mts <mainnet|base|local>");
  process.exit(1);
}

const key = process.env.PERSONAL_WALLET_DEPLOYER_KEY as Hex | undefined;
if (!key) {
  console.error("PERSONAL_WALLET_DEPLOYER_KEY missing from packages/relay/.env");
  process.exit(1);
}

const artifact = JSON.parse(
  readFileSync(new URL("../../hardhat/artifacts/contracts/PollAnchor.sol/PollAnchor.json", import.meta.url), "utf8"),
) as { abi: unknown[]; bytecode: Hex };

const chain = CHAINS[chainName];
const transport = http(process.env.VOTING_ANCHOR_RPC || undefined);
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

const balance = await pub.getBalance({ address: account.address });
console.log(`deployer ${account.address} — ${formatEther(balance)} ETH on ${chainName}`);
if (balance === 0n) {
  console.error("deployer has no ETH on this chain — fund it first");
  process.exit(1);
}

console.log("deploying PollAnchor…");
const txHash = await wallet.deployContract({ abi: artifact.abi as never, bytecode: artifact.bytecode });
const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 300_000 });
if (!receipt.contractAddress) throw new Error("no contract address in receipt");

console.log(`\nPollAnchor deployed at ${receipt.contractAddress}`);
console.log(`tx: ${txHash} (gas used ${receipt.gasUsed})`);
console.log("\nAdd to packages/relay/.env (and prod):");
console.log(`VOTING_ANCHOR_CHAIN=${chainName}`);
console.log(`VOTING_ANCHOR_ADDRESS=${receipt.contractAddress}`);

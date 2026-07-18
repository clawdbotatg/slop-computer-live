// AI wallet intent engine — ported from slop-computer-ai-wallet's
// app/api/intent/route.ts. The Next.js POST handler becomes a plain
// `runWalletIntent()` function the relay calls from the wallet-chat
// subsystem. No streaming: one agentic loop, single JSON result.
//
// The model runs through Bankr's OpenAI-compatible gateway. It is given
// a tool belt (simulate, portfolio, history, LI.FI routing, ENS, …) and
// loops until it emits a final chat / transaction / multistep answer.
//
// External services: Alchemy (RPC + simulation), Zerion (history),
// LI.FI (routing), CoinGecko + GeckoTerminal (prices/liquidity),
// ensideas.com (ENS). All keys come from relay config.

import { randomBytes } from "node:crypto";
import OpenAI from "openai";
import { namehash } from "viem/ens";
import { config } from "./config.js";
import { alchemyUrl, fetchPortfolio } from "./wallet-data.js";
import { simulateForAi } from "./wallet-ai.js";
import { TOKEN_ADDRESSES } from "./wallet-tokens.js";
import {
  type WalletDebugStep,
  type WalletDebugToolCall,
  serializeResult,
  writeWalletDebug,
} from "./wallet-debug.js";

const ALCHEMY_KEY = config.alchemyApiKey;
const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Address of the WETH9-style native-gas-token wrapper for a chain — the
// deposit()/withdraw() ABI is identical across WETH, WMATIC and WXDAI, so
// the wrap/unwrap tools just need the right contract. Polygon wraps MATIC
// (WMATIC), Gnosis wraps xDAI (WXDAI); everything else wraps ETH (WETH).
// Resolved from the shared TOKEN_ADDRESSES registry so new chains work
// automatically once their tokens are listed there.
function nativeWrapper(chainId: number): string {
  const tokens = TOKEN_ADDRESSES[String(chainId)];
  const symbol = chainId === 137 ? "WMATIC" : chainId === 100 ? "WXDAI" : "WETH";
  return tokens?.[symbol]?.address ?? WETH_MAINNET;
}

const ENS_REGISTRAR = "0x253553366Da8546fC250F225fe3d25d0C782303b";
const ENS_PUBLIC_RESOLVER = "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63";

// ─── Encoding helpers ────────────────────────────────────────────────────────

function toHex(value: bigint): string {
  return "0x" + value.toString(16);
}
function padUint256(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}
function padAddress(addr: string): string {
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}
/** Convert a human/wei/hex amount string to wei BigInt. */
function safeBigInt(amount: string | number, decimals = 18): bigint {
  const s = String(amount);
  if (s.startsWith("0x")) return BigInt(s);
  if (s.includes(".")) {
    const [whole, frac = ""] = s.split(".");
    const paddedFrac = frac.padEnd(decimals, "0").slice(0, decimals);
    return BigInt(whole + paddedFrac);
  }
  return BigInt(s);
}
/** Parse an already-raw (wei/base-unit) integer amount string to BigInt.
 *  Unlike safeBigInt this does NOT scale by decimals — LI.FI's fromAmount is
 *  already in base units. Returns 0n on anything unparseable. */
function safeRawBigInt(amount: unknown): bigint {
  try {
    const s = String(amount ?? "").trim();
    if (!s) return 0n;
    return s.startsWith("0x") ? BigInt(s) : BigInt(s.split(".")[0]!);
  } catch {
    return 0n;
  }
}
/** Read an ERC-20 allowance(owner, spender) on a given chain. Returns the
 *  granted amount, or null if the call failed (caller treats null as "assume
 *  not approved" so a route is never proposed that would revert). */
async function readAllowance(
  chainId: number,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint | null> {
  try {
    const data = "0xdd62ed3e" + padAddress(owner) + padAddress(spender);
    const res = await fetch(alchemyUrl(chainId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to: token, data }, "latest"], id: 1 }),
    });
    const json = (await res.json()) as any;
    if (json.error || typeof json.result !== "string") return null;
    return BigInt(json.result || "0x0");
  } catch {
    return null;
  }
}
function encodeString(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  const len = padUint256(BigInt(bytes.length));
  const padded = bytes.toString("hex").padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return len + padded;
}
function encodeBytes32(hex: string): string {
  return hex.replace("0x", "").padStart(64, "0");
}
function encodeBool(val: boolean): string {
  return padUint256(val ? 1n : 0n);
}
function encodeUint16(val: number): string {
  return padUint256(BigInt(val));
}
/** ABI-encode the makeCommitment / register param tuple for ENS. */
function encodeENSParams(
  name: string,
  owner: string,
  duration: bigint,
  secret: string,
  resolver: string,
  reverseRecord: boolean,
  fuses: number,
): string {
  const headSize = 8 * 32;
  const nameEncoded = encodeString(name);
  const emptyBytesArray = padUint256(0n);
  const nameOffset = headSize;
  const dataOffset = nameOffset + nameEncoded.length / 2;
  let head = "";
  head += padUint256(BigInt(nameOffset));
  head += padAddress(owner);
  head += padUint256(duration);
  head += encodeBytes32(secret);
  head += padAddress(resolver);
  head += padUint256(BigInt(dataOffset));
  head += encodeBool(reverseRecord);
  head += encodeUint16(fuses);
  return head + nameEncoded + emptyBytesArray;
}

// ─── Tool belt ───────────────────────────────────────────────────────────────
// Each tool's execute() is a plain async fn. Args are loosely typed —
// the model passes them per the JSON schemas declared further down.

/* eslint-disable @typescript-eslint/no-explicit-any */
const intentTools: Record<string, { execute: (args: any) => Promise<unknown> }> = {
  simulateAssetChanges: {
    // Ground truth via eth_simulateV1 (the same path the tx-summary cards
    // trust). The old `alchemy_simulateAssetChanges` RPC is dead on our key
    // ("JS Tracer is not enabled"), so this tool used to fail on EVERY call and
    // the AI shipped unverified, reverting txs. Returns { success, simulated,
    // reverted, error, changes } — the AI MUST refuse to present a tx when
    // reverted:true (see SYSTEM_PROMPT step 7).
    execute: async ({ from, to, data, value, chainId }: any) => {
      const chain = chainId ?? 1;
      // simulateTransfers wants DECIMAL wei; LI.FI/the model passes hex.
      let decValue = "0";
      try {
        if (value) decValue = BigInt(value).toString();
      } catch {
        decValue = "0";
      }
      try {
        const sim = await simulateForAi({ from, calls: [{ to, data, value: decValue }], chainId: chain });
        if (!sim.simulated) {
          return {
            success: false,
            simulated: false,
            reverted: false,
            error: sim.error || "simulation unavailable",
            changes: [],
          };
        }
        if (sim.reverted) {
          return {
            success: false,
            simulated: true,
            reverted: true,
            error: sim.error || "transaction reverts on-chain — do NOT present it",
            changes: [],
          };
        }
        return { success: true, simulated: true, reverted: false, changes: sim.changes };
      } catch (e) {
        return {
          success: false,
          simulated: false,
          reverted: false,
          error: `Simulation failed: ${e instanceof Error ? e.message : String(e)}`,
          changes: [],
        };
      }
    },
  },

  traceCall: {
    execute: async ({ from, to, data, value, chainId }: any) => {
      const chain = chainId ?? 1;
      try {
        const res = await fetch(alchemyUrl(chain), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "debug_traceCall",
            params: [{ from, to, data, value: value || "0x0" }, "latest", { tracer: "callTracer" }],
          }),
        });
        const json = (await res.json()) as any;
        if (json.error) {
          return {
            success: false,
            revertReason: json.error.message || JSON.stringify(json.error),
            gasUsed: "0x0",
            internalCalls: [],
            hasUnlimitedApproval: false,
          };
        }
        const result = json.result;
        const internalCalls: { to: string; input: string; value: string }[] = [];
        let hasUnlimitedApproval = false;
        const MAX_UINT256 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        function walkCalls(calls: any[]) {
          for (const call of calls) {
            if (call.to) {
              internalCalls.push({ to: call.to, input: (call.input || "0x").slice(0, 74), value: call.value || "0x0" });
            }
            if (call.input && call.input.startsWith("0x095ea7b3") && call.input.includes(MAX_UINT256)) {
              hasUnlimitedApproval = true;
            }
            if (Array.isArray(call.calls)) walkCalls(call.calls);
          }
        }
        if (Array.isArray(result.calls)) walkCalls(result.calls);
        return {
          success: !result.error,
          revertReason: result.error || undefined,
          gasUsed: result.gasUsed || "0x0",
          internalCalls: internalCalls.slice(0, 20),
          hasUnlimitedApproval,
        };
      } catch (e) {
        return {
          success: false,
          revertReason: `Trace failed: ${e instanceof Error ? e.message : String(e)}`,
          gasUsed: "0x0",
          internalCalls: [],
          hasUnlimitedApproval: false,
        };
      }
    },
  },

  getPortfolio: {
    // Ported: was an HTTP call to /api/portfolio; now calls the
    // wallet-data fetcher directly (same process).
    execute: async ({ address }: any) => {
      try {
        const data = await fetchPortfolio(String(address));
        return {
          assets: data.assets ?? [],
          totalBalanceUsd: data.totalBalanceUsd ?? "0",
          totalPortfolioUsd: data.totalPortfolioUsd ?? "0",
          change1dUsd: data.change1dUsd ?? "0",
          change1dPct: data.change1dPct ?? "0",
        };
      } catch (e) {
        return { error: `Failed to fetch portfolio: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },

  searchTransactions: {
    execute: async ({ address, tokenSymbol, chainId, operationType, afterDate, beforeDate, limit }: any) => {
      const auth = Buffer.from(`${config.zerionApiKey}:`).toString("base64");
      const headers = { Authorization: `Basic ${auth}`, accept: "application/json" };
      const maxResults = Math.min(limit || 20, 100);
      try {
        let fungibleId: string | null = null;
        if (tokenSymbol) {
          const fRes = await fetch(
            `https://api.zerion.io/v1/fungibles/?filter[search_query]=${encodeURIComponent(tokenSymbol)}&currency=usd`,
            { headers },
          );
          if (fRes.ok) {
            const fData = (await fRes.json()) as any;
            const match = (fData.data || []).find(
              (f: any) => f.attributes?.symbol?.toLowerCase() === tokenSymbol.toLowerCase(),
            );
            fungibleId = match?.id || null;
          }
        }
        const params = new URLSearchParams();
        params.set("currency", "usd");
        params.set("page[size]", "100");
        params.set("sort", "-mined_at");
        if (fungibleId) params.set("filter[fungible_ids]", fungibleId);
        if (chainId) params.set("filter[chain_ids]", chainId);
        if (operationType) params.set("filter[operation_types]", operationType);
        const res = await fetch(`https://api.zerion.io/v1/wallets/${address}/transactions/?${params.toString()}`, {
          headers,
        });
        if (!res.ok) return { error: `Zerion API error: ${res.status}` };
        const data = (await res.json()) as any;
        const allItems: any[] = data.data || [];
        const items = allItems.filter((tx: any) => {
          const minedAt = tx.attributes?.mined_at || "";
          if (afterDate && minedAt < afterDate) return false;
          if (beforeDate && minedAt > beforeDate) return false;
          return true;
        });
        const results = items.slice(0, maxResults).map((tx: any) => {
          const attrs = tx.attributes;
          return {
            date: attrs.mined_at,
            type: attrs.operation_type,
            chain: tx.relationships?.chain?.data?.id,
            hash: attrs.hash,
            from: attrs.sent_from,
            to: attrs.sent_to,
            transfers: (attrs.transfers || []).map((t: any) => ({
              direction: t.direction,
              symbol: t.fungible_info?.symbol,
              name: t.fungible_info?.name,
              amount: t.quantity?.float,
              valueUsd: t.value,
              pricePerToken: t.price,
            })),
          };
        });
        if (results.length === 0) {
          return {
            found: false,
            tokenSymbol,
            fungibleIdResolved: fungibleId,
            message: fungibleId
              ? `No transactions found for ${tokenSymbol} (Zerion ID: ${fungibleId}). Token may have been received via airdrop, farming, or contract interaction not indexed as a transfer.`
              : `Token symbol '${tokenSymbol}' not found in Zerion's fungible index.`,
          };
        }
        return {
          found: true,
          totalFound: items.length,
          returned: results.length,
          tokenSymbol,
          fungibleIdResolved: fungibleId,
          transactions: results,
        };
      } catch (e) {
        return { error: `searchTransactions failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },

  getTransactionDetails: {
    execute: async ({ hash, chain }: any) => {
      const auth = Buffer.from(`${config.zerionApiKey}:`).toString("base64");
      try {
        const res = await fetch(`https://api.zerion.io/v1/transactions/${hash}?currency=usd`, {
          headers: { Authorization: `Basic ${auth}`, accept: "application/json" },
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const attrs = data.data?.attributes || {};
          return {
            hash,
            chain: data.data?.relationships?.chain?.data?.id || chain,
            from: attrs.sent_from,
            to: attrs.sent_to,
            status: attrs.status,
            minedAt: attrs.mined_at,
            fee: attrs.fee,
            transfers: (attrs.transfers || []).map((t: any) => ({
              direction: t.direction,
              symbol: t.fungible_info?.symbol,
              name: t.fungible_info?.name,
              amount: t.quantity?.float,
              valueUsd: t.value,
              from: t.sender,
              to: t.recipient,
            })),
            type: attrs.operation_type,
          };
        }
        const rpcUrls: Record<string, string> = {
          ethereum: alchemyUrl(1),
          base: alchemyUrl(8453),
          arbitrum: alchemyUrl(42161),
          optimism: alchemyUrl(10),
          polygon: alchemyUrl(137),
          xdai: "https://rpc.gnosischain.com",
          gnosis: "https://rpc.gnosischain.com",
          robinhood: alchemyUrl(4663),
        };
        const rpcUrl = rpcUrls[chain];
        if (!rpcUrl) return { error: `Chain ${chain} not supported for direct lookup` };
        const rpcRes = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionByHash", params: [hash], id: 1 }),
        });
        const rpcData = (await rpcRes.json()) as any;
        const tx = rpcData.result;
        if (!tx) return { error: "Transaction not found" };
        return {
          hash,
          chain,
          from: tx.from,
          to: tx.to,
          value: tx.value,
          blockNumber: parseInt(tx.blockNumber, 16),
          gas: parseInt(tx.gas, 16),
        };
      } catch (e) {
        return { error: String(e) };
      }
    },
  },

  getOnChainBalance: {
    execute: async ({ walletAddress, chain, tokenAddress, tokenSymbol, tokenDecimals }: any) => {
      const rpcUrls: Record<string, string> = {
        ethereum: alchemyUrl(1),
        base: alchemyUrl(8453),
        arbitrum: alchemyUrl(42161),
        optimism: alchemyUrl(10),
        polygon: alchemyUrl(137),
        xdai: "https://rpc.gnosischain.com",
        gnosis: "https://rpc.gnosischain.com",
        robinhood: alchemyUrl(4663),
      };
      const rpcUrl = rpcUrls[chain];
      if (!rpcUrl) return { error: `Chain '${chain}' not supported` };
      try {
        const isNative =
          !tokenAddress ||
          tokenAddress === "0x0000000000000000000000000000000000000000" ||
          tokenAddress === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" ||
          tokenAddress === "";
        if (isNative) {
          const res = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [walletAddress, "latest"], id: 1 }),
          });
          const data = (await res.json()) as any;
          const balance = Number(BigInt(data.result || "0x0")) / 1e18;
          return { walletAddress, chain, token: tokenSymbol || "ETH", balance: balance.toFixed(6), raw: data.result };
        }
        const decimals = tokenDecimals ?? 18;
        const dataHex = "0x70a08231" + padAddress(walletAddress);
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to: tokenAddress, data: dataHex }, "latest"],
            id: 1,
          }),
        });
        const data = (await res.json()) as any;
        if (data.error) return { error: data.error.message };
        const balance = Number(BigInt(data.result || "0x0")) / Math.pow(10, decimals);
        return {
          walletAddress,
          chain,
          token: tokenSymbol || tokenAddress,
          tokenAddress,
          balance: balance.toFixed(decimals > 6 ? 6 : decimals),
          raw: data.result,
        };
      } catch (e) {
        return { error: String(e) };
      }
    },
  },

  getTokenPrice: {
    execute: async ({ symbol }: any) => {
      try {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${symbol.toLowerCase()}&vs_currencies=usd&include_24hr_change=true`,
          { headers: { accept: "application/json" } },
        );
        const data = (await res.json()) as any;
        if (data[symbol.toLowerCase()]) {
          return {
            symbol,
            priceUsd: data[symbol.toLowerCase()].usd,
            change24h: data[symbol.toLowerCase()].usd_24h_change,
          };
        }
        const searchRes = await fetch(`https://api.coingecko.com/api/v3/search?query=${symbol}`);
        const searchData = (await searchRes.json()) as any;
        const coin = searchData.coins?.[0];
        if (coin) {
          const priceRes = await fetch(
            `https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_24hr_change=true`,
          );
          const priceData = (await priceRes.json()) as any;
          return { symbol, name: coin.name, priceUsd: priceData[coin.id]?.usd, change24h: priceData[coin.id]?.usd_24h_change };
        }
        return { error: "Token not found" };
      } catch (e) {
        return { error: String(e) };
      }
    },
  },

  getWalletActivity: {
    execute: async ({ address, limit }: any) => {
      const fetchLimit = limit ?? 20;
      const auth = Buffer.from(`${config.zerionApiKey}:`).toString("base64");
      try {
        const res = await fetch(
          `https://api.zerion.io/v1/wallets/${address}/transactions/?currency=usd&page[size]=${fetchLimit}&sort=-mined_at`,
          { headers: { Authorization: `Basic ${auth}`, accept: "application/json" } },
        );
        const data = (await res.json()) as any;
        return {
          transactions: (data.data || []).slice(0, fetchLimit).map((tx: any) => {
            const attrs = tx.attributes;
            return {
              date: attrs.mined_at?.slice(0, 10),
              type: attrs.operation_type,
              chain: tx.relationships?.chain?.data?.id,
              status: attrs.status,
              transfers: (attrs.transfers || []).map((t: any) => ({
                direction: t.direction,
                symbol: t.fungible_info?.symbol,
                amount: t.quantity?.float?.toFixed(4),
                valueUsd: t.value?.toFixed(2),
              })),
              hash: attrs.hash,
            };
          }),
        };
      } catch (e) {
        return { error: `Failed to fetch activity: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },

  buildRoute: {
    execute: async ({ fromToken, toToken, amountIn, fromChainId, toChainId, fromAddress, toAddress }: any) => {
      const recipient = toAddress && /^0x[0-9a-fA-F]{40}$/.test(toAddress) ? `&toAddress=${toAddress}` : "";
      const url = `https://li.quest/v1/quote?fromChain=${fromChainId}&toChain=${toChainId}&fromToken=${fromToken}&toToken=${toToken}&fromAmount=${amountIn}&fromAddress=${fromAddress}${recipient}&slippage=0.005`;
      try {
        const res = await fetch(url, { headers: { "x-lifi-api-key": config.lifiApiKey } });
        if (!res.ok) return { error: `LI.FI API error (${res.status}): ${await res.text()}` };
        const data = (await res.json()) as any;
        if (!data.transactionRequest) {
          return { error: "No transactionRequest in LI.FI response", rawResponse: JSON.stringify(data).slice(0, 500) };
        }
        const txReq = {
          to: data.transactionRequest.to as string,
          data: data.transactionRequest.data as string,
          value: (data.transactionRequest.value as string) || "0x0",
          chainId: fromChainId,
        };
        const estimate = data.estimate
          ? {
              fromAmount: data.estimate.fromAmount,
              toAmount: data.estimate.toAmount,
              toAmountMin: data.estimate.toAmountMin,
              approvalAddress: data.estimate.approvalAddress,
              gasCosts: data.estimate.gasCosts,
            }
          : undefined;

        // ERC-20 routes need the spender (LI.FI router) approved to pull the
        // input token first, or the swap/bridge reverts on-chain. LI.FI only
        // returns `approvalAddress` for ERC-20 inputs (native ETH needs none),
        // so its presence is the signal. We read the live allowance; if it's
        // short (or unreadable), we return ONLY the approval as a single tx —
        // NOT a bundled 2-step. The route is built one step at a time: the
        // route's calldata here was quoted against pre-approval state and the
        // LI.FI quote goes stale fast, so bundling it would revert by the time
        // the approval lands. The caller approves, confirms it on-chain, then
        // re-calls buildRoute for a fresh route tx. Approve is exact-amount.
        const fromTokenAddr = (
          (data.action?.fromToken?.address as string | undefined) ??
          (data.estimate?.fromToken?.address as string | undefined) ??
          (typeof fromToken === "string" ? fromToken : undefined)
        )?.toLowerCase();
        const spender = (estimate?.approvalAddress as string | undefined)?.toLowerCase();
        const needAmount = safeRawBigInt(data.estimate?.fromAmount);
        const isErc20 =
          !!fromTokenAddr &&
          /^0x[a-f0-9]{40}$/.test(fromTokenAddr) &&
          fromTokenAddr !== "0x0000000000000000000000000000000000000000" &&
          fromTokenAddr !== "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        if (spender && isErc20 && needAmount > 0n) {
          const allowance = await readAllowance(fromChainId, fromTokenAddr, fromAddress, spender);
          // null = couldn't read it → assume not approved (return approve; it's
          // cheap and idempotent for a fresh allowance, the common case here).
          if (allowance === null || allowance < needAmount) {
            const symbol = (data.action?.fromToken?.symbol as string | undefined) ?? "tokens";
            const approveData = "0x095ea7b3" + padAddress(spender) + padUint256(needAmount);
            return {
              approvalStep: true,
              to: fromTokenAddr,
              data: approveData,
              value: "0x0",
              chainId: fromChainId,
              description: `Approve the LI.FI router (${spender.slice(0, 8)}…) to spend ${symbol}`,
              estimate,
              note: "APPROVAL REQUIRED FIRST. Present ONLY this approval as a single { type:'transaction' } card (step 1 of 2) — do NOT build or include the swap/bridge yet, and do NOT simulate the approval (approvals have no asset changes). After the user submits it and you confirm on-chain that it succeeded (getTransactionDetails), call buildRoute again with the SAME args to get a FRESH route tx — only then present the swap/bridge. Building the route before the approval confirms gives a stale quote that reverts.",
            };
          }
        }
        return { ...txReq, estimate };
      } catch (e) {
        return { error: `Failed to fetch LI.FI quote: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },

  getRouteStatus: {
    execute: async ({ txHash, fromChain, toChain }: any) => {
      const url = `https://li.quest/v1/status?txHash=${txHash}&fromChain=${fromChain}&toChain=${toChain}`;
      try {
        const res = await fetch(url, { headers: { "x-lifi-api-key": config.lifiApiKey } });
        if (!res.ok) return { error: `LI.FI status API error (${res.status}): ${await res.text()}` };
        const data = (await res.json()) as any;
        return {
          status: data.status as string,
          substatus: data.substatus as string | undefined,
          substatusMessage: data.substatusMessage as string | undefined,
          sending: data.sending
            ? {
                txHash: data.sending.txHash,
                amount: data.sending.amount,
                token: data.sending.token?.symbol,
                chainId: data.sending.chainId,
              }
            : undefined,
          receiving: data.receiving
            ? {
                txHash: data.receiving.txHash,
                amount: data.receiving.amount,
                token: data.receiving.token?.symbol,
                chainId: data.receiving.chainId,
              }
            : undefined,
        };
      } catch (e) {
        return { error: `Failed to check route status: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },

  buildTransfer: {
    execute: async ({ to, amount, token, chainId, tokenDecimals }: any) => {
      const chain = chainId ?? 1;
      const decimals = tokenDecimals ?? 18;
      if (String(token).toUpperCase() === "ETH") {
        return { to, data: "0x", value: toHex(safeBigInt(amount, 18)), chainId: chain };
      }
      return {
        to: token,
        data: "0xa9059cbb" + padAddress(to) + padUint256(safeBigInt(amount, decimals)),
        value: "0x0",
        chainId: chain,
      };
    },
  },

  resolveENS: {
    execute: async ({ name }: any) => {
      try {
        const res = await fetch(`https://api.ensideas.com/ens/resolve/${name}`);
        if (!res.ok) return { error: `ENS resolution failed (${res.status})` };
        const data = (await res.json()) as any;
        return {
          address: data.address as string,
          name: data.name as string,
          displayName: data.displayName as string,
          avatar: data.avatar as string,
        };
      } catch (e) {
        return { error: `Failed to resolve ENS: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },

  getTokenAddress: {
    execute: async ({ symbol, chainId }: any) => {
      const upper = String(symbol).toUpperCase();
      const chainTokens = TOKEN_ADDRESSES[String(chainId)];
      if (chainTokens) {
        if (chainTokens[upper]) return chainTokens[upper];
        const match = Object.entries(chainTokens).find(([k]) => k.toUpperCase() === upper);
        if (match) return match[1];
      }
      try {
        const res = await fetch(`https://li.quest/v1/tokens?chains=${chainId}`, {
          headers: { "x-lifi-api-key": config.lifiApiKey },
        });
        if (!res.ok) return { error: `LI.FI token search failed (${res.status})` };
        const data = (await res.json()) as any;
        const tokens: any[] = data.tokens?.[String(chainId)] || [];
        const exact = tokens.find(t => String(t.symbol).toUpperCase() === upper);
        if (exact) return { address: exact.address, decimals: exact.decimals, name: exact.name };
        return { error: `Token '${symbol}' not found on chain ${chainId}` };
      } catch (e) {
        return { error: `Token search failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },

  wrapEth: {
    execute: async ({ amount, chainId }: any) => {
      const chain = chainId ?? 1;
      return {
        to: nativeWrapper(chain),
        data: "0xd0e30db0",
        value: toHex(safeBigInt(amount, 18)),
        chainId: chain,
      };
    },
  },

  unwrapWeth: {
    execute: async ({ amount, chainId }: any) => {
      const chain = chainId ?? 1;
      return {
        to: nativeWrapper(chain),
        data: "0x2e1a7d4d" + padUint256(safeBigInt(amount, 18)),
        value: "0x0",
        chainId: chain,
      };
    },
  },

  validateENSName: {
    execute: async ({ name }: any) => {
      const label = String(name).replace(/\.eth$/i, "").toLowerCase();
      if (label.length < 3) return { valid: false, name: label, error: `ENS name "${label}" is too short — minimum 3 characters.` };
      if (label.length > 173) return { valid: false, name: label, error: `ENS name "${label}" is too long — maximum 173 characters.` };
      if (!/^[a-z0-9_-]+$/.test(label)) {
        return { valid: false, name: label, error: `ENS name "${label}" contains invalid characters.` };
      }
      if (label.includes("_")) {
        const firstNonUnderscore = label.search(/[^_]/);
        if (firstNonUnderscore === -1) return { valid: false, name: label, error: `ENS name cannot be only underscores.` };
        if (label.slice(firstNonUnderscore).includes("_")) {
          return {
            valid: false,
            name: label,
            error: `ENS name "${label}" has underscores in invalid positions. Underscores are only allowed as leading characters.`,
          };
        }
      }
      return { valid: true, name: label };
    },
  },

  checkENSAvailability: {
    execute: async ({ name }: any) => {
      const label = String(name).replace(/\.eth$/i, "").toLowerCase();
      const fullName = `${label}.eth`;
      if (label.length < 3) return { available: false, name: label, valid: false, error: `ENS name "${label}" is too short.` };
      if (label.length > 173) return { available: false, name: label, valid: false, error: `ENS name "${label}" is too long.` };
      if (!/^[a-z0-9_-]+$/.test(label)) {
        return { available: false, name: label, valid: false, error: `ENS name "${label}" contains invalid characters.` };
      }
      if (label.includes("_")) {
        const firstNonUnderscore = label.search(/[^_]/);
        const afterPrefix = firstNonUnderscore === -1 ? "" : label.slice(firstNonUnderscore);
        if (firstNonUnderscore === -1 || afterPrefix.includes("_")) {
          return { available: false, name: label, valid: false, error: `ENS name "${label}" has underscores in invalid positions.` };
        }
      }
      try {
        const node = namehash(fullName);
        const calldata = "0x02571be3" + node.replace("0x", "");
        const res = await fetch("https://mainnet.rpc.buidlguidl.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e", data: calldata }, "latest"],
          }),
        });
        const json = (await res.json()) as any;
        const result = json?.result as string;
        const owner = "0x" + result?.slice(-40);
        return { available: !result || owner === "0x0000000000000000000000000000000000000000", valid: true, name: label };
      } catch (e) {
        return { error: `Failed to check ENS availability: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },

  getENSRentPrice: {
    execute: async ({ name, years }: any) => {
      const label = String(name).replace(/\.eth$/i, "");
      const duration = BigInt(years * 365 * 24 * 60 * 60);
      try {
        const calldata = "0x83e7f6ff" + padUint256(64n) + padUint256(duration) + encodeString(label);
        const res = await fetch(alchemyUrl(1), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to: ENS_REGISTRAR, data: calldata }, "latest"],
          }),
        });
        const json = (await res.json()) as any;
        if (json.error) return { error: json.error.message || JSON.stringify(json.error) };
        const result = (json.result || "0x").replace("0x", "");
        const base = BigInt("0x" + (result.slice(0, 64) || "0"));
        const premium = BigInt("0x" + (result.slice(64, 128) || "0"));
        const total = base + premium;
        return {
          priceWei: total.toString(),
          priceEth: (Number(total) / 1e18).toFixed(6),
          baseWei: base.toString(),
          premiumWei: premium.toString(),
          years,
          name: label,
        };
      } catch (e) {
        return { error: `Failed to get ENS rent price: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },

  buildENSRegistration: {
    execute: async ({ name, years, owner }: any) => {
      const label = String(name).replace(/\.eth$/i, "").toLowerCase();
      const duration = BigInt(years * 365 * 24 * 60 * 60);
      if (label.length < 3) return { error: `ENS name "${label}" is too short — minimum 3 characters.` };
      if (label.length > 173) return { error: `ENS name "${label}" is too long — maximum 173 characters.` };
      if (!/^[a-z0-9_-]+$/.test(label)) return { error: `ENS name "${label}" contains invalid characters.` };
      if (label.includes("_")) {
        const firstNonUnderscore = label.search(/[^_]/);
        const afterPrefix = firstNonUnderscore === -1 ? "" : label.slice(firstNonUnderscore);
        if (firstNonUnderscore === -1 || afterPrefix.includes("_")) {
          return { error: `ENS name "${label}" has underscores in invalid positions.` };
        }
      }
      const secretHex = "0x" + randomBytes(32).toString("hex");
      try {
        const priceCalldata = "0x83e7f6ff" + padUint256(64n) + padUint256(duration) + encodeString(label);
        const priceRes = await fetch(alchemyUrl(1), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to: ENS_REGISTRAR, data: priceCalldata }, "latest"],
          }),
        });
        const priceJson = (await priceRes.json()) as any;
        if (priceJson.error) {
          return { error: `Failed to get rent price: ${priceJson.error.message || JSON.stringify(priceJson.error)}` };
        }
        const priceResult = (priceJson.result || "0x").replace("0x", "");
        const base = BigInt("0x" + (priceResult.slice(0, 64) || "0"));
        const premium = BigInt("0x" + (priceResult.slice(64, 128) || "0"));
        const totalPrice = base + premium;
        const valueWithBuffer = (totalPrice * 110n) / 100n;
        const priceEth = Number(totalPrice) / 1e18;

        const params = encodeENSParams(label, owner, duration, secretHex, ENS_PUBLIC_RESOLVER, true, 0);
        const commitmentRes = await fetch(alchemyUrl(1), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to: ENS_REGISTRAR, data: "0x65a69dcf" + params }, "latest"],
          }),
        });
        const commitmentJson = (await commitmentRes.json()) as any;
        if (commitmentJson.error) {
          return { error: `Failed to compute commitment: ${commitmentJson.error.message || JSON.stringify(commitmentJson.error)}` };
        }
        const commitment = commitmentJson.result as string;
        const commitCalldata = "0xf14fcbc8" + commitment.replace("0x", "").padStart(64, "0");
        const registerCalldata = "0x74694a2b" + params;
        return {
          type: "multistep_transaction",
          message: `I'll register **${label}.eth** for you. This is a 2-step process:\n1. **Commit** — locks in your registration intent (gas only)\n2. **Wait 60 seconds** — required by the ENS contract\n3. **Register** — completes registration (${priceEth.toFixed(4)} ETH + gas)`,
          steps: [
            {
              to: ENS_REGISTRAR,
              data: commitCalldata,
              value: "0x0",
              chainId: 1,
              description: `Step 1 of 2: Commit to register ${label}.eth`,
              label: "Commit",
            },
            {
              to: ENS_REGISTRAR,
              data: registerCalldata,
              value: toHex(valueWithBuffer),
              chainId: 1,
              description: `Step 2 of 2: Register ${label}.eth (${priceEth.toFixed(4)} ETH for ${years} year${years > 1 ? "s" : ""})`,
              label: "Register",
            },
          ],
          delay: 65000,
          priceEth: priceEth.toFixed(6),
          priceWei: totalPrice.toString(),
        };
      } catch (e) {
        return { error: `Failed to build ENS registration: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },

  // Build calldata for a self-call that changes the multisig's own signer set
  // or threshold. The wallet IS a slop Multisig; these execute via the normal
  // threshold-approved exec flow (target = the wallet's own address). Returns
  // { to, value, data } ready to drop into a transaction. addPasskeySigner is
  // intentionally NOT handled here — registering a passkey needs a browser
  // WebAuthn enrollment ceremony (to mint qx/qy/credentialId) that the relay
  // cannot perform; tell the user to add a passkey from the wallet UI instead.
  buildSignerChange: {
    execute: async ({ action, signer, threshold, multisigAddress }: any) => {
      const SEL: Record<string, string> = {
        addAccountSigner: "aba7f004",
        removeSigner: "0e316ab7",
        changeThreshold: "694e80c3",
      };
      const to = typeof multisigAddress === "string" ? multisigAddress.toLowerCase() : "";
      if (!/^0x[0-9a-f]{40}$/.test(to)) {
        return { error: "multisigAddress (the wallet's own address) is required for a self-call." };
      }
      if (action === "addAccountSigner" || action === "removeSigner") {
        if (typeof signer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(signer)) {
          return { error: `${action} needs a valid 20-byte address in 'signer' (resolve ENS first).` };
        }
        const data = "0x" + SEL[action] + signer.toLowerCase().replace(/^0x/, "").padStart(64, "0");
        return {
          to,
          value: "0x0",
          data,
          description: `${action === "addAccountSigner" ? "Add" : "Remove"} signer ${signer}`,
        };
      }
      if (action === "changeThreshold") {
        let n: bigint;
        try {
          n = BigInt(threshold);
        } catch {
          return { error: "changeThreshold needs an integer 'threshold'." };
        }
        if (n < 1n) return { error: "threshold must be >= 1." };
        const data = "0x" + SEL.changeThreshold + n.toString(16).padStart(64, "0");
        return { to, value: "0x0", data, description: `Change threshold to ${n.toString()}` };
      }
      if (action === "addPasskeySigner") {
        return {
          error:
            "Adding a passkey requires a browser WebAuthn enrollment (to create the new credential and read its P-256 public key) — the relay can't do it. Tell the user to add a passkey from the wallet UI on the device that will hold it.",
        };
      }
      return { error: `Unknown action '${action}'. Use addAccountSigner | removeSigner | changeThreshold.` };
    },
  },

  logMiss: {
    // Optional internal miss log. No-ops unless MISS_LOG_GIST_ID +
    // GITHUB_GIST_TOKEN are set on the relay.
    execute: async ({ userRequest, reason, category }: any) => {
      try {
        const gistId = process.env.MISS_LOG_GIST_ID;
        const token = process.env.GITHUB_GIST_TOKEN;
        if (!gistId || !token) return { logged: false };
        const getRes = await fetch(`https://api.github.com/gists/${gistId}`, {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "slop-ai-wallet" },
        });
        const gist = (await getRes.json()) as any;
        const current = JSON.parse(gist?.files?.["misses.json"]?.content ?? "[]");
        current.push({ ts: new Date().toISOString(), userRequest, reason, category });
        await fetch(`https://api.github.com/gists/${gistId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "slop-ai-wallet", "Content-Type": "application/json" },
          body: JSON.stringify({ files: { "misses.json": { content: JSON.stringify(current.slice(-500), null, 2) } } }),
        });
        return { logged: true };
      } catch {
        return { logged: false };
      }
    },
  },

  getTokenLiquidity: {
    execute: async ({ tokenAddress, chain }: any) => {
      const chainMap: Record<string, string> = {
        ethereum: "eth",
        base: "base",
        arbitrum: "arbitrum",
        optimism: "optimism",
        polygon: "polygon",
        gnosis: "xdai",
        xdai: "xdai",
        "binance-smart-chain": "bsc",
        avalanche: "avax",
        zksync: "zksync",
        scroll: "scroll",
        linea: "linea",
        mantle: "mantle",
      };
      const network = chainMap[chain] || chain;
      try {
        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}/pools?page=1`,
          { headers: { accept: "application/json" } },
        );
        if (!res.ok) return { error: `GeckoTerminal API error: ${res.status}` };
        const data = (await res.json()) as any;
        const pools = (data.data || []).map((p: any) => ({
          dex: p.relationships?.dex?.data?.id,
          poolAddress: p.attributes?.address,
          name: p.attributes?.name,
          liquidityUsd: parseFloat(p.attributes?.reserve_in_usd || "0"),
          volume24hUsd: parseFloat(p.attributes?.volume_usd?.h24 || "0"),
          priceUsd: p.attributes?.base_token_price_usd,
        }));
        if (pools.length === 0) {
          return {
            found: false,
            tokenAddress,
            chain,
            message: `No liquidity pools found for ${tokenAddress} on ${chain}.`,
          };
        }
        const totalLiquidity = pools.reduce((s: number, p: any) => s + p.liquidityUsd, 0);
        return {
          found: true,
          tokenAddress,
          chain,
          totalLiquidityUsd: totalLiquidity,
          poolCount: pools.length,
          bestPool: pools[0],
          pools: pools.slice(0, 5),
          swappable: totalLiquidity > 10,
          warning:
            totalLiquidity < 100
              ? `Very low liquidity ($${totalLiquidity.toFixed(2)}) — expect high slippage or swap failure`
              : undefined,
        };
      } catch (e) {
        return { error: `getTokenLiquidity failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the assistant for a "slop" Multisig wallet, with full visibility into its portfolio and transaction history.

WHAT THIS WALLET IS (important — do NOT treat it as a plain EOA):
- It is a SMART-CONTRACT multisig wallet (a "slop Multisig", similar in spirit to a Safe), deployed at the address given in context. It has an M-of-N signer set and a threshold.
- Signers are one of two kinds: "account" signers (a normal EOA, a 7702 smart account, a Safe, or another Multisig — anything validated by ECDSA-or-ERC1271) and "passkey" signers (WebAuthn / Face-ID / security key). The current signers + threshold are injected in context below.
- Because it's a contract, it CAN change its own membership and threshold. You do this by proposing a transaction that calls the wallet ON ITSELF (target = the wallet's own address, value 0x0) — exactly like a Safe owner change. Use the buildSignerChange tool to get the calldata; never hand-write it.
- So when the user says "add a signer", "remove a signer", "make it 2-of-3", etc. — you CAN do that. Do NOT say "that's only for smart wallets / I can't manage an EOA". This IS a smart wallet.
- EXCEPTION — adding a PASSKEY: you cannot do this from here. Registering a passkey needs a browser WebAuthn enrollment (to mint the credential and read its P-256 public key) on the device that will hold it. Tell the user to add a passkey from the wallet UI; you can still add/remove account signers and change the threshold yourself.
- Any signer/threshold change is a normal multisig transaction: it still has to be approved by the wallet's signers to threshold before it executes. You just propose it.

HOW A TRANSACTION ACTUALLY EXECUTES (the multisig flow):
- You never send a transaction directly. You PROPOSE one (target, value, calldata). The wallet's signers each sign the proposal's exec hash, and once "threshold" signatures are collected the multisig's execTransaction runs the call on-chain. So everything you build is a proposal that still needs M-of-N approval.
- Account signers approve with a normal ECDSA signature (raw or personal_sign) or, for contract signers (Safe / nested Multisig), an ERC-1271 signature. Passkey signers approve with a WebAuthn/P-256 signature. The wallet validates all of these; you don't need to care which kind a signer is.
- The wallet can also batch several calls into one atomic approval (execBatchTransaction) — relevant if the user wants multiple actions to land together.

WHERE THIS WALLET LIVES (cross-chain — same address everywhere):
- The slop Multisig is deployed at the SAME address on every chain we support: Ethereum (1), Optimism (10), Gnosis (100), Polygon (137), Arbitrum (42161), and Base (8453). The address in context is valid on all of them.
- Robinhood Chain (4663) is ALSO a supported network for balances, swaps, sends, and bridges: it's Robinhood's Arbitrum-stack L2 (ETH gas, settles to Ethereum, mainnet since July 2026), and LI.FI routes to it — buildRoute with toChainId 4663 works. Native ETH there is plain ETH.
- CAUTION for Robinhood Chain (4663) specifically: the slop Multisig FACTORY is not deployed there yet, so the multisig's own address is NOT controlled by anyone on 4663. NEVER bridge the multisig's funds to its own address on Robinhood Chain — they would be stranded. Bridging to an EOA the user controls (their own connected address, or an explicit recipient) on 4663 is fine.
- BUT each chain is independent: separate balances, separate nonce, separate signer-set state. Holding ETH on Base says nothing about Polygon.
- Approvals are per-chain too. Each exec hash is bound to its chainId, so a signature collected on one chain CANNOT be replayed on another. To do the same action on two chains, you propose it once per chain. Build every transaction for the chain the user means (default to the connected chain ID in context).

YOU ALWAYS HAVE:
- The user's current portfolio (all tokens, all chains, USD values) — injected in context below
- The user's DeFi positions (staked, deposited, LP, locked tokens with protocol names) — injected in context below
- The user's recent 20 transactions — injected in context below
- Tools to look up more detailed history, prices, and to build transactions

INTENT CLASSIFICATION (read this FIRST before doing anything):
- "do you know...?", "are you aware...?", "did you know...?" → The user is asking whether you KNOW something. Respond conversationally confirming or denying your knowledge. Do NOT call any tools. Do NOT dump portfolio data. Just answer the question in plain English.
- "what do I have?", "show me my portfolio", "how much X?" → Portfolio/balance question. Use injected data or tools.
- "swap X", "send X", "bridge X" → Transaction request. Build calldata.
- "add/remove a signer", "add 0x… / name.eth as a signer", "change the threshold", "make it 2-of-3" → Transaction request: a self-call. Build it with buildSignerChange. (Adding a PASSKEY is the one exception — direct them to the wallet UI.)
- If unsure, default to a conversational chat response and ask for clarification. NEVER dump unrelated data.

WHEN ANSWERING QUESTIONS:
- Injected portfolio + DeFi positions = your starting point for overviews
- For ANY specific question about a token/balance on a specific chain → call getOnChainBalance to get the LIVE on-chain value.
- For ANY question about past transactions → call searchTransactions. NEVER say you can't find something without calling this first.
- Once you have a tx hash, call getTransactionDetails for sender/receiver. NEVER say "check a block explorer".
- For "how is X doing?" or "what's the price of X?" → call getTokenPrice.
- Be specific: always give dates, amounts, chains, USD values.
- Keep answers concise — 2-4 sentences unless they ask for more detail.

WHEN TO BUILD A TRANSACTION:
Only when the user clearly wants to execute: "swap", "send", "bridge", "wrap", "buy", "sell", or change signers/threshold (add/remove signer, change threshold).
Chat (plain English) for portfolio questions, prices, explanations, history, ambiguous input, or small talk.

RESPONSE RULES:
- For chat: respond in plain English, 2-4 sentences max, conversational.
- For transactions: use your tools to build + simulate it, then respond with the JSON transaction format.
- NEVER show error-like output for simple questions.
- NEVER say "I don't have access to your transaction history" — you DO.

AVAILABLE TOOLS:
- simulateAssetChanges: Simulate a tx to see exact asset changes. USE THIS to verify every transaction.
- traceCall: Full EVM trace for debugging.
- getPortfolio / getOnChainBalance: balances. searchTransactions / getTransactionDetails / getWalletActivity: history.
- getTokenPrice: current price + 24h change. getTokenAddress: token contract lookup. getTokenLiquidity: DEX pools.
- buildRoute: swap / bridge / DeFi-zap calldata via LI.FI. getRouteStatus: cross-chain transfer status.
- buildTransfer: ETH/ERC-20 transfer calldata. wrapEth / unwrapWeth. resolveENS.
- buildSignerChange: calldata to add/remove an account signer or change this wallet's threshold (a self-call). Resolve ENS to an address first; pass the wallet's own address as multisigAddress. Returns { to, value, data } → return it as a transaction response. (Passkeys must be added from the wallet UI, not here.)
- validateENSName, checkENSAvailability, getENSRentPrice, buildENSRegistration: ENS workflow.
- logMiss: call when you cannot fulfill a request.

MANDATORY WORKFLOW (for transactions only):
1. If you need balance info → call getPortfolio first.
2. Resolve any ENS names → call resolveENS.
3. For swaps/bridges: use buildRoute with token symbols. APPROVE-THEN-ROUTE IS ONE STEP AT A TIME, never bundled. If buildRoute returns approvalStep:true, the input token isn't approved yet — present ONLY that approval as a single { type:"transaction" } card and tell the user it's step 1 of 2 (an approval, then the swap/bridge once it lands). Do NOT build or present the swap/bridge in the same turn — its quote would go stale before the approval confirms and revert. After the user submits the approval and you've confirmed on-chain it succeeded, call buildRoute again with the same args; it now returns the actual swap/bridge tx to present. Otherwise (no approval needed) buildRoute returns the route tx directly.
4. For simple transfers: use buildTransfer. For WETH wrap/unwrap: use wrapEth / unwrapWeth.
5. For ENS registration: validateENSName → checkENSAvailability → getENSRentPrice → (user confirms) → buildENSRegistration.
6. ALWAYS call simulateAssetChanges on built calldata before returning (skip ONLY for: ENS multistep, a standalone ERC-20 approval (approvalStep — approvals have no asset changes), AND signer/threshold self-calls — config self-calls correctly show no asset changes; return those directly).
7. ACT ON THE SIMULATION RESULT — this is the single most important rule, do not skip it:
   - reverted:true → the transaction WILL FAIL on-chain. DO NOT present it. Return a { type:"chat" } message telling the user it reverts in simulation, and diagnose why (e.g. for a swap, the input token may not be approved yet — re-check buildRoute for an approvalStep; or call getTokenLiquidity). NEVER hand the user a tx that reverts in simulation.
   - success:true → verified. Present the transaction; its "simulation" field is { "verified": true, "changes": [...] } from the tool's changes.
   - simulated:false (sim could not run — provider error or unsupported chain like Gnosis or Robinhood Chain) → first retry simulateAssetChanges ONCE. If it still can't run: you MAY present the tx ONLY with simulation { "verified": false, "changes": [] } AND a plain-English warning in "message" that you could NOT verify it and it may revert. NEVER claim numbers are confirmed when simulated:false. Do not present unverified on a chain where simulation normally works (Ethereum/Base/Arbitrum/Optimism/Polygon) without saying the simulator errored.
8. If buildRoute returns an error → call getTokenLiquidity to diagnose and explain why.

RESPONSE FORMAT:

For chat responses, return ONLY this JSON:
{ "type": "chat", "message": "your conversational response here" }

For transaction responses, return ONLY this JSON (after all tool calls complete):
{ "type": "transaction", "message": "I'll swap 0.1 ETH for USDC:", "transaction": { "to": "0x...", "data": "0x...", "value": "0x...", "chainId": 1, "description": "Swap 0.1 ETH → ~198 USDC", "simulation": { "verified": true, "changes": [{ "direction": "out", "symbol": "ETH", "amount": "0.1" }] } } }

For ENS registration multistep — return the tool result directly:
{ "type": "multistep_transaction", "message": "...", "steps": [ ... ], "delay": 65000 }
(Swaps/bridges are NEVER multistep — an approval, if needed, is its own single transaction returned one turn before the route.)

DELAY RULES:
- ENS registration: delay 65000 (set by buildENSRegistration). Everything else: 0.

RULES:
- Token contract addresses are injected in the portfolio context as [0x...] after each token. USE THESE FIRST.
- Never return a transaction that failed simulation. Work in wei internally, display human units.
- The "simulation" field, IF present, MUST be exactly { "verified": bool, "changes": [...] } with a changes array (use [] when there are none). NEVER emit a simulation object with a "note" or any other shape, and if you didn't/couldn't simulate, OMIT the simulation field entirely rather than sending a partial one.
- For native ETH in LI.FI: use symbol "ETH".
- buildRoute can deliver a bridge to a DIFFERENT recipient: pass toAddress when the user names one (e.g. "bridge $10 of Base ETH to 0xabc… on Robinhood Chain"). Confirm the recipient address back to the user in the card description.
- If the user's request is unclear, respond with a chat message asking for clarification.
- NEVER claim on-chain verification results without actually calling a verification tool.
- TX STATUS: if a user message reports a submitted transaction with a tx hash (e.g. "submitted tx 0x… on chain N"), NEVER ask the user for the hash — it's already given. Immediately check it yourself: for a cross-chain bridge use getRouteStatus(txHash, fromChain, toChain) (infer the chains from the route you proposed earlier in this conversation); for anything else use getTransactionDetails(txHash, chainId). Then report concisely whether it succeeded, is pending, or what went wrong. If the submitted tx was an ERC-20 approval for a swap/bridge: once you confirm it succeeded, immediately call buildRoute again with the original route args to build the now-ready swap/bridge, simulate it, and present that as the next transaction — don't make the user ask. (If buildRoute still returns approvalStep:true, the approval hasn't settled yet — tell the user to wait a moment and ping you; do NOT present a second approval.)`;

// Appended to SYSTEM_PROMPT when the chat is operating the user's own
// connected EOA (walletKind:"eoa") rather than a slop Multisig. The base
// prompt is multisig-framed; without this the AI insists the user's own
// MetaMask address is a contract and refuses safe cross-chain sends to it.
const EOA_MODE_OVERRIDE = `

MODE OVERRIDE — CONNECTED EOA SESSION (read last; this section SUPERSEDES every multisig instruction above):
- The wallet address in context is the user's OWN externally-owned account — their connected wallet (MetaMask, Rainbow, a hardware wallet, …). It is NOT a slop Multisig and NOT a smart contract. Never claim it is, no matter what the sections above say.
- Transactions you build execute DIRECTLY from that wallet: the user signs and it sends. There is NO proposal queue, NO signer set, NO threshold, NO exec hash. Never mention proposals or M-of-N approval.
- An EOA is controlled by the same private key on EVERY EVM chain, including Robinhood Chain (4663). Bridging or sending funds to the user's own address on ANY chain is SAFE — the multisig-stranding caution above applies only to multisig contract addresses, never to this wallet.
- buildSignerChange does not apply here. If the user asks about signers or thresholds, explain that their connected wallet is a regular EOA and those features live in the Bank / personal wallet multisigs.`;

// ─── OpenAI tool schemas ─────────────────────────────────────────────────────

const openAiTools: OpenAI.Chat.ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "simulateAssetChanges",
      description:
        "Simulate a transaction (eth_simulateV1) to see exactly what assets leave/enter the wallet AND whether it reverts. Returns { success, simulated, reverted, error, changes }. reverted:true means the tx WILL fail on-chain — do NOT present it. simulated:false means the sim could not run (provider error or unsupported chain). success:true with changes = verified.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          data: { type: "string" },
          value: { type: "string" },
          chainId: { type: "number" },
        },
        required: ["from", "to", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "traceCall",
      description: "Full EVM execution trace via debug_traceCall.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          data: { type: "string" },
          value: { type: "string" },
          chainId: { type: "number" },
        },
        required: ["from", "to", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getPortfolio",
      description: "Get all token balances for the user's wallet across all chains.",
      parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
    },
  },
  {
    type: "function",
    function: {
      name: "searchTransactions",
      description: "Search the wallet's full on-chain transaction history.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string" },
          tokenSymbol: { type: "string" },
          chainId: { type: "string" },
          operationType: { type: "string" },
          afterDate: { type: "string" },
          beforeDate: { type: "string" },
          limit: { type: "number" },
        },
        required: ["address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getTransactionDetails",
      description: "Look up full details of a specific transaction by hash.",
      parameters: {
        type: "object",
        properties: { hash: { type: "string" }, chain: { type: "string" } },
        required: ["hash", "chain"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getOnChainBalance",
      description: "Get the LIVE on-chain balance of ETH or any ERC-20 token for a wallet address.",
      parameters: {
        type: "object",
        properties: {
          walletAddress: { type: "string" },
          chain: { type: "string" },
          tokenAddress: { type: "string" },
          tokenSymbol: { type: "string" },
          tokenDecimals: { type: "number" },
        },
        required: ["walletAddress", "chain"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getTokenPrice",
      description: "Get the current USD price and 24h change for a token by symbol.",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
  },
  {
    type: "function",
    function: {
      name: "getWalletActivity",
      description: "Get the user's recent cross-chain transaction history.",
      parameters: {
        type: "object",
        properties: { address: { type: "string" }, limit: { type: "number" } },
        required: ["address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buildRoute",
      description:
        "Build swap, bridge, or DeFi zap calldata via LI.FI. Returns the route tx when the input token is already approved; returns { approvalStep: true, ... } (a single ERC-20 approval tx) when the allowance is missing — present only that, then call buildRoute again after it confirms to get the route tx.",
      parameters: {
        type: "object",
        properties: {
          fromToken: { type: "string" },
          toToken: { type: "string" },
          amountIn: { type: "string" },
          fromChainId: { type: "number" },
          toChainId: { type: "number" },
          fromAddress: { type: "string" },
          toAddress: {
            type: "string",
            description:
              "Optional recipient on the destination chain (0x address). Omit to deliver to fromAddress. Use when the user names an explicit recipient for a bridge.",
          },
        },
        required: ["fromToken", "toToken", "amountIn", "fromChainId", "toChainId", "fromAddress"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getRouteStatus",
      description: "Check the status of a cross-chain LI.FI transfer.",
      parameters: {
        type: "object",
        properties: { txHash: { type: "string" }, fromChain: { type: "number" }, toChain: { type: "number" } },
        required: ["txHash", "fromChain", "toChain"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buildTransfer",
      description: "Build ETH or ERC-20 transfer calldata.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          amount: { type: "string" },
          token: { type: "string" },
          fromAddress: { type: "string" },
          chainId: { type: "number" },
        },
        required: ["to", "amount", "token"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolveENS",
      description: "Resolve an ENS name to an Ethereum address.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "getTokenAddress",
      description: "Look up a token's contract address by symbol on a given chain.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" }, chainId: { type: "number" } },
        required: ["symbol", "chainId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wrapEth",
      description: "Wrap ETH to WETH.",
      parameters: {
        type: "object",
        properties: { amount: { type: "string" }, chainId: { type: "number" } },
        required: ["amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unwrapWeth",
      description: "Unwrap WETH to ETH.",
      parameters: {
        type: "object",
        properties: { amount: { type: "string" }, chainId: { type: "number" } },
        required: ["amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validateENSName",
      description: "Validate an ENS name. Must be called FIRST in any ENS registration workflow.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "checkENSAvailability",
      description: "Check if an ENS name is available for registration.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "getENSRentPrice",
      description: "Get the rent price for registering an ENS name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, years: { type: "number" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buildENSRegistration",
      description: "Build the 2-step ENS registration transaction.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, owner: { type: "string" }, years: { type: "number" } },
        required: ["name", "owner"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buildSignerChange",
      description:
        "Build calldata to change THIS wallet's own signers or threshold (it's a smart-contract multisig). Use for 'add a signer', 'remove a signer', 'make it 2-of-3', etc. Returns { to, value, data } for a self-call transaction. Resolve ENS to an address first. NOTE: action 'addPasskeySigner' is not supported here — passkeys must be added from the wallet UI.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["addAccountSigner", "removeSigner", "changeThreshold"] },
          signer: { type: "string", description: "20-byte address (for addAccountSigner / removeSigner)" },
          threshold: { type: "number", description: "new threshold (for changeThreshold)" },
          multisigAddress: { type: "string", description: "this wallet's own address (the self-call target)" },
        },
        required: ["action", "multisigAddress"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "logMiss",
      description: "Call this when you cannot fulfill a user request.",
      parameters: {
        type: "object",
        properties: { userRequest: { type: "string" }, reason: { type: "string" }, category: { type: "string" } },
        required: ["userRequest", "reason", "category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getTokenLiquidity",
      description: "Look up all DEX liquidity pools for a token by contract address.",
      parameters: {
        type: "object",
        properties: { tokenAddress: { type: "string" }, chain: { type: "string" } },
        required: ["tokenAddress", "chain"],
      },
    },
  },
];

// ─── Public types ────────────────────────────────────────────────────────────

export type IntentTransaction = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  description?: string;
  simulation?: { verified: boolean; changes: { direction: string; symbol: string; amount: string }[] };
};

export type IntentStep = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  description: string;
  label: string;
};

export type IntentResult =
  | { type: "chat"; message: string; error?: string }
  | { type: "transaction"; message: string; transaction: IntentTransaction }
  | {
      type: "multistep_transaction";
      message: string;
      steps: IntentStep[];
      delay: number;
      priceEth?: string;
      priceWei?: string;
    };

export type WalletIntentInput = {
  message: string;
  address: string;
  chainId?: number;
  portfolio?: {
    tokenSymbol: string;
    balance: string;
    balanceUsd: string;
    blockchain: string;
    contractAddress?: string;
  }[];
  defiPositions?: {
    tokenName: string;
    tokenSymbol: string;
    positionType: string;
    protocol: string | null;
    balance: string;
    balanceUsd: string;
    blockchain: string;
    contractAddress?: string;
  }[];
  recentMessages?: { role: string; content: string }[];
  // The wallet's own multisig membership, so the AI can reason about
  // add/remove-signer and threshold changes.
  signers?: { address: string; kind: "account" | "passkey"; label?: string }[];
  threshold?: number;
  // What kind of wallet the chat is operating: a slop Multisig (Bank or
  // personal passkey multisig) or the user's own connected EOA. The system
  // prompt is multisig-framed; "eoa" appends an override so the AI never
  // treats the user's MetaMask address as a contract. Defaults to multisig
  // for back-compat.
  walletKind?: "multisig" | "eoa";
  recentActivity?: {
    type: string;
    chain: string;
    minedAt: string;
    out: { symbol: string; amount: string } | null;
    in: { symbol: string; amount: string } | null;
    valueUsd: number | null;
  }[];
};

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runWalletIntent(input: WalletIntentInput): Promise<IntentResult> {
  if (!config.aiWalletLlmKey) {
    return { type: "chat", message: "Wallet AI is not configured on the relay (missing SLOP_COMPUTER_AI_WALLET)." };
  }

  const userChainId = input.chainId ?? 1;

  const portfolioAssets = input.portfolio ?? [];
  const totalUsd = portfolioAssets.reduce((s, a) => s + (parseFloat(a.balanceUsd) || 0), 0);
  const portfolioSummary = portfolioAssets.length
    ? `\n\nPortfolio (${portfolioAssets.length} assets, total $${totalUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}):\n${portfolioAssets
        .map(
          a =>
            `- ${parseFloat(a.balance).toFixed(4)} ${a.tokenSymbol} ($${parseFloat(a.balanceUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}) on ${a.blockchain}${a.contractAddress ? ` [${a.contractAddress}]` : ""}`,
        )
        .join("\n")}`
    : "";

  const defiItems = input.defiPositions ?? [];
  const defiTotalUsd = defiItems.reduce((s, a) => s + (parseFloat(a.balanceUsd) || 0), 0);
  const defiSummary = defiItems.length
    ? `\n\nDeFi Positions (${defiItems.length} positions, total $${defiTotalUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}):\n${defiItems
        .map(
          a =>
            `- ${parseFloat(a.balance).toFixed(4)} ${a.tokenSymbol} "${a.tokenName}" [${a.positionType}${a.protocol ? ` via ${a.protocol}` : ""}] ($${parseFloat(a.balanceUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}) on ${a.blockchain}${a.contractAddress ? ` [${a.contractAddress}]` : ""}`,
        )
        .join("\n")}`
    : "";

  const activityItems = input.recentActivity ?? [];
  const activitySummary = activityItems.length
    ? `\n\nRecent activity (last ${activityItems.length} transactions):\n${activityItems
        .map(a => {
          const date = a.minedAt?.slice(0, 10) || "unknown";
          const outStr = a.out ? `-${a.out.amount} ${a.out.symbol}` : "";
          const inStr = a.in ? `+${a.in.amount} ${a.in.symbol}` : "";
          const valueStr =
            a.valueUsd != null ? ` ($${a.valueUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })})` : "";
          if (a.type === "trade" || a.type === "bridge") {
            return `- ${date} on ${a.chain}: ${a.type === "trade" ? "Swap" : "Bridge"} ${outStr} → ${inStr}${valueStr}`;
          }
          if (a.type === "send" && outStr) return `- ${date} on ${a.chain}: Send ${outStr}${valueStr}`;
          if (a.type === "receive" && inStr) return `- ${date} on ${a.chain}: Receive ${inStr}${valueStr}`;
          const transferStr = outStr && inStr ? `${outStr} → ${inStr}` : outStr || inStr || "";
          return `- ${date} on ${a.chain}: ${a.type} ${transferStr}${valueStr}`;
        })
        .join("\n")}`
    : "";

  const client = new OpenAI({ apiKey: config.aiWalletLlmKey, baseURL: config.aiWalletLlmBaseUrl });

  const historyMessages: OpenAI.Chat.ChatCompletionMessageParam[] = (input.recentMessages ?? []).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  const signerSummary =
    input.signers && input.signers.length > 0
      ? `\n\nThis wallet is a slop Multisig — ${input.threshold ?? "?"}-of-${input.signers.length}. Current signers:\n` +
        input.signers
          .map(s => `- ${s.address}${s.label ? ` (${s.label})` : ""} · ${s.kind}`)
          .join("\n") +
        `\nTo change membership/threshold, build a self-call with buildSignerChange (multisigAddress = ${input.address}).`
      : "";

  const loopMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: input.walletKind === "eoa" ? SYSTEM_PROMPT + EOA_MODE_OVERRIDE : SYSTEM_PROMPT },
    {
      role: "user",
      content: `User's wallet address: ${input.address}\nConnected chain ID: ${userChainId}${signerSummary}${portfolioSummary}${defiSummary}${activitySummary}\n\n[Context injected — ready for conversation]`,
    },
    {
      role: "assistant",
      content: "Got it. I have your portfolio, DeFi positions, and activity loaded. What would you like to do?",
    },
    ...historyMessages,
    { role: "user", content: input.message },
  ];

  async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const t = intentTools[name];
    if (!t) return { error: `Unknown tool: ${name}` };
    return t.execute(args);
  }

  // Debug trace — accumulated across the loop and flushed on every exit path
  // through finish() below, so the JSONL log always carries the full reasoning
  // even when the turn errors out. See wallet-debug.ts.
  const debugSteps: WalletDebugStep[] = [];
  const startedAt = Date.now();
  const finish = (result: IntentResult, errorMsg?: string): IntentResult => {
    writeWalletDebug({
      ts: new Date().toISOString(),
      address: input.address,
      chainId: userChainId,
      model: config.aiWalletLlmModel,
      userMessage: input.message,
      historyDepth: historyMessages.length,
      steps: debugSteps,
      result,
      error: errorMsg,
      durationMs: Date.now() - startedAt,
    });
    return result;
  };

  let finalText = "";
  try {
    for (let step = 0; step < 15; step++) {
      const completion = await client.chat.completions.create({
        model: config.aiWalletLlmModel,
        messages: loopMessages,
        tools: openAiTools,
        tool_choice: "auto",
        max_tokens: 4096,
      });
      const choice = completion.choices[0];
      if (!choice) break;
      const assistantMsg: OpenAI.Chat.ChatCompletionMessageParam = {
        role: "assistant",
        content: choice.message.content ?? null,
      };
      if (choice.message.tool_calls?.length) {
        (assistantMsg as OpenAI.Chat.ChatCompletionAssistantMessageParam).tool_calls = choice.message.tool_calls;
      }
      loopMessages.push(assistantMsg);

      if (!choice.message.tool_calls?.length || choice.finish_reason === "stop") {
        finalText = choice.message.content ?? "";
        debugSteps.push({ step, text: finalText, toolCalls: [] });
        break;
      }
      const dbgCalls: WalletDebugToolCall[] = [];
      const toolResults = await Promise.all(
        choice.message.tool_calls
          .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => tc.type === "function")
          .map(async tc => {
            const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            const t0 = Date.now();
            const res = await executeTool(tc.function.name, args);
            dbgCalls.push({ name: tc.function.name, args, result: serializeResult(res), ms: Date.now() - t0 });
            return { role: "tool" as const, tool_call_id: tc.id, content: JSON.stringify(res) };
          }),
      );
      // The model's pre-tool reasoning text (if any) plus what it just called.
      debugSteps.push({ step, text: choice.message.content ?? "", toolCalls: dbgCalls });
      loopMessages.push(...toolResults);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return finish(
      {
        type: "chat",
        message: "Sorry, something went wrong talking to the wallet AI. Please try again.",
        error: errorMsg,
      },
      errorMsg,
    );
  }

  // Parse the AI's final text as JSON (fenced or bare object).
  let parsed: Record<string, unknown> | null = null;
  if (finalText) {
    const jsonMatch = finalText.match(/```(?:json)?\s*([\s\S]*?)```/) || finalText.match(/(\{[\s\S]*\})/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        parsed = JSON.parse(jsonMatch[1]);
      } catch {
        /* not valid JSON */
      }
    }
  }

  if (parsed) {
    if (parsed.type === "chat") {
      return finish({ type: "chat", message: String(parsed.message ?? "") });
    }
    if (parsed.type === "transaction" && parsed.transaction) {
      return finish({ type: "transaction", message: String(parsed.message ?? ""), transaction: parsed.transaction as IntentTransaction });
    }
    if (parsed.type === "multistep_transaction" && parsed.steps) {
      return finish({
        type: "multistep_transaction",
        message: String(parsed.message ?? ""),
        steps: parsed.steps as IntentStep[],
        delay: typeof parsed.delay === "number" ? parsed.delay : 3000,
        priceEth: parsed.priceEth as string | undefined,
        priceWei: parsed.priceWei as string | undefined,
      });
    }
    if (Array.isArray(parsed.transactions) && parsed.transactions[0]) {
      const tx0 = parsed.transactions[0] as IntentTransaction;
      const sim = parsed.simulation as
        | { verified: boolean; changes: { direction: string; symbol: string; amount: string }[] }
        | undefined;
      return finish({
        type: "transaction",
        message: (parsed.description as string) || finalText || "Transaction ready",
        transaction: {
          ...tx0,
          description: (parsed.description as string) || "",
          simulation: sim ? { verified: sim.verified, changes: sim.changes } : undefined,
        },
      });
    }
  }

  // Fallback: scan tool results for transaction data.
  type ScannedTx = { to: string; data: string; value: string; chainId: number };
  type ScannedSim = { success: boolean; changes: { direction: string; symbol: string; amount: string }[] };
  type ScannedMultistep = { steps: IntentStep[]; delay?: number; message?: string; priceEth?: string; priceWei?: string };
  let lastTx: ScannedTx | null = null;
  let lastSim: ScannedSim | null = null;
  let lastMultistep: ScannedMultistep | null = null;
  for (const msg of loopMessages) {
    if (msg.role === "tool" && typeof msg.content === "string") {
      try {
        const r = JSON.parse(msg.content) as Record<string, unknown>;
        if (r && r.type === "multistep_transaction" && Array.isArray(r.steps)) {
          lastMultistep = r as unknown as ScannedMultistep;
        } else if (r && typeof r.to === "string" && typeof r.data === "string") {
          lastTx = r as unknown as ScannedTx;
        }
        if (r && typeof r.success === "boolean" && Array.isArray(r.changes)) {
          lastSim = r as unknown as ScannedSim;
        }
      } catch {
        /* not JSON */
      }
    }
  }

  if (lastMultistep) {
    return finish({
      type: "multistep_transaction",
      message: finalText || lastMultistep.message || "Multi-step transaction ready",
      steps: lastMultistep.steps,
      delay: lastMultistep.delay ?? 0,
      priceEth: lastMultistep.priceEth,
      priceWei: lastMultistep.priceWei,
    });
  }
  if (lastTx) {
    return finish({
      type: "transaction",
      message: finalText || "Transaction ready",
      transaction: {
        ...lastTx,
        description: finalText || "",
        simulation: lastSim ? { verified: !!lastSim.success, changes: lastSim.changes } : undefined,
      },
    });
  }

  let chatMessage = finalText || "I'm not sure how to help with that. Could you rephrase?";
  try {
    const maybeJson = JSON.parse(chatMessage);
    if (maybeJson.message) chatMessage = maybeJson.message;
  } catch {
    /* not JSON */
  }
  return finish({ type: "chat", message: chatMessage });
}

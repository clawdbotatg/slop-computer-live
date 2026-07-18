// Wallet data fetchers — portfolio, activity, prices, modal detail
// lookups, and transaction simulation. Ported from the AI wallet's
// Next.js API routes (api/portfolio, api/activity, api/prices,
// api/security, api/modal/*). Each is a plain async function returning
// the same JSON shape the old route returned, so the ported frontend
// components consume them unchanged via the relay's /v1/wallet/* routes.
//
// External services: Zerion (portfolio + activity + token search),
// Alchemy (RPC reads + tx simulation). Keys come from relay config.

import { config } from "./config.js";

const ZERION_KEY = config.zerionApiKey;
const ALCHEMY_KEY = config.alchemyApiKey;

function zerionHeaders(): Record<string, string> {
  const auth = Buffer.from(`${ZERION_KEY}:`).toString("base64");
  return { Authorization: `Basic ${auth}`, accept: "application/json" };
}

const ALCHEMY_NETWORK: Record<number, string> = {
  1: "eth-mainnet",
  8453: "base-mainnet",
  42161: "arb-mainnet",
  10: "opt-mainnet",
  137: "polygon-mainnet",
  100: "gnosis-mainnet",
};

// Chains we route to their own public RPC instead of Alchemy. Robinhood
// Chain has an Alchemy slug (robinhood-mainnet) but ROBINHOOD_MAINNET isn't
// enabled on our Alchemy app yet — move it into ALCHEMY_NETWORK once the
// dashboard flag is flipped.
const PUBLIC_RPC: Record<number, string> = {
  4663: "https://rpc.mainnet.chain.robinhood.com",
};

export function alchemyUrl(chainId: number): string {
  const publicRpc = PUBLIC_RPC[chainId];
  if (publicRpc) return publicRpc;
  const network = ALCHEMY_NETWORK[chainId] ?? "eth-mainnet";
  return `https://${network}.g.alchemy.com/v2/${ALCHEMY_KEY}`;
}

// Chain-name → Alchemy/public RPC, used by the modal + intent tools that
// take a chain *name* rather than an id.
export const CHAIN_RPC: Record<string, string> = {
  ethereum: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  base: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  optimism: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  polygon: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  xdai: `https://gnosis-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  gnosis: `https://gnosis-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  robinhood: "https://rpc.mainnet.chain.robinhood.com",
};

const CHAIN_EXPLORERS: Record<string, string> = {
  ethereum: "https://etherscan.io/tx/",
  base: "https://basescan.org/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  optimism: "https://optimistic.etherscan.io/tx/",
  polygon: "https://polygonscan.com/tx/",
  xdai: "https://gnosisscan.io/tx/",
  gnosis: "https://gnosisscan.io/tx/",
  robinhood: "https://robinhoodchain.blockscout.com/tx/",
  monad: "https://testnet.monadexplorer.com/tx/",
};

// ─── Portfolio ───────────────────────────────────────────────────────────────

export type PortfolioAsset = {
  blockchain: string;
  tokenName: string;
  tokenSymbol: string;
  positionType: string;
  protocol: string | null;
  balance: string;
  balanceUsd: string;
  tokenDecimals: number;
  contractAddress: string;
  thumbnail: string;
};

export type PortfolioResult = {
  totalBalanceUsd: string;
  assets: PortfolioAsset[];
  defiPositions: PortfolioAsset[];
  totalPortfolioUsd: string;
  change1dUsd: string;
  change1dPct: string;
  chainBreakdown: { chain: string; valueUsd: string }[];
  error?: string;
};

type ZerionPosition = {
  attributes: {
    value: number | null;
    quantity: { float: number };
    position_type: string;
    fungible_info: {
      name: string;
      symbol: string;
      icon?: { url: string };
      implementations?: { chain_id: string; address: string | null; decimals: number }[];
    };
    flags: { displayable: boolean };
    protocol?: string;
  };
  relationships: { chain: { data: { id: string } } };
};

function mapPosition(p: ZerionPosition): PortfolioAsset {
  const chain = p.relationships.chain.data.id;
  const info = p.attributes.fungible_info;
  const impl = info.implementations?.find(i => i.chain_id === chain);
  return {
    blockchain: chain,
    tokenName: info.name,
    tokenSymbol: info.symbol,
    positionType: p.attributes.position_type,
    protocol: p.attributes.protocol ?? null,
    balance: p.attributes.quantity.float.toString(),
    balanceUsd: (p.attributes.value ?? 0).toFixed(2),
    tokenDecimals: impl?.decimals ?? 18,
    contractAddress: impl?.address ?? "",
    thumbnail: info.icon?.url ?? "",
  };
}

export async function fetchPortfolio(address: string): Promise<PortfolioResult> {
  const empty: PortfolioResult = {
    totalBalanceUsd: "0",
    assets: [],
    defiPositions: [],
    totalPortfolioUsd: "0",
    change1dUsd: "0",
    change1dPct: "0",
    chainBreakdown: [],
  };
  if (!ZERION_KEY) return { ...empty, error: "ZERION_API_KEY not configured" };

  const headers = zerionHeaders();
  const [walletRes, defiRes, portfolioRes] = await Promise.all([
    fetch(
      `https://api.zerion.io/v1/wallets/${address}/positions/?filter[positions]=only_simple&currency=usd&sort=-value&page[size]=100`,
      { headers },
    ),
    fetch(
      `https://api.zerion.io/v1/wallets/${address}/positions/?filter[positions]=only_complex&currency=usd&sort=-value&page[size]=100`,
      { headers },
    ),
    fetch(`https://api.zerion.io/v1/wallets/${address}/portfolio?currency=usd`, { headers }),
  ]);

  if (!walletRes.ok) {
    const err = await walletRes.text().catch(() => "");
    return { ...empty, error: `Zerion wallet positions error (${walletRes.status}): ${err.slice(0, 200)}` };
  }

  const walletData = (await walletRes.json()) as { data?: ZerionPosition[] };
  const assets = (walletData.data ?? [])
    .filter(p => p.attributes.flags.displayable && (p.attributes.value ?? 0) > 0.01)
    .map(mapPosition)
    .sort((a, b) => parseFloat(b.balanceUsd) - parseFloat(a.balanceUsd));
  const totalBalanceUsd = assets.reduce((s, a) => s + parseFloat(a.balanceUsd), 0).toFixed(2);

  let defiPositions: PortfolioAsset[] = [];
  let totalPortfolioUsd = "0";
  if (defiRes.ok) {
    try {
      const defiData = (await defiRes.json()) as { data?: ZerionPosition[] };
      defiPositions = (defiData.data ?? [])
        .filter(p => p.attributes.flags.displayable && (p.attributes.value ?? 0) > 0.01)
        .map(mapPosition)
        .sort((a, b) => parseFloat(b.balanceUsd) - parseFloat(a.balanceUsd));
      totalPortfolioUsd = defiPositions.reduce((s, p) => s + parseFloat(p.balanceUsd), 0).toFixed(2);
    } catch {
      /* best-effort */
    }
  }

  let change1dUsd = "0";
  let change1dPct = "0";
  let chainBreakdown: { chain: string; valueUsd: string }[] = [];
  if (portfolioRes.ok) {
    try {
      const pd = (await portfolioRes.json()) as {
        data?: { attributes?: { changes?: Record<string, number>; positions_distribution_by_chain?: Record<string, number> } };
      };
      const attrs = pd.data?.attributes ?? {};
      change1dUsd = (attrs.changes?.absolute_1d ?? 0).toFixed(2);
      change1dPct = (attrs.changes?.percent_1d ?? 0).toFixed(2);
      chainBreakdown = Object.entries(attrs.positions_distribution_by_chain ?? {})
        .map(([chain, value]) => ({ chain, valueUsd: Number(value).toFixed(2) }))
        .filter(c => parseFloat(c.valueUsd) > 1)
        .sort((a, b) => parseFloat(b.valueUsd) - parseFloat(a.valueUsd));
    } catch {
      /* best-effort */
    }
  }

  return { totalBalanceUsd, assets, defiPositions, totalPortfolioUsd, change1dUsd, change1dPct, chainBreakdown };
}

// ─── Activity ────────────────────────────────────────────────────────────────

export type ActivityItem = {
  id: string;
  hash: string;
  chain: string;
  type: string;
  status: string;
  minedAt: string;
  valueUsd: number | null;
  out: { symbol: string; amount: string; icon: string } | null;
  in: { symbol: string; amount: string; icon: string } | null;
  explorerUrl: string;
};

function formatAmount(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toPrecision(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toPrecision(3)}K`;
  if (num === 0) return "0";
  return num.toPrecision(4).replace(/\.?0+$/, "");
}

function mapTxType(rawType: string): string {
  const typeMap: Record<string, string> = {
    send: "send",
    receive: "receive",
    trade: "trade",
    approve: "approve",
    borrow: "deposit",
    deposit: "deposit",
    withdraw: "withdraw",
    mint: "mint",
    burn: "withdraw",
    bridge: "bridge",
    stake: "deposit",
    unstake: "withdraw",
    claim: "receive",
  };
  return typeMap[rawType] ?? rawType;
}

export async function fetchActivity(address: string, page = 1): Promise<{ items: ActivityItem[]; error?: string }> {
  if (!ZERION_KEY) return { items: [], error: "ZERION_API_KEY not configured" };
  const url = `https://api.zerion.io/v1/wallets/${address}/transactions/?currency=usd&page[size]=50${page > 1 ? `&page[after]=${(page - 1) * 50}` : ""}&sort=-mined_at`;
  const res = await fetch(url, { headers: zerionHeaders() });
  if (!res.ok) return { items: [], error: `Zerion activity error ${res.status}` };
  const data = (await res.json()) as { data?: Array<Record<string, any>> };
  const items: ActivityItem[] = (data.data ?? []).map(tx => {
    const attrs = tx.attributes ?? {};
    const hash = attrs.hash ?? "";
    const chain = tx.relationships?.chain?.data?.id ?? attrs.chain ?? "ethereum";
    const transfers = attrs.transfers ?? [];
    const outT = transfers.find((t: any) => t.direction === "out");
    const inT = transfers.find((t: any) => t.direction === "in");
    const mapTransfer = (t: any) => ({
      symbol: t.fungible_info?.symbol ?? "???",
      amount: formatAmount(t.quantity?.float ?? 0),
      icon: t.fungible_info?.icon?.url ?? "",
    });
    let valueUsd: number | null = null;
    for (const t of transfers) {
      if (t.value != null) {
        valueUsd = (valueUsd ?? 0) + Math.abs(typeof t.value === "number" ? t.value : parseFloat(t.value) || 0);
      }
    }
    return {
      id: tx.id ?? hash,
      hash,
      chain,
      type: mapTxType(attrs.operation_type ?? "unknown"),
      status: attrs.status ?? "confirmed",
      minedAt: attrs.mined_at ?? new Date().toISOString(),
      valueUsd,
      out: outT ? mapTransfer(outT) : null,
      in: inT ? mapTransfer(inT) : null,
      explorerUrl: `${CHAIN_EXPLORERS[chain] ?? "https://etherscan.io/tx/"}${hash}`,
    };
  });
  return { items };
}

// ─── Prices ──────────────────────────────────────────────────────────────────

const PRICE_TOKEN_IDS: Record<string, string> = {
  ETH: "eth",
  BTC: "ee9702a0-c587-4c69-ac0c-ce820a50c95b",
  CLAWD: "b07ec41c-2b1c-4ad9-8cfb-a71896b180e2",
};

export async function fetchPrices(): Promise<{ symbol: string; price: number | null; change24h: number | null }[]> {
  if (!ZERION_KEY) return [];
  const headers = zerionHeaders();
  try {
    return await Promise.all(
      Object.entries(PRICE_TOKEN_IDS).map(async ([symbol, id]) => {
        const res = await fetch(`https://api.zerion.io/v1/fungibles/${id}?currency=usd`, { headers });
        if (!res.ok) return { symbol, price: null, change24h: null };
        const data = (await res.json()) as { data?: { attributes?: { market_data?: any } } };
        const market = data.data?.attributes?.market_data;
        return { symbol, price: market?.price ?? null, change24h: market?.changes?.percent_1d ?? null };
      }),
    );
  } catch {
    return [];
  }
}

// ─── eth_simulateV1 transfer simulation (ground truth for tx cards) ─────────
//
// The older `alchemy_simulateAssetChanges` path (see simulateCalldata
// below) returns nicely-decoded asset deltas BUT is currently throwing an
// internal `bigInt is not defined` error on our key across all chains.
// `eth_simulateV1` is the EIP-standard method, works on Base/ETH/Arb/OP,
// and with `traceTransfers: true` synthesizes Transfer logs for every
// ERC-20 + native move. We decode those logs ourselves and resolve token
// metadata via wallet-tokens, which makes the wallet's tx-summary chips
// ground truth instead of an AI guess. Gnosis (no Alchemy Transact) falls
// through to the AI-decode path until we add Tenderly.

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// eth_simulateV1 emits native-ETH moves under this pseudo-token address.
const NATIVE_LOG_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
// Chains where Alchemy serves eth_simulateV1. Gnosis (100) and Robinhood
// (4663) are intentionally absent — we don't route them through Alchemy, so
// sim there returns chain-unsupported and the caller falls back to the
// AI-decode card.
const SIMULATABLE_CHAINS = new Set([1, 8453, 42161, 10, 137]);
// Native balance we override onto the sender before simulating. NOTE:
// `validation:false` does NOT skip the balance check — Alchemy auto-funds
// only ~0.003 of the gas token, so a swap/send whose value exceeds the
// multisig's current on-chain balance would otherwise fail with
// "insufficient funds" and silently drop us back to the AI-decode chips.
// The amounts we read come from the emitted Transfer logs, not from any
// balance delta, so over-funding never distorts the chips. 1e27 wei.
const SIM_BALANCE_OVERRIDE = `0x${(10n ** 27n).toString(16)}`;

export type SimTransfer = {
  // lowercase contract address, or the literal "native" for ETH/native gas token
  token: string;
  from: string;
  to: string;
  rawAmount: bigint;
  isNft: boolean;
  tokenId?: string;
};

export type SimTransfersResult = {
  ok: boolean; // true only when every call succeeded (status 0x1)
  reverted: boolean;
  transfers: SimTransfer[];
  error?: string;
};

const topicToAddress = (topic: string): string => `0x${topic.slice(-40).toLowerCase()}`;

const decimalWeiToHex = (wei: string): string => {
  try {
    return `0x${BigInt(wei || "0").toString(16)}`;
  } catch {
    return "0x0";
  }
};

// Simulate one or more calls executed sequentially by `from` (the multisig)
// in a single block, and return every Transfer that moved value. For a
// single tx pass one call; for a batch pass all inner calls (they execute
// with chained state, exactly like execBatchTransaction).
export async function simulateTransfers(args: {
  from: string;
  calls: { to: string; data: string; value: string }[]; // value = decimal wei
  chainId: number;
}): Promise<SimTransfersResult> {
  if (!ALCHEMY_KEY) return { ok: false, reverted: false, transfers: [], error: "no-alchemy-key" };
  if (!SIMULATABLE_CHAINS.has(args.chainId)) {
    return { ok: false, reverted: false, transfers: [], error: `chain-${args.chainId}-unsupported` };
  }

  const calls = args.calls.map(c => ({
    from: args.from,
    to: c.to,
    value: decimalWeiToHex(c.value),
    data: c.data && c.data !== "0x" ? c.data : "0x",
  }));

  const body = {
    id: 1,
    jsonrpc: "2.0",
    method: "eth_simulateV1",
    params: [
      {
        blockStateCalls: [
          {
            // Fund the multisig so a value > its current balance still sims.
            stateOverrides: { [args.from.toLowerCase()]: { balance: SIM_BALANCE_OVERRIDE } },
            calls,
          },
        ],
        traceTransfers: true,
        validation: false,
      },
      "latest",
    ],
  };

  try {
    const res = await fetch(alchemyUrl(args.chainId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      error?: { message?: string };
      result?: Array<{ calls?: Array<{ status?: string; logs?: Array<{ address?: string; topics?: string[]; data?: string }> }> }>;
    };
    if (json.error) return { ok: false, reverted: false, transfers: [], error: json.error.message ?? "rpc-error" };
    const block = json.result?.[0];
    if (!block) return { ok: false, reverted: false, transfers: [], error: "no-result" };

    const transfers: SimTransfer[] = [];
    let reverted = false;
    for (const call of block.calls ?? []) {
      if (call.status !== undefined && call.status !== "0x1") reverted = true;
      for (const log of call.logs ?? []) {
        const topics = log.topics ?? [];
        const [topic0, fromTopic, toTopic, tokenIdTopic] = topics;
        if ((topic0 ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
        if (!fromTopic || !toTopic) continue; // not a standard Transfer
        const addr = (log.address ?? "").toLowerCase();
        const isNative = addr === NATIVE_LOG_SENTINEL;
        const token = isNative ? "native" : addr;
        const from = topicToAddress(fromTopic);
        const to = topicToAddress(toTopic);
        if (tokenIdTopic) {
          // ERC-721: tokenId is the (indexed) 4th topic; one unit moves.
          let tokenId = "0";
          try {
            tokenId = BigInt(tokenIdTopic).toString();
          } catch {
            /* leave default */
          }
          transfers.push({ token, from, to, rawAmount: 1n, isNft: true, tokenId });
        } else {
          let rawAmount = 0n;
          try {
            rawAmount = BigInt(log.data && log.data !== "0x" ? log.data : "0x0");
          } catch {
            /* leave 0 */
          }
          transfers.push({ token, from, to, rawAmount, isNft: false });
        }
      }
    }
    return { ok: !reverted, reverted, transfers };
  } catch (e) {
    return { ok: false, reverted: false, transfers: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Transaction simulation (api/security) ──────────────────────────────────

export type SimulationResult = {
  safe: boolean;
  explanation: string;
  warnings: string[];
  changes: { type: string; symbol: string; amount: string; logo: string; direction: "in" | "out" }[];
  error?: string;
};

export async function simulateCalldata(args: {
  calldata: { to: string; data?: string; value?: string };
  address: string;
  chainId?: number;
}): Promise<SimulationResult> {
  const { calldata, address, chainId = 1 } = args;
  if (!calldata?.to || !address) {
    return { safe: false, explanation: "", warnings: ["calldata.to and address required"], changes: [], error: "bad-args" };
  }
  if (!ALCHEMY_KEY) {
    return { safe: false, explanation: "", warnings: ["ALCHEMY key not configured"], changes: [], error: "no-key" };
  }
  const txParams: Record<string, string> = { from: address, to: calldata.to, data: calldata.data || "0x" };
  if (calldata.value && calldata.value !== "0x0" && calldata.value !== "0x") txParams.value = calldata.value;

  const res = await fetch(alchemyUrl(chainId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "alchemy_simulateAssetChanges", params: [txParams] }),
  });
  const data = (await res.json()) as { error?: { message?: string }; result?: any };
  if (data.error) {
    return {
      safe: false,
      explanation: "Could not simulate transaction",
      warnings: [data.error.message ?? "Simulation failed"],
      changes: [],
    };
  }
  const result = data.result ?? {};
  const userAddr = address.toLowerCase();
  const changes = ((result.changes ?? []) as any[]).map(c => {
    const toAddr = (c.to ?? "").toLowerCase();
    return {
      type: c.assetType as string,
      symbol: (c.symbol || c.name || "???") as string,
      amount: (c.amount ?? "?") as string,
      logo: (c.logo ?? "") as string,
      direction: (toAddr === userAddr ? "in" : "out") as "in" | "out",
    };
  });
  const outC = changes.filter(c => c.direction === "out");
  const inC = changes.filter(c => c.direction === "in");
  let explanation: string;
  if (outC.length && inC.length) {
    explanation = `${outC.map(c => `${c.amount} ${c.symbol}`).join(" + ")} → ${inC.map(c => `${c.amount} ${c.symbol}`).join(" + ")}`;
  } else if (outC.length) {
    explanation = `Send ${outC.map(c => `${c.amount} ${c.symbol}`).join(", ")}`;
  } else if (inC.length) {
    explanation = `Receive ${inC.map(c => `${c.amount} ${c.symbol}`).join(", ")}`;
  } else {
    explanation = "No asset changes detected";
  }
  return { safe: !result.error, explanation, warnings: result.error ? [String(result.error)] : [], changes };
}

// ─── Modal detail lookups (api/modal/*) ─────────────────────────────────────

async function rpcCall(rpcUrl: string, method: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = (await res.json()) as { result?: unknown };
  return data.result;
}

// ─── Deposit verification (money-chess escrow) ──────────────────────────────
//
// The relay confirms a buy-in landed in escrow by reading the funder's
// own tx back from chain — never by trusting the client's "I paid"
// claim. We assert the tx came FROM the player, went TO the multisig,
// carried at least the buy-in, and is mined+successful. `not_mined` is a
// soft failure the client can retry on (the tx may simply be pending).

export type DepositCheck =
  | { ok: true; valueWei: string }
  | { ok: false; reason: "not_found" | "not_mined" | "reverted" | "wrong_from" | "wrong_to" | "underpaid" | "rpc_error" };

export async function verifyEthDeposit(opts: {
  chainId: number;
  txHash: string;
  from: string; // expected sender, lowercased
  to: string; // expected recipient (the multisig), lowercased
  minValueWei: bigint;
}): Promise<DepositCheck> {
  const url = alchemyUrl(opts.chainId);
  try {
    const [tx, receipt] = await Promise.all([
      rpcCall(url, "eth_getTransactionByHash", [opts.txHash]),
      rpcCall(url, "eth_getTransactionReceipt", [opts.txHash]),
    ]);
    if (!tx || typeof tx !== "object") return { ok: false, reason: "not_found" };
    const t = tx as { from?: string; to?: string | null; value?: string; blockNumber?: string | null };
    // Mined? Both the tx and its receipt must have a block.
    const r = receipt as { status?: string; blockNumber?: string | null } | null;
    if (!t.blockNumber || !r || !r.blockNumber) return { ok: false, reason: "not_mined" };
    if (r.status !== undefined && r.status !== null && BigInt(r.status) === 0n) return { ok: false, reason: "reverted" };
    if ((t.from ?? "").toLowerCase() !== opts.from.toLowerCase()) return { ok: false, reason: "wrong_from" };
    if ((t.to ?? "").toLowerCase() !== opts.to.toLowerCase()) return { ok: false, reason: "wrong_to" };
    const value = BigInt(t.value ?? "0x0");
    if (value < opts.minValueWei) return { ok: false, reason: "underpaid" };
    return { ok: true, valueWei: value.toString() };
  } catch {
    return { ok: false, reason: "rpc_error" };
  }
}

export async function fetchAssetModal(symbol: string): Promise<Record<string, unknown>> {
  if (!ZERION_KEY) return { error: "ZERION_API_KEY not configured" };
  const res = await fetch(
    `https://api.zerion.io/v1/fungibles/?filter[search_query]=${encodeURIComponent(symbol)}&currency=usd`,
    { headers: zerionHeaders() },
  );
  if (!res.ok) return { error: `Zerion API error: ${res.status}` };
  const data = (await res.json()) as { data?: Array<Record<string, any>> };
  const fungibles = data.data ?? [];
  const fungible = fungibles.find(f => f.attributes?.symbol?.toLowerCase() === symbol.toLowerCase()) ?? fungibles[0];
  if (!fungible) return { error: `Token '${symbol}' not found` };
  const attrs = fungible.attributes;
  const market = attrs.market_data;
  return {
    symbol: attrs.symbol,
    name: attrs.name,
    price: market?.price ?? null,
    priceChange24h: market?.changes?.percent_1d ?? null,
    marketCap: market?.market_cap ?? null,
    volume24h: market?.total_volume ?? null,
    description: attrs.description || null,
    icon: attrs.icon?.url || null,
    links: (attrs.external_links ?? []).slice(0, 5).map((l: any) => ({ type: l.type, url: l.url, name: l.name })),
    implementations: (attrs.implementations ?? [])
      .slice(0, 5)
      .map((i: any) => ({ chain: i.chain_id, address: i.address, decimals: i.decimals })),
  };
}

const NETWORK_MODAL_CONFIG: Record<string, { chainId: number; explorerUrl: string }> = {
  ethereum: { chainId: 1, explorerUrl: "https://etherscan.io" },
  base: { chainId: 8453, explorerUrl: "https://basescan.org" },
  arbitrum: { chainId: 42161, explorerUrl: "https://arbiscan.io" },
  optimism: { chainId: 10, explorerUrl: "https://optimistic.etherscan.io" },
  polygon: { chainId: 137, explorerUrl: "https://polygonscan.com" },
  robinhood: { chainId: 4663, explorerUrl: "https://robinhoodchain.blockscout.com" },
};

export async function fetchNetworkModal(chain: string): Promise<Record<string, unknown>> {
  const cfg = NETWORK_MODAL_CONFIG[chain.toLowerCase()];
  if (!cfg) return { error: `Unsupported chain: ${chain}` };
  const rpcUrl = alchemyUrl(cfg.chainId);
  const [gasPriceHex, blockNumberHex] = await Promise.all([
    rpcCall(rpcUrl, "eth_gasPrice"),
    rpcCall(rpcUrl, "eth_blockNumber"),
  ]);
  return {
    gasGwei: (parseInt(gasPriceHex || "0x0", 16) / 1e9).toFixed(2),
    blockNumber: parseInt(blockNumberHex || "0x0", 16),
    chainId: cfg.chainId,
    explorerUrl: cfg.explorerUrl,
  };
}

export async function fetchAddressModal(address: string): Promise<Record<string, unknown>> {
  const headers = zerionHeaders();
  const alchemy = alchemyUrl(1);
  const [portfolioRes, positionsRes, txCountRes] = await Promise.all([
    ZERION_KEY
      ? fetch(`https://api.zerion.io/v1/wallets/${address}/portfolio?currency=usd`, { headers })
      : Promise.resolve(null),
    ZERION_KEY
      ? fetch(
          `https://api.zerion.io/v1/wallets/${address}/positions/?filter[position_types]=wallet&currency=usd&sort=-value&page[size]=5`,
          { headers },
        )
      : Promise.resolve(null),
    fetch(alchemy, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionCount", params: [address, "latest"] }),
    }),
  ]);

  let portfolioUsd = "0";
  if (portfolioRes && portfolioRes.ok) {
    const pd = (await portfolioRes.json()) as { data?: { attributes?: { total?: { positions?: number } } } };
    portfolioUsd = (pd.data?.attributes?.total?.positions ?? 0).toFixed(2);
  }

  const ethBalRes = await fetch(alchemy, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: [address, "latest"] }),
  });
  const ethBalData = (await ethBalRes.json()) as { result?: string };
  const ethBalance = (Number(BigInt(ethBalData.result || "0x0")) / 1e18).toFixed(4);

  let topTokens: { symbol: string; balanceUsd: string; icon: string }[] = [];
  if (positionsRes && positionsRes.ok) {
    const posData = (await positionsRes.json()) as { data?: Array<Record<string, any>> };
    topTokens = (posData.data ?? [])
      .filter(p => (p.attributes?.value ?? 0) > 0.01)
      .map(p => ({
        symbol: p.attributes.fungible_info.symbol,
        balanceUsd: (p.attributes.value ?? 0).toFixed(2),
        icon: p.attributes.fungible_info.icon?.url ?? "",
      }));
  }

  let txCount = 0;
  if (txCountRes.ok) {
    const txData = (await txCountRes.json()) as { result?: string };
    txCount = parseInt(txData.result || "0x0", 16);
  }
  return { portfolioUsd, ethBalance, topTokens, txCount };
}

export async function fetchTransactionModal(hash: string, chain = "ethereum"): Promise<Record<string, unknown>> {
  const rpcUrl = CHAIN_RPC[chain.toLowerCase()];
  if (!rpcUrl) return { error: `Unsupported chain: ${chain}` };
  const [tx, receipt] = await Promise.all([
    rpcCall(rpcUrl, "eth_getTransactionByHash", [hash]),
    rpcCall(rpcUrl, "eth_getTransactionReceipt", [hash]),
  ]);
  if (!tx) return { error: "Transaction not found" };

  let timestamp: string | null = null;
  if (tx.blockNumber) {
    const block = await rpcCall(rpcUrl, "eth_getBlockByNumber", [tx.blockNumber, false]);
    if (block?.timestamp) timestamp = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
  }
  const valueEth = (Number(BigInt(tx.value || "0x0")) / 1e18).toFixed(6);
  const gasUsed = receipt ? parseInt(receipt.gasUsed || "0x0", 16) : 0;
  const effectiveGasPrice = receipt
    ? parseInt(receipt.effectiveGasPrice || tx.gasPrice || "0x0", 16)
    : parseInt(tx.gasPrice || "0x0", 16);
  const gasCostEth = (Number(BigInt(gasUsed) * BigInt(effectiveGasPrice)) / 1e18).toFixed(6);
  return {
    from: tx.from,
    to: tx.to,
    valueEth,
    gasUsed,
    gasCostEth,
    blockNumber: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
    timestamp,
    status: receipt ? (receipt.status === "0x1" ? "success" : "failed") : "pending",
    explorerUrl: `${CHAIN_EXPLORERS[chain.toLowerCase()] ?? "https://etherscan.io/tx/"}${hash}`,
  };
}

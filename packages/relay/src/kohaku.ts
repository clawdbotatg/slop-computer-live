// Privacy Wallet — Railgun (mainnet) via kohaku-cli. See docs/PRIVACY-WALLET.md.
//
// ⚠️ CUSTODIAL: kohaku-cli proves spends server-side, so while funds are in
// the privacy wallet (deposited → shielded → withdrawn-but-not-sent-out) the
// slop box holds the keys. This buys UNLINKABILITY between the deposit source
// and the eventual spend, not trustlessness. Mainnet, small amounts, caps.
//
// Architecture: ONE box kohaku wallet ("slop"), per-user accounting. Each
// user gets a distinct HD public account for deposit and another for
// withdrawal (addresses isolate users); all shielded funds commingle in one
// Railgun balance — the best case for anonymity and one historical sync for
// the whole app. The relay tracks who owns what; Railgun notes are fungible
// in the pool, so the cap enforcement here is accounting-trust, not crypto.
//
// Process model mirrors fanout.ts (external tool spawned as a child) and the
// state-file pattern (writeFileAtomic + boot load). kohaku-cli is spawned via
// `npx tsx src/index.ts …` in config.kohakuCliDir — the packaged dist has an
// ESM dir-import bug in @kohaku-eth/railgun, so tsx-from-source is the way.
// One op at a time: proving is CPU/RAM-heavy and the prod box is small.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { http, createPublicClient, formatEther, getAddress, isAddress, parseAbiItem, parseEther } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { bankrChat, hasBankrLlm } from "./bankr-llm.js";
import { getState as getGasState } from "./gas.js";
import { randomBytes } from "node:crypto";
import { type IntentStep, runWalletIntent } from "./wallet-intent.js";
import { fetchActivity, fetchPortfolio } from "./wallet-data.js";

const STATE_FILE = process.env.KOHAKU_STATE_PATH ?? "/var/lib/slop-relay/kohaku-state.json";

// Railgun V2 RailgunSmartWallet proxy on Ethereum mainnet. The Shield event
// signature below is verified against live mainnet logs (593 events in the
// week before 2026-07-18) — if Railgun ever migrates the proxy, the
// anonymity counter silently drops to zero, not wrong numbers.
const RAILGUN_PROXY = "0xFA7093CdD9EE6932B4eb2c9e1cde7CE00B1FA4b9" as const;
const SHIELD_EVENT = parseAbiItem(
  "event Shield(uint256 treeNumber, uint256 startPosition, (bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, (bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext, uint256[] fees)",
);

// --- Tunables (env-overridable, defaults are sane for mainnet) --------------
const POLL_MS = Number(process.env.KOHAKU_POLL_MS ?? 30_000);
// Full pool sync (kohaku balances) cadence while anyone is mid-lifecycle.
// Each run is an incremental Railgun sync — cheap after the first, but still
// a child process, so keep it occasional.
const POOL_SYNC_MS = Number(process.env.KOHAKU_POOL_SYNC_MS ?? 5 * 60_000);
// Don't react to dust at a deposit address.
const MIN_DEPOSIT_WEI = BigInt(process.env.KOHAKU_MIN_DEPOSIT_WEI ?? "2000000000000000"); // 0.002 ETH
// Left at the deposit address to pay the shield tx's own gas (shield is
// self-broadcast FROM the deposit account).
const SHIELD_GAS_RESERVE_WEI = BigInt(process.env.KOHAKU_SHIELD_GAS_RESERVE_WEI ?? "600000000000000"); // 0.0006
// Reserved from the private balance for the unshield's 4337 bundler gas
// (paid out of the pool, on top of the withdrawn amount).
const UNSHIELD_GAS_RESERVE_WEI = BigInt(process.env.KOHAKU_UNSHIELD_GAS_RESERVE_WEI ?? "500000000000000"); // 0.0005
// Withdrawals are rounded DOWN to this grid so every exit is a common
// denomination instead of a wei-precision fingerprint (fallback when no
// crowd denomination below fits well).
const WITHDRAW_GRID_WEI = BigInt(process.env.KOHAKU_WITHDRAW_GRID_WEI ?? "500000000000000"); // 0.0005
// The RECEIVED amounts the biggest Railgun crowds actually emit (largest
// first, within our cap). Key finding from the 30-day study
// (ops/RAILGUN-DENOMINATION-STUDY.md): the dominant convention is round
// *gross* on the 1-2-5 series, so the recipient receives gross × (1 − 25 bps
// Railgun fee). At our scale that's 0.009975 (crowd of 100/mo) — NOT a clean
// 0.01 (crowd of 29). kohaku's --amount-wei is the RECEIVED amount, so we
// target these exact values directly. Recompute from the 1-2-5 gross grid so
// the fee math stays honest if the fee ever changes.
const RG_UNSHIELD_FEE_BPS = 25n;
const WITHDRAW_GROSS_125 = [50n, 20n, 10n, 5n, 2n, 1n].map(m => m * 1_000_000_000_000_000n); // 0.05 … 0.001 gross
const WITHDRAW_RECV_DENOMS_WEI = WITHDRAW_GROSS_125.map(g => g - (g * RG_UNSHIELD_FEE_BPS) / 10_000n);
// Railgun shield fee is 25 bps; the credited note = amount − fee.
const SHIELD_FEE_BPS = 25n;
// Fallback POI gate: if we can't match the user's note in private_notes,
// allow shielding→soaking once this much time passed AND the pool's
// spendable balance covers the user (POI matured in ~35 min in the de-risk).
const POI_FALLBACK_MS = Number(process.env.KOHAKU_POI_FALLBACK_MS ?? 45 * 60_000);
// getLogs chunk for the anonymity counter (strict nodes reject big spans).
const LOG_CHUNK = BigInt(process.env.KOHAKU_GETLOGS_MAX_BLOCK_SPAN ?? "499");
// Child-process timeouts. Proving + mining are slow; first-ever balances
// sync can be very slow (should be pre-seeded via rg-storage.json instead).
const BALANCES_TIMEOUT_MS = Number(process.env.KOHAKU_BALANCES_TIMEOUT_MS ?? 30 * 60_000);
const SHIELD_TIMEOUT_MS = Number(process.env.KOHAKU_SHIELD_TIMEOUT_MS ?? 20 * 60_000);
const UNSHIELD_TIMEOUT_MS = Number(process.env.KOHAKU_UNSHIELD_TIMEOUT_MS ?? 30 * 60_000);
const QUICK_TIMEOUT_MS = Number(process.env.KOHAKU_QUICK_TIMEOUT_MS ?? 5 * 60_000);

// --- Types ------------------------------------------------------------------

export type KohakuPhase = "awaiting-deposit" | "shielding" | "soaking" | "withdrawing" | "wallet";

type ActivityEntry = { at: number; text: string };

type KohakuUser = {
  owner: string; // lowercased session address — the durable identity
  phase: KohakuPhase;
  depositAddress: string | null;
  depositIndex: number | null;
  withdrawAddress: string | null;
  // Wei strings (JSON-safe).
  depositedWei: string; // ETH detected + shielded from the deposit address
  expectedNoteWei: string; // deposited − 25 bps shield fee = private credit
  withdrawnWei: string; // amount requested in the unshield
  shieldTxHash: string | null;
  unshieldHash: string | null;
  depositBlock: string | null; // block at shield time — anonymity count baseline
  depositAt: number | null;
  shieldedAt: number | null;
  soakEndsAt: number | null;
  withdrawnAt: number | null;
  // Anonymity counter cache: Shield events counted in (depositBlock, countedTo].
  anonCount: number;
  anonCountedTo: string | null;
  // Watcher scratch: last seen deposit balance (so we only shield once the
  // balance is stable across two ticks — a user sending twice in quick
  // succession shouldn't race the shield).
  lastSeenDepositWei: string;
  // Backoff for a failing shield: without this a persistent failure (e.g.
  // RPC down) would spawn a CLI child every 30s tick forever.
  lastShieldAttemptAt?: number;
  overCap: boolean;
  error: string | null;
  activity: ActivityEntry[];
};

// Per-owner preferences, kept OUTSIDE the user cycle record so they survive
// "start a new cycle" (which replaces the KohakuUser wholesale).
type KohakuSettings = { rpcUrl?: string };

type KohakuState = { users: Record<string, KohakuUser>; settings?: Record<string, KohakuSettings> };

// Pool-level snapshot from the last `kohaku balances` run (shared — the
// Railgun balance is one commingled pot).
type PoolSnapshot = {
  at: number;
  spendableWei: string;
  pendingWei: string;
  // Raw per-note rows (value + status) — used to match a user's freshly
  // shielded note and flip shielding → soaking when it turns spendable.
  notes: { valueWei: string; status: string }[];
};

// --- Config / setup ---------------------------------------------------------

export function isKohakuConfigured(): boolean {
  return !!config.kohakuCliDir && !!config.kohakuRpcUrl && !!config.kohakuWalletPassword;
}

let emit: (line: string) => void = () => {};
export function setKohakuLogger(fn: (line: string) => void): void {
  emit = fn;
}

const client = (rpcUrl?: string) =>
  createPublicClient({ chain: mainnet, transport: http(rpcUrl ?? config.kohakuRpcUrl) });

// Effective RPC for one owner's ops: their validated override, else the box
// default. The shared pool sync always uses the box default — it serves
// everyone's commingled data, not one user's.
function rpcFor(owner: string): string {
  return state.settings?.[owner]?.rpcUrl || config.kohakuRpcUrl;
}

// What the UI may show as "the default RPC". NEVER the raw URL: a box
// default like Alchemy embeds the API key in the path, and /v1/kohaku/state
// is readable by every signed-in user. Origin only.
function defaultRpcDisplay(): string {
  try {
    return new URL(config.kohakuRpcUrl).origin;
  } catch {
    return "(relay default)";
  }
}

// Password handed to the CLI as a file path, never on argv (argv is visible
// in `ps`). Written 0600 next to the state file at first use.
let pwFilePath: string | null = null;
function passwordFile(): string {
  if (pwFilePath) return pwFilePath;
  const path = join(dirname(STATE_FILE), "kohaku.pw");
  if (!existsSync(path) || readFileSync(path, "utf8") !== config.kohakuWalletPassword) {
    writeFileSync(path, config.kohakuWalletPassword, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  pwFilePath = path;
  return path;
}

// --- State ------------------------------------------------------------------

function loadState(): KohakuState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.users) return parsed as KohakuState;
  } catch {
    /* first boot */
  }
  return { users: {} };
}

const state: KohakuState = loadState();
let pool: PoolSnapshot | null = null;

function persist(): void {
  try {
    writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    emit(`[kohaku] persist failed: ${(e as Error).message}`);
  }
}

function log(u: KohakuUser, text: string): void {
  u.activity.push({ at: Date.now(), text });
  if (u.activity.length > 100) u.activity.splice(0, u.activity.length - 100);
  emit(`[kohaku ${u.owner.slice(0, 10)}] ${text}`);
}

// --- kohaku-cli spawn helper ------------------------------------------------

// Serialize every CLI invocation: proving is CPU-heavy, the wallet keystore
// and rg-storage are single-writer, and the prod box is RAM-constrained.
let cliQueue: Promise<unknown> = Promise.resolve();

type CliResult = { code: number | null; stdout: string; stderr: string };

function runKohakuRaw(args: string[], timeoutMs: number, rpcUrl?: string): Promise<CliResult> {
  const task = cliQueue.then(
    () =>
      new Promise<CliResult>(resolve => {
        const full = ["tsx", "src/index.ts", ...args, "--non-interactive"];
        if (config.kohakuDataDir) full.push("--dataDir", config.kohakuDataDir);
        const proc = spawn("npx", full, {
          cwd: config.kohakuCliDir,
          env: { ...process.env, RPC_URL: rpcUrl ?? config.kohakuRpcUrl },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", d => (stdout += d.toString()));
        proc.stderr.on("data", d => (stderr += d.toString()));
        const killer = setTimeout(() => {
          proc.kill("SIGKILL");
        }, timeoutMs);
        proc.on("close", code => {
          clearTimeout(killer);
          if (code !== 0) {
            // Full tails to the journal — the UI only gets the cleaned
            // one-liner, and debugging the first prod failure without
            // these meant reproducing the whole op by hand.
            emit(
              `[kohaku] cli '${args[0]}' exit ${code} — stdout tail: ${stdout.trim().slice(-600) || "(empty)"} | stderr tail: ${stderr.trim().slice(-600) || "(empty)"}`,
            );
          }
          resolve({ code, stdout, stderr });
        });
        proc.on("error", err => {
          clearTimeout(killer);
          resolve({ code: null, stdout, stderr: stderr + String(err) });
        });
      }),
  );
  // Keep the queue alive through failures.
  cliQueue = task.catch(() => undefined);
  return task;
}

function walletArgs(): string[] {
  return ["--wallet", config.kohakuWalletName, "--password", passwordFile()];
}

// Parse the last JSON object the CLI printed (spinner-free in
// non-interactive mode, but be tolerant of stray lines).
function lastJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    // Fall back to the last {...} line.
    for (const line of stdout.trim().split("\n").reverse()) {
      const t = line.trim();
      if (t.startsWith("{")) {
        try {
          return JSON.parse(t);
        } catch {
          /* keep looking */
        }
      }
    }
    return null;
  }
}

// Node's stderr is polluted with harmless runtime chatter (the tsx loader's
// ExperimentalWarning etc.) — the first prod withdraw failure surfaced ONLY
// that warning while the real error sat in stdout. Strip the noise and fall
// through to stdout so the user sees the actual reason.
function cliErrorText(r: CliResult): string {
  const clean = (s: string) =>
    s
      .split("\n")
      .filter(l => {
        const t = l.trim();
        return t && !t.startsWith("(node:") && !t.includes("ExperimentalWarning") && !t.includes("--trace-warnings");
      })
      .join("\n")
      .trim();
  const err = clean(r.stderr) || clean(r.stdout);
  return err.slice(-400) || `exit ${r.code}`;
}

// --- Pool sync (kohaku balances) -------------------------------------------

type BalanceRow = { symbol?: string; raw_token_holdings?: string; status?: string };
type NoteRow = { balance_raw?: string; status?: string };

async function syncPool(): Promise<void> {
  const r = await runKohakuRaw(["balances", ...walletArgs(), "--include", "railgun", "--verbose"], BALANCES_TIMEOUT_MS);
  if (r.code !== 0) {
    emit(`[kohaku] balances sync failed: ${cliErrorText(r)}`);
    return;
  }
  const j = lastJson(r.stdout) as {
    private_balances?: { railgun?: BalanceRow[] };
    private_notes?: { railgun?: NoteRow[] };
  } | null;
  if (!j) {
    emit("[kohaku] balances sync: no JSON in output");
    return;
  }
  let spendable = 0n;
  let pending = 0n;
  for (const row of j.private_balances?.railgun ?? []) {
    let v = 0n;
    try {
      v = BigInt(row.raw_token_holdings ?? "0");
    } catch {
      continue;
    }
    if ((row.status ?? "spendable").toLowerCase() === "spendable") spendable += v;
    else pending += v;
  }
  const notes: PoolSnapshot["notes"] = [];
  for (const n of j.private_notes?.railgun ?? []) {
    if (typeof n.balance_raw !== "string") continue;
    notes.push({ valueWei: n.balance_raw, status: (n.status ?? "spendable").toLowerCase() });
  }
  pool = { at: Date.now(), spendableWei: spendable.toString(), pendingWei: pending.toString(), notes };
}

// Does the pool hold a SPENDABLE note that looks like this user's shield
// credit? Note value = shielded amount − 25 bps fee, but rounding inside
// Railgun isn't ours to reproduce exactly — match within [−30 bps, 0] of the
// shielded amount. Collisions between identically-sized concurrent shields
// just advance both users, which is harmless.
//
// Status vocabulary: Railgun NOTE rows carry the POI status ("Valid" |
// "ProofSubmitted" | "Missing" | "ShieldBlocked"), defaulting to "spendable"
// when the plugin reports none — NOT the "spendable"/"pending" labels the
// aggregate balance rows use. Accepting only "spendable" here left the first
// real prod cycle stuck in `shielding` forever after its note matured to
// "Valid" (2026-07-19).
function userNoteStatus(u: KohakuUser): "spendable" | "pending" | "missing" {
  if (!pool) return "missing";
  const amt = BigInt(u.depositedWei || "0");
  if (amt <= 0n) return "missing";
  const lo = amt - (amt * 30n) / 10_000n;
  let best: "missing" | "pending" | "spendable" = "missing";
  for (const n of pool.notes) {
    let v: bigint;
    try {
      v = BigInt(n.valueWei);
    } catch {
      continue;
    }
    if (v >= lo && v <= amt) {
      if (n.status === "spendable" || n.status === "valid") return "spendable";
      best = "pending";
    }
  }
  return best;
}

// --- Anonymity counter ------------------------------------------------------

// Count Railgun Shield events in (from, to] — chunked so strict RPCs accept
// the spans. Incremental: callers persist countedTo and only ask for new blocks.
async function countShieldEvents(fromBlock: bigint, toBlock: bigint, rpcUrl?: string): Promise<number> {
  const c = client(rpcUrl);
  let count = 0;
  for (let lo = fromBlock + 1n; lo <= toBlock; lo += LOG_CHUNK) {
    const hi = lo + LOG_CHUNK - 1n > toBlock ? toBlock : lo + LOG_CHUNK - 1n;
    const logs = await c.getLogs({ address: RAILGUN_PROXY, event: SHIELD_EVENT, fromBlock: lo, toBlock: hi });
    count += logs.length;
  }
  return count;
}

async function refreshAnonCount(u: KohakuUser): Promise<void> {
  if (!u.depositBlock) return;
  const c = client(rpcFor(u.owner));
  const tip = await c.getBlockNumber();
  const from = BigInt(u.anonCountedTo ?? u.depositBlock);
  if (tip <= from) return;
  // Bound one refresh to ~20 chunks so a long gap can't stall the tick;
  // the next tick continues from where we stopped.
  const maxTo = from + LOG_CHUNK * 20n;
  const to = tip > maxTo ? maxTo : tip;
  u.anonCount += await countShieldEvents(from, to, rpcFor(u.owner));
  u.anonCountedTo = to.toString();
  persist();
}

// --- Lifecycle steps --------------------------------------------------------

// Re-entrancy guard: the watcher tick is async and overlapping ticks must
// not double-shield / double-advance.
let tickBusy = false;
// Per-user long op in flight (shield/unshield/send) — surfaced in state.
const busyOps = new Map<string, string>();

async function beginShield(u: KohakuUser, balanceWei: bigint): Promise<void> {
  const amount = balanceWei - SHIELD_GAS_RESERVE_WEI;
  if (amount <= 0n) return;
  busyOps.set(u.owner, "shielding");
  log(u, `deposit detected: ${formatEther(balanceWei)} ETH — shielding ${formatEther(amount)} into Railgun`);
  persist();
  try {
    const r = await runKohakuRaw(
      [
        "shield",
        "--protocol",
        "railgun",
        ...walletArgs(),
        "--from",
        u.depositAddress!,
        "--amount-wei",
        amount.toString(),
        "--broadcast",
      ],
      SHIELD_TIMEOUT_MS,
      rpcFor(u.owner),
    );
    if (r.code !== 0) {
      u.error = `shield failed: ${cliErrorText(r)}`;
      log(u, u.error);
      return;
    }
    const j = lastJson(r.stdout) as { transactions?: { type?: string; hash?: string }[] } | null;
    const hash = j?.transactions?.find(t => t.type === "shield")?.hash ?? null;
    const tip = await client(rpcFor(u.owner)).getBlockNumber();
    u.phase = "shielding";
    u.error = null;
    u.depositedWei = amount.toString();
    u.expectedNoteWei = (amount - (amount * SHIELD_FEE_BPS) / 10_000n).toString();
    u.shieldTxHash = hash;
    u.depositBlock = tip.toString();
    u.anonCountedTo = tip.toString();
    u.anonCount = 0;
    u.depositAt = u.depositAt ?? Date.now();
    u.shieldedAt = Date.now();
    u.soakEndsAt = Date.now() + config.kohakuSoakHours * 3_600_000;
    log(u, `shielded ${formatEther(amount)} ETH${hash ? ` (tx ${hash.slice(0, 10)}…)` : ""} — waiting for POI maturation`);
    // Kick a pool sync soon so the "confirming" phase has fresh note data.
    lastPoolSyncAt = 0;
  } finally {
    busyOps.delete(u.owner);
    persist();
  }
}

function maybeAdvanceToSoak(u: KohakuUser): void {
  const note = userNoteStatus(u);
  const age = u.shieldedAt ? Date.now() - u.shieldedAt : 0;
  const poolSpendable = pool ? BigInt(pool.spendableWei) : 0n;
  const expected = BigInt(u.expectedNoteWei || "0");
  const matured =
    note === "spendable" || (note === "missing" && age > POI_FALLBACK_MS && poolSpendable >= expected && expected > 0n);
  if (matured) {
    u.phase = "soaking";
    log(u, "funds are POI-spendable — soaking (anonymity set growing)");
    persist();
  }
}

// --- Watcher ---------------------------------------------------------------

let lastPoolSyncAt = 0;
let watcherStarted = false;

export function startKohakuWatcher(): void {
  if (watcherStarted || !isKohakuConfigured()) return;
  watcherStarted = true;
  emit(`[kohaku] watcher started (cli=${config.kohakuCliDir}, soak=${config.kohakuSoakHours}h)`);
  setInterval(() => {
    void tick().catch(e => emit(`[kohaku] tick error: ${(e as Error).message}`));
  }, POLL_MS).unref();
}

async function tick(): Promise<void> {
  if (tickBusy) return;
  tickBusy = true;
  try {
    const users = Object.values(state.users);
    const anyMidFlight = users.some(u => u.phase === "shielding" || u.phase === "soaking");

    // Occasional pool sync keeps rg-storage warm and note statuses fresh.
    if (anyMidFlight && Date.now() - lastPoolSyncAt > POOL_SYNC_MS) {
      lastPoolSyncAt = Date.now();
      await syncPool();
    }

    for (const u of users) {
      if (busyOps.has(u.owner)) continue;
      if (u.phase === "awaiting-deposit" && u.depositAddress) {
        const bal = await client(rpcFor(u.owner)).getBalance({ address: u.depositAddress as `0x${string}` });
        const prev = BigInt(u.lastSeenDepositWei || "0");
        if (bal >= MIN_DEPOSIT_WEI && bal === prev) {
          // Stable across two ticks — safe to shield.
          if (bal > BigInt(config.kohakuMaxDepositWei)) {
            if (!u.overCap) {
              u.overCap = true;
              log(
                u,
                `deposit ${formatEther(bal)} ETH exceeds the ${formatEther(BigInt(config.kohakuMaxDepositWei))} ETH cap — NOT shielding; contact the host`,
              );
              persist();
            }
          } else if (!u.lastShieldAttemptAt || Date.now() - u.lastShieldAttemptAt > 10 * 60_000) {
            u.depositAt = Date.now();
            u.lastShieldAttemptAt = Date.now();
            await beginShield(u, bal);
          }
        } else if (bal !== prev) {
          u.lastSeenDepositWei = bal.toString();
          if (bal > 0n && prev === 0n) log(u, `incoming ETH spotted (${formatEther(bal)}) — confirming`);
          persist();
        }
      } else if (u.phase === "shielding") {
        maybeAdvanceToSoak(u);
      } else if (u.phase === "soaking") {
        await refreshAnonCount(u).catch(() => undefined);
      }
    }
  } finally {
    tickBusy = false;
  }
}

// --- Public API (called by the routes in index.ts) --------------------------

function newUser(owner: string): KohakuUser {
  return {
    owner,
    phase: "awaiting-deposit",
    depositAddress: null,
    depositIndex: null,
    withdrawAddress: null,
    depositedWei: "0",
    expectedNoteWei: "0",
    withdrawnWei: "0",
    shieldTxHash: null,
    unshieldHash: null,
    depositBlock: null,
    depositAt: null,
    shieldedAt: null,
    soakEndsAt: null,
    withdrawnAt: null,
    anonCount: 0,
    anonCountedTo: null,
    lastSeenDepositWei: "0",
    overCap: false,
    error: null,
    activity: [],
  };
}

export type KohakuOpResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

/** Create (or return) this user's privacy wallet cycle with a fresh deposit
 *  address. Also the "start over" path once a finished cycle is emptied. */
export async function kohakuOpen(ownerRaw: string): Promise<KohakuOpResult> {
  if (!isKohakuConfigured()) return { ok: false, error: "privacy wallet not configured" };
  const owner = ownerRaw.toLowerCase();
  const existing = state.users[owner];
  if (existing) {
    if (existing.phase !== "wallet") return { ok: true, state: publicView(existing) };
    // Re-open after a completed cycle — only once the withdrawal address is
    // (near) empty, so we never orphan accounting for funds still there.
    const bal = existing.withdrawAddress
      ? await client(rpcFor(owner)).getBalance({ address: existing.withdrawAddress as `0x${string}` })
      : 0n;
    if (bal >= MIN_DEPOSIT_WEI) {
      return { ok: false, error: "your wallet still holds funds — send them out before starting a new cycle" };
    }
  }
  // next-fresh-address prints the bare address and persists the account.
  const r = await runKohakuRaw(["next-fresh-address", ...walletArgs()], QUICK_TIMEOUT_MS, rpcFor(owner));
  if (r.code !== 0) return { ok: false, error: `couldn't derive a deposit address: ${cliErrorText(r)}` };
  const addr = r.stdout
    .trim()
    .split("\n")
    .map(l => l.trim())
    .reverse()
    .find(l => /^0x[0-9a-fA-F]{40}$/.test(l));
  if (!addr) return { ok: false, error: "couldn't parse the deposit address from kohaku-cli" };
  // Index lookup: balances --verbose maps address → account index, but a
  // spare child-process run here is waste — the CLI appends accounts in
  // order, and `shield --from` also accepts the ADDRESS itself. We store
  // the index as null and pass the address to --from. (shield-flow's
  // findAccountWithBalance accepts address-or-index.)
  const u = newUser(owner);
  u.depositAddress = getAddress(addr);
  state.users[owner] = u;
  log(u, `privacy wallet opened — deposit address ${u.depositAddress}`);
  persist();
  return { ok: true, state: publicView(u) };
}

/** Unshield the user's private balance to a fresh, unlinked address. */
export async function kohakuWithdraw(ownerRaw: string): Promise<KohakuOpResult> {
  if (!isKohakuConfigured()) return { ok: false, error: "privacy wallet not configured" };
  const owner = ownerRaw.toLowerCase();
  const u = state.users[owner];
  if (!u) return { ok: false, error: "no privacy wallet — open one first" };
  if (busyOps.has(owner)) return { ok: false, error: `busy: ${busyOps.get(owner)}` };
  if (u.phase !== "soaking") {
    return { ok: false, error: u.phase === "shielding" ? "still confirming on-chain — withdraw unlocks once your funds are spendable" : `can't withdraw in phase ${u.phase}` };
  }
  busyOps.set(owner, "withdrawing");
  u.phase = "withdrawing";
  log(u, "withdrawing — deriving a fresh unlinked address and unshielding");
  persist();
  try {
    const ra = await runKohakuRaw(["next-fresh-address", ...walletArgs()], QUICK_TIMEOUT_MS, rpcFor(owner));
    if (ra.code !== 0) throw new Error(`fresh address: ${cliErrorText(ra)}`);
    const addr = ra.stdout
      .trim()
      .split("\n")
      .map(l => l.trim())
      .reverse()
      .find(l => /^0x[0-9a-fA-F]{40}$/.test(l));
    if (!addr) throw new Error("couldn't parse the withdrawal address");
    u.withdrawAddress = getAddress(addr);
    persist();

    // How much to unshield: the user's accounted note, minus the 25 bps
    // unshield fee margin and a flat gas reserve (both paid out of the
    // private balance on top of the amount), then rounded DOWN to the
    // withdrawal grid. The grid is a privacy feature, not cosmetics: the
    // first live cycle exited with 0.0088483705 ETH — a wei-precision
    // snowflake that fingerprints the withdrawal against the deposit no
    // matter how long it soaked. Round denominations make every exit look
    // like every other exit. NEVER --amount-max: the pool is commingled,
    // so "max" is the whole pool — including other users' notes and legacy
    // change (observed live: max quoted 0.0164 against a 0.0094 note).
    // The crumbs stay in the pool as anonymity-set ballast.
    //
    // Denomination choice comes from watching the actual crowd: 30 days of
    // mainnet Unshield events (n=2627 via the local node — see
    // ops/RAILGUN-DENOMINATION-STUDY.md). The dominant convention is round
    // *gross*, so the biggest crowds RECEIVE gross×(1−25bps): 0.009975
    // (n=100), 0.09975 (45), 0.9975 (40), 0.49875 (19)… kohaku's
    // --amount-wei IS the received amount, so we target those values
    // directly. Snap to the largest crowd denom the balance affords (≥85%
    // capture); fine-grid fallback so funds never strand.
    const expected = BigInt(u.expectedNoteWei || "0");
    const available = expected - UNSHIELD_GAS_RESERVE_WEI;
    // Max we can have the recipient RECEIVE: the note still owes the 25 bps
    // unshield fee on the gross, pulled from balance on top. received ≈
    // available / (1 + 25bps); use a 30 bps safety divisor.
    const maxRecv = (available * 10_000n) / 10_030n;
    let amount = (maxRecv / WITHDRAW_GRID_WEI) * WITHDRAW_GRID_WEI;
    for (const d of WITHDRAW_RECV_DENOMS_WEI) {
      if (d <= maxRecv && d * 100n >= maxRecv * 85n) {
        amount = d;
        break;
      }
    }
    if (amount <= 0n) throw new Error("balance too small to cover the unshield fee + gas reserve");
    const amountArgs = ["--amount-wei", amount.toString()];
    const r = await runKohakuRaw(
      ["unshield", "--protocol", "railgun", ...walletArgs(), "--to", u.withdrawAddress, ...amountArgs, "--broadcast"],
      UNSHIELD_TIMEOUT_MS,
      rpcFor(owner),
    );
    if (r.code !== 0) throw new Error(cliErrorText(r));
    const j = lastJson(r.stdout) as { amountWei?: string; explorerHash?: string | null } | null;
    u.phase = "wallet";
    u.error = null;
    u.withdrawnWei = j?.amountWei ?? "0";
    u.unshieldHash = j?.explorerHash ?? null;
    u.withdrawnAt = Date.now();
    log(
      u,
      `unshielded ${j?.amountWei ? formatEther(BigInt(j.amountWei)) : "?"} ETH to ${u.withdrawAddress}${u.unshieldHash ? ` (${u.unshieldHash.slice(0, 10)}…)` : ""} — your clean wallet is live`,
    );
    persist();
    return { ok: true, state: publicView(u) };
  } catch (e) {
    u.phase = "soaking"; // roll back — funds are still private and spendable
    u.error = `withdraw failed: ${(e as Error).message}`;
    log(u, u.error);
    persist();
    return { ok: false, error: u.error };
  } finally {
    busyOps.delete(owner);
  }
}

/** Send ETH out of the user's (relay-held) withdrawal address. The dangerous
 *  op: capped per-op, simulated by the CLI before broadcast. */
export async function kohakuSend(ownerRaw: string, toRaw: string, amountWeiRaw: string | "max"): Promise<KohakuOpResult> {
  if (!isKohakuConfigured()) return { ok: false, error: "privacy wallet not configured" };
  const owner = ownerRaw.toLowerCase();
  const u = state.users[owner];
  if (!u) return { ok: false, error: "no privacy wallet" };
  if (u.phase !== "wallet" || !u.withdrawAddress) return { ok: false, error: "no withdrawn funds to send yet" };
  if (busyOps.has(owner)) return { ok: false, error: `busy: ${busyOps.get(owner)}` };
  if (!isAddress(toRaw)) return { ok: false, error: "destination must be a 0x… address" };
  const to = getAddress(toRaw);
  const cap = BigInt(config.kohakuMaxSendWei);

  let amountArgs: string[];
  if (amountWeiRaw === "max") {
    const bal = await client(rpcFor(owner)).getBalance({ address: u.withdrawAddress as `0x${string}` });
    if (bal > cap) return { ok: false, error: `sends are capped at ${formatEther(cap)} ETH per op — send in slices` };
    amountArgs = ["--amount-max"];
  } else {
    let amt: bigint;
    try {
      amt = BigInt(amountWeiRaw);
    } catch {
      return { ok: false, error: "bad amount" };
    }
    if (amt <= 0n) return { ok: false, error: "amount must be positive" };
    if (amt > cap) return { ok: false, error: `sends are capped at ${formatEther(cap)} ETH per op` };
    amountArgs = ["--amount-wei", amt.toString()];
  }

  busyOps.set(owner, "sending");
  persist();
  try {
    const r = await runKohakuRaw(
      ["transfer", ...walletArgs(), "--from", u.withdrawAddress, "--to", to, ...amountArgs, "--broadcast"],
      QUICK_TIMEOUT_MS,
      rpcFor(owner),
    );
    if (r.code !== 0) return { ok: false, error: `send failed: ${cliErrorText(r)}` };
    const j = lastJson(r.stdout) as { hash?: string; amount?: string } | null;
    log(u, `sent ${j?.amount ? formatEther(BigInt(j.amount)) : "?"} ETH to ${to}${j?.hash ? ` (${j.hash.slice(0, 10)}…)` : ""}`);
    persist();
    return { ok: true, hash: j?.hash ?? null, state: publicView(u) };
  } finally {
    busyOps.delete(owner);
  }
}

/** Set (or clear, with an empty string) this owner's mainnet RPC override.
 *  Validated hard: the relay will POST to this URL on the user's behalf, so
 *  it must be a public http(s) endpoint that answers eth_chainId with 0x1 —
 *  the liveness probe doubles as an SSRF gate (a non-RPC internal service
 *  won't answer 0x1) on top of the private-address blocks below. */
export async function kohakuSetRpc(ownerRaw: string, urlRaw: string): Promise<KohakuOpResult> {
  if (!isKohakuConfigured()) return { ok: false, error: "privacy wallet not configured" };
  const owner = ownerRaw.toLowerCase();
  const url = urlRaw.trim();
  if (!state.settings) state.settings = {};
  if (!url) {
    delete state.settings[owner];
    persist();
    return { ok: true, rpcUrl: null, defaultRpcUrl: defaultRpcDisplay() };
  }
  if (url.length > 300) return { ok: false, error: "URL too long" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "not a valid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "must be an http(s) URL" };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host)
  ) {
    return { ok: false, error: "that address isn't reachable from the relay — expose your node publicly (or tunnel it) first" };
  }
  // Liveness + right-chain + log-serving probes. The getLogs check matters:
  // Railgun's incremental sync is getLogs-driven, so an endpoint that
  // rate-limits or refuses log queries (e.g. the BuidlGuidl public RPC,
  // verified 2026-07: eth_chainId fine, first eth_getLogs → 429) would break
  // every shield/withdraw for this user. Better to reject at save time.
  const probe = async (method: string, params: unknown[]): Promise<{ result?: unknown; error?: unknown } | null> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ac.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as { result?: unknown; error?: unknown };
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  };
  const chainRes = await probe("eth_chainId", []);
  const chainId = typeof chainRes?.result === "string" ? chainRes.result : undefined;
  if (chainId !== "0x1") {
    if (!chainRes) return { ok: false, error: "couldn't reach that RPC from the relay" };
    return { ok: false, error: chainId ? `that RPC is on chain ${Number(chainId)}, not mainnet` : "that URL didn't answer like an Ethereum RPC" };
  }
  const tipRes = await probe("eth_blockNumber", []);
  const tipHex = typeof tipRes?.result === "string" ? tipRes.result : null;
  if (tipHex) {
    const tip = Number.parseInt(tipHex, 16);
    const logsRes = await probe("eth_getLogs", [
      { address: RAILGUN_PROXY, fromBlock: `0x${(tip - 20).toString(16)}`, toBlock: tipHex },
    ]);
    if (!logsRes || !Array.isArray(logsRes.result)) {
      return {
        ok: false,
        error: "that RPC refuses eth_getLogs queries, which Railgun syncing needs — use a node that serves logs",
      };
    }
  }
  state.settings[owner] = { rpcUrl: url };
  persist();
  const u = state.users[owner];
  if (u) log(u, `RPC set to ${parsed.hostname}`);
  emit(`[kohaku ${owner.slice(0, 10)}] rpc override → ${parsed.hostname}`);
  return { ok: true, rpcUrl: url, defaultRpcUrl: defaultRpcDisplay() };
}

// --- Chat ("talk to your funds") ---------------------------------------------

const CHAT_SYS = [
  "You are the voice of a user's Shield wallet on slop.computer — ETH that was passed through Railgun's private pool and now sits at a fresh, unlinkable address held by the relay.",
  "Answer questions about the wallet plainly in 1-3 short sentences, plain text, a light cyberdelic vibe is fine. You know only what WALLET STATE says.",
  "WALLET STATE may include ethUsdPrice (Chainlink ETH/USD spot) and balanceUsd (the holding's precomputed dollar value) — quote those for any what's-it-worth question; never do your own multiplication. If they're null, say price data is briefly unavailable.",
  "If (and only if) the user asks to SEND ETH somewhere, include a proposal. The destination must be one the USER explicitly gave — a 0x address or a .eth name. NEVER invent a destination or an amount. 'send all/everything/max' → amountEth \"max\".",
  'Return ONLY compact JSON, no markdown: {"reply":"<text>","proposal":{"to":"<0x-or-ens>","amountEth":"<decimal or max>"}|null}',
  "If the user wants to send to their main/known/public wallet, still propose it but warn in the reply that sending to a known wallet publicly ties the clean ETH to them — a FRESH wallet preserves anonymity.",
].join("\n");

function chatJson(text: string): { reply?: unknown; proposal?: unknown } | null {
  const fenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** One turn of wallet chat. The LLM only ever PROPOSES — the UI confirms and
 *  the capped relay endpoints execute, so the model holds no authority.
 *  Wallet phase runs the full intent engine (swaps, ERC-20s, LI.FI) against
 *  the clean address; earlier phases keep the lightweight Q&A below. */
export async function kohakuChat(ownerRaw: string, textRaw: string): Promise<KohakuOpResult> {
  if (!isKohakuConfigured()) return { ok: false, error: "privacy wallet not configured" };
  const owner = ownerRaw.toLowerCase();
  const u = state.users[owner];
  if (!u) return { ok: false, error: "open your Shield first" };
  const text = textRaw.trim().slice(0, 500);
  if (!text) return { ok: false, error: "say something" };
  if (u.phase === "wallet" && u.withdrawAddress && config.aiWalletLlmKey) {
    return shieldIntentTurn(owner, u, text);
  }
  if (!hasBankrLlm()) return { ok: false, error: "chat isn't configured on this box" };

  let balanceEth: string | null = null;
  if (u.phase === "wallet" && u.withdrawAddress) {
    try {
      balanceEth = formatEther(await client(rpcFor(owner)).getBalance({ address: u.withdrawAddress as `0x${string}` }));
    } catch {
      /* stale is fine for chat */
    }
  }
  const v = publicView(u);
  // Chainlink ETH/USD from the gas poller — precompute the USD value so
  // the model reports it instead of attempting arithmetic (or refusing).
  // Pre-wallet phases have no withdraw balance yet; value whatever ETH is
  // in flight (pool note, then raw deposit) instead.
  const ethUsd = getGasState()?.ethUsd ?? null;
  const holdingEth = [balanceEth, v.poolSpendableEth, v.expectedNoteEth, v.depositedEth].find(
    x => x && Number(x) > 0,
  );
  const balanceUsd = ethUsd && holdingEth ? (Number(holdingEth) * ethUsd).toFixed(2) : null;
  const ctx = {
    phase: v.phase,
    balanceEth,
    balanceUsd,
    ethUsdPrice: ethUsd ? ethUsd.toFixed(2) : null,
    address: u.withdrawAddress,
    soakProgressPct: Math.round(v.soakProgress * 100),
    anonymityShields: v.anonymityShields,
    depositedEth: v.depositedEth,
    withdrawnEth: v.withdrawnEth,
    sendCapEth: v.caps.maxSendEth,
    recentActivity: u.activity.slice(-6).map(a => a.text),
    sendsPossible: u.phase === "wallet",
  };

  const res = await bankrChat(
    [
      { role: "system", content: CHAT_SYS },
      { role: "user", content: `WALLET STATE: ${JSON.stringify(ctx)}\n\nUSER: ${text}` },
    ],
    { maxTokens: 300, temperature: 0.4 },
  );
  if (!res.ok) return { ok: false, error: "the wallet's brain is unreachable — try again" };
  const parsed = chatJson(res.text);
  let reply = typeof parsed?.reply === "string" && parsed.reply ? parsed.reply : res.text.slice(0, 400);

  // Validate any proposal down to something the send endpoint would accept.
  let proposal: { to: string; toLabel: string; amountEth: string; max: boolean } | null = null;
  const p = parsed?.proposal as { to?: unknown; amountEth?: unknown } | null | undefined;
  if (p && typeof p.to === "string" && typeof p.amountEth === "string" && u.phase === "wallet") {
    const rawTo = p.to.trim();
    let to: string | null = null;
    let toLabel = rawTo;
    if (isAddress(rawTo)) {
      to = getAddress(rawTo);
    } else if (/^[a-z0-9-.]+\.eth$/i.test(rawTo)) {
      try {
        const resolved = await client(rpcFor(owner)).getEnsAddress({ name: normalize(rawTo) });
        if (resolved) {
          to = resolved;
          toLabel = `${rawTo} (${resolved.slice(0, 8)}…)`;
        }
      } catch {
        /* fall through */
      }
      if (!to) reply += `\n(couldn't resolve ${rawTo} — check the name)`;
    }
    const max = p.amountEth.trim().toLowerCase() === "max";
    let amountOk = max;
    if (!max) {
      try {
        amountOk = parseEther(p.amountEth.trim()) > 0n;
      } catch {
        amountOk = false;
      }
    }
    if (to && amountOk) proposal = { to, toLabel, amountEth: max ? "max" : p.amountEth.trim(), max };
  }

  return { ok: true, reply, proposal };
}

// --- Full intent-engine chat (wallet phase) ---------------------------------
//
// The same brain as the main Wallet app (runWalletIntent: LI.FI swaps, ERC-20
// sends, wraps, simulation, ENS) pointed at the Shield clean address. The
// custody inversion is the danger here — the relay holds this key, so unlike
// the multisig flow nobody co-signs. Containment: the engine only ever stores
// a proposal server-side; the client can confirm an id, never submit calldata;
// total ETH value per confirmed op stays under the send cap; mainnet only;
// proposals expire before LI.FI quotes go stale.

const CHAT_HISTORY_TURNS = 12;
const PROPOSAL_TTL_MS = 10 * 60_000;
const MAX_STEP_DELAY_MS = 120_000;

type ChatProposal = {
  id: string;
  steps: IntentStep[];
  delayMs: number;
  createdAt: number;
};

const chatHistories = new Map<string, { role: string; content: string }[]>();
const chatProposals = new Map<string, ChatProposal>(); // one live proposal per owner

const shieldIntentSystem = (capEth: string) => `
SHIELD MODE — this session operates the user's Shield clean wallet on slop.computer (read last; this section supersedes every conflicting instruction above):
- The address is a fresh EOA holding ETH that exited Railgun's private pool. Its unlinkability to the user's public identity IS the product. The relay holds its key custodially; anything you build executes server-side ONLY after the user taps confirm in the Shield UI.
- ETHEREUM MAINNET ONLY (chainId 1). Never build a transaction on any other chain and never propose bridging away from mainnet.
- Total ETH value per confirmed operation is capped at ${capEth} ETH. Refuse larger amounts and suggest sending in slices.
- Never invent a destination: sends and transfers go only to a 0x address or ENS name the user explicitly gave.
- If the user directs funds at an address or ENS name publicly known as theirs, still build it but WARN in your message that it publicly ties the clean funds back to them — a fresh wallet keeps the anonymity.`;

/** One wallet-phase chat turn through the intent engine. Returns a reply plus
 *  an optional server-stored txProposal the UI can confirm by id. */
async function shieldIntentTurn(owner: string, u: KohakuUser, text: string): Promise<KohakuOpResult> {
  const address = u.withdrawAddress as string;
  const [pf, act] = await Promise.all([
    fetchPortfolio(address).catch(() => null),
    fetchActivity(address).catch(() => null),
  ]);
  const history = chatHistories.get(owner) ?? [];
  const result = await runWalletIntent({
    message: text,
    address,
    chainId: 1,
    walletKind: "eoa",
    extraSystem: shieldIntentSystem(formatEther(BigInt(config.kohakuMaxSendWei))),
    portfolio: (pf?.assets ?? []).map(x => ({
      tokenSymbol: x.tokenSymbol,
      balance: x.balance,
      balanceUsd: x.balanceUsd,
      blockchain: x.blockchain,
      contractAddress: x.contractAddress,
    })),
    recentActivity: (act?.items ?? []).slice(0, 10).map(x => ({
      type: x.type,
      chain: x.chain,
      minedAt: x.minedAt,
      out: x.out ? { symbol: x.out.symbol, amount: x.out.amount } : null,
      in: x.in ? { symbol: x.in.symbol, amount: x.in.amount } : null,
      valueUsd: x.valueUsd,
    })),
    recentMessages: history,
  });
  chatHistories.set(
    owner,
    [...history, { role: "user", content: text }, { role: "assistant", content: result.message }].slice(
      -CHAT_HISTORY_TURNS,
    ),
  );

  const reply = result.message;
  let steps: IntentStep[] = [];
  let delayMs = 0;
  let changes: { direction: string; symbol: string; amount: string }[] = [];
  if (result.type === "transaction") {
    const t = result.transaction;
    steps = [
      {
        to: t.to,
        data: t.data,
        value: t.value,
        chainId: t.chainId,
        description: t.description ?? "transaction",
        label: "tx",
      },
    ];
    if (t.simulation?.verified && Array.isArray(t.simulation.changes)) changes = t.simulation.changes;
  } else if (result.type === "multistep_transaction") {
    steps = result.steps;
    delayMs = Math.min(Math.max(result.delay, 0), MAX_STEP_DELAY_MS);
  }

  if (steps.length === 0) {
    chatProposals.delete(owner);
    return { ok: true, reply, txProposal: null };
  }

  // Validate down to what the executor would sign: mainnet, sane fields,
  // total ETH under the per-op cap. A violation demotes the turn to chat.
  const demote = (why: string): KohakuOpResult => ({ ok: true, reply: `${reply}\n(dropped: ${why})`, txProposal: null });
  let totalWei = 0n;
  for (const s of steps) {
    if (s.chainId !== 1) return demote("proposal wasn't mainnet — Shield is mainnet-only");
    if (!isAddress(s.to)) return demote("bad destination in the built transaction");
    if (!/^0x[0-9a-fA-F]*$/.test(s.data || "0x")) return demote("malformed calldata");
    try {
      const v = BigInt(s.value || "0");
      if (v < 0n) throw new Error("neg");
      totalWei += v;
    } catch {
      return demote("bad value in the built transaction");
    }
  }
  const cap = BigInt(config.kohakuMaxSendWei);
  if (totalWei > cap) {
    return demote(`total ${formatEther(totalWei)} ETH exceeds the ${formatEther(cap)} ETH per-op cap`);
  }

  const proposal: ChatProposal = { id: randomBytes(8).toString("hex"), steps, delayMs, createdAt: Date.now() };
  chatProposals.set(owner, proposal);
  return {
    ok: true,
    reply,
    txProposal: {
      id: proposal.id,
      steps: steps.map(s => ({
        description: s.description || s.label || "transaction",
        to: getAddress(s.to),
        valueEth: formatEther(BigInt(s.value || "0")),
      })),
      changes,
      totalValueEth: formatEther(totalWei),
    },
  };
}

/** Execute a chat-built proposal by id — the confirm chip's endpoint. Each
 *  step runs as its own CLI invocation so transact-raw's pre-broadcast
 *  simulation sees the prior step mined (approve → swap). Plain ETH sends
 *  (empty calldata) reuse the proven `transfer` command. */
export async function kohakuExecuteChatTx(ownerRaw: string, id: string): Promise<KohakuOpResult> {
  if (!isKohakuConfigured()) return { ok: false, error: "privacy wallet not configured" };
  const owner = ownerRaw.toLowerCase();
  const u = state.users[owner];
  if (!u) return { ok: false, error: "no privacy wallet" };
  if (u.phase !== "wallet" || !u.withdrawAddress) return { ok: false, error: "no withdrawn funds yet" };
  if (busyOps.has(owner)) return { ok: false, error: `busy: ${busyOps.get(owner)}` };
  const p = chatProposals.get(owner);
  if (!p || p.id !== id) return { ok: false, error: "that proposal is gone — ask the chat again" };
  if (Date.now() - p.createdAt > PROPOSAL_TTL_MS) {
    chatProposals.delete(owner);
    return { ok: false, error: "that proposal expired (quotes go stale) — ask the chat again" };
  }
  // Re-check the cap at execution time — the store is trusted, but cheap belt+braces.
  const totalWei = p.steps.reduce((s, x) => s + BigInt(x.value || "0"), 0n);
  if (totalWei > BigInt(config.kohakuMaxSendWei)) {
    chatProposals.delete(owner);
    return { ok: false, error: "proposal exceeds the per-op cap" };
  }

  busyOps.set(owner, "executing");
  chatProposals.delete(owner); // single-shot: confirm consumes it, success or not
  try {
    const hashes: string[] = [];
    for (let i = 0; i < p.steps.length; i++) {
      const s = p.steps[i]!;
      if (i > 0 && p.delayMs > 0) await new Promise(r => setTimeout(r, p.delayMs));
      const stepName = s.description || s.label || `step ${i + 1}`;
      const plainSend = !s.data || s.data === "0x";
      const r = await runKohakuRaw(
        plainSend
          ? [
              "transfer",
              ...walletArgs(),
              "--from",
              u.withdrawAddress,
              "--to",
              s.to,
              "--amount-wei",
              BigInt(s.value || "0").toString(),
              "--broadcast",
            ]
          : [
              "transact-raw",
              ...walletArgs(),
              "--from",
              u.withdrawAddress,
              "--targets",
              s.to,
              "--payloads",
              s.data,
              "--values",
              BigInt(s.value || "0").toString(),
              "--broadcast",
            ],
        QUICK_TIMEOUT_MS,
        rpcFor(owner),
      );
      if (r.code !== 0) {
        const landed = hashes.length
          ? ` — earlier steps already landed: ${hashes.map(h => h.slice(0, 10)).join(", ")}`
          : "";
        log(u, `chat op failed at ${stepName}`);
        return { ok: false, error: `${stepName} failed: ${cliErrorText(r)}${landed}` };
      }
      const j = lastJson(r.stdout) as { hash?: string; transactions?: { hash?: string }[] } | null;
      const hash = j?.hash ?? j?.transactions?.[0]?.hash ?? null;
      if (hash) hashes.push(hash);
      log(u, `chat: ${stepName}${hash ? ` (${hash.slice(0, 10)}…)` : ""}`);
    }
    persist();
    return { ok: true, hashes, state: publicView(u) };
  } finally {
    busyOps.delete(owner);
  }
}

// --- State views ------------------------------------------------------------

// Deposits pre-padded to land exactly on a big-crowd RECEIVED denomination,
// working the fee waterfall backwards: deposit → −shield gas → −25 bps shield
// fee → note → −unshield gas reserve → −25 bps unshield fee → received. The
// exit shown is the crowd amount (0.009975…), not a clean round number — the
// clean number is a smaller crowd (see the study). Rounded up to 0.0001 so
// the deposit is typeable.
function depositSuggestions(): { depositEth: string; exitEth: string }[] {
  const out: { depositEth: string; exitEth: string }[] = [];
  const grid = 100_000_000_000_000n; // 0.0001 display grid
  for (const recv of [...WITHDRAW_RECV_DENOMS_WEI].reverse()) {
    // note must cover received + unshield fee (25bps of gross≈recv) + gas.
    const noteNeeded = recv + (recv * RG_UNSHIELD_FEE_BPS) / 10_000n + UNSHIELD_GAS_RESERVE_WEI;
    const beforeShieldFee = (noteNeeded * 10_000n) / 9_975n;
    let dep = beforeShieldFee + SHIELD_GAS_RESERVE_WEI + 200_000_000_000_000n; // +0.0002 pad
    dep = ((dep + grid - 1n) / grid) * grid;
    if (dep < MIN_DEPOSIT_WEI || dep > BigInt(config.kohakuMaxDepositWei)) continue;
    out.push({ depositEth: formatEther(dep), exitEth: formatEther(recv) });
  }
  return out;
}

function publicView(u: KohakuUser) {
  const now = Date.now();
  const soakStart = u.shieldedAt ?? now;
  const soakEnd = u.soakEndsAt ?? now;
  const soakProgress =
    u.phase === "wallet" ? 1 : soakEnd > soakStart ? Math.min(1, Math.max(0, (now - soakStart) / (soakEnd - soakStart))) : 0;
  return {
    phase: u.phase,
    busy: busyOps.get(u.owner) ?? null,
    error: u.error,
    overCap: u.overCap,
    depositAddress: u.depositAddress,
    withdrawAddress: u.withdrawAddress,
    depositedEth: formatEther(BigInt(u.depositedWei || "0")),
    expectedNoteEth: formatEther(BigInt(u.expectedNoteWei || "0")),
    withdrawnEth: formatEther(BigInt(u.withdrawnWei || "0")),
    pendingDepositEth: formatEther(BigInt(u.lastSeenDepositWei || "0")),
    shieldTxHash: u.shieldTxHash,
    unshieldHash: u.unshieldHash,
    shieldedAt: u.shieldedAt,
    soakEndsAt: u.soakEndsAt,
    soakProgress,
    soakHours: config.kohakuSoakHours,
    anonymityShields: u.anonCount,
    poolSpendableEth: pool ? formatEther(BigInt(pool.spendableWei)) : null,
    poolPendingEth: pool ? formatEther(BigInt(pool.pendingWei)) : null,
    poolSyncedAt: pool?.at ?? null,
    activity: u.activity.slice(-30),
    caps: {
      maxDepositEth: formatEther(BigInt(config.kohakuMaxDepositWei)),
      maxSendEth: formatEther(BigInt(config.kohakuMaxSendWei)),
      minDepositEth: formatEther(MIN_DEPOSIT_WEI),
    },
    depositSuggestions: depositSuggestions(),
  };
}

export type KohakuPublicView = ReturnType<typeof publicView>;

/** Full per-user view for GET /v1/kohaku/state (null = no cycle opened). */
export async function kohakuStateFor(ownerRaw: string): Promise<{
  configured: boolean;
  state: KohakuPublicView | null;
  walletBalanceEth: string | null;
  rpcUrl: string | null;
  defaultRpcUrl: string;
}> {
  const owner = ownerRaw.toLowerCase();
  const u = state.users[owner];
  let walletBalanceEth: string | null = null;
  if (u?.phase === "wallet" && u.withdrawAddress && isKohakuConfigured()) {
    try {
      walletBalanceEth = formatEther(await client(rpcFor(owner)).getBalance({ address: u.withdrawAddress as `0x${string}` }));
    } catch {
      /* RPC hiccup — the UI shows a stale/blank balance rather than erroring */
    }
  }
  return {
    configured: isKohakuConfigured(),
    state: u ? publicView(u) : null,
    walletBalanceEth,
    rpcUrl: state.settings?.[owner]?.rpcUrl ?? null,
    defaultRpcUrl: defaultRpcDisplay(),
  };
}

/** One-line summary folded into the big /v1/state snapshot. */
export function kohakuSummaryFor(ownerRaw: string | null): { phase: KohakuPhase; soakProgress: number } | null {
  if (!ownerRaw) return null;
  const u = state.users[ownerRaw.toLowerCase()];
  if (!u) return null;
  const v = publicView(u);
  return { phase: v.phase, soakProgress: v.soakProgress };
}

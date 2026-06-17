"use client";

// No-Limit Texas Hold'em TOURNAMENT. Built on the generic escrow session
// (mesh.escrow, game === "poker") + the server-authoritative engine
// (mesh.pokerState public view + mesh.pokerPrivate hole cards). The relay
// owns the deck, the betting state machine, the deadline, eliminations, and
// every transition; this surface renders the table and posts intent.
//
//   1. Open    — a host sets buy-in, starting stack, blinds (escalating),
//                and a buy-in-window length. No roster up front.
//   2. Join    — any player buys in (plain ETH → multisig, verified) and
//                takes the next seat until the window closes (late
//                registration). Mid-hand joiners are dealt in next hand.
//   3. Play    — once ≥2 are seated, anyone deals. Play until you bust; the
//                window keeps counting down; blinds escalate on a clock.
//   4. Payout  — when one player has all the chips the tournament ends; the
//                prize pool (Σ buy-ins) is split by finishing place and
//                anyone submits the multisig payout (reused PayoutProposeButton).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, parseEther } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from "wagmi";
import { PayoutProposeButton } from "~~/components/desktop/chess/WagerPanel";
import type {
  EscrowSession,
  PeerMeshState,
  PokerActionKind,
  PokerSeatPublic,
  PokerTableView,
} from "~~/hooks/usePeerMesh";
import {
  isPokerMuted,
  setPokerMuted,
  sfxCardFlip,
  sfxCheck,
  sfxChips,
  sfxDeal,
  sfxFold,
  sfxTick,
  sfxWin,
  unlockPokerAudio,
} from "~~/utils/pokerSounds";

const ACCENT = "var(--slop-magenta, #ff3ec9)";
const CYAN = "var(--slop-cyan, #2ee6d6)";
const LIME = "var(--slop-lime, #b6ff3c)";
const PANEL_BG = "#0a061a";
const FELT = "#0c2a1e";

type Props = { mesh: PeerMeshState; myOwnerKey: string | null; myLabel: string | null };

const fmtEth = (wei: string) => {
  try {
    const n = Number(formatEther(BigInt(wei)));
    return n < 0.0001 ? n.toExponential(2) : n.toLocaleString(undefined, { maximumFractionDigits: 5 });
  } catch {
    return "0";
  }
};
const metaStr = (esc: EscrowSession, k: string) => (typeof esc.meta[k] === "string" ? (esc.meta[k] as string) : "");
const metaNum = (esc: EscrowSession, k: string) => (typeof esc.meta[k] === "number" ? (esc.meta[k] as number) : 0);

function btn(color: string, disabled = false): React.CSSProperties {
  return {
    background: disabled ? "#1a1530" : color,
    color: disabled ? "var(--slop-text-muted)" : "#0a061a",
    border: "none",
    borderRadius: 8,
    padding: "8px 14px",
    fontFamily: "var(--slop-font-display)",
    fontSize: 13,
    cursor: disabled ? "default" : "pointer",
    fontWeight: 700,
  };
}

// ─── Cards ───────────────────────────────────────────────────────────

const SUIT_GLYPH: Record<string, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };
const RED = new Set(["d", "h"]);

const Card = ({ card, hidden, small }: { card?: string; hidden?: boolean; small?: boolean }) => {
  const w = small ? 26 : 34;
  const h = small ? 36 : 48;
  if (hidden || !card) {
    return (
      <div
        style={{
          width: w,
          height: h,
          borderRadius: 5,
          background: hidden
            ? "repeating-linear-gradient(45deg,#3a2160,#3a2160 4px,#2a1648 4px,#2a1648 8px)"
            : "#160e2e",
          border: "1px solid #2a1648",
        }}
      />
    );
  }
  const rank = card[0] === "T" ? "10" : card[0];
  const suit = card[1]!;
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: 5,
        background: "#f4f0ff",
        border: "1px solid #c9bdf0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: RED.has(suit) ? "#c01e3c" : "#160e2e",
        fontWeight: 800,
        fontSize: small ? 12 : 15,
        lineHeight: 1,
      }}
    >
      <span>{rank}</span>
      <span style={{ fontSize: small ? 13 : 16 }}>{SUIT_GLYPH[suit]}</span>
    </div>
  );
};

// Live countdown to a deadline — ticks each second. Formats m:ss past 60s.
const Countdown = ({ deadline, urgentAt = 10 }: { deadline: number | null; urgentAt?: number }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);
  if (!deadline) return null;
  const secs = Math.max(0, Math.ceil((deadline - now) / 1000));
  const label = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
  return <span style={{ fontSize: 12, color: secs <= urgentAt ? ACCENT : "var(--slop-text-muted)" }}>⏱ {label}</span>;
};

// ─── Open a table ────────────────────────────────────────────────────

const CHAIN_LABELS: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  10: "Optimism",
  42161: "Arbitrum",
  137: "Polygon",
  100: "Gnosis",
};

const OpenTableForm = ({ mesh }: { mesh: PeerMeshState }) => {
  const { chainId } = useAccount();
  const [buyinEth, setBuyinEth] = useState("0.001");
  const [startingStack, setStartingStack] = useState(1500);
  const [smallBlind, setSmallBlind] = useState(10);
  const [bigBlind, setBigBlind] = useState(20);
  const [blindUpMin, setBlindUpMin] = useState(10); // 0 = fixed blinds
  const [windowMin, setWindowMin] = useState(10);
  const [networkSel, setNetworkSel] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const noWallet = !mesh.wallet;

  // Only chains the room multisig is actually deployed on can hold the
  // buy-ins, so offer exactly those.
  const deployed = mesh.wallet
    ? Object.keys(mesh.wallet.deployments)
        .map(Number)
        .filter(n => !Number.isNaN(n))
    : [];
  const chainOptions = deployed.length ? deployed : [8453];
  const network = networkSel ?? (chainId && chainOptions.includes(chainId) ? chainId : chainOptions[0]!);

  const onOpen = useCallback(() => {
    setErr(null);
    if (noWallet) return setErr("Deploy a room multisig first (Wallet app).");
    let buyinWei: bigint;
    try {
      buyinWei = parseEther(buyinEth as `${number}`);
    } catch {
      return setErr("Bad buy-in amount.");
    }
    if (buyinWei <= 0n) return setErr("Buy-in must be > 0.");
    if (startingStack <= 0) return setErr("Starting stack must be > 0.");
    if (bigBlind < smallBlind || smallBlind <= 0) return setErr("Bad blinds.");
    if (bigBlind % smallBlind !== 0) return setErr("Big blind must be a multiple of the small blind.");
    mesh.pokerOpenTable({
      buyinWei: buyinWei.toString(),
      startingStack: Math.floor(startingStack),
      smallBlind,
      bigBlind,
      blindIntervalMs: Math.max(0, blindUpMin) * 60_000,
      buyinWindowMs: Math.max(1, windowMin) * 60_000,
      chainId: network,
    });
  }, [noWallet, buyinEth, startingStack, smallBlind, bigBlind, blindUpMin, windowMin, mesh, network]);

  const inp: React.CSSProperties = {
    background: "#160e2e",
    border: "1px solid #2a1648",
    borderRadius: 6,
    color: "var(--slop-text)",
    padding: "6px 8px",
    fontSize: 13,
    width: "100%",
  };
  const lbl: React.CSSProperties = { fontSize: 12, color: "var(--slop-text-muted)" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 18, color: LIME }}>♠ New poker tournament</div>
      <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
        No-Limit Hold&apos;em freezeout. Everyone buys in for the same amount into one prize pool and starts with equal
        chips. Play until you bust; the last players standing split the pool by place (2–3: winner-take-all · 4–5: 65/35
        · 6–8: 50/30/20). Anyone can buy in during the window.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={lbl}>
          Network
          <select style={inp} value={network} onChange={e => setNetworkSel(Number(e.target.value))}>
            {chainOptions.map(c => (
              <option key={c} value={c}>
                {CHAIN_LABELS[c] ?? `chain ${c}`}
              </option>
            ))}
          </select>
        </label>
        <label style={lbl}>
          Buy-in ({CHAIN_LABELS[network] ?? "chain"} ETH)
          <input style={inp} value={buyinEth} onChange={e => setBuyinEth(e.target.value)} />
        </label>
        <label style={lbl}>
          Starting stack (chips)
          <input
            style={inp}
            type="number"
            value={startingStack}
            onChange={e => setStartingStack(Number(e.target.value))}
          />
        </label>
        <label style={lbl}>
          Small blind (chips)
          <input style={inp} type="number" value={smallBlind} onChange={e => setSmallBlind(Number(e.target.value))} />
        </label>
        <label style={lbl}>
          Big blind (chips)
          <input style={inp} type="number" value={bigBlind} onChange={e => setBigBlind(Number(e.target.value))} />
        </label>
        <label style={lbl}>
          Blinds double every (min, 0 = never)
          <input style={inp} type="number" value={blindUpMin} onChange={e => setBlindUpMin(Number(e.target.value))} />
        </label>
        <label style={lbl}>
          Buy-in window (min)
          <input style={inp} type="number" value={windowMin} onChange={e => setWindowMin(Number(e.target.value))} />
        </label>
      </div>
      <button type="button" onClick={onOpen} disabled={noWallet} style={btn(LIME, noWallet)}>
        Open tournament
      </button>
      {noWallet && <div style={{ fontSize: 12, color: ACCENT }}>Deploy a room multisig in the Wallet app first.</div>}
      {err && <div style={{ fontSize: 12, color: ACCENT }}>{err}</div>}
    </div>
  );
};

// ─── Join (buy in during the window) ─────────────────────────────────

const JoinButton = ({ mesh, escrow }: { mesh: PeerMeshState; escrow: EscrowSession }) => {
  const currentChainId = useChainId();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { sendTransactionAsync, isPending: sending } = useSendTransaction();
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [reported, setReported] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { isLoading: waiting, data: receipt } = useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    chainId: escrow.chainId,
  });
  const buyinWei = metaStr(escrow, "buyinWei") || "0";

  useEffect(() => {
    if (receipt && txHash && !reported) {
      setReported(true);
      mesh.pokerJoin(txHash);
    }
  }, [receipt, txHash, reported, mesh]);

  const result = mesh.pokerJoinResult;
  const rejected = reported && result && !result.ok && result.txHash === txHash ? result.reason : null;

  const onJoin = useCallback(async () => {
    setErr(null);
    try {
      if (currentChainId !== escrow.chainId) await switchChainAsync({ chainId: escrow.chainId });
      const hash = await sendTransactionAsync({
        to: escrow.multisig as `0x${string}`,
        value: BigInt(buyinWei),
        chainId: escrow.chainId,
      });
      setReported(false);
      setTxHash(hash);
    } catch (e) {
      setErr(String(e).slice(0, 160));
    }
  }, [currentChainId, escrow.chainId, escrow.multisig, buyinWei, switchChainAsync, sendTransactionAsync]);

  const busy = switching || sending || (!!txHash && (waiting || (reported && !rejected)));
  const statusText = switching
    ? "Switching chain…"
    : sending
      ? "Confirm in your wallet…"
      : waiting
        ? "Waiting for confirmation…"
        : reported && !rejected
          ? "Verifying buy-in…"
          : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button type="button" onClick={onJoin} disabled={busy} style={btn(LIME, busy)}>
        {busy ? "Buying in…" : `Buy in — ${fmtEth(buyinWei)} ETH`}
      </button>
      {statusText && <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>{statusText}</div>}
      {rejected && (
        <div style={{ fontSize: 12, color: ACCENT }}>
          {rejected === "not_mined"
            ? "Not confirmed yet — give it a moment, then retry."
            : `Buy-in rejected: ${rejected}`}
          {rejected === "not_mined" && txHash && (
            <button
              type="button"
              onClick={() => {
                setReported(false);
                mesh.pokerJoin(txHash);
              }}
              style={{ ...btn(CYAN), padding: "4px 10px", marginLeft: 8, fontSize: 11 }}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {err && <div style={{ fontSize: 12, color: ACCENT }}>{err}</div>}
    </div>
  );
};

// One labelled stat in the config summary — small caption over a bold value.
const Stat = ({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
    <span style={{ fontSize: 10, color: "var(--slop-text-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>
      {label}
    </span>
    <span style={{ fontSize: 13, color: "var(--slop-text)", fontWeight: 700 }}>{value}</span>
    {hint && <span style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>{hint}</span>}
  </div>
);

// The full configuration of the tournament, so a joiner knows exactly what
// they're buying into: blinds + escalation clock, starting stack, network.
// Mirrors every field set on the open-table form ("first page").
const TournamentConfig = ({ escrow }: { escrow: EscrowSession }) => {
  const buyin = metaStr(escrow, "buyinWei");
  const startingStack = metaNum(escrow, "startingStack");
  const smallBlind = metaNum(escrow, "smallBlind");
  const bigBlind = metaNum(escrow, "bigBlind");
  const blindIntervalMs = metaNum(escrow, "blindIntervalMs");
  const blindMin = blindIntervalMs > 0 ? Math.round(blindIntervalMs / 60_000) : 0;
  const bbStacks = bigBlind > 0 && startingStack > 0 ? Math.round(startingStack / bigBlind) : 0;
  const network = CHAIN_LABELS[escrow.chainId] ?? `chain ${escrow.chainId}`;
  return (
    <div
      style={{
        borderTop: "1px solid #2a1648",
        paddingTop: 8,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))",
        gap: 10,
      }}
    >
      <Stat label="Buy-in" value={`${fmtEth(buyin)} ETH`} hint={network} />
      <Stat
        label="Starting stack"
        value={`${startingStack.toLocaleString()} chips`}
        hint={bbStacks ? `${bbStacks} BB` : undefined}
      />
      <Stat label="Blinds" value={`${smallBlind} / ${bigBlind}`} hint="small / big" />
      <Stat
        label="Blinds go up"
        value={blindMin > 0 ? `Every ${blindMin} min` : "Never"}
        hint={blindMin > 0 ? "doubles each level" : "fixed blinds"}
      />
    </div>
  );
};

// Buy-in window banner. Pre-game it shows the full tournament config so a
// joiner knows exactly what they're buying into. Once play has started
// (`compact`) all that detail is redundant — the table speaks for itself — so
// it collapses to a slim strip that only resurfaces the join control while the
// late-registration window is still open.
const BuyInBanner = ({
  mesh,
  myOwnerKey,
  escrow,
  compact = false,
}: {
  mesh: PeerMeshState;
  myOwnerKey: string | null;
  escrow: EscrowSession;
  compact?: boolean;
}) => {
  const deadline = metaNum(escrow, "buyinDeadline") || null;
  const open = !!deadline && deadline > Date.now();
  const iAmIn = escrow.accounts.some(a => a.key === myOwnerKey);
  const full = escrow.accounts.length >= 8;
  const buyin = metaStr(escrow, "buyinWei");
  const pool = escrow.accounts.reduce((s, a) => s + BigInt(a.depositedWei || "0"), 0n).toString();

  // Slim in-game strip: pool + a join CTA only while the window is still open
  // to a newcomer. Nothing if there's nothing actionable to show.
  if (compact) {
    const canJoin = open && !iAmIn && !full;
    if (!canJoin && !(open && !iAmIn)) {
      // Closed window (or already seated): a one-liner is plenty.
      return (
        <div style={{ fontSize: 11, color: "var(--slop-text-muted)" }}>
          prize pool <span style={{ color: GOLD }}>{fmtEth(pool)} ETH</span>
          {open && <span> · late buy-in open</span>}
        </div>
      );
    }
    return (
      <div
        style={{
          background: "#160e2e",
          border: `1px solid ${CYAN}`,
          borderRadius: 10,
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
          Late buy-in {fmtEth(buyin)} ETH · pool <span style={{ color: GOLD }}>{fmtEth(pool)} ETH</span>{" "}
          {open && <Countdown deadline={deadline} urgentAt={30} />}
        </span>
        {canJoin && <JoinButton mesh={mesh} escrow={escrow} />}
        {full && !iAmIn && <span style={{ fontSize: 12, color: ACCENT }}>Full</span>}
      </div>
    );
  }

  return (
    <div
      style={{
        background: "#160e2e",
        border: `1px solid ${CYAN}`,
        borderRadius: 10,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: CYAN, fontFamily: "var(--slop-font-display)" }}>
          {open ? "Buy-in window open" : "Buy-in window closed"}
        </span>
        {open && <Countdown deadline={deadline} urgentAt={30} />}
      </div>
      <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
        {escrow.accounts.length}/8 players · buy-in {fmtEth(buyin)} ETH · prize pool{" "}
        <span style={{ color: GOLD }}>{fmtEth(pool)} ETH</span>
      </div>
      <TournamentConfig escrow={escrow} />
      {open && !iAmIn && !full && <JoinButton mesh={mesh} escrow={escrow} />}
      {iAmIn && <div style={{ fontSize: 12, color: LIME }}>✓ You&apos;re in.</div>}
      {open && full && !iAmIn && <div style={{ fontSize: 12, color: ACCENT }}>Tournament full (8 players).</div>}
    </div>
  );
};

// ─── Settling / settled (cash out) ───────────────────────────────────

const MEDAL = ["🥇", "🥈", "🥉"];
const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10] ?? "th"}`;

const CashOutView = ({ mesh, escrow }: { mesh: PeerMeshState; escrow: EscrowSession }) => {
  const total = (escrow.payouts ?? []).reduce((s, p) => s + BigInt(p.amountWei), 0n).toString();
  const settled = escrow.status === "settled";
  const standings = (escrow.meta.standings as { key: string; label: string; place: number }[] | undefined) ?? [];
  const payByKey = new Map((escrow.payouts ?? []).map(p => [p.to, p.amountWei] as const));
  // Once proposed, the payout tx lives in the room wallet; the user must
  // sign + execute it there (it's a multisig tx, not a plain send).
  const payoutTx = escrow.payoutTxId ? (mesh.walletTxs.find(t => t.id === escrow.payoutTxId) ?? null) : null;
  const threshold = mesh.wallet?.threshold ?? 0;
  // Detect the payout on-chain: once the multisig's nonce advances past the
  // proposed payout's nonce, that tx executed (the money moved) — even if
  // the relay's wallet-status watch missed it. Robust to re-proposes (they
  // all share the same nonce) and to executing straight from the multisig.
  const publicClient = usePublicClient({ chainId: escrow.chainId });
  const [paidOut, setPaidOut] = useState(false);
  // Detect the payout on-chain WITHOUT depending on the relay having linked the
  // proposal as the escrow's payout tx. That linkage is fragile — it misses a
  // re-propose (several txs share the plan) or a payout executed straight from
  // the multisig — and when it misses, BOTH the relay's auto-settle and the old
  // nonce poll silently no-op, stranding the room on "Pay out winners" (exactly
  // the bug we keep hitting). Instead watch the money itself: the room multisig
  // holds exactly the prize pool (Σ buy-ins == Σ payouts == `total`) while
  // settling, so once the payout executes those funds leave and its balance
  // drops below the pool. A balance under `total` ⇒ the money has gone out —
  // robust to who proposed, re-proposes, RPC hiccups, and a player who only
  // loads the table after the winner already cashed everyone out.
  useEffect(() => {
    if (settled || !publicClient) return;
    let poolWei: bigint;
    try {
      poolWei = BigInt(total);
    } catch {
      return;
    }
    if (poolWei <= 0n) return;
    let cancelled = false;
    const check = async () => {
      try {
        const bal = await publicClient.getBalance({ address: escrow.multisig as `0x${string}` });
        if (!cancelled && bal < poolWei) setPaidOut(true);
      } catch {
        /* RPC hiccup — try again next tick */
      }
    };
    void check();
    const id = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [settled, publicClient, escrow.multisig, total]);

  // Belt-and-suspenders: even if on-chain detection can't run, offer a
  // manual close after a grace period so the room is never stranded.
  const [canForceClose, setCanForceClose] = useState(false);
  useEffect(() => {
    if (settled) return;
    const id = setTimeout(() => setCanForceClose(true), 60_000);
    return () => clearTimeout(id);
  }, [settled]);

  // Once the payout is confirmed (relay-settled or seen on-chain), don't make
  // anyone hunt for a button — show the result for a beat, then auto-clear the
  // escrow so the room drops back to a fresh table for the next tournament.
  const paid = settled || paidOut;
  const [advanceIn, setAdvanceIn] = useState<number | null>(null);
  useEffect(() => {
    setAdvanceIn(paid ? 8 : null);
  }, [paid]);
  useEffect(() => {
    if (advanceIn === null) return;
    if (advanceIn <= 0) {
      mesh.escrowClear(); // idempotent — any peer can clear; first one wins
      return;
    }
    const id = setTimeout(() => setAdvanceIn(n => (n === null ? null : n - 1)), 1000);
    return () => clearTimeout(id);
  }, [advanceIn, mesh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 17, color: settled ? LIME : GOLD }}>
        🏆 Tournament over — {fmtEth(total)} ETH pool
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {standings.map(s => {
          const won = payByKey.get(s.key);
          return (
            <div
              key={s.key}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 13,
                color: won ? "var(--slop-text)" : "var(--slop-text-muted)",
                fontWeight: won ? 700 : 400,
              }}
            >
              <span>
                {s.place <= 3 ? MEDAL[s.place - 1] : ` ${ordinal(s.place)}`} {s.label}
              </span>
              {won && <span style={{ color: GOLD }}>{fmtEth(won)} ETH</span>}
            </div>
          );
        })}
      </div>
      {paid ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 13, color: LIME }}>✓ Paid out{settled ? "" : " on-chain"} — winners settled.</div>
          <button type="button" onClick={() => mesh.escrowClear()} style={{ ...btn(LIME), alignSelf: "flex-start" }}>
            New tournament{advanceIn !== null && advanceIn > 0 ? ` (${advanceIn}s)` : ""}
          </button>
        </div>
      ) : payoutTx ? (
        // Proposed — now it has to be signed + executed in the Wallet app
        // (it's a multisig tx). Surface that clearly + a one-tap shortcut.
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 13, color: CYAN }}>
            Payout proposed — sign &amp; execute it in the <b>Wallet</b> app to send the ETH.
          </div>
          <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
            {payoutTx.status === "executing"
              ? "Executing on-chain…"
              : `Signatures ${payoutTx.signatures.length}/${threshold || "?"} · ${payoutTx.status}`}
          </div>
          <button
            type="button"
            onClick={() => mesh.openWindow("wallet")}
            style={{ ...btn(LIME), alignSelf: "flex-start" }}
          >
            Open Wallet app →
          </button>
        </div>
      ) : (
        // Anyone can submit the payout — the plan is fixed server-side, so it
        // can only ever pay the finishers by place. Popping the Wallet app on
        // propose makes the multisig tx show up to sign right away.
        <PayoutProposeButton
          mesh={mesh}
          escrow={escrow}
          isRefund={false}
          canPropose={true}
          claimText={`Pay out winners — ${fmtEth(total)} ETH`}
          onProposed={() => mesh.openWindow("wallet")}
        />
      )}
      {!paid && canForceClose && (
        <button
          type="button"
          onClick={() => mesh.escrowClear()}
          style={{ ...btn(ACCENT), alignSelf: "flex-start", fontSize: 12, padding: "6px 12px" }}
        >
          Already paid out? Close &amp; start a new tournament
        </button>
      )}
    </div>
  );
};

// ─── Live table ──────────────────────────────────────────────────────

// The dealer button — a real white disc with a "D", the universal poker
// signal. Far clearer at a glance than a glyph after the name.
const DealerChip = () => (
  <span
    title="Dealer"
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 19,
      height: 19,
      borderRadius: "50%",
      background: "radial-gradient(circle at 35% 30%, #ffffff, #d8d2ec)",
      color: "#160e2e",
      fontSize: 11,
      fontWeight: 900,
      border: "1px solid #b3a9d6",
      boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
      flex: "0 0 auto",
    }}
  >
    D
  </span>
);

const GOLD = "#ffd23c";

// A single seat at the rail. Compact on purpose — the table is the star, so
// each plate is just name + cards + stack, with the live state carried by the
// frame: a pulsing lime glow when it's this seat's turn (the "who's up" signal
// that travels around the table), gold on a win, cyan for you, dimmed when
// folded/out. The per-street bet rides as chips between the seat and the pot
// (rendered by the parent), not as text here.
const SeatBox = ({
  seat,
  isActor,
  isButton,
  isMe,
  isWinner,
  myHole,
}: {
  seat: PokerSeatPublic;
  isActor: boolean;
  isButton: boolean;
  isMe: boolean;
  isWinner: boolean;
  myHole: [string, string] | null;
}) => {
  const revealed = seat.hole; // populated at showdown
  const cards: (string | undefined)[] = isMe && myHole ? myHole : revealed ? revealed : [undefined, undefined];
  const folded = seat.status === "folded" || seat.status === "out";
  const concealed = seat.hasCards && !(isMe && myHole) && !revealed;
  const borderColor = isActor ? LIME : isWinner ? GOLD : isMe ? CYAN : "#2a1648";
  const glow = isActor ? `0 0 18px ${LIME}` : isWinner ? `0 0 16px ${GOLD}` : "none";
  return (
    <div
      style={{
        position: "relative",
        width: 116,
        background: isActor ? "#1f2a14" : "#140d2a",
        border: `2px solid ${borderColor}`,
        boxShadow: glow,
        borderRadius: 10,
        padding: 6,
        opacity: folded ? 0.45 : 1,
        transition: "box-shadow 0.2s, border-color 0.2s, background 0.2s",
        // A one-shot bump (replayed on remount each turn — see the key on
        // SeatBox) that hands off into the steady infinite pulse.
        animation: isActor ? "pokerActorBump 0.6s ease-out, pokerActorPulse 1.1s ease-in-out 0.6s infinite" : undefined,
      }}
    >
      {isActor && (
        <div
          style={{
            position: "absolute",
            top: -9,
            left: 8,
            background: LIME,
            color: "#0a061a",
            fontSize: 9,
            fontWeight: 900,
            padding: "1px 7px",
            borderRadius: 8,
            letterSpacing: 0.5,
          }}
        >
          ● TO ACT
        </div>
      )}
      {isWinner && !isActor && (
        <div
          style={{
            position: "absolute",
            top: -9,
            left: 8,
            background: GOLD,
            color: "#160e2e",
            fontSize: 9,
            fontWeight: 900,
            padding: "1px 7px",
            borderRadius: 8,
          }}
        >
          🏆 WINS
        </div>
      )}
      {seat.status === "allin" && (
        <div
          style={{
            position: "absolute",
            top: -9,
            right: 8,
            background: ACCENT,
            color: "#0a061a",
            fontSize: 9,
            fontWeight: 900,
            padding: "1px 7px",
            borderRadius: 8,
          }}
        >
          ALL-IN
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, marginBottom: 4 }}>
        {isButton && <DealerChip />}
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: isMe ? CYAN : "var(--slop-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {seat.label}
        </span>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 4, justifyContent: "center" }}>
        <Card card={cards[0]} hidden={concealed} small />
        <Card card={cards[1]} hidden={concealed} small />
      </div>
      <div
        style={{ fontSize: 12, textAlign: "center", color: seat.stack === 0 ? "var(--slop-text-muted)" : undefined }}
      >
        💰 {seat.stack}
      </div>
    </div>
  );
};

// A little stack of chips sitting in front of a seat, between the player and
// the pot — the visual of money pushed toward the middle when someone bets.
const BetChip = ({ amount }: { amount: number }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 3,
      background: "#0a061a",
      border: `1px solid ${LIME}`,
      color: LIME,
      fontSize: 11,
      fontWeight: 800,
      padding: "1px 7px",
      borderRadius: 10,
      boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
      whiteSpace: "nowrap",
    }}
  >
    🪙 {amount}
  </span>
);

// "Deal next hand" but held during the post-showdown pause so everyone can
// study the revealed hands. Ticks locally to re-enable when the pause ends.
const DealButton = ({ onClick, readyAt }: { onClick: () => void; readyAt: number | null }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!readyAt) return;
    const id = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(id);
  }, [readyAt]);
  const waiting = readyAt ? now < readyAt : false;
  const secs = readyAt ? Math.max(0, Math.ceil((readyAt - now) / 1000)) : 0;
  return (
    <button type="button" disabled={waiting} onClick={onClick} style={btn(LIME, waiting)}>
      {waiting ? `Showdown — ${secs}s` : "Deal next hand"}
    </button>
  );
};

const ActionBar = ({
  mesh,
  mySeat,
  currentBet,
  minRaise,
  bigBlind,
}: {
  mesh: PeerMeshState;
  mySeat: PokerSeatPublic;
  currentBet: number;
  minRaise: number;
  bigBlind: number;
}) => {
  const toCall = Math.max(0, currentBet - mySeat.committed);
  const maxTo = mySeat.committed + mySeat.stack; // all-in ceiling
  const minRaiseTo = Math.min(maxTo, currentBet + minRaise);
  const [raiseTo, setRaiseTo] = useState(minRaiseTo);
  // The slider snaps in one-big-blind detents. Re-clamp whenever the band shifts
  // (a new street, blinds going up, or stack changes) so we never sit out of range.
  useEffect(() => {
    setRaiseTo(r => Math.max(minRaiseTo, Math.min(maxTo, r)));
  }, [minRaiseTo, maxTo]);
  const act = (action: PokerActionKind, toChips?: number) => mesh.pokerAct(action, toChips);
  const canCheck = toCall === 0;
  const canRaise = maxTo > currentBet;
  const clamped = Math.max(minRaiseTo, Math.min(maxTo, raiseTo));
  // Snap an arbitrary value onto the big-blind grid (anchored at minRaiseTo),
  // always staying inside [minRaiseTo, maxTo]. maxTo itself is always reachable.
  const bb = bigBlind > 0 ? bigBlind : 1;
  const snap = (v: number) => {
    const stepped = minRaiseTo + Math.round((v - minRaiseTo) / bb) * bb;
    return Math.max(minRaiseTo, Math.min(maxTo, stepped));
  };
  const lastNotch = useRef(clamped);
  const onSlide = (v: number) => {
    const next = snap(v);
    if (next !== lastNotch.current) {
      lastNotch.current = next;
      sfxTick(); // a click per big-blind notch
    }
    setRaiseTo(next);
  };
  // BB above the current bet — what the raise actually adds, in big blinds.
  const bbOver = bb > 0 ? Math.round((clamped - currentBet) / bb) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" onClick={() => act("fold")} style={btn(ACCENT)}>
          Fold
        </button>
        {canCheck ? (
          <button type="button" onClick={() => act("check")} style={btn(CYAN)}>
            Check
          </button>
        ) : (
          <button type="button" onClick={() => act("call")} style={btn(CYAN)}>
            Call {Math.min(toCall, mySeat.stack)}
          </button>
        )}
        {canRaise && (
          <>
            <button type="button" onClick={() => act("raise", clamped)} style={btn(LIME)}>
              {currentBet === 0 ? "Bet" : "Raise to"} {clamped}
            </button>
            <button type="button" onClick={() => act("raise", maxTo)} style={btn(LIME)}>
              All-in {maxTo}
            </button>
          </>
        )}
      </div>
      {canRaise && maxTo > minRaiseTo && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", width: "100%" }}>
          <input
            type="range"
            value={clamped}
            min={minRaiseTo}
            max={maxTo}
            step={bb}
            onChange={e => onSlide(Number(e.target.value))}
            style={{ flex: 1, accentColor: LIME, minWidth: 120 }}
          />
          <input
            type="number"
            value={clamped}
            min={minRaiseTo}
            max={maxTo}
            step={bb}
            onChange={e => setRaiseTo(Math.max(minRaiseTo, Math.min(maxTo, Number(e.target.value))))}
            style={{
              width: 80,
              background: "#160e2e",
              border: "1px solid #2a1648",
              borderRadius: 6,
              color: "var(--slop-text)",
              padding: "6px 8px",
              fontSize: 13,
            }}
          />
          <span style={{ fontSize: 11, color: "var(--slop-text-dim, #9a86c4)", whiteSpace: "nowrap" }}>
            +{bbOver} BB
          </span>
        </div>
      )}
    </div>
  );
};

// Inject the actor-pulse keyframes once (styled-jsx isn't set up here and we
// want a self-contained component). Idempotent via the id.
const PULSE_CSS = `@keyframes pokerActorPulse {
  0%, 100% { box-shadow: 0 0 10px ${LIME}; }
  50% { box-shadow: 0 0 22px ${LIME}; }
}
/* One-shot attention "bump": fires when a seat becomes the actor — including
   when the SAME player is on the clock again (a new street, or play folding
   back round). Re-keying the seat on actorDeadline remounts it so this replays
   every turn, then it settles into the steady pulse. */
@keyframes pokerActorBump {
  0%   { transform: scale(1);    box-shadow: 0 0 10px ${LIME}; }
  30%  { transform: scale(1.14); box-shadow: 0 0 30px ${LIME}; }
  60%  { transform: scale(0.98); box-shadow: 0 0 16px ${LIME}; }
  100% { transform: scale(1);    box-shadow: 0 0 10px ${LIME}; }
}
/* The action buttons "go away and come back" each turn: keying the bar on
   actorDeadline remounts it, replaying this entrance so a back-to-back turn
   is unmistakable even though the buttons were already on screen. */
@keyframes pokerTurnIn {
  0%   { transform: scale(0.9); opacity: 0; }
  55%  { transform: scale(1.04); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}`;
const PokerStyles = () => <style id="poker-fx-styles">{PULSE_CSS}</style>;

// Seat coordinates around the table oval. p=0 is the bottom-centre (anchored to
// "me" when I'm seated) and p increases clockwise — i.e. action moves to my
// left, the real direction of play. Returned as CSS percentages so the table
// scales with the window. `hx/vy` are the ellipse radii in % of the container.
const seatPos = (p: number, n: number, hx: number, vy: number) => {
  const theta = Math.PI / 2 + (p * 2 * Math.PI) / Math.max(1, n);
  return { left: `${50 + hx * Math.cos(theta)}%`, top: `${50 + vy * Math.sin(theta)}%` };
};

const Felt = ({
  mesh,
  myOwnerKey,
  poker,
}: {
  mesh: PeerMeshState;
  myOwnerKey: string | null;
  poker: PokerTableView;
}) => {
  const myHole = mesh.pokerPrivate && mesh.pokerPrivate.handId === poker.handId ? mesh.pokerPrivate.hole : null;
  const mySeat = poker.seats.find(s => s.key === myOwnerKey) ?? null;
  const myTurn = mySeat && poker.status === "running" && poker.actor === mySeat.idx;
  const winnerSeats = new Set(poker.showdown.filter(s => s.won).map(s => s.seat));

  const [muted, setMuted] = useState(false);
  useEffect(() => setMuted(isPokerMuted()), []);

  // Sound effects, driven by diffing consecutive public snapshots so the whole
  // table is audible (every player's action, not just mine). `wagered` =
  // pot + everyone's current-street commitment, which only ever rises within a
  // hand as chips go in (it stays continuous across street closes, when
  // commitments roll into the pot) — so a rise means real money hit the felt.
  const prevRef = useRef<PokerTableView | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = poker;
    if (!prev) return; // first snapshot — nothing to compare, stay silent

    if (prev.handId !== poker.handId) {
      if (poker.handId) sfxDeal(); // new hand dealt
      return;
    }
    if (poker.status === "complete" && prev.status !== "complete") {
      sfxWin(); // pot awarded
      return;
    }
    if (poker.board.length > prev.board.length) sfxCardFlip(poker.board.length - prev.board.length);

    const wagered = poker.potTotal + poker.seats.reduce((s, x) => s + x.committed, 0);
    const prevWagered = prev.potTotal + prev.seats.reduce((s, x) => s + x.committed, 0);
    if (wagered > prevWagered) {
      sfxChips(); // bet / call / raise / blinds
    } else if (poker.actor !== prev.actor && prev.actor >= 0) {
      // Someone acted but no chips moved: a check (tap) or a fold (swish).
      const acted = poker.seats.find(s => s.idx === prev.actor);
      if (acted && acted.status === "folded") sfxFold();
      else sfxCheck();
    }
  }, [poker]);

  // Compact table-rim seats, positioned around an oval. Anchor "me" to the
  // bottom; spectators see the natural table order from the bottom.
  const seats = poker.seats;
  const n = seats.length;
  const meIdx = seats.findIndex(s => s.key === myOwnerKey);
  const rot = meIdx >= 0 ? meIdx : 0;
  const tableH = n <= 3 ? 300 : 360;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PokerStyles />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "var(--slop-font-display)", fontSize: 15, color: LIME }}>
          ♠ {poker.smallBlind}/{poker.bigBlind}
          {poker.blindLevel > 0 ? ` · L${poker.blindLevel + 1}` : ""} ·{" "}
          {poker.street === "idle" ? "between hands" : poker.street}
        </span>
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {poker.nextBlindAt && (
            <span style={{ fontSize: 11, color: "var(--slop-text-muted)" }}>
              blinds up <Countdown deadline={poker.nextBlindAt} urgentAt={20} />
            </span>
          )}
          <button
            type="button"
            title={muted ? "Unmute table sounds" : "Mute table sounds"}
            onClick={() => {
              const next = !muted;
              setPokerMuted(next);
              setMuted(next);
              if (!next) unlockPokerAudio();
            }}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 15,
              lineHeight: 1,
              padding: 0,
              color: "var(--slop-text-muted)",
            }}
          >
            {muted ? "🔈" : "🔊"}
          </button>
        </span>
      </div>

      {/* The table: an oval of felt with the pot + board in the middle and the
          seats around the rail. Tapping it also unlocks audio (browsers gate
          the AudioContext behind a user gesture). */}
      <div onPointerDown={() => unlockPokerAudio()} style={{ position: "relative", height: tableH, margin: "4px 0" }}>
        <div
          style={{
            position: "absolute",
            top: "13%",
            bottom: "13%",
            left: "9%",
            right: "9%",
            background: `radial-gradient(ellipse at 50% 38%, #11402c, ${FELT})`,
            border: "3px solid #1c5238",
            borderRadius: "50%",
            boxShadow: "inset 0 0 40px rgba(0,0,0,0.55)",
          }}
        />
        {/* Pot + community cards, dead centre. */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 15, color: CYAN }}>
            💰 Pot {poker.potTotal}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {[0, 1, 2, 3, 4].map(i => (
              <Card key={i} card={poker.board[i]} />
            ))}
          </div>
          {poker.pots.length > 1 && (
            <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
              {poker.pots.map((p, i) => `${i === 0 ? "main" : `side ${i}`}: ${p.amountChips}`).join(" · ")}
            </div>
          )}
        </div>

        {/* Seats around the rim + their bet chips pushed toward the pot. */}
        {seats.map(seat => {
          const p = (seat.idx - rot + n) % n;
          const seatXY = seatPos(p, n, 41, 39);
          const betXY = seatPos(p, n, 22, 21);
          return (
            <div key={seat.key}>
              <div
                style={{
                  position: "absolute",
                  left: seatXY.left,
                  top: seatXY.top,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <SeatBox
                  // Remount the active seat each new turn (actorDeadline is
                  // fresh per turn, even back-to-back for the same player) so
                  // the attention bump replays. Idle seats share a stable key.
                  key={poker.status === "running" && poker.actor === seat.idx ? `act-${poker.actorDeadline}` : "idle"}
                  seat={seat}
                  isActor={poker.status === "running" && poker.actor === seat.idx}
                  isButton={poker.button === seat.idx}
                  isMe={seat.key === myOwnerKey}
                  isWinner={poker.status === "complete" && winnerSeats.has(seat.idx)}
                  myHole={seat.key === myOwnerKey ? myHole : null}
                />
              </div>
              {seat.committed > 0 && (
                <div
                  style={{
                    position: "absolute",
                    left: betXY.left,
                    top: betXY.top,
                    transform: "translate(-50%, -50%)",
                  }}
                >
                  <BetChip amount={seat.committed} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {poker.status === "complete" && poker.showdown.length > 0 && (
        <div
          style={{
            background: "#160e2e",
            border: `1px solid ${GOLD}55`,
            borderRadius: 10,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {poker.showdown
            .filter(s => s.won)
            .map(s => (
              <div key={s.seat} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ color: GOLD, fontWeight: 800, fontFamily: "var(--slop-font-display)" }}>
                  🏆 {poker.seats.find(x => x.idx === s.seat)?.label ?? s.seat} wins
                </span>
                <span style={{ color: LIME, fontSize: 13 }}>{s.hand}</span>
                <span style={{ display: "flex", gap: 3 }}>
                  {s.cards.map((c, i) => (
                    <Card key={i} card={c} small />
                  ))}
                </span>
              </div>
            ))}
          {poker.showdown.filter(s => !s.won).length > 0 && (
            <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
              {poker.showdown
                .filter(s => !s.won)
                .map(s => `${poker.seats.find(x => x.idx === s.seat)?.label ?? s.seat}: ${s.hand}`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}

      {myTurn && mySeat && (
        // Keyed on actorDeadline so a back-to-back turn remounts this block —
        // the buttons visibly drop out and re-enter (pokerTurnIn), making it
        // unmistakable it's your turn again even though they were already up.
        <div
          key={`turn-${poker.actorDeadline}`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            transformOrigin: "left center",
            animation: "pokerTurnIn 0.42s ease-out",
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 13, color: LIME, fontWeight: 700 }}>Your turn</span>
            <Countdown deadline={poker.actorDeadline} />
          </div>
          <ActionBar
            mesh={mesh}
            mySeat={mySeat}
            currentBet={poker.currentBet}
            minRaise={poker.minRaise}
            bigBlind={poker.bigBlind}
          />
        </div>
      )}
      {!myTurn && poker.status === "running" && poker.runningOut && (
        <div style={{ fontSize: 13, color: GOLD, fontWeight: 700 }}>🎬 All in — running it out…</div>
      )}
      {!myTurn && poker.status === "running" && !poker.runningOut && poker.actor >= 0 && (
        <div style={{ fontSize: 13, color: "var(--slop-text-muted)", display: "flex", gap: 8, alignItems: "center" }}>
          <span>Waiting on {poker.seats.find(s => s.idx === poker.actor)?.label ?? "…"}</span>
          <Countdown deadline={poker.actorDeadline} />
        </div>
      )}
    </div>
  );
};

// The whole live table: buy-in banner + felt + start/close controls.
const LiveTable = ({
  mesh,
  myOwnerKey,
  escrow,
}: {
  mesh: PeerMeshState;
  myOwnerKey: string | null;
  escrow: EscrowSession;
}) => {
  const poker = mesh.pokerState;
  const seated = poker?.seats ?? [];
  const playable = seated.filter(s => s.stack > 0).length;
  const running = poker?.status === "running";
  const neverStarted = !poker || poker.status === "idle";
  // A joiner who bought in mid-hand isn't seated until the next deal.
  const pendingJoin = escrow.accounts.some(a => a.key === myOwnerKey) && !seated.some(s => s.key === myOwnerKey);
  // Players already knocked out (provisional standings, worst place first).
  const out = (poker?.standings ?? []).filter(s => s.out);
  // After a hand ends, let a player who still holds their cards flash them
  // (the move after winning on a fold). Hidden once they've shown — their
  // hole then appears publicly on their seat (mySeat.hole is populated).
  const myHole = poker && mesh.pokerPrivate?.handId === poker.handId ? mesh.pokerPrivate.hole : null;
  const mySeat = poker?.seats.find(s => s.key === myOwnerKey) ?? null;
  const canShowCards = poker?.status === "complete" && !!myHole && !!mySeat && !mySeat.hole;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <BuyInBanner mesh={mesh} myOwnerKey={myOwnerKey} escrow={escrow} compact={!neverStarted} />
      {pendingJoin && <div style={{ fontSize: 12, color: CYAN }}>You&apos;re dealt in on the next hand.</div>}

      {!neverStarted && poker && (
        <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
          {poker.playersLeft} of {seated.length} left
          {out.length > 0 && (
            <span>
              {" · out: "}
              {out.map(s => `${ordinal(s.place)} ${s.label}`).join(", ")}
            </span>
          )}
        </div>
      )}

      {poker && seated.length > 0 && <Felt mesh={mesh} myOwnerKey={myOwnerKey} poker={poker} />}
      {seated.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--slop-text-muted)" }}>Waiting for players to buy in…</div>
      )}

      {!running && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {playable >= 2 &&
            (neverStarted ? (
              <button type="button" onClick={() => mesh.pokerStart()} style={btn(LIME)}>
                Start tournament
              </button>
            ) : (
              <DealButton onClick={() => mesh.pokerNextHand()} readyAt={poker?.nextHandAt ?? null} />
            ))}
          {canShowCards && (
            <button type="button" onClick={() => mesh.pokerShowCards()} style={btn(CYAN)}>
              Show my hand
            </button>
          )}
          {playable < 2 && neverStarted && (
            <span style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>Need ≥2 players to start.</span>
          )}
          {/* Before the first hand anyone can cancel (refunds any buy-ins).
              Once it starts there's no early exit — it plays to a winner. */}
          {neverStarted && (
            <button type="button" onClick={() => mesh.escrowCancel()} style={btn(ACCENT)}>
              Cancel tournament
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Victory pause ───────────────────────────────────────────────────

// How long to savour the winning hand before the payout screen takes over.
const VICTORY_PAUSE_MS = 14000;

// The final hand of the tournament just ended and the escrow is settling. The
// relay would have us cut straight to the cash-out screen, but the last hand
// deserves a beat — hold on the felt with the showdown revealed so everyone can
// see how it ended, with a countdown (and a Skip) leading into the payout. This
// is purely a local view delay: the relay is already settling and nothing here
// touches money. `onExpire` is called once the countdown elapses (or on Skip),
// which drops us into CashOutView.
const VictoryPause = ({
  mesh,
  myOwnerKey,
  escrow,
  poker,
  until,
  onExpire,
}: {
  mesh: PeerMeshState;
  myOwnerKey: string | null;
  escrow: EscrowSession;
  poker: PokerTableView;
  until: number;
  onExpire: () => void;
}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  // Fire the handoff to the payout screen once the clock runs out (in an effect,
  // never during render).
  useEffect(() => {
    if (now >= until) onExpire();
  }, [now, until, onExpire]);

  const secs = Math.max(0, Math.ceil((until - now) / 1000));
  const pool = (escrow.payouts ?? []).reduce((s, p) => s + BigInt(p.amountWei), 0n).toString();
  const standings = (escrow.meta.standings as { key: string; label: string; place: number }[] | undefined) ?? [];
  const champ = standings.find(s => s.place === 1) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}
      >
        <span style={{ fontFamily: "var(--slop-font-display)", fontSize: 19, color: GOLD }}>
          🏆 {champ?.label ?? "Winner"} takes the tournament
        </span>
        <span style={{ fontSize: 13, color: CYAN }}>{fmtEth(pool)} ETH pool</span>
      </div>

      {/* Keep the final hand on the felt — board, revealed holes, and the
          showdown summary — so the last beat is the win, not the cash register. */}
      <Felt mesh={mesh} myOwnerKey={myOwnerKey} poker={poker} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          background: "#160e2e",
          border: `1px solid ${GOLD}55`,
          borderRadius: 10,
          padding: "10px 12px",
        }}
      >
        <span style={{ fontSize: 14, color: GOLD, fontFamily: "var(--slop-font-display)" }}>
          Heading to payout in {secs}s…
        </span>
        <button type="button" onClick={onExpire} style={{ ...btn(LIME), fontSize: 12, padding: "6px 12px" }}>
          Skip to payout →
        </button>
      </div>
    </div>
  );
};

// ─── Root ────────────────────────────────────────────────────────────

export const PokerWindow = ({ mesh, myOwnerKey }: Props) => {
  const escrow = mesh.escrow && mesh.escrow.game === "poker" ? mesh.escrow : null;

  // Victory pause: when the tournament's final hand ends, the relay flips the
  // escrow to "settling" (broadcast a tick before the poker "complete" frame).
  // Without this we'd jump straight to the payout the instant the win lands —
  // so on that open→settling EDGE (observed live this session, for a real
  // tournament end) we hold on the table for a countdown first. A reload
  // mid-settle starts with status already "settling" → no edge → no pause, so
  // returning players land on the payout directly.
  const [pauseUntil, setPauseUntil] = useState<number | null>(null);
  const prevStatusRef = useRef<string | null>(null);
  const clearPause = useCallback(() => setPauseUntil(null), []);
  const settleKind = typeof escrow?.meta.settleKind === "string" ? escrow.meta.settleKind : "";
  useEffect(() => {
    const status = escrow?.status ?? null;
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (
      status === "settling" &&
      prev != null &&
      prev !== "settling" &&
      prev !== "settled" &&
      settleKind === "tournament"
    ) {
      setPauseUntil(Date.now() + VICTORY_PAUSE_MS);
    } else if (status !== "settling" && status !== "settled") {
      // Left the cash-out flow entirely (new tournament, cancel) — drop any pause.
      setPauseUntil(null);
    }
  }, [escrow?.status, settleKind]);

  const body = useMemo(() => {
    if (escrow && (escrow.status === "settling" || escrow.status === "settled")) {
      if (pauseUntil !== null && mesh.pokerState) {
        return (
          <VictoryPause
            mesh={mesh}
            myOwnerKey={myOwnerKey}
            escrow={escrow}
            poker={mesh.pokerState}
            until={pauseUntil}
            onExpire={clearPause}
          />
        );
      }
      return <CashOutView mesh={mesh} escrow={escrow} />;
    }
    if (escrow && escrow.status === "open") {
      return <LiveTable mesh={mesh} myOwnerKey={myOwnerKey} escrow={escrow} />;
    }
    return <OpenTableForm mesh={mesh} />;
  }, [escrow, mesh, myOwnerKey, pauseUntil, clearPause]);

  return (
    <div
      style={{
        background: PANEL_BG,
        color: "var(--slop-text)",
        padding: 16,
        height: "100%",
        overflow: "auto",
        fontFamily: "var(--slop-font-body, sans-serif)",
      }}
    >
      {body}
    </div>
  );
};

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
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, useChainId, useSendTransaction, useSwitchChain, useWaitForTransactionReceipt } from "wagmi";
import { PayoutProposeButton } from "~~/components/desktop/chess/WagerPanel";
import type {
  EscrowSession,
  PeerMeshState,
  PokerActionKind,
  PokerSeatPublic,
  PokerTableView,
} from "~~/hooks/usePeerMesh";

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

// Buy-in window banner: countdown + who's in + the join control.
const BuyInBanner = ({
  mesh,
  myOwnerKey,
  escrow,
}: {
  mesh: PeerMeshState;
  myOwnerKey: string | null;
  escrow: EscrowSession;
}) => {
  const deadline = metaNum(escrow, "buyinDeadline") || null;
  const open = !!deadline && deadline > Date.now();
  const iAmIn = escrow.accounts.some(a => a.key === myOwnerKey);
  const full = escrow.accounts.length >= 8;
  const buyin = metaStr(escrow, "buyinWei");
  const pool = escrow.accounts.reduce((s, a) => s + BigInt(a.depositedWei || "0"), 0n).toString();
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
      {settled ? (
        <button type="button" onClick={() => mesh.escrowClear()} style={{ ...btn(CYAN), alignSelf: "flex-start" }}>
          New tournament
        </button>
      ) : (
        // Anyone can submit the payout — the plan is fixed server-side, so it
        // can only ever pay the finishers by place.
        <PayoutProposeButton
          mesh={mesh}
          escrow={escrow}
          isRefund={false}
          canPropose={true}
          claimText={`Pay out winners — ${fmtEth(total)} ETH`}
        />
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

const SeatBox = ({
  seat,
  isActor,
  isButton,
  isMe,
  isWinner,
  myHole,
  bigBlind,
}: {
  seat: PokerSeatPublic;
  isActor: boolean;
  isButton: boolean;
  isMe: boolean;
  isWinner: boolean;
  myHole: [string, string] | null;
  bigBlind: number;
}) => {
  const revealed = seat.hole; // populated at showdown
  const cards: (string | undefined)[] = isMe && myHole ? myHole : revealed ? revealed : [undefined, undefined];
  const folded = seat.status === "folded" || seat.status === "out";
  const concealed = seat.hasCards && !(isMe && myHole) && !revealed;
  // Whose turn it is is the strongest signal on the table — a bright glow,
  // not just a border tint, so every spectator can see it instantly.
  const borderColor = isActor ? LIME : isWinner ? GOLD : isMe ? CYAN : "#2a1648";
  const glow = isActor ? `0 0 16px ${LIME}` : isWinner ? `0 0 16px ${GOLD}` : "none";
  return (
    <div
      style={{
        position: "relative",
        background: isActor ? "#1f2a14" : "#140d2a",
        border: `2px solid ${borderColor}`,
        boxShadow: glow,
        borderRadius: 10,
        padding: 8,
        opacity: folded ? 0.4 : 1,
        minWidth: 130,
        transition: "box-shadow 0.2s, border-color 0.2s",
      }}
    >
      {isActor && (
        <div
          style={{
            position: "absolute",
            top: -10,
            left: 8,
            background: LIME,
            color: "#0a061a",
            fontSize: 10,
            fontWeight: 900,
            padding: "1px 8px",
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
            top: -10,
            left: 8,
            background: GOLD,
            color: "#160e2e",
            fontSize: 10,
            fontWeight: 900,
            padding: "1px 8px",
            borderRadius: 8,
          }}
        >
          🏆 WINS
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 6 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
          {isButton && <DealerChip />}
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: isMe ? CYAN : "var(--slop-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {seat.label}
          </span>
        </span>
        <span style={{ fontSize: 11, color: "var(--slop-text-muted)", flex: "0 0 auto" }}>{seat.status}</span>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
        <Card card={cards[0]} hidden={concealed} small />
        <Card card={cards[1]} hidden={concealed} small />
      </div>
      <div style={{ fontSize: 12 }}>
        💰 {seat.stack}{" "}
        <span style={{ color: "var(--slop-text-muted)" }}>
          ({bigBlind > 0 ? (seat.stack / bigBlind).toFixed(0) : "—"} BB)
        </span>
      </div>
      {seat.committed > 0 && <div style={{ fontSize: 11, color: LIME }}>bet {seat.committed}</div>}
    </div>
  );
};

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
}: {
  mesh: PeerMeshState;
  mySeat: PokerSeatPublic;
  currentBet: number;
  minRaise: number;
}) => {
  const toCall = Math.max(0, currentBet - mySeat.committed);
  const maxTo = mySeat.committed + mySeat.stack; // all-in ceiling
  const minRaiseTo = Math.min(maxTo, currentBet + minRaise);
  const [raiseTo, setRaiseTo] = useState(minRaiseTo);
  const act = (action: PokerActionKind, toChips?: number) => mesh.pokerAct(action, toChips);
  const canCheck = toCall === 0;
  const canRaise = maxTo > currentBet;
  return (
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
          <input
            type="number"
            value={raiseTo}
            min={minRaiseTo}
            max={maxTo}
            onChange={e => setRaiseTo(Number(e.target.value))}
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
          <button
            type="button"
            onClick={() => act("raise", Math.max(minRaiseTo, Math.min(maxTo, raiseTo)))}
            style={btn(LIME)}
          >
            {currentBet === 0 ? "Bet" : "Raise to"} {Math.max(minRaiseTo, Math.min(maxTo, raiseTo))}
          </button>
          <button type="button" onClick={() => act("raise", maxTo)} style={btn(LIME)}>
            All-in {maxTo}
          </button>
        </>
      )}
    </div>
  );
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "var(--slop-font-display)", fontSize: 16, color: LIME }}>
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
        </span>
      </div>

      <div
        style={{
          background: FELT,
          border: "2px solid #15402d",
          borderRadius: 14,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        {/* Pot, centered right above the community cards. */}
        <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 15, color: CYAN }}>💰 Pot {poker.potTotal}</div>
        <div style={{ display: "flex", gap: 6 }}>
          {[0, 1, 2, 3, 4].map(i => (
            <Card key={i} card={poker.board[i]} />
          ))}
        </div>
        {poker.pots.length > 1 && (
          <div style={{ fontSize: 11, color: "var(--slop-text-muted)" }}>
            {poker.pots.map((p, i) => `${i === 0 ? "main" : `side ${i}`}: ${p.amountChips}`).join(" · ")}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {poker.seats.map(seat => (
          <SeatBox
            key={seat.key}
            seat={seat}
            isActor={poker.status === "running" && poker.actor === seat.idx}
            isButton={poker.button === seat.idx}
            isMe={seat.key === myOwnerKey}
            isWinner={poker.status === "complete" && winnerSeats.has(seat.idx)}
            myHole={seat.key === myOwnerKey ? myHole : null}
            bigBlind={poker.bigBlind}
          />
        ))}
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
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 13, color: LIME, fontWeight: 700 }}>Your turn</span>
            <Countdown deadline={poker.actorDeadline} />
          </div>
          <ActionBar mesh={mesh} mySeat={mySeat} currentBet={poker.currentBet} minRaise={poker.minRaise} />
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <BuyInBanner mesh={mesh} myOwnerKey={myOwnerKey} escrow={escrow} />
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

// ─── Root ────────────────────────────────────────────────────────────

export const PokerWindow = ({ mesh, myOwnerKey }: Props) => {
  const escrow = mesh.escrow && mesh.escrow.game === "poker" ? mesh.escrow : null;

  const body = useMemo(() => {
    if (escrow && (escrow.status === "settling" || escrow.status === "settled")) {
      return <CashOutView mesh={mesh} escrow={escrow} />;
    }
    if (escrow && escrow.status === "open") {
      return <LiveTable mesh={mesh} myOwnerKey={myOwnerKey} escrow={escrow} />;
    }
    return <OpenTableForm mesh={mesh} />;
  }, [escrow, mesh, myOwnerKey]);

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

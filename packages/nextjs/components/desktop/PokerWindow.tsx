"use client";

// No-Limit Texas Hold'em with a BUY-IN WINDOW. Built on the generic escrow
// session (mesh.escrow, game === "poker") + the server-authoritative engine
// (mesh.pokerState public view + mesh.pokerPrivate hole cards). The relay
// owns the deck, the betting state machine, the deadline, and every
// transition; this surface renders the table and posts intent.
//
//   1. Open    — a host opens a table: buy-in, chip value, blinds (which can
//                escalate), and a buy-in-window length. No roster up front.
//   2. Join    — any player buys in (plain ETH → multisig, verified) and
//                takes the next seat, until the window closes. Latecomers
//                who join mid-hand sit out and are dealt in next hand.
//   3. Start   — once ≥2 players are seated, anyone can deal. The window
//                keeps counting down during play; blinds escalate on a clock.
//   4. Cash out — closing settles every stack to its owner in one multisig
//                batch (reused PayoutProposeButton).
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

const OpenTableForm = ({ mesh }: { mesh: PeerMeshState }) => {
  const { chainId } = useAccount();
  const [buyinEth, setBuyinEth] = useState("0.01");
  const [chipsPerBuyin, setChipsPerBuyin] = useState(1000);
  const [smallBlind, setSmallBlind] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);
  const [blindUpMin, setBlindUpMin] = useState(10); // 0 = fixed blinds
  const [windowMin, setWindowMin] = useState(10);
  const [err, setErr] = useState<string | null>(null);
  const noWallet = !mesh.wallet;

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
    if (chipsPerBuyin <= 0) return setErr("Chips per buy-in must be > 0.");
    if (buyinWei % BigInt(chipsPerBuyin) !== 0n) {
      return setErr("Buy-in doesn't divide evenly into chips — tweak the amount or chip count.");
    }
    if (bigBlind < smallBlind || smallBlind <= 0) return setErr("Bad blinds.");
    mesh.pokerOpenTable({
      buyinWei: buyinWei.toString(),
      chipValueWei: (buyinWei / BigInt(chipsPerBuyin)).toString(),
      smallBlind,
      bigBlind,
      blindIntervalMs: Math.max(0, blindUpMin) * 60_000,
      buyinWindowMs: Math.max(1, windowMin) * 60_000,
      chainId: chainId ?? 8453,
    });
  }, [noWallet, buyinEth, chipsPerBuyin, smallBlind, bigBlind, blindUpMin, windowMin, mesh, chainId]);

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
      <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 18, color: LIME }}>♠ New poker table</div>
      <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
        No-Limit Hold&apos;em. Open the table, then anyone can buy in during the window — a few friends can start early
        and others join if they make it in time.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={lbl}>
          Buy-in (ETH)
          <input style={inp} value={buyinEth} onChange={e => setBuyinEth(e.target.value)} />
        </label>
        <label style={lbl}>
          Chips per buy-in
          <input
            style={inp}
            type="number"
            value={chipsPerBuyin}
            onChange={e => setChipsPerBuyin(Number(e.target.value))}
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
        Open table
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
  const full = escrow.accounts.length >= 6;
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
        {escrow.accounts.length}/6 players in · buy-in {fmtEth(metaStr(escrow, "buyinWei"))} ETH
      </div>
      {open && !iAmIn && !full && <JoinButton mesh={mesh} escrow={escrow} />}
      {iAmIn && <div style={{ fontSize: 12, color: LIME }}>✓ You&apos;re in.</div>}
      {open && full && !iAmIn && <div style={{ fontSize: 12, color: ACCENT }}>Table full.</div>}
    </div>
  );
};

// ─── Settling / settled (cash out) ───────────────────────────────────

const CashOutView = ({ mesh, escrow }: { mesh: PeerMeshState; escrow: EscrowSession }) => {
  const { address } = useAccount();
  const total = (escrow.payouts ?? []).reduce((s, p) => s + BigInt(p.amountWei), 0n).toString();
  const iAmInPlan = (escrow.payouts ?? []).some(p => p.to === address?.toLowerCase());
  if (escrow.status === "settled") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 16, color: LIME }}>
          🃏 Table settled — {fmtEth(total)} ETH paid out
        </div>
        <button type="button" onClick={() => mesh.escrowClear()} style={{ ...btn(CYAN), alignSelf: "flex-start" }}>
          New table
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 16, color: CYAN }}>
        🃏 Cashing out — {fmtEth(total)} ETH across {(escrow.payouts ?? []).length} stack(s)
      </div>
      <PayoutProposeButton mesh={mesh} escrow={escrow} isRefund={false} canPropose={iAmInPlan} />
    </div>
  );
};

// ─── Live table ──────────────────────────────────────────────────────

const SeatBox = ({
  seat,
  isActor,
  isButton,
  isMe,
  myHole,
  bigBlind,
}: {
  seat: PokerSeatPublic;
  isActor: boolean;
  isButton: boolean;
  isMe: boolean;
  myHole: [string, string] | null;
  bigBlind: number;
}) => {
  const revealed = seat.hole; // populated at showdown
  const cards: (string | undefined)[] = isMe && myHole ? myHole : revealed ? revealed : [undefined, undefined];
  const folded = seat.status === "folded" || seat.status === "out";
  const concealed = seat.hasCards && !(isMe && myHole) && !revealed;
  return (
    <div
      style={{
        background: isActor ? "#241a44" : "#140d2a",
        border: `2px solid ${isActor ? LIME : isMe ? CYAN : "#2a1648"}`,
        borderRadius: 10,
        padding: 8,
        opacity: folded ? 0.45 : 1,
        minWidth: 130,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: isMe ? CYAN : "var(--slop-text)" }}>
          {seat.label}
          {isButton ? " Ⓓ" : ""}
        </span>
        <span style={{ fontSize: 11, color: "var(--slop-text-muted)" }}>{seat.status}</span>
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
          <span style={{ fontSize: 13, color: CYAN }}>Pot {poker.potTotal}</span>
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
            myHole={seat.key === myOwnerKey ? myHole : null}
            bigBlind={poker.bigBlind}
          />
        ))}
      </div>

      {poker.status === "complete" && poker.showdown.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
          Showdown:{" "}
          {poker.showdown
            .map(s => `${poker.seats.find(x => x.idx === s.seat)?.label ?? s.seat} — ${s.hand}`)
            .join(" · ")}
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
      {!myTurn && poker.status === "running" && (
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
  const iAmParticipant = escrow.accounts.some(a => a.key === myOwnerKey) || seated.some(s => s.key === myOwnerKey);
  const neverStarted = !poker || poker.status === "idle";
  // A joiner who bought in mid-hand isn't seated until the next deal.
  const pendingJoin = escrow.accounts.some(a => a.key === myOwnerKey) && !seated.some(s => s.key === myOwnerKey);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <BuyInBanner mesh={mesh} myOwnerKey={myOwnerKey} escrow={escrow} />
      {pendingJoin && <div style={{ fontSize: 12, color: CYAN }}>You&apos;re dealt in on the next hand.</div>}

      {poker && seated.length > 0 && <Felt mesh={mesh} myOwnerKey={myOwnerKey} poker={poker} />}
      {seated.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--slop-text-muted)" }}>Waiting for players to buy in…</div>
      )}

      {!running && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {playable >= 2 && (
            <button
              type="button"
              onClick={() => (neverStarted ? mesh.pokerStart() : mesh.pokerNextHand())}
              style={btn(LIME)}
            >
              {neverStarted ? "Start game" : "Deal next hand"}
            </button>
          )}
          {playable < 2 && neverStarted && (
            <span style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>Need ≥2 players to start.</span>
          )}
          {/* Before the first hand anyone can cancel (refunds any buy-ins);
              once playing, only a player can cash the table out. */}
          {neverStarted ? (
            <button type="button" onClick={() => mesh.escrowCancel()} style={btn(ACCENT)}>
              Cancel table
            </button>
          ) : (
            iAmParticipant && (
              <button type="button" onClick={() => mesh.pokerCloseTable()} style={btn(CYAN)}>
                Close table &amp; cash out
              </button>
            )
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

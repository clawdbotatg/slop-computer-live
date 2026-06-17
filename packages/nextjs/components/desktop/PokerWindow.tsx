"use client";

// No-Limit Texas Hold'em, built on the generic escrow session
// (mesh.escrow, game === "poker") + the server-authoritative poker engine
// (mesh.pokerState public view + mesh.pokerPrivate hole cards). The relay
// owns the deck, the betting state machine, and every transition; this
// surface renders the table and posts intent. Money flow mirrors chess:
//
//   1. Lobby   — a host opens a table with a roster + buy-in. Chips are
//                money: chipValueWei maps a chip to wei.
//   2. Buy-in  — each player sends a plain ETH transfer to the multisig
//                (reused FundButton). The relay verifies on-chain.
//   3. Play    — once all buy-ins land, any player deals. Hands run; chips
//                move via the engine; the relay keeps the escrow ledger in
//                sync (applyDeltas per hand).
//   4. Cash out — closing the table settles every stack to its owner in
//                one multisig batch (reused PayoutProposeButton).
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount } from "wagmi";
import { FundButton, PayoutProposeButton } from "~~/components/desktop/chess/WagerPanel";
import type { EscrowSession, PeerMeshState, PokerActionKind, PokerSeatPublic } from "~~/hooks/usePeerMesh";

const ACCENT = "var(--slop-magenta, #ff3ec9)";
const CYAN = "var(--slop-cyan, #2ee6d6)";
const LIME = "var(--slop-lime, #b6ff3c)";
const PANEL_BG = "#0a061a";
const FELT = "#0c2a1e";

type Props = { mesh: PeerMeshState; myOwnerKey: string | null; myLabel: string | null };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtEth = (wei: string) => {
  try {
    const n = Number(formatEther(BigInt(wei)));
    return n < 0.0001 ? n.toExponential(2) : n.toLocaleString(undefined, { maximumFractionDigits: 5 });
  } catch {
    return "0";
  }
};

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

// Live turn countdown — ticks each second toward the auto-act deadline.
const TurnClock = ({ deadline }: { deadline: number | null }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);
  if (!deadline) return null;
  const secs = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <span style={{ fontSize: 12, color: secs <= 10 ? ACCENT : "var(--slop-text-muted)" }}>⏱ {secs}s</span>;
};

// ─── Lobby (open a table) ────────────────────────────────────────────

const LobbyForm = ({ mesh, myOwnerKey, myLabel }: Props) => {
  const { chainId } = useAccount();
  const [buyinEth, setBuyinEth] = useState("0.01");
  const [chipsPerBuyin, setChipsPerBuyin] = useState(1000);
  const [smallBlind, setSmallBlind] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);
  const [rows, setRows] = useState<{ key: string; label: string }[]>(
    myOwnerKey ? [{ key: myOwnerKey, label: myLabel ?? short(myOwnerKey) }] : [{ key: "", label: "" }],
  );
  const [err, setErr] = useState<string | null>(null);

  const noWallet = !mesh.wallet;

  const addRow = () => setRows(r => (r.length >= 6 ? r : [...r, { key: "", label: "" }]));
  const setRow = (i: number, patch: Partial<{ key: string; label: string }>) =>
    setRows(r => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const delRow = (i: number) => setRows(r => r.filter((_, j) => j !== i));

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
    const seen = new Set<string>();
    const accounts: { key: string; seat: number; buyinWei: string; label?: string }[] = [];
    rows.forEach((row, i) => {
      const key = row.key.trim().toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(key)) return;
      if (seen.has(key)) return;
      seen.add(key);
      accounts.push({ key, seat: i, buyinWei: buyinWei.toString(), label: row.label.trim() || short(key) });
    });
    if (accounts.length < 2) return setErr("Need at least 2 players with valid addresses.");
    const chipValueWei = (buyinWei / BigInt(chipsPerBuyin)).toString();
    mesh.pokerProposeTable({
      accounts,
      chipValueWei,
      smallBlind,
      bigBlind,
      chainId: chainId ?? 8453,
    });
  }, [noWallet, buyinEth, chipsPerBuyin, smallBlind, bigBlind, rows, mesh, chainId]);

  const inp: React.CSSProperties = {
    background: "#160e2e",
    border: "1px solid #2a1648",
    borderRadius: 6,
    color: "var(--slop-text)",
    padding: "6px 8px",
    fontSize: 13,
    width: "100%",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 18, color: LIME }}>♠ New poker table</div>
      <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
        No-Limit Hold&apos;em cash game. Each player buys in for chips; stacks cash out of the room multisig when the
        table closes.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
          Buy-in (ETH)
          <input style={inp} value={buyinEth} onChange={e => setBuyinEth(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
          Chips per buy-in
          <input
            style={inp}
            type="number"
            value={chipsPerBuyin}
            onChange={e => setChipsPerBuyin(Number(e.target.value))}
          />
        </label>
        <label style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
          Small blind (chips)
          <input style={inp} type="number" value={smallBlind} onChange={e => setSmallBlind(Number(e.target.value))} />
        </label>
        <label style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
          Big blind (chips)
          <input style={inp} type="number" value={bigBlind} onChange={e => setBigBlind(Number(e.target.value))} />
        </label>
      </div>
      <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>Players (2–6, wallet addresses)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--slop-text-muted)", width: 16 }}>{i + 1}</span>
            <input
              style={{ ...inp, flex: 2 }}
              placeholder="0x… address"
              value={row.key}
              onChange={e => setRow(i, { key: e.target.value })}
            />
            <input
              style={{ ...inp, flex: 1 }}
              placeholder="label"
              value={row.label}
              onChange={e => setRow(i, { label: e.target.value })}
            />
            {rows.length > 2 && (
              <button type="button" onClick={() => delRow(i)} style={{ ...btn(ACCENT), padding: "4px 8px" }}>
                ✕
              </button>
            )}
          </div>
        ))}
        {rows.length < 6 && (
          <button
            type="button"
            onClick={addRow}
            style={{ ...btn(CYAN), alignSelf: "flex-start", padding: "4px 10px", fontSize: 11 }}
          >
            + add player
          </button>
        )}
      </div>
      <button type="button" onClick={onOpen} disabled={noWallet} style={btn(LIME, noWallet)}>
        Open table
      </button>
      {noWallet && <div style={{ fontSize: 12, color: ACCENT }}>Deploy a room multisig in the Wallet app first.</div>}
      {err && <div style={{ fontSize: 12, color: ACCENT }}>{err}</div>}
    </div>
  );
};

// ─── Buy-in collection ───────────────────────────────────────────────

const FundingView = ({
  mesh,
  myOwnerKey,
  escrow,
}: {
  mesh: PeerMeshState;
  myOwnerKey: string | null;
  escrow: EscrowSession;
}) => {
  const myAccount = escrow.accounts.find(a => a.key === myOwnerKey);
  const allFunded = escrow.accounts.every(a => BigInt(a.depositedWei) >= BigInt(a.requiredWei));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 18, color: CYAN }}>♠ Collecting buy-ins</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {escrow.accounts.map(a => {
          const funded = BigInt(a.depositedWei) >= BigInt(a.requiredWei);
          return (
            <div
              key={a.key}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#160e2e",
                borderRadius: 8,
                padding: "8px 12px",
              }}
            >
              <span style={{ fontSize: 13 }}>
                Seat {a.role} · {a.label}
              </span>
              <span style={{ fontSize: 12, color: funded ? LIME : "var(--slop-text-muted)" }}>
                {funded
                  ? "✓ funded"
                  : `owes ${fmtEth((BigInt(a.requiredWei) - BigInt(a.depositedWei)).toString())} ETH`}
              </span>
            </div>
          );
        })}
      </div>
      {myAccount && BigInt(myAccount.depositedWei) < BigInt(myAccount.requiredWei) && (
        <FundButton mesh={mesh} escrow={escrow} account={myAccount} />
      )}
      {allFunded && (
        <button type="button" onClick={() => mesh.pokerStart()} style={btn(LIME)}>
          Deal first hand
        </button>
      )}
      <button
        type="button"
        onClick={() => mesh.escrowCancel()}
        style={{ ...btn(ACCENT), alignSelf: "flex-start", padding: "4px 10px", fontSize: 11 }}
      >
        Cancel table
      </button>
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
        <Card card={cards[0]} hidden={seat.hasCards && !(isMe && myHole) && !revealed} small />
        <Card card={cards[1]} hidden={seat.hasCards && !(isMe && myHole) && !revealed} small />
      </div>
      <div style={{ fontSize: 12 }}>
        💰 {seat.stack}{" "}
        <span style={{ color: "var(--slop-text-muted)" }}>({(seat.stack / bigBlind).toFixed(0)} BB)</span>
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

const TableView = ({ mesh, myOwnerKey }: { mesh: PeerMeshState; myOwnerKey: string | null }) => {
  const poker = mesh.pokerState!;
  const myHole = mesh.pokerPrivate && mesh.pokerPrivate.handId === poker.handId ? mesh.pokerPrivate.hole : null;
  const mySeat = poker.seats.find(s => s.key === myOwnerKey) ?? null;
  const myTurn = mySeat && poker.status === "running" && poker.actor === mySeat.idx;
  const handOver = poker.status === "complete";
  const between = poker.status === "complete" || poker.status === "idle";
  const isParticipant = !!mySeat;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "var(--slop-font-display)", fontSize: 16, color: LIME }}>
          ♠ {poker.smallBlind}/{poker.bigBlind} · {poker.street === "idle" ? "between hands" : poker.street}
        </span>
        <span style={{ fontSize: 13, color: CYAN }}>Pot {poker.potTotal}</span>
      </div>

      {/* Felt: board + pots */}
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

      {/* Seats */}
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

      {/* Showdown summary */}
      {handOver && poker.showdown.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
          Showdown:{" "}
          {poker.showdown
            .map(s => `${poker.seats.find(x => x.idx === s.seat)?.label ?? s.seat} — ${s.hand}`)
            .join(" · ")}
        </div>
      )}

      {/* Actions */}
      {myTurn && mySeat && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 13, color: LIME, fontWeight: 700 }}>Your turn</span>
            <TurnClock deadline={poker.actorDeadline} />
          </div>
          <ActionBar mesh={mesh} mySeat={mySeat} currentBet={poker.currentBet} minRaise={poker.minRaise} />
        </div>
      )}
      {!myTurn && poker.status === "running" && (
        <div style={{ fontSize: 13, color: "var(--slop-text-muted)", display: "flex", gap: 8, alignItems: "center" }}>
          <span>Waiting on {poker.seats.find(s => s.idx === poker.actor)?.label ?? "…"}</span>
          <TurnClock deadline={poker.actorDeadline} />
        </div>
      )}

      {/* Between-hand controls */}
      {between && isParticipant && (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={() => mesh.pokerNextHand()} style={btn(LIME)}>
            Deal next hand
          </button>
          <button type="button" onClick={() => mesh.pokerCloseTable()} style={btn(CYAN)}>
            Close table &amp; cash out
          </button>
        </div>
      )}
    </div>
  );
};

// ─── Root ────────────────────────────────────────────────────────────

export const PokerWindow = ({ mesh, myOwnerKey, myLabel }: Props) => {
  const escrow = mesh.escrow && mesh.escrow.game === "poker" ? mesh.escrow : null;
  const poker = mesh.pokerState;

  const body = useMemo(() => {
    // Settling / settled → cash-out flow.
    if (escrow && (escrow.status === "settling" || escrow.status === "settled")) {
      return <CashOutView mesh={mesh} escrow={escrow} />;
    }
    // Locked + an active/idle engine table → live table.
    if (escrow && escrow.status === "locked" && poker && poker.seats.length > 0) {
      return <TableView mesh={mesh} myOwnerKey={myOwnerKey} />;
    }
    // Collecting buy-ins, OR all funded but not yet dealt (locked, no seats
    // seated in the engine yet) — the funding view shows the "Deal" button.
    if (escrow && (escrow.status === "open" || escrow.status === "locked")) {
      return <FundingView mesh={mesh} myOwnerKey={myOwnerKey} escrow={escrow} />;
    }
    // No live poker escrow → lobby.
    return <LobbyForm mesh={mesh} myOwnerKey={myOwnerKey} myLabel={myLabel} />;
  }, [escrow, poker, mesh, myOwnerKey, myLabel]);

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

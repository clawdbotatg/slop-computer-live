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
import { base } from "viem/chains";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from "wagmi";
import { PayoutProposeButton } from "~~/components/desktop/chess/WagerPanel";
import { SlopAddress } from "~~/components/ui";
import { useEthPrice } from "~~/hooks/useEthPrice";
import { usePageVisible } from "~~/hooks/usePageVisible";
import type {
  EscrowSession,
  PeerMeshState,
  PokerActionKind,
  PokerSeatPublic,
  PokerTableView,
} from "~~/hooks/usePeerMesh";
import { usePersonalWalletSend } from "~~/hooks/usePersonalWalletSend";
import { bandsFromIdentity } from "~~/utils/blockieBands";
import {
  isPokerMuted,
  setPokerMuted,
  sfxCardFlip,
  sfxCheck,
  sfxChips,
  sfxDeal,
  sfxFold,
  sfxShuffle,
  sfxTick,
  sfxWin,
  unlockPokerAudio,
  warmPokerAudio,
} from "~~/utils/pokerSounds";
import { usdSuffixFromEth, usdSuffixFromWei } from "~~/utils/usd";

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
  const w = small ? 32 : 42;
  const h = small ? 44 : 60;
  if (hidden || !card) {
    return (
      <div
        style={{
          width: w,
          height: h,
          borderRadius: 5,
          // Hidden = a slop-computer card back: a tight hot-magenta × violet
          // cross-hatch over deep purple. Each diagonal alternates a pink line
          // then a purple line (a colored line every 4px) for a dense weave.
          // An empty board slot stays flat dark.
          background: hidden
            ? [
                "repeating-linear-gradient(45deg, rgba(255,62,201,0.7) 0 1.5px, transparent 1.5px 4px, rgba(166,77,255,0.7) 4px 5.5px, transparent 5.5px 8px)",
                "repeating-linear-gradient(-45deg, rgba(255,62,201,0.5) 0 1.5px, transparent 1.5px 4px, rgba(166,77,255,0.5) 4px 5.5px, transparent 5.5px 8px)",
                "linear-gradient(155deg, #3a2160, #1d0f3c)",
              ].join(",")
            : "#160e2e",
          border: hidden ? "1px solid #ff3ec9" : "1px solid #2a1648",
          boxShadow: hidden ? "inset 0 0 6px rgba(255,62,201,0.35)" : undefined,
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
        fontSize: small ? 15 : 19,
        lineHeight: 1,
      }}
    >
      <span>{rank}</span>
      <span style={{ fontSize: small ? 16 : 20 }}>{SUIT_GLYPH[suit]}</span>
    </div>
  );
};

// Live countdown to a deadline — ticks each second. Formats m:ss past 60s.
const Countdown = ({ deadline, urgentAt = 10 }: { deadline: number | null; urgentAt?: number }) => {
  const [now, setNow] = useState(() => Date.now());
  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!deadline || !pageVisible) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline, pageVisible]);
  if (!deadline) return null;
  const secs = Math.max(0, Math.ceil((deadline - now) / 1000));
  const label = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
  return <span style={{ fontSize: 12, color: secs <= urgentAt ? ACCENT : "var(--slop-text-muted)" }}>⏱ {label}</span>;
};

// Whole seconds, no unit — the trailing "s" reads like a 5 next to the digits.
const fmtThink = (ms: number): string => `${Math.max(0, Math.round((ms || 0) / 1000))}`;

// Per-seat clock, two values:
//   • TEAL  = seconds spent on THIS turn — live-ticking while on the clock
//             (its last turn's time when idle).
//   • GRAY  = total time spent thinking all game — static; it only jumps when
//             a turn completes (the server folds the turn into the total), so
//             it does NOT tick per second.
const SeatThinkTime = ({
  live,
  actorSince,
  lastMs,
  totalMs,
}: {
  live: boolean;
  actorSince: number;
  lastMs: number | null;
  totalMs: number;
}) => {
  const [, setTick] = useState(0);
  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!live || !pageVisible) return;
    const id = window.setInterval(() => setTick(t => t + 1), 1000); // ticks the teal this-turn value
    return () => window.clearInterval(id);
  }, [live, pageVisible]);
  const turn = live ? Math.max(0, Date.now() - actorSince) : lastMs; // teal, increments while live
  const total = totalMs || 0; // gray, static (server-accumulated, no live add)
  if (turn == null && total <= 0) return null; // nothing yet
  return (
    <div style={{ fontSize: 10, whiteSpace: "nowrap" }}>
      <span style={{ color: "var(--slop-text-muted)" }}>⏱ {fmtThink(total)}</span>
      {turn != null && <span style={{ color: CYAN }}> ({fmtThink(turn)})</span>}
    </div>
  );
};

// ─── Open a table ────────────────────────────────────────────────────

const CHAIN_LABELS: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  10: "Optimism",
  42161: "Arbitrum",
  137: "Polygon",
  100: "Gnosis",
  4663: "Robinhood",
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
  const ethUsd = useEthPrice();
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
    if (noWallet) return setErr("Deploy the Bank using the Bank app first.");
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
          Buy-in ({CHAIN_LABELS[network] ?? "chain"} ETH){usdSuffixFromEth(buyinEth, ethUsd)}
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
      {noWallet && <div style={{ fontSize: 12, color: ACCENT }}>Deploy the Bank using the Bank app first.</div>}
      {err && <div style={{ fontSize: 12, color: ACCENT }}>{err}</div>}
    </div>
  );
};

// ─── Join (buy in during the window) ─────────────────────────────────

// The ETH deposit that funds a seat: pay the buy-in to the room multisig from
// either a passkey personal wallet (Base-only, via the relay facilitator) or a
// connected EOA. Returns the tx hash; the caller waits for the receipt and
// reports it (buy in for yourself, or sponsor an AI). Factored out so both
// flows share the identical passkey/EOA branch.
function useEscrowDeposit(escrow: EscrowSession) {
  const currentChainId = useChainId();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { sendTransactionAsync, isPending: sending } = useSendTransaction();
  const { send: personalSend, phase: personalPhase, isPasskey } = usePersonalWalletSend();
  const buyinWei = metaStr(escrow, "buyinWei") || "0";
  const sendDeposit = useCallback(async (): Promise<`0x${string}`> => {
    if (isPasskey) {
      // Passkey wallet: no EOA to send from. Spend from the personal multisig
      // via the relay facilitator (Base-only). See usePersonalWalletSend.
      if (escrow.chainId !== base.id) throw new Error("Passkey wallets can buy in on Base only.");
      return personalSend({ to: escrow.multisig as `0x${string}`, valueWei: BigInt(buyinWei) });
    }
    if (currentChainId !== escrow.chainId) await switchChainAsync({ chainId: escrow.chainId });
    return sendTransactionAsync({
      to: escrow.multisig as `0x${string}`,
      value: BigInt(buyinWei),
      chainId: escrow.chainId,
    });
  }, [
    isPasskey,
    personalSend,
    currentChainId,
    escrow.chainId,
    escrow.multisig,
    buyinWei,
    switchChainAsync,
    sendTransactionAsync,
  ]);
  return { sendDeposit, buyinWei, switching, sending, personalPhase };
}

// Shared "deposit in progress" caption for the buy-in / sponsor flows.
function depositStatus(p: {
  personalPhase: string | null | undefined;
  switching: boolean;
  sending: boolean;
  waiting: boolean;
  verifying: boolean;
}): string | null {
  if (p.personalPhase)
    return p.personalPhase === "deploying"
      ? "Deploying your wallet…"
      : p.personalPhase === "signing"
        ? "Approve with your passkey…"
        : "Submitting…";
  if (p.switching) return "Switching chain…";
  if (p.sending) return "Confirm in your wallet…";
  if (p.waiting) return "Waiting for confirmation…";
  if (p.verifying) return "Verifying deposit…";
  return null;
}

const JoinButton = ({ mesh, escrow }: { mesh: PeerMeshState; escrow: EscrowSession }) => {
  const ethUsd = useEthPrice();
  const { sendDeposit, buyinWei, switching, sending, personalPhase } = useEscrowDeposit(escrow);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [reported, setReported] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { isLoading: waiting, data: receipt } = useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    chainId: escrow.chainId,
  });

  useEffect(() => {
    // Only report the receipt that belongs to the CURRENT txHash. Without this
    // a stale receipt from a prior deposit can re-fire the effect and report
    // the wrong (already-consumed) hash.
    if (receipt && txHash && !reported && receipt.transactionHash.toLowerCase() === txHash.toLowerCase()) {
      setReported(true);
      mesh.pokerJoin(txHash);
    }
  }, [receipt, txHash, reported, mesh]);

  const result = mesh.pokerJoinResult;
  const rejected = reported && result && !result.ok && result.txHash === txHash ? result.reason : null;

  const onJoin = useCallback(async () => {
    setErr(null);
    // Drop any prior hash + reported flag BEFORE awaiting the wallet, so the
    // previous deposit's cached receipt can't trigger the effect against the
    // stale hash while the new tx is still being signed.
    setReported(false);
    setTxHash(null);
    try {
      setTxHash(await sendDeposit());
    } catch (e) {
      setErr(String(e).slice(0, 160));
    }
  }, [sendDeposit]);

  const busy = switching || sending || !!personalPhase || (!!txHash && (waiting || (reported && !rejected)));
  const statusText = depositStatus({
    personalPhase,
    switching,
    sending,
    waiting,
    verifying: !!(reported && !rejected),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button type="button" onClick={onJoin} disabled={busy} style={btn(LIME, busy)}>
        {busy ? "Buying in…" : `Buy in — ${fmtEth(buyinWei)} ETH${usdSuffixFromWei(buyinWei, ethUsd)}`}
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

// ─── Sponsor an LLM (buy in a bot you pick + name) ───────────────────
//
// You pay the same buy-in from your wallet, choose a model and a name, and the
// relay seats an autonomous AI player. It plays itself; its prize settles back
// to you. Hidden when the relay ships no AI models (none have an API key set).
const sponsorField: React.CSSProperties = {
  background: "#160e2e",
  border: "1px solid #2a1648",
  borderRadius: 6,
  color: "var(--slop-text)",
  padding: "6px 8px",
  fontSize: 13,
};

const SponsorPanel = ({ mesh, escrow }: { mesh: PeerMeshState; escrow: EscrowSession }) => {
  const ethUsd = useEthPrice();
  const { sendDeposit, buyinWei, switching, sending, personalPhase } = useEscrowDeposit(escrow);
  // Sort fastest-first by measured avg decision time (unbenchmarked last) so
  // the snappiest models are at the top of the dropdown.
  const models = useMemo(
    () => [...mesh.aiPlayers].sort((a, b) => (a.avgMs ?? Infinity) - (b.avgMs ?? Infinity)),
    [mesh.aiPlayers],
  );
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [reported, setReported] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { isLoading: waiting, data: receipt } = useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    chainId: escrow.chainId,
  });

  // Default to the first model once the list arrives.
  useEffect(() => {
    if (!modelId && models.length) setModelId(models[0]!.id);
  }, [models, modelId]);
  const chosen = models.find(m => m.id === modelId) ?? null;
  const botName = name.trim() || chosen?.label || "a bot";

  useEffect(() => {
    // Only report the receipt that belongs to the CURRENT txHash. Sponsoring
    // is the one flow where the same panel sends multiple deposits in a
    // session, so a stale receipt from the previous bot would otherwise
    // re-fire here and report an already-consumed hash — flipping `reported`
    // true and gating off the real (second) deposit. That stranded the ETH in
    // the multisig with no bot and the button stuck on "Sponsoring…".
    if (receipt && txHash && !reported && chosen && receipt.transactionHash.toLowerCase() === txHash.toLowerCase()) {
      setReported(true);
      mesh.pokerSponsorAi({ txHash, modelId: chosen.id, name: name.trim() || chosen.label });
    }
  }, [receipt, txHash, reported, chosen, name, mesh]);

  const result = mesh.pokerSponsorAiResult;
  const rejected = reported && result && !result.ok && result.txHash === txHash ? result.reason : null;
  const sponsored = !!(reported && result && result.ok && result.txHash === txHash);

  const onSponsor = useCallback(async () => {
    setErr(null);
    if (!chosen) {
      setErr("Pick a model first.");
      return;
    }
    // Clear the prior deposit's hash + reported flag BEFORE awaiting the
    // wallet, so its cached receipt can't fire the effect against the stale
    // hash while the new tx is still being signed.
    setReported(false);
    setTxHash(null);
    try {
      setTxHash(await sendDeposit());
    } catch (e) {
      setErr(String(e).slice(0, 160));
    }
  }, [chosen, sendDeposit]);

  if (!models.length) return null;

  const busy =
    switching || sending || !!personalPhase || (!!txHash && (waiting || (reported && !rejected && !sponsored)));
  const statusText = depositStatus({
    personalPhase,
    switching,
    sending,
    waiting,
    verifying: !!(reported && !rejected && !sponsored),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid #2a1648", paddingTop: 8 }}>
      <span style={{ fontSize: 11, color: CYAN, textTransform: "uppercase", letterSpacing: 0.4 }}>
        Sponsor an LLM 🤖
      </span>
      <span style={{ fontSize: 11, color: "var(--slop-text-muted)" }}>
        Pick a model, name it, and pay its buy-in — it plays autonomously and its winnings come back to you.
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <select
          value={modelId}
          onChange={e => setModelId(e.target.value)}
          disabled={busy}
          style={{ ...sponsorField, flex: "1 1 150px" }}
        >
          {models.map(m => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.avgMs != null ? ` · ~${Math.max(1, Math.round(m.avgMs / 1000))}s/move` : ""}
              {m.costPerHandUsd != null ? ` · ~$${(m.costPerHandUsd * 100).toFixed(2)}/100 hands` : ""}
            </option>
          ))}
        </select>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={24}
          placeholder={chosen?.label ?? "Bot name"}
          disabled={busy}
          style={{ ...sponsorField, flex: "1 1 120px" }}
        />
      </div>
      <button type="button" onClick={onSponsor} disabled={busy} style={btn(CYAN, busy)}>
        {busy ? "Sponsoring…" : `Sponsor ${botName} — ${fmtEth(buyinWei)} ETH${usdSuffixFromWei(buyinWei, ethUsd)}`}
      </button>
      {statusText && <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>{statusText}</div>}
      {sponsored && <div style={{ fontSize: 12, color: LIME }}>✓ {botName} is in.</div>}
      {rejected && (
        <div style={{ fontSize: 12, color: ACCENT }}>
          {rejected === "not_mined"
            ? "Not confirmed yet — give it a moment, then retry."
            : `Sponsor rejected: ${rejected}`}
          {rejected === "not_mined" && txHash && chosen && (
            <button
              type="button"
              onClick={() => {
                setReported(false);
                mesh.pokerSponsorAi({ txHash, modelId: chosen.id, name: name.trim() || chosen.label });
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
  const ethUsd = useEthPrice();
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
      <Stat label="Buy-in" value={`${fmtEth(buyin)} ETH${usdSuffixFromWei(buyin, ethUsd)}`} hint={network} />
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
  const ethUsd = useEthPrice();
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
          {usdSuffixFromWei(pool, ethUsd)}
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
          Late buy-in {fmtEth(buyin)} ETH{usdSuffixFromWei(buyin, ethUsd)} · pool{" "}
          <span style={{ color: GOLD }}>{fmtEth(pool)} ETH</span>
          {usdSuffixFromWei(pool, ethUsd)} {open && <Countdown deadline={deadline} urgentAt={30} />}
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
        {escrow.accounts.length}/8 players · buy-in {fmtEth(buyin)} ETH{usdSuffixFromWei(buyin, ethUsd)} · prize pool{" "}
        <span style={{ color: GOLD }}>{fmtEth(pool)} ETH</span>
        {usdSuffixFromWei(pool, ethUsd)}
      </div>
      <TournamentConfig escrow={escrow} />
      {open && !iAmIn && !full && <JoinButton mesh={mesh} escrow={escrow} />}
      {iAmIn && <div style={{ fontSize: 12, color: LIME }}>✓ You&apos;re in.</div>}
      {open && full && !iAmIn && <div style={{ fontSize: 12, color: ACCENT }}>Tournament full (8 players).</div>}
      {/* Sponsor a bot whether or not you've bought yourself in — as long as
          the window's open and there's an empty seat. */}
      {open && !full && <SponsorPanel mesh={mesh} escrow={escrow} />}
    </div>
  );
};

// ─── Settling / settled (cash out) ───────────────────────────────────

const MEDAL = ["🥇", "🥈", "🥉"];
const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10] ?? "th"}`;

const CashOutView = ({ mesh, escrow }: { mesh: PeerMeshState; escrow: EscrowSession }) => {
  const ethUsd = useEthPrice();
  const total = (escrow.payouts ?? []).reduce((s, p) => s + BigInt(p.amountWei), 0n).toString();
  const settled = escrow.status === "settled";
  const standings =
    (escrow.meta.standings as
      | { key: string; label: string; place: number; recipient?: string; wonWei?: string }[]
      | undefined) ?? [];
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
        🏆 Tournament over — {fmtEth(total)} ETH{usdSuffixFromWei(total, ethUsd)} pool
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {standings.map(s => {
          // Each finisher's own prize (server-computed per place). May be
          // redirected to a sponsor for an AI seat — shown next to the bot's
          // row regardless, since the row carries its own amount.
          const won = s.wonWei && BigInt(s.wonWei) > 0n ? s.wonWei : undefined;
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
                {s.key.startsWith("ai:") && " 🤖"}
              </span>
              {won && (
                <span style={{ color: GOLD }}>
                  {fmtEth(won)} ETH{usdSuffixFromWei(won, ethUsd)}
                </span>
              )}
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
        // Proposed — now it has to be signed + executed in the Bank app (the
        // room multisig; it's a multisig tx). Surface that + a one-tap shortcut.
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 13, color: CYAN }}>
            Payout proposed — sign &amp; execute it in the <b>Bank</b> app to send the ETH.
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
            Open Bank app →
          </button>
        </div>
      ) : (
        // Anyone can submit the payout — the plan is fixed server-side, so it
        // can only ever pay the finishers by place. Popping the Bank app on
        // propose makes the multisig tx show up to sign right away.
        <PayoutProposeButton
          mesh={mesh}
          escrow={escrow}
          isRefund={false}
          canPropose={true}
          claimText={`Pay out winners — ${fmtEth(total)} ETH${usdSuffixFromWei(total, ethUsd)}`}
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
  actorSince,
  lastThinkMs,
  backer,
  customNames,
  boxWidth,
}: {
  seat: PokerSeatPublic;
  isActor: boolean;
  isButton: boolean;
  isMe: boolean;
  isWinner: boolean;
  myHole: [string, string] | null;
  /** When this seat went on the clock (epoch ms) — drives the live timer. */
  actorSince: number;
  /** How long this seat took on its most recent action this hand (ms), or
   *  null if it hasn't acted yet. */
  lastThinkMs: number | null;
  /** For a sponsored AI seat: the backer's address (the human who'll collect
   *  if the bot wins), rendered via <SlopAddress>. null for human seats. */
  backer: string | null;
  /** Global custom-name map so <SlopAddress> resolves display names. */
  customNames: Record<string, string>;
  /** Plate width (px). Scaled by seat count so a small table gets big plates
   *  while a full 8-handed table stays tight enough to fit the felt. */
  boxWidth: number;
}) => {
  const revealed = seat.hole; // populated at showdown
  const cards: (string | undefined)[] = isMe && myHole ? myHole : revealed ? revealed : [undefined, undefined];
  const isAi = seat.key.startsWith("ai:"); // a sponsored LLM player
  // Busted out of the tournament — no chips and marked "out" of play — so
  // ghost the whole plate to ~5% and let the players still alive read clearly.
  // The stack===0 guard matters: a freshly-seated player waiting for the next
  // hand is also status "out" but still has chips, and must NOT be ghosted.
  // "folded" is only folded *this hand*; keep it lightly dimmed and it returns
  // to full opacity next hand.
  const busted = seat.status === "out" && seat.stack === 0;
  const folded = seat.status === "folded";
  const concealed = seat.hasCards && !(isMe && myHole) && !revealed;
  const borderColor = isActor ? LIME : isWinner ? GOLD : isMe ? CYAN : "#2a1648";
  const glow = isActor ? `0 0 18px ${LIME}` : isWinner ? `0 0 16px ${GOLD}` : "none";
  // The player's identity band colors (address bands for a human, a stable
  // hash for an AI seat) — painted as a strip across the bottom of the plate
  // instead of an inline flag, so it reads as the card's edge + saves space.
  const bands = useMemo(() => bandsFromIdentity({ address: seat.key, fallback: seat.key }), [seat.key]);
  return (
    <div
      style={{
        position: "relative",
        width: boxWidth,
        background: isActor ? "#1f2a14" : "#140d2a",
        border: `2px solid ${borderColor}`,
        boxShadow: glow,
        borderRadius: 10,
        padding: 9,
        paddingBottom: 13, // clearance for the band strip pinned to the bottom edge
        opacity: busted ? 0.05 : folded ? 0.45 : 1,
        // Busted plates also stop intercepting pointer events so the ghost
        // never sits on top of a live seat's interactions.
        pointerEvents: busted ? "none" : undefined,
        transition: "opacity 0.6s ease, box-shadow 0.2s, border-color 0.2s, background 0.2s",
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
      {seat.away && seat.status !== "allin" && (
        <div
          style={{
            position: "absolute",
            top: -9,
            right: 8,
            background: "#6b7280",
            color: "#0a061a",
            fontSize: 9,
            fontWeight: 900,
            padding: "1px 7px",
            borderRadius: 8,
            letterSpacing: 0.5,
          }}
          title="Away — timed out repeatedly; short turn clock until they act"
        >
          💤 AWAY
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          minWidth: 0,
          marginBottom: 4,
          justifyContent: "center",
        }}
      >
        {isButton && <DealerChip />}
        {isAi ? (
          // Sponsored bot: show the name the sponsor gave it (no on-chain
          // address of its own), with a 🤖 so it reads as a bot.
          <span
            title="Sponsored AI player"
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: isMe ? CYAN : "var(--slop-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            🤖 {seat.label}
          </span>
        ) : (
          // Real player: the standard slop address chip (ENS / blockie / name),
          // scaled down a touch so it sits neatly in the seat plate.
          <span style={{ display: "inline-flex", transform: "scale(0.82)", transformOrigin: "center" }}>
            <SlopAddress address={seat.key} customNames={customNames} blockieSize={14} hideFlag />
          </span>
        )}
      </div>
      {isAi && backer && (
        // Who's backing the bot — the sponsor's address chip (they collect its
        // winnings). Replaces the old "🎟️ by 0x…" text with the real component.
        <div
          title="Sponsored by — they collect this seat's winnings"
          style={{ display: "flex", justifyContent: "center", marginBottom: 4, fontSize: 9, opacity: 0.85 }}
        >
          <span style={{ display: "inline-flex", transform: "scale(0.8)", transformOrigin: "center" }}>
            <SlopAddress address={backer} customNames={customNames} blockieSize={11} hideFlag />
          </span>
        </div>
      )}
      <div style={{ display: "flex", gap: 4, marginBottom: 4, justifyContent: "center" }}>
        <Card card={cards[0]} hidden={concealed} small />
        <Card card={cards[1]} hidden={concealed} small />
      </div>
      <div
        style={{ fontSize: 12, textAlign: "center", color: seat.stack === 0 ? "var(--slop-text-muted)" : undefined }}
      >
        💰 {seat.stack}
      </div>
      <div style={{ textAlign: "center" }}>
        <SeatThinkTime live={isActor} actorSince={actorSince} lastMs={lastThinkMs} totalMs={seat.thinkMsTotal} />
      </div>
      {/* The player's band colors as a strip along the bottom edge — the old
          inline flag, moved here so it reads as the card's edge. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 6,
          borderRadius: "0 0 8px 8px",
          background: `linear-gradient(to right, ${bands.band1} 0 33.33%, ${bands.band2} 33.33% 66.66%, ${bands.band3} 66.66% 100%)`,
        }}
      />
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
// study the revealed hands. Ticks locally to re-enable when the pause ends —
// then a 10s countdown runs and auto-deals so a table never stalls waiting on
// a human click (you can still click to deal immediately).
const AUTO_DEAL_MS = 10_000;
const DealButton = ({ onClick, readyAt }: { onClick: () => void; readyAt: number | null }) => {
  const [now, setNow] = useState(() => Date.now());
  const [autoAt, setAutoAt] = useState<number | null>(null);
  const fired = useRef(false);
  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!pageVisible) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [pageVisible]);
  const waiting = readyAt ? now < readyAt : false;
  // Once the showdown pause is over, arm the auto-deal countdown (once).
  useEffect(() => {
    if (waiting || autoAt != null) return;
    setAutoAt(Date.now() + AUTO_DEAL_MS);
  }, [waiting, autoAt]);
  // Auto-deal when the countdown elapses.
  useEffect(() => {
    if (autoAt == null || fired.current || now < autoAt) return;
    fired.current = true;
    onClick();
  }, [now, autoAt, onClick]);
  if (waiting) {
    const secs = Math.max(0, Math.ceil((readyAt! - now) / 1000));
    return (
      <button type="button" disabled style={btn(LIME, true)}>
        Showdown — {secs}s
      </button>
    );
  }
  const secs = autoAt ? Math.max(0, Math.ceil((autoAt - now) / 1000)) : AUTO_DEAL_MS / 1000;
  return (
    <button
      type="button"
      onClick={() => {
        fired.current = true;
        onClick();
      }}
      style={btn(LIME)}
    >
      Deal next hand — {secs}s
    </button>
  );
};

// ─── Pre-action queue ───────────────────────────────────────────────────
// While it isn't yet our turn, a player can arm one of these so it fires the
// instant the action reaches them (PokerStars-style check/fold buttons).
type PreActionKind = "check-fold" | "check" | "call" | "call-any";
type ArmedPreAction = { kind: PreActionKind; atBet: number; handId: string | null };

const PRE_ACTIONS: { kind: PreActionKind; label: string; color: string }[] = [
  { kind: "check-fold", label: "Check/Fold", color: ACCENT },
  { kind: "check", label: "Check", color: CYAN },
  { kind: "call", label: "Call", color: CYAN },
  { kind: "call-any", label: "Call Any", color: LIME },
];

// A sticky pre-action toggle: outlined when idle, filled solid when armed.
function preBtn(color: string, armed: boolean): React.CSSProperties {
  return {
    background: armed ? color : "transparent",
    color: armed ? "#0a061a" : color,
    border: `2px solid ${color}`,
    borderRadius: 8,
    padding: "6px 12px",
    fontFamily: "var(--slop-font-display)",
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 700,
  };
}

const PreActionBar = ({ armed, onArm }: { armed: PreActionKind | null; onArm: (kind: PreActionKind) => void }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
    <span style={{ fontSize: 11, color: "var(--slop-text-dim, #9a86c4)", fontWeight: 700 }}>
      Pre-action — fires the instant it&apos;s your turn
    </span>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {PRE_ACTIONS.map(pa => (
        <button
          key={pa.kind}
          type="button"
          onClick={() => onArm(pa.kind)}
          style={preBtn(pa.color, armed === pa.kind)}
          aria-pressed={armed === pa.kind}
        >
          {pa.label}
        </button>
      ))}
    </div>
  </div>
);

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
}
/* Between-hands "shuffle" interstitial: a felt-coloured curtain that wipes over
   the whole table for a beat (clearing the last hand) then lifts to reveal the
   fresh deal. Mounted only while shuffling; the keyframe ends fully transparent
   so the unmount is invisible. Paired with sfxShuffle() → sfxDeal(). */
@keyframes pokerShuffleVeil {
  0%   { opacity: 0; }
  16%  { opacity: 1; }
  70%  { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes pokerShuffleRiffle {
  0%   { transform: translateX(-9px) rotate(-8deg); }
  50%  { transform: translateX(9px)  rotate(8deg); }
  100% { transform: translateX(-9px) rotate(-8deg); }
}`;
const PokerStyles = () => <style id="poker-fx-styles">{PULSE_CSS}</style>;

// How long the between-hands shuffle curtain stays up (must match the
// pokerShuffleVeil keyframe so the unmount lands on opacity 0). Long enough for
// the full ~2s riffle shuffle (sfxShuffle / shuffle.mp3) to play out before the
// curtain lifts and the cards are dealt (sfxDeal).
const SHUFFLE_MS = 2100;

// Seat coordinates around the table oval. p=0 is the bottom-centre (anchored to
// "me" when I'm seated) and p increases clockwise — i.e. action moves to my
// left, the real direction of play. Returned as CSS percentages so the table
// scales with the window. `hx/vy` are the ellipse radii in % of the container.
// Lay seats around the rail. The hero (display index 0) sits bottom-centre on
// its own; everyone else fans EVENLY across the top arc, with a wedge kept
// clear at the bottom so no one crowds the hero, the bottom corners, or the
// pot/board in the centre. hx/vy are the ellipse radii (% of the container).
// (+y points down, so θ=π/2 is bottom-centre and θ=−π/2 is top-centre.)
const seatPos = (p: number, n: number, hx: number, vy: number) => {
  const bottom = Math.PI / 2;
  let theta: number;
  if (p === 0 || n <= 1) {
    theta = bottom; // hero
  } else {
    const m = n - 1; // villains
    const gap = 0.7; // ~40° wedge held clear at the bottom
    if (m === 1) {
      theta = -Math.PI / 2; // lone villain → top-centre
    } else {
      const span = 2 * Math.PI - 2 * gap;
      theta = bottom + gap + ((p - 1) * span) / (m - 1);
    }
  }
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

  // ─── Pre-action queue ───────────────────────────────────────────────────
  // A player still in the hand but not on the clock can arm a next action; it
  // auto-fires the moment the action reaches them — provided it's still valid.
  const [preAction, setPreAction] = useState<ArmedPreAction | null>(null);
  const inHand = !!mySeat && poker.status === "running" && mySeat.status === "active";

  const armPreAction = useCallback(
    (kind: PreActionKind) =>
      setPreAction(prev => (prev?.kind === kind ? null : { kind, atBet: poker.currentBet, handId: poker.handId })),
    [poker.currentBet, poker.handId],
  );

  // Drop a queued pre-action whenever firing it would be unsafe: the hand
  // changed, we left the hand, or the bet we sized against moved (unless we
  // explicitly armed "Call Any", which honours any amount). Skipped on our own
  // turn — there the fire effect below consumes it instead of clearing it.
  useEffect(() => {
    if (!preAction || myTurn) return;
    const stillInHand = poker.status === "running" && mySeat?.status === "active";
    const handChanged = poker.handId !== preAction.handId;
    const betMoved = poker.currentBet !== preAction.atBet && preAction.kind !== "call-any";
    if (!stillInHand || handChanged || betMoved) setPreAction(null);
  }, [preAction, myTurn, poker.status, poker.handId, poker.currentBet, mySeat?.status]);

  // Fire the armed pre-action the instant it becomes our turn, down the same
  // path the manual buttons use. Validity is re-checked against live state: a
  // check only goes when nothing is owed, otherwise check/fold falls through to
  // a fold and a plain check simply clears (the player acts manually instead).
  useEffect(() => {
    if (!myTurn || !mySeat || !preAction) return;
    const { kind } = preAction;
    setPreAction(null);
    const toCall = Math.max(0, poker.currentBet - mySeat.committed);
    if (kind === "check-fold") mesh.pokerAct(toCall === 0 ? "check" : "fold");
    else if (kind === "check") {
      if (toCall === 0) mesh.pokerAct("check");
    } else if (kind === "call" || kind === "call-any") mesh.pokerAct(toCall === 0 ? "check" : "call");
  }, [myTurn, mySeat, preAction, poker.currentBet, mesh]);

  const [muted, setMuted] = useState(false);
  useEffect(() => setMuted(isPokerMuted()), []);

  // Between-hands "shuffle" interstitial: when a new hand begins we drop a
  // felt-coloured curtain over the whole table for a beat — clearing the last
  // hand from view, riffling (sfxShuffle), then lifting it as the deal lands
  // (sfxDeal). A deliberate mental break between hands so they don't blur.
  const [shuffling, setShuffling] = useState(false);
  const shuffleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (shuffleTimer.current) clearTimeout(shuffleTimer.current);
    },
    [],
  );

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
      if (poker.handId) {
        // New hand: riffle now, drop the curtain over the old hand, then lift it
        // ~SHUFFLE_MS later as the cards are dealt out.
        sfxShuffle();
        setShuffling(true);
        if (shuffleTimer.current) clearTimeout(shuffleTimer.current);
        shuffleTimer.current = setTimeout(() => {
          setShuffling(false);
          sfxDeal(); // cards dealt out as the curtain lifts
        }, SHUFFLE_MS);
      }
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
  // More seats need a taller oval so the top arc has vertical room and the
  // boxes (now carrying a think-time line) don't pile onto the felt.
  const tableH = n <= 2 ? 320 : n <= 4 ? 360 : n <= 6 ? 420 : 500;
  // Plate width scales down as the table fills: roomy big plates at a small
  // table, tighter ones at 7–8 seats so the top arc still fits the felt.
  const seatW = n <= 4 ? 172 : n <= 6 ? 164 : 150;
  // Each seat's most recent action time this hand (the feed is chronological,
  // so the last write per seat wins). Powers the per-seat "took Xs" readout.
  const actions = poker.actions ?? [];
  const lastThinkBySeat = new Map<number, number>();
  for (const a of actions) lastThinkBySeat.set(a.seat, a.thinkMs);

  // Each seat's sponsor (its escrow account's `backer`), keyed by seat id, so
  // an AI plate can show who's playing its money. Human seats have no backer.
  const backerByKey = new Map<string, string | undefined>();
  for (const a of mesh.escrow?.accounts ?? []) backerByKey.set(a.key, a.backer);

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
            // Inset a touch more than the seat ring (radii 38/41) so the rail
            // seats sit just OUTSIDE the felt instead of overlapping it.
            top: "16%",
            bottom: "16%",
            left: "13%",
            right: "13%",
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
          const seatXY = seatPos(p, n, 42, 42);
          const betXY = seatPos(p, n, 18, 20);
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
                  actorSince={poker.actorSince}
                  lastThinkMs={lastThinkBySeat.get(seat.idx) ?? null}
                  backer={backerByKey.get(seat.key) ?? null}
                  customNames={mesh.customNames}
                  boxWidth={seatW}
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

        {/* The shuffle curtain — wipes the whole table (board, seats, chips) for
            a beat between hands, then lifts as the new deal lands. */}
        {shuffling && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 5,
              pointerEvents: "none",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              borderRadius: 16,
              background: "radial-gradient(ellipse at 50% 45%, rgba(17,64,44,0.97), rgba(8,20,16,0.99))",
              animation: `pokerShuffleVeil ${SHUFFLE_MS}ms ease-in-out forwards`,
            }}
          >
            <div style={{ display: "flex", gap: 10 }}>
              {[0, 1].map(i => (
                <div
                  key={i}
                  style={{
                    width: 30,
                    height: 42,
                    borderRadius: 5,
                    border: `1.5px solid ${CYAN}`,
                    background: "repeating-linear-gradient(45deg, rgba(255,62,201,0.28) 0 5px, #1a0f33 5px 10px)",
                    boxShadow: "0 0 14px rgba(255,62,201,0.6)",
                    animation: `pokerShuffleRiffle 0.26s ease-in-out ${i * 0.13}s infinite`,
                  }}
                />
              ))}
            </div>
            <span style={{ fontFamily: "var(--slop-font-display)", fontSize: 14, letterSpacing: 1, color: LIME }}>
              Shuffling…
            </span>
          </div>
        )}
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
      {!myTurn && inHand && !poker.runningOut && <PreActionBar armed={preAction?.kind ?? null} onArm={armPreAction} />}
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
  const ethUsd = useEthPrice();
  const [now, setNow] = useState(() => Date.now());
  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!pageVisible) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [pageVisible]);
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
        <span style={{ fontSize: 13, color: CYAN }}>
          {fmtEth(pool)} ETH{usdSuffixFromWei(pool, ethUsd)} pool
        </span>
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

  // Warm the foley sample cache as soon as the poker window opens, so the first
  // bet/flip/deal isn't silent. Decoding doesn't need a user gesture (only
  // playback does, which slop-computer already unlocks), so this can run on mount.
  useEffect(() => {
    warmPokerAudio();
  }, []);

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

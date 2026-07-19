"use client";

// Money chess UI, built on the generic escrow session (mesh.escrow). The
// relay (packages/relay/src/escrow.ts) owns the state machine; this
// surface renders the session and posts intent. Three escrow movements:
//
//   1. Buy-in   — each player sends a PLAIN ETH transfer from their own
//                 wallet to the multisig (useSendTransaction). Once it's
//                 mined we tell the relay the hash; the relay reads it
//                 back on-chain before counting the side as funded.
//   2. Play     — once all buy-ins land, any player starts the game.
//   3. Payout   — when chess ends, the relay sets a canonical `payouts`
//                 plan; the claim button proposes a multisig tx matching
//                 it (single send for a winner, batch for a refund). The
//                 relay auto-adopts the proposal and watches it execute,
//                 then flips the session to `settled`.
//
// This component is chess-specific (white/black framing) but reads the
// generic escrow shape — pong/poker get their own panels over the same
// session. White/black come from account.role; the winner from meta.
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Address as AddressType, type Hex, formatEther, parseEther } from "viem";
import { base } from "viem/chains";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from "wagmi";
import { LoadingBar } from "~~/components/ui";
import { MultisigAbi } from "~~/contracts/multisig";
import { useEthPrice } from "~~/hooks/useEthPrice";
import type { EscrowAccount, EscrowSession, PeerMeshState } from "~~/hooks/usePeerMesh";
import { usePersonalWalletSend } from "~~/hooks/usePersonalWalletSend";
import { computeExecHash, defaultDeadline } from "~~/utils/multisig";
import { usdSuffixFromEth, usdSuffixFromWei } from "~~/utils/usd";

const ACCENT = "var(--slop-magenta, #ff3ec9)";
const CYAN = "var(--slop-cyan, #2ee6d6)";
const LIME = "var(--slop-lime, #b6ff3c)";
const PANEL_BG = "#0a061a";

const CHAIN_LABELS: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  10: "Optimism",
  42161: "Arbitrum",
  137: "Polygon",
  100: "Gnosis",
  4663: "Robinhood",
};
const chainLabel = (id: number) => CHAIN_LABELS[id] ?? `chain ${id}`;

const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io/tx/",
  8453: "https://basescan.org/tx/",
  10: "https://optimistic.etherscan.io/tx/",
  42161: "https://arbiscan.io/tx/",
  137: "https://polygonscan.com/tx/",
  100: "https://gnosisscan.io/tx/",
  4663: "https://robinhoodchain.blockscout.com/tx/",
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function fmtEth(wei: string): string {
  try {
    const s = formatEther(BigInt(wei));
    return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  } catch {
    return "0";
  }
}

// ─── escrow helpers ─────────────────────────────────────────────────

const seat = (e: EscrowSession, role: "white" | "black") => e.accounts.find(a => a.role === role) ?? null;
const buyinWei = (e: EscrowSession) => seat(e, "white")?.requiredWei ?? "0";
const potWei = (e: EscrowSession) => e.accounts.reduce((s, a) => s + BigInt(a.depositedWei), 0n).toString();
const isFunded = (a: EscrowAccount) => BigInt(a.depositedWei) >= BigInt(a.requiredWei);

// Pick the chain the escrow can settle on: one the multisig is deployed
// on, preferring Base.
function escrowChainId(mesh: PeerMeshState): number | null {
  const w = mesh.wallet;
  if (!w) return null;
  const chains = Object.keys(w.deployments).map(Number);
  if (chains.length === 0) return null;
  if (chains.includes(8453)) return 8453;
  return chains[0]!;
}

const btn = (bg: string, disabled?: boolean): React.CSSProperties => ({
  padding: "8px 14px",
  borderRadius: 6,
  border: "none",
  background: disabled ? "rgba(255,255,255,0.08)" : bg,
  color: disabled ? "var(--slop-text-muted)" : "#0a0612",
  fontFamily: "var(--slop-font-display)",
  fontWeight: 700,
  letterSpacing: "0.04em",
  cursor: disabled ? "not-allowed" : "pointer",
  fontSize: 13,
});

const card: React.CSSProperties = {
  background: PANEL_BG,
  border: `1px solid rgba(255,62,201,0.35)`,
  borderRadius: 8,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const label: React.CSSProperties = {
  fontFamily: "var(--slop-font-display)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  fontSize: 11,
  color: "var(--slop-text-muted)",
};

// =====================================================================
// Propose card — shown in the chess lobby when no session is live.
// =====================================================================

const isAddr = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v);

// Decorative pawn — an image sprite, not the ♟ glyph, which tofus on Linux.
const PawnBadge = ({ size }: { size: number }) => (
  <img
    src="/chess/bp.png"
    alt=""
    draggable={false}
    style={{ width: size, height: size, objectFit: "contain", verticalAlign: "-2px" }}
  />
);

export const WagerProposeCard = ({
  mesh,
  whiteKey,
  whiteLabel,
  blackKey,
  blackLabel,
}: {
  mesh: PeerMeshState;
  // The two players already chosen in the lobby form above. The wager is
  // played between them — this card only adds the stakes.
  whiteKey: string;
  whiteLabel: string;
  blackKey: string;
  blackLabel: string;
}) => {
  const ethUsd = useEthPrice();
  const [buyin, setBuyin] = useState<string>("0.001");
  const [err, setErr] = useState<string | null>(null);

  const chainId = useMemo(() => escrowChainId(mesh), [mesh.wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mesh.wallet || chainId == null) {
    return (
      <div style={{ ...card, borderColor: "rgba(255,255,255,0.12)" }}>
        <div style={label}>
          <PawnBadge size={13} /> Play for ETH
        </div>
        <div style={{ fontSize: 13, color: "var(--slop-text-muted)" }}>
          Deploy the Bank using the Bank app first — it&apos;s the escrow that holds the pot.
        </div>
      </div>
    );
  }

  // Both seats must be wallet addresses to fund + sign. AI/anon players
  // (whose ownerKey isn't an address) can't play for money.
  const bothAddrs = isAddr(whiteKey) && isAddr(blackKey);
  const distinct = whiteKey.toLowerCase() !== blackKey.toLowerCase();

  const onChallenge = () => {
    setErr(null);
    if (!bothAddrs) return setErr("Both players must be wallet-connected to play for ETH.");
    if (!distinct) return setErr("Pick two different players above.");
    let wei: bigint;
    try {
      wei = parseEther(buyin || "0");
    } catch {
      return setErr("Bad buy-in amount.");
    }
    if (wei <= 0n) return setErr("Buy-in must be greater than 0.");
    mesh.chessWagerPropose({ whiteKey, whiteLabel, blackKey, blackLabel, buyinWei: wei.toString(), chainId });
  };

  let pot = "?";
  try {
    pot = fmtEth((parseEther(buyin || "0") * 2n).toString());
  } catch {
    /* keep ? */
  }

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={label}>
          <PawnBadge size={13} /> Play for ETH
        </div>
        <div style={{ fontSize: 11, color: CYAN }}>
          {chainLabel(chainId)} · escrow {short(mesh.wallet.address)}
        </div>
      </div>
      {!bothAddrs ? (
        <div style={{ fontSize: 13, color: "var(--slop-text-muted)" }}>
          Both players must be wallet-connected to play for ETH (AI / anonymous players can&apos;t fund).
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13 }}>
            <span style={{ color: CYAN }}>{whiteLabel}</span> vs <span style={{ color: ACCENT }}>{blackLabel}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 140 }}>
            <span style={{ ...label, fontSize: 10 }}>Buy-in each (ETH)</span>
            <input
              value={buyin}
              onChange={e => setBuyin(e.target.value)}
              inputMode="decimal"
              style={{
                background: "#06030d",
                color: "var(--slop-text)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 6,
                padding: "8px 10px",
                fontFamily: "var(--slop-font-mono, monospace)",
              }}
            />
          </div>
          <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
            Each side sends the buy-in to escrow. Winner takes the{" "}
            <span style={{ color: LIME }}>
              {pot} ETH{usdSuffixFromEth(Number(buyin || "0") * 2, ethUsd)}
            </span>{" "}
            pot. A draw refunds both.
          </div>
          {err && <div style={{ color: ACCENT, fontSize: 12 }}>{err}</div>}
          <button type="button" onClick={onChallenge} style={btn(ACCENT)}>
            Play for {pot} ETH{usdSuffixFromEth(Number(buyin || "0") * 2, ethUsd)}
          </button>
        </>
      )}
    </div>
  );
};

// =====================================================================
// Stage — funding (open) / ready (locked) / settling / settled.
// =====================================================================

export const WagerStage = ({ mesh, escrow }: { mesh: PeerMeshState; escrow: EscrowSession }) => {
  const ethUsd = useEthPrice();
  const { address } = useAccount();
  const white = seat(escrow, "white");
  const black = seat(escrow, "black");
  const isParticipant = useMemo(() => {
    const a = address?.toLowerCase();
    return !!a && escrow.accounts.some(acc => acc.key === a);
  }, [address, escrow.accounts]);

  if (!white || !black) return null;
  const pot = fmtEth(potWei(escrow));

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 18, color: ACCENT }}>
          <PawnBadge size={17} /> Money Chess
        </div>
        <div style={{ fontSize: 12, color: CYAN }}>
          {fmtEth(buyinWei(escrow))} ETH{usdSuffixFromWei(buyinWei(escrow), ethUsd)} buy-in · {pot} ETH
          {usdSuffixFromWei(potWei(escrow), ethUsd)} pot · {chainLabel(escrow.chainId)}
        </div>
      </div>

      <PlayerRow escrow={escrow} account={white} />
      <PlayerRow escrow={escrow} account={black} />

      {(escrow.status === "open" || escrow.status === "locked") && (
        <FundingControls mesh={mesh} escrow={escrow} isParticipant={isParticipant} />
      )}
      {escrow.status === "settling" && <SettleControls mesh={mesh} escrow={escrow} isParticipant={isParticipant} />}
      {escrow.status === "settled" && <SettledView mesh={mesh} escrow={escrow} />}
    </div>
  );
};

const PlayerRow = ({ escrow, account }: { escrow: EscrowSession; account: EscrowAccount }) => {
  const ethUsd = useEthPrice();
  const isWhite = account.role === "white";
  const won = (escrow.meta.winner as string | undefined) === account.role;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: PANEL_BG,
        border: `1px solid ${won ? LIME : "rgba(255,255,255,0.12)"}`,
        borderRadius: 8,
        padding: "10px 14px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <img
          src={isWhite ? "/chess/wk.png" : "/chess/bk.png"}
          alt={isWhite ? "white king" : "black king"}
          draggable={false}
          style={{ width: 18, height: 18, objectFit: "contain", verticalAlign: "middle" }}
        />
        <span style={{ fontFamily: "var(--slop-font-display)", fontSize: 14 }}>{account.label}</span>
        {won && <span style={{ color: LIME, fontSize: 12, fontWeight: 700 }}>WINNER</span>}
      </div>
      <div style={{ fontSize: 12, color: isFunded(account) ? LIME : "var(--slop-text-muted)" }}>
        {isFunded(account)
          ? `✓ funded ${fmtEth(account.depositedWei)} ETH${usdSuffixFromWei(account.depositedWei, ethUsd)}`
          : "waiting for buy-in…"}
      </div>
    </div>
  );
};

// ─── Funding (open) / ready (locked) ────────────────────────────────

const FundingControls = ({
  mesh,
  escrow,
  isParticipant,
}: {
  mesh: PeerMeshState;
  escrow: EscrowSession;
  isParticipant: boolean;
}) => {
  const { address } = useAccount();
  const myAccount = useMemo(() => {
    const a = address?.toLowerCase();
    return a ? (escrow.accounts.find(acc => acc.key === a) ?? null) : null;
  }, [address, escrow.accounts]);
  const ready = escrow.status === "locked";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {myAccount && !isFunded(myAccount) && <FundButton mesh={mesh} escrow={escrow} account={myAccount} />}
      {myAccount && isFunded(myAccount) && <div style={{ fontSize: 13, color: LIME }}>✓ Your buy-in is in escrow.</div>}
      {!isParticipant && (
        <div style={{ fontSize: 13, color: "var(--slop-text-muted)" }}>
          You&apos;re spectating this wager — only the two players fund it.
        </div>
      )}
      {ready && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 13, color: LIME }}>All buy-ins escrowed — ready to play.</div>
          {isParticipant && (
            <button type="button" onClick={() => mesh.chessWagerStart()} style={btn(LIME)}>
              ▶ Start game
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => mesh.escrowCancel()}
        style={{
          ...btn("transparent"),
          color: "var(--slop-text-muted)",
          border: "1px solid rgba(255,255,255,0.15)",
          alignSelf: "flex-start",
        }}
      >
        Cancel wager
      </button>
    </div>
  );
};

// The buy-in: a plain ETH transfer FROM the player's wallet TO the
// multisig. After it's mined we report the hash; the relay verifies it
// before counting the account as funded.
// Exported + game-agnostic: reads the generic escrow + account shape, so
// poker (and any future money game) reuses the exact buy-in flow.
export const FundButton = ({
  mesh,
  escrow,
  account,
}: {
  mesh: PeerMeshState;
  escrow: EscrowSession;
  account: EscrowAccount;
}) => {
  const ethUsd = useEthPrice();
  const currentChainId = useChainId();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { sendTransactionAsync, isPending: sending } = useSendTransaction();
  const { send: personalSend, phase: personalPhase, isPasskey } = usePersonalWalletSend();
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [reported, setReported] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { isLoading: waiting, data: receipt } = useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    chainId: escrow.chainId,
  });

  // Once the deposit is mined, hand the hash to the relay to verify.
  useEffect(() => {
    if (receipt && txHash && !reported) {
      setReported(true);
      mesh.escrowFund(txHash);
    }
  }, [receipt, txHash, reported, mesh]);

  const fundResult = mesh.escrowFundResult;
  const relayRejected =
    reported && fundResult && !fundResult.ok && fundResult.txHash === txHash ? fundResult.reason : null;

  const owed = (BigInt(account.requiredWei) - BigInt(account.depositedWei)).toString();

  const onFund = useCallback(async () => {
    setErr(null);
    try {
      let hash: `0x${string}`;
      if (isPasskey) {
        // Passkey wallet: no EOA to send from. Spend from the personal multisig
        // via the relay facilitator (Base-only). See usePersonalWalletSend.
        if (escrow.chainId !== base.id) {
          setErr("Passkey wallets can buy in on Base only.");
          return;
        }
        hash = await personalSend({ to: escrow.multisig as AddressType, valueWei: BigInt(owed) });
      } else {
        if (currentChainId !== escrow.chainId) {
          await switchChainAsync({ chainId: escrow.chainId });
        }
        hash = await sendTransactionAsync({
          to: escrow.multisig as AddressType,
          value: BigInt(owed),
          chainId: escrow.chainId,
        });
      }
      setReported(false);
      setTxHash(hash);
    } catch (e) {
      setErr(String(e).slice(0, 160));
    }
  }, [
    isPasskey,
    personalSend,
    currentChainId,
    escrow.chainId,
    escrow.multisig,
    owed,
    switchChainAsync,
    sendTransactionAsync,
  ]);

  const busy = switching || sending || !!personalPhase || (!!txHash && (waiting || (reported && !relayRejected)));
  const statusText = personalPhase
    ? personalPhase === "deploying"
      ? "Deploying your wallet…"
      : personalPhase === "signing"
        ? "Approve with your passkey…"
        : "Submitting buy-in…"
    : switching
      ? "Switching chain…"
      : sending
        ? "Confirm in your wallet…"
        : waiting
          ? "Waiting for confirmation…"
          : reported && !relayRejected
            ? "Verifying deposit…"
            : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button type="button" onClick={onFund} disabled={busy} style={btn(CYAN, busy)}>
        {busy ? "Sending buy-in…" : `Send ${fmtEth(owed)} ETH${usdSuffixFromWei(owed, ethUsd)} buy-in`}
      </button>
      {busy && <LoadingBar />}
      {statusText && <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>{statusText}</div>}
      {relayRejected && (
        <div style={{ fontSize: 12, color: ACCENT }}>
          {relayRejected === "not_mined"
            ? "Not confirmed yet — give it a moment, then retry."
            : `Deposit rejected: ${relayRejected}`}
          {relayRejected === "not_mined" && txHash && (
            <button
              type="button"
              onClick={() => {
                setReported(false);
                mesh.escrowFund(txHash);
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

// ─── Settling ───────────────────────────────────────────────────────

const SettleControls = ({
  mesh,
  escrow,
  isParticipant,
}: {
  mesh: PeerMeshState;
  escrow: EscrowSession;
  isParticipant: boolean;
}) => {
  const ethUsd = useEthPrice();
  const { address } = useAccount();
  const winner = escrow.meta.winner as string | undefined;
  const isRefund = !winner || winner === "draw";
  const iWon = !isRefund && seat(escrow, winner as "white" | "black")?.key === address?.toLowerCase();
  const winnerLabel = winner && winner !== "draw" ? (seat(escrow, winner as "white" | "black")?.label ?? winner) : null;

  const payoutTx = useMemo(
    () => (escrow.payoutTxId ? (mesh.walletTxs.find(t => t.id === escrow.payoutTxId) ?? null) : null),
    [escrow.payoutTxId, mesh.walletTxs],
  );
  const threshold = mesh.wallet?.threshold ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          fontFamily: "var(--slop-font-display)",
          fontSize: 16,
          color: isRefund ? CYAN : iWon ? LIME : "var(--slop-text)",
        }}
      >
        {winner === "draw"
          ? "🤝 Draw — buy-ins to be refunded"
          : isRefund
            ? "↩️ Wager cancelled — buy-ins to be refunded"
            : iWon
              ? `🏆 You won the ${fmtEth(potWei(escrow))} ETH${usdSuffixFromWei(potWei(escrow), ethUsd)} pot!`
              : `🏆 ${winnerLabel} won the ${fmtEth(potWei(escrow))} ETH${usdSuffixFromWei(potWei(escrow), ethUsd)} pot`}
      </div>

      {!payoutTx ? (
        <PayoutProposeButton mesh={mesh} escrow={escrow} isRefund={isRefund} canPropose={isParticipant} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 13, color: CYAN }}>
            {isRefund ? "Refund" : "Payout"} proposed — sign &amp; execute it in the <b>Wallet</b> app (Transactions
            tab).
          </div>
          <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
            {payoutTx.status === "executing"
              ? "Executing on-chain…"
              : `Signatures ${payoutTx.signatures.length}/${threshold || "?"} · status: ${payoutTx.status}`}
          </div>
          {payoutTx.status === "executing" && <LoadingBar />}
        </div>
      )}
    </div>
  );
};

// Propose the settlement tx straight from the relay's canonical
// `payouts` plan — single send (winner) or batch (refund). The relay
// auto-adopts a matching proposal and watches it execute.
// Exported + game-agnostic: proposes the multisig tx matching the relay's
// canonical `escrow.payouts` plan (single send or batch). Poker's cash-out
// is a batch of one leg per remaining stack — the same path handles it.
export const PayoutProposeButton = ({
  mesh,
  escrow,
  isRefund,
  canPropose,
  claimText,
  onProposed,
}: {
  mesh: PeerMeshState;
  escrow: EscrowSession;
  isRefund: boolean;
  canPropose: boolean;
  /** Override the non-refund button label (poker: "Pay out winners"). */
  claimText?: string;
  /** Fired after a successful propose (poker uses it to pop the Wallet app
   *  so the multisig tx is right there to sign + execute). */
  onProposed?: () => void;
}) => {
  const ethUsd = useEthPrice();
  const publicClient = usePublicClient({ chainId: escrow.chainId });
  const [state, setState] = useState<"idle" | "proposing" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);

  const onPropose = useCallback(async () => {
    setErr(null);
    const wallet = mesh.wallet;
    const payouts = escrow.payouts;
    if (!wallet) return setErr("No escrow multisig.");
    if (!payouts || payouts.length === 0) return setErr("No payout plan yet.");
    if (!publicClient) return setErr(`No RPC client for ${chainLabel(escrow.chainId)}.`);
    if (!(escrow.chainId in wallet.deployments)) {
      return setErr(`Multisig isn't deployed on ${chainLabel(escrow.chainId)}.`);
    }
    setState("proposing");
    try {
      const nonce = (await publicClient.readContract({
        address: wallet.address as AddressType,
        abi: MultisigAbi,
        functionName: "nonce",
      })) as bigint;
      const deadline = defaultDeadline();
      if (payouts.length > 1) {
        const calls = payouts.map(p => ({ target: p.to, value: p.amountWei, data: "0x" }));
        const execHash = (await publicClient.readContract({
          address: wallet.address as AddressType,
          abi: MultisigAbi,
          functionName: "getBatchExecHash",
          args: [
            calls.map(c => ({ target: c.target as AddressType, value: BigInt(c.value), data: c.data as Hex })),
            deadline,
          ],
        })) as Hex;
        mesh.walletProposeTx({
          chainId: escrow.chainId,
          target: wallet.address,
          value: "0",
          data: "0x",
          deadline: deadline.toString(),
          nonce: nonce.toString(),
          execHash,
          source: "manual",
          browserId: null,
          calls,
        });
      } else {
        const p = payouts[0]!;
        const value = BigInt(p.amountWei);
        const execHash = computeExecHash({
          chainId: escrow.chainId,
          multisig: wallet.address as AddressType,
          nonce,
          deadline,
          target: p.to as AddressType,
          value,
          data: "0x",
        });
        mesh.walletProposeTx({
          chainId: escrow.chainId,
          target: p.to,
          value: value.toString(),
          data: "0x",
          deadline: deadline.toString(),
          nonce: nonce.toString(),
          execHash,
          source: "manual",
          browserId: null,
        });
      }
      setState("done");
      onProposed?.();
    } catch (e) {
      setState("idle");
      setErr(String(e).slice(0, 160));
    }
  }, [mesh, publicClient, escrow, onProposed]);

  if (!canPropose) {
    return (
      <div style={{ fontSize: 13, color: "var(--slop-text-muted)" }}>
        {isRefund ? "A player will propose the refund." : "The winner will claim the pot."}
      </div>
    );
  }

  const total = (escrow.payouts ?? []).reduce((s, p) => s + BigInt(p.amountWei), 0n).toString();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button type="button" onClick={onPropose} disabled={state !== "idle"} style={btn(LIME, state !== "idle")}>
        {state === "proposing"
          ? "Proposing…"
          : isRefund
            ? "Propose refund"
            : (claimText ?? `Claim ${fmtEth(total)} ETH${usdSuffixFromWei(total, ethUsd)} pot`)}
      </button>
      {state === "proposing" && <LoadingBar />}
      {err && <div style={{ fontSize: 12, color: ACCENT }}>{err}</div>}
    </div>
  );
};

// ─── Settled ────────────────────────────────────────────────────────

const SettledView = ({ mesh, escrow }: { mesh: PeerMeshState; escrow: EscrowSession }) => {
  const ethUsd = useEthPrice();
  const winner = escrow.meta.winner as string | undefined;
  const isRefund = !winner || winner === "draw";
  const winnerLabel = winner && winner !== "draw" ? (seat(escrow, winner as "white" | "black")?.label ?? winner) : null;
  const explorer = EXPLORERS[escrow.chainId];
  const total = (escrow.payouts ?? []).reduce((s, p) => s + BigInt(p.amountWei), 0n).toString();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 16, color: LIME }}>
        {isRefund
          ? `↩️ Refunded — ${fmtEth(buyinWei(escrow))} ETH${usdSuffixFromWei(buyinWei(escrow), ethUsd)} returned`
          : `🏆 Paid out — ${fmtEth(total)} ETH${usdSuffixFromWei(total, ethUsd)} to ${winnerLabel}`}
      </div>
      {escrow.payoutTxHash && explorer && (
        <a
          href={`${explorer}${escrow.payoutTxHash}`}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: CYAN }}
        >
          View settlement tx ↗
        </a>
      )}
      <button type="button" onClick={() => mesh.escrowClear()} style={btn(ACCENT)}>
        New game
      </button>
    </div>
  );
};

// =====================================================================
// Banner — thin pot strip shown above the board while playing.
// =====================================================================

export const WagerBanner = ({ escrow }: { escrow: EscrowSession }) => {
  const ethUsd = useEthPrice();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "5px 12px",
        background: "linear-gradient(90deg, rgba(255,62,201,0.18), rgba(46,230,214,0.18))",
        borderBottom: "1px solid rgba(255,62,201,0.3)",
        fontFamily: "var(--slop-font-display)",
        fontSize: 12,
        letterSpacing: "0.04em",
        color: LIME,
      }}
    >
      💰 Playing for {fmtEth(potWei(escrow))} ETH{usdSuffixFromWei(potWei(escrow), ethUsd)} · winner takes the pot
    </div>
  );
};

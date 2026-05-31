"use client";

// Money chess UI. The relay (packages/relay/src/wager.ts) owns the
// wager state machine; this surface only renders `mesh.wager` and posts
// intent (propose / fund / start / claim) back. Three escrow movements:
//
//   1. Buy-in   — each player sends a PLAIN ETH transfer from their own
//                 wallet to the multisig (useSendTransaction). Once it's
//                 mined we tell the relay the hash; the relay reads it
//                 back on-chain before counting the side as funded.
//   2. Play     — once both buy-ins land, any player starts the game.
//   3. Payout   — when chess ends, the pot is released FROM the multisig
//                 via the normal multisig tx flow (winner gets the pot;
//                 a draw refunds each buy-in via a batch). The relay
//                 auto-recognizes the proposal as the payout and watches
//                 it execute, then flips the wager to `settled`.
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Address as AddressType, type Hex, formatEther, parseEther } from "viem";
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
import type { Peer, PeerMeshState, Wager, WagerSide } from "~~/hooks/usePeerMesh";
import { computeExecHash, defaultDeadline } from "~~/utils/multisig";

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
};
const chainLabel = (id: number) => CHAIN_LABELS[id] ?? `chain ${id}`;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function fmtEth(wei: string): string {
  try {
    const s = formatEther(BigInt(wei));
    // Trim trailing zeros but keep it readable.
    return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  } catch {
    return "0";
  }
}

const potWei = (w: Wager) => (BigInt(w.buyinWei) * 2n).toString();

// Pick the chain the escrow can actually settle on: a chain the multisig
// is deployed on, preferring Base.
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
// Propose card — shown in the chess lobby when no wager is live.
// =====================================================================

export const WagerProposeCard = ({ mesh }: { mesh: PeerMeshState }) => {
  const { address } = useAccount();
  const [opponent, setOpponent] = useState<string>("");
  const [buyin, setBuyin] = useState<string>("0.001");
  const [err, setErr] = useState<string | null>(null);

  const chainId = useMemo(() => escrowChainId(mesh), [mesh.wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opponents = connected peers with a real address, excluding me + spectators.
  const opponents = useMemo(() => {
    const me = address?.toLowerCase();
    const seen = new Set<string>();
    const out: { addr: string; label: string }[] = [];
    for (const p of mesh.peers as Peer[]) {
      if (!p.address || p.spectator) continue;
      const a = p.address.toLowerCase();
      if (a === me || seen.has(a)) continue;
      seen.add(a);
      out.push({ addr: a, label: mesh.customNames[a] ?? p.handle ?? short(a) });
    }
    return out;
  }, [mesh.peers, mesh.customNames, address]);

  if (!mesh.wallet || chainId == null) {
    return (
      <div style={{ ...card, borderColor: "rgba(255,255,255,0.12)" }}>
        <div style={label}>♟ Play for ETH</div>
        <div style={{ fontSize: 13, color: "var(--slop-text-muted)" }}>
          Deploy the room multisig (Wallet app) first — it&apos;s the escrow that holds the pot.
        </div>
      </div>
    );
  }

  const onChallenge = () => {
    setErr(null);
    if (!address) return setErr("Connect a wallet to play for ETH.");
    if (!opponent) return setErr("Pick an opponent.");
    let wei: bigint;
    try {
      wei = parseEther(buyin || "0");
    } catch {
      return setErr("Bad buy-in amount.");
    }
    if (wei <= 0n) return setErr("Buy-in must be greater than 0.");
    const opp = opponents.find(o => o.addr === opponent);
    mesh.wagerPropose({
      opponentKey: opponent,
      opponentLabel: opp?.label ?? short(opponent),
      buyinWei: wei.toString(),
      chainId,
    });
  };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={label}>♟ Play for ETH</div>
        <div style={{ fontSize: 11, color: CYAN }}>
          {chainLabel(chainId)} · escrow {short(mesh.wallet.address)}
        </div>
      </div>
      {opponents.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--slop-text-muted)" }}>
          No other wallet-connected players in the room yet.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 160 }}>
              <span style={{ ...label, fontSize: 10 }}>Opponent (plays black)</span>
              <select
                value={opponent}
                onChange={e => setOpponent(e.target.value)}
                style={{
                  background: "#06030d",
                  color: "var(--slop-text)",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 6,
                  padding: "8px 10px",
                  fontFamily: "var(--slop-font-body)",
                }}
              >
                <option value="">— select —</option>
                {opponents.map(o => (
                  <option key={o.addr} value={o.addr}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 120 }}>
              <span style={{ ...label, fontSize: 10 }}>Buy-in (ETH)</span>
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
          </div>
          <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
            Each side sends the buy-in to escrow. Winner takes the{" "}
            <span style={{ color: LIME }}>
              {(() => {
                try {
                  return fmtEth((parseEther(buyin || "0") * 2n).toString());
                } catch {
                  return "?";
                }
              })()}{" "}
              ETH
            </span>{" "}
            pot. A draw refunds both.
          </div>
          {err && <div style={{ color: ACCENT, fontSize: 12 }}>{err}</div>}
          <button type="button" onClick={onChallenge} style={btn(ACCENT)}>
            Challenge for ETH
          </button>
        </>
      )}
    </div>
  );
};

// =====================================================================
// Stage — funding / armed / settling / refunding / settled.
// =====================================================================

export const WagerStage = ({ mesh, wager }: { mesh: PeerMeshState; wager: Wager }) => {
  const { address } = useAccount();
  const mySide: WagerSide | null = useMemo(() => {
    const a = address?.toLowerCase();
    if (!a) return null;
    if (a === wager.whiteKey) return "white";
    if (a === wager.blackKey) return "black";
    return null;
  }, [address, wager.whiteKey, wager.blackKey]);

  const pot = fmtEth(potWei(wager));

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 18, color: ACCENT }}>♟ Money Chess</div>
        <div style={{ fontSize: 12, color: CYAN }}>
          {fmtEth(wager.buyinWei)} ETH buy-in · {pot} ETH pot · {chainLabel(wager.chainId)}
        </div>
      </div>

      <PlayerRow wager={wager} side="white" />
      <PlayerRow wager={wager} side="black" />

      {(wager.status === "funding" || wager.status === "armed") && (
        <FundingControls mesh={mesh} wager={wager} mySide={mySide} />
      )}
      {(wager.status === "settling" || wager.status === "refunding") && (
        <SettleControls mesh={mesh} wager={wager} mySide={mySide} />
      )}
      {wager.status === "settled" && <SettledView mesh={mesh} wager={wager} />}
    </div>
  );
};

const PlayerRow = ({ wager, side }: { wager: Wager; side: WagerSide }) => {
  const isWhite = side === "white";
  const label2 = isWhite ? wager.whiteLabel : wager.blackLabel;
  const deposit = isWhite ? wager.whiteDeposit : wager.blackDeposit;
  const won = wager.winner === side;
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
        <span style={{ fontSize: 18 }}>{isWhite ? "♔" : "♚"}</span>
        <span style={{ fontFamily: "var(--slop-font-display)", fontSize: 14 }}>{label2}</span>
        {won && <span style={{ color: LIME, fontSize: 12, fontWeight: 700 }}>WINNER</span>}
      </div>
      <div style={{ fontSize: 12, color: deposit ? LIME : "var(--slop-text-muted)" }}>
        {deposit ? `✓ funded ${fmtEth(deposit.amountWei)} ETH` : "waiting for buy-in…"}
      </div>
    </div>
  );
};

// ─── Funding / armed ────────────────────────────────────────────────

const FundingControls = ({ mesh, wager, mySide }: { mesh: PeerMeshState; wager: Wager; mySide: WagerSide | null }) => {
  const myFunded = mySide === "white" ? !!wager.whiteDeposit : mySide === "black" ? !!wager.blackDeposit : false;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {mySide && !myFunded && <FundButton mesh={mesh} wager={wager} />}
      {mySide && myFunded && <div style={{ fontSize: 13, color: LIME }}>✓ Your buy-in is in escrow.</div>}
      {!mySide && (
        <div style={{ fontSize: 13, color: "var(--slop-text-muted)" }}>
          You&apos;re spectating this wager — only the two players fund it.
        </div>
      )}
      {wager.status === "armed" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 13, color: LIME }}>Both buy-ins escrowed — ready to play.</div>
          {mySide && (
            <button type="button" onClick={() => mesh.wagerStart()} style={btn(LIME)}>
              ▶ Start game
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => mesh.wagerCancel()}
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
// before counting the side as funded.
const FundButton = ({ mesh, wager }: { mesh: PeerMeshState; wager: Wager }) => {
  const currentChainId = useChainId();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { sendTransactionAsync, isPending: sending } = useSendTransaction();
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [reported, setReported] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { isLoading: waiting, data: receipt } = useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    chainId: wager.chainId,
  });

  // Once the deposit is mined, hand the hash to the relay to verify.
  useEffect(() => {
    if (receipt && txHash && !reported) {
      setReported(true);
      mesh.wagerFund(txHash);
    }
  }, [receipt, txHash, reported, mesh]);

  const fundResult = mesh.wagerFundResult;
  const relayRejected =
    reported && fundResult && !fundResult.ok && fundResult.txHash === txHash ? fundResult.reason : null;

  const onFund = useCallback(async () => {
    setErr(null);
    try {
      if (currentChainId !== wager.chainId) {
        await switchChainAsync({ chainId: wager.chainId });
      }
      const hash = await sendTransactionAsync({
        to: wager.multisig as AddressType,
        value: BigInt(wager.buyinWei),
        chainId: wager.chainId,
      });
      setReported(false);
      setTxHash(hash);
    } catch (e) {
      setErr(String(e).slice(0, 160));
    }
  }, [currentChainId, wager.chainId, wager.multisig, wager.buyinWei, switchChainAsync, sendTransactionAsync]);

  const busy = switching || sending || (!!txHash && (waiting || (reported && !relayRejected)));
  const statusText = switching
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
        {busy ? "Sending buy-in…" : `Send ${fmtEth(wager.buyinWei)} ETH buy-in`}
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
                mesh.wagerFund(txHash);
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

// ─── Settling / refunding ───────────────────────────────────────────

const SettleControls = ({ mesh, wager, mySide }: { mesh: PeerMeshState; wager: Wager; mySide: WagerSide | null }) => {
  const isDraw = wager.winner === "draw" || wager.status === "refunding";
  const iWon = !isDraw && wager.winner === mySide;
  const winnerLabel = wager.winner === "white" ? wager.whiteLabel : wager.blackLabel;

  // The linked payout tx (if proposed) — show its progress through the
  // normal multisig sign/execute flow.
  const payoutTx = useMemo(
    () => (wager.payoutTxId ? (mesh.walletTxs.find(t => t.id === wager.payoutTxId) ?? null) : null),
    [wager.payoutTxId, mesh.walletTxs],
  );
  const threshold = mesh.wallet?.threshold ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          fontFamily: "var(--slop-font-display)",
          fontSize: 16,
          color: isDraw ? CYAN : iWon ? LIME : "var(--slop-text)",
        }}
      >
        {wager.status === "refunding"
          ? "↩️ Wager cancelled — buy-ins to be refunded"
          : isDraw
            ? "🤝 Draw — buy-ins to be refunded"
            : iWon
              ? `🏆 You won the ${fmtEth(potWei(wager))} ETH pot!`
              : `🏆 ${winnerLabel} won the ${fmtEth(potWei(wager))} ETH pot`}
      </div>

      {!payoutTx ? (
        // Nobody has proposed the payout yet.
        <PayoutProposeButton mesh={mesh} wager={wager} isDraw={isDraw} iWon={iWon} mySide={mySide} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 13, color: CYAN }}>
            Payout proposed — sign &amp; execute it in the <b>Wallet</b> app (Transactions tab).
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

// Build + propose the settlement tx. Winner-takes-pot is a single send;
// a draw/refund is a batch returning each buy-in. The relay auto-links
// it to the wager (no separate call), then watches it execute.
const PayoutProposeButton = ({
  mesh,
  wager,
  isDraw,
  iWon,
  mySide,
}: {
  mesh: PeerMeshState;
  wager: Wager;
  isDraw: boolean;
  iWon: boolean;
  mySide: WagerSide | null;
}) => {
  const publicClient = usePublicClient({ chainId: wager.chainId });
  const [state, setState] = useState<"idle" | "proposing" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);

  // Who may propose: the winner (single payout) or either player (draw refund).
  const canPropose = isDraw ? !!mySide : iWon;

  const onPropose = useCallback(async () => {
    setErr(null);
    const wallet = mesh.wallet;
    if (!wallet) return setErr("No escrow multisig.");
    if (!publicClient) return setErr(`No RPC client for ${chainLabel(wager.chainId)}.`);
    if (!(wager.chainId in wallet.deployments)) {
      return setErr(`Multisig isn't deployed on ${chainLabel(wager.chainId)}.`);
    }
    setState("proposing");
    try {
      const nonce = (await publicClient.readContract({
        address: wallet.address as AddressType,
        abi: MultisigAbi,
        functionName: "nonce",
      })) as bigint;
      const deadline = defaultDeadline();
      if (isDraw) {
        // Refund batch: return the buy-in to every side that ACTUALLY
        // funded. For a played-out draw that's both; for a cancelled
        // half-funded wager it's only the one who paid in (refunding an
        // unfunded side would over-draw the escrow or revert).
        const buyin = BigInt(wager.buyinWei);
        const calls: { target: string; value: string; data: string }[] = [];
        if (wager.whiteDeposit) calls.push({ target: wager.whiteKey, value: buyin.toString(), data: "0x" });
        if (wager.blackDeposit) calls.push({ target: wager.blackKey, value: buyin.toString(), data: "0x" });
        if (calls.length === 0) {
          setState("idle");
          return setErr("Nothing to refund — no buy-ins landed.");
        }
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
          chainId: wager.chainId,
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
        const winnerAddr = (wager.winner === "white" ? wager.whiteKey : wager.blackKey) as AddressType;
        const value = BigInt(potWei(wager));
        const execHash = computeExecHash({
          chainId: wager.chainId,
          multisig: wallet.address as AddressType,
          nonce,
          deadline,
          target: winnerAddr,
          value,
          data: "0x",
        });
        mesh.walletProposeTx({
          chainId: wager.chainId,
          target: winnerAddr,
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
    } catch (e) {
      setState("idle");
      setErr(String(e).slice(0, 160));
    }
  }, [mesh, publicClient, wager, isDraw]);

  if (!canPropose) {
    return (
      <div style={{ fontSize: 13, color: "var(--slop-text-muted)" }}>
        {isDraw ? "A player will propose the refund." : "The winner will claim the pot."}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button type="button" onClick={onPropose} disabled={state !== "idle"} style={btn(LIME, state !== "idle")}>
        {state === "proposing"
          ? "Proposing…"
          : isDraw
            ? `Propose refund (${fmtEth(wager.buyinWei)} ETH each)`
            : `Claim ${fmtEth(potWei(wager))} ETH pot`}
      </button>
      {state === "proposing" && <LoadingBar />}
      {err && <div style={{ fontSize: 12, color: ACCENT }}>{err}</div>}
    </div>
  );
};

// ─── Settled ────────────────────────────────────────────────────────

const SettledView = ({ mesh, wager }: { mesh: PeerMeshState; wager: Wager }) => {
  // A settled wager paid out either to a winner (winner white/black) or
  // as a refund — both a draw (winner === "draw") and a cancellation
  // (winner === null) settle via the refund batch.
  const isRefund = wager.winner === "draw" || wager.winner == null;
  const explorer = EXPLORERS[wager.chainId];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontFamily: "var(--slop-font-display)", fontSize: 16, color: LIME }}>
        {isRefund
          ? `↩️ Refunded — ${fmtEth(wager.buyinWei)} ETH returned`
          : `🏆 Paid out — ${fmtEth(potWei(wager))} ETH to ${wager.winner === "white" ? wager.whiteLabel : wager.blackLabel}`}
      </div>
      {wager.payoutTxHash && explorer && (
        <a
          href={`${explorer}${wager.payoutTxHash}`}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: CYAN }}
        >
          View settlement tx ↗
        </a>
      )}
      <button type="button" onClick={() => mesh.wagerClear()} style={btn(ACCENT)}>
        New game
      </button>
    </div>
  );
};

const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io/tx/",
  8453: "https://basescan.org/tx/",
  10: "https://optimistic.etherscan.io/tx/",
  42161: "https://arbiscan.io/tx/",
  137: "https://polygonscan.com/tx/",
};

// =====================================================================
// Banner — thin pot strip shown above the board while playing.
// =====================================================================

export const WagerBanner = ({ wager }: { wager: Wager }) => (
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
    💰 Playing for {fmtEth(potWei(wager))} ETH · winner takes the pot
  </div>
);

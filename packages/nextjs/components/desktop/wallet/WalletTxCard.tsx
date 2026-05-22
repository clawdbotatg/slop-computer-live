"use client";

import { useCallback, useState } from "react";
import { type Address as AddressType, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import { MultisigAbi } from "~~/contracts/multisig";
import type { PeerMeshState, WalletChatMessage, WalletRecord } from "~~/hooks/usePeerMesh";
import { computeExecHash, defaultDeadline } from "~~/utils/multisig";

// Renders the transaction / multi-step payload attached to an assistant
// message in the wallet chat. "Send to multisig" computes the exec hash
// the same way the old AI-wallet iframe bridge did, then drops the tx
// into the existing multiplayer multisig queue (the Transactions tab)
// where signers approve + execute. Each multi-step step proposes
// independently — a multisig can only hold one tx at a time, so the
// room executes them in order across separate sign/execute cycles.

const ACCENT = "var(--slop-magenta, #ff3ec9)";
const PANEL_BG = "#0a061a";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function hexValueToDecimal(value: string): string {
  try {
    return BigInt(value || "0").toString();
  } catch {
    return "0";
  }
}

type SingleTx = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  description?: string;
};

const SendButton = ({
  tx,
  wallet,
  mesh,
  label,
  disabled,
}: {
  tx: SingleTx;
  wallet: WalletRecord;
  mesh: PeerMeshState;
  label: string;
  disabled?: boolean;
}) => {
  const publicClient = usePublicClient({ chainId: tx.chainId });
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const onSend = useCallback(async () => {
    setError(null);
    if (!(tx.chainId in wallet.deployments)) {
      setError(`multisig isn't deployed on chain ${tx.chainId}`);
      return;
    }
    if (!publicClient) {
      setError(`no RPC client for chain ${tx.chainId}`);
      return;
    }
    setState("sending");
    try {
      const nonce = (await publicClient.readContract({
        address: wallet.address as AddressType,
        abi: MultisigAbi,
        functionName: "nonce",
      })) as bigint;
      const deadline = defaultDeadline();
      const target = tx.to as AddressType;
      const valueWei = BigInt(tx.value || "0");
      const data = (tx.data || "0x") as Hex;
      const execHash = computeExecHash({
        chainId: tx.chainId,
        multisig: wallet.address as AddressType,
        nonce,
        deadline,
        target,
        value: valueWei,
        data,
      });
      mesh.walletProposeTx({
        chainId: tx.chainId,
        target,
        value: valueWei.toString(),
        data,
        deadline: deadline.toString(),
        nonce: nonce.toString(),
        execHash,
        source: "manual",
        browserId: null,
      });
      setState("sent");
    } catch (err) {
      setState("idle");
      setError(String(err).slice(0, 160));
    }
  }, [tx, wallet, mesh, publicClient]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || state !== "idle"}
        style={{
          padding: "6px 12px",
          fontSize: 10,
          fontFamily: "var(--slop-font-display)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          fontWeight: 700,
          background: state === "sent" ? "rgba(123,232,138,0.2)" : disabled ? "rgba(255,62,201,0.25)" : ACCENT,
          color: state === "sent" ? "#7be88a" : "#06030d",
          border: state === "sent" ? "1px solid rgba(123,232,138,0.4)" : "none",
          borderRadius: 4,
          cursor: disabled || state !== "idle" ? "default" : "pointer",
        }}
      >
        {state === "sending" ? "Sending…" : state === "sent" ? "✓ In multisig queue" : label}
      </button>
      {error ? <div style={{ fontSize: 10, color: "#ff7676" }}>{error}</div> : null}
    </div>
  );
};

const SimChanges = ({ changes }: { changes: { direction: string; symbol: string; amount: string }[] }) => {
  if (changes.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
      {changes.map((c, i) => {
        const out = c.direction === "out";
        return (
          <span
            key={i}
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 3,
              background: out ? "rgba(255,118,118,0.12)" : "rgba(123,232,138,0.12)",
              border: `1px solid ${out ? "rgba(255,118,118,0.3)" : "rgba(123,232,138,0.3)"}`,
              color: out ? "#ff9a9a" : "#7be88a",
            }}
          >
            {out ? "−" : "+"}
            {c.amount} {c.symbol}
          </span>
        );
      })}
    </div>
  );
};

export const WalletTxCard = ({
  message,
  wallet,
  mesh,
}: {
  message: WalletChatMessage;
  wallet: WalletRecord;
  mesh: PeerMeshState;
}) => {
  const tx = message.transaction;
  const multi = message.multistep;
  if (!tx && !multi) return null;

  return (
    <div
      style={{
        marginTop: 8,
        padding: 10,
        background: PANEL_BG,
        border: "1px solid rgba(255,62,201,0.3)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {tx ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, flexWrap: "wrap" }}>
            <span style={{ color: "var(--slop-text-muted)" }}>to</span>
            <span style={{ fontFamily: "monospace" }}>{short(tx.to)}</span>
            <span style={{ color: "var(--slop-text-muted)" }}>· chain {tx.chainId}</span>
          </div>
          {tx.description ? <div style={{ fontSize: 12, lineHeight: 1.5 }}>{tx.description}</div> : null}
          {tx.simulation ? (
            <div>
              <div
                style={{
                  fontSize: 9,
                  color: "var(--slop-text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                }}
              >
                Simulated {tx.simulation.verified ? "✓" : "⚠ unverified"}
              </div>
              <SimChanges changes={tx.simulation.changes} />
            </div>
          ) : null}
          <SendButton
            tx={{ to: tx.to, data: tx.data, value: hexValueToDecimal(tx.value), chainId: tx.chainId }}
            wallet={wallet}
            mesh={mesh}
            label="Send to multisig"
          />
        </>
      ) : null}

      {multi ? (
        <>
          <div
            style={{ fontSize: 9, color: "var(--slop-text-muted)", textTransform: "uppercase", letterSpacing: "0.1em" }}
          >
            {multi.steps.length}-step transaction
            {multi.delay > 0 ? ` · ${Math.round(multi.delay / 1000)}s between steps` : ""}
          </div>
          {multi.steps.map((step, i) => (
            <div
              key={i}
              style={{
                padding: 8,
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,62,201,0.18)",
                borderRadius: 4,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600 }}>
                {i + 1}. {step.label}
              </div>
              <div style={{ fontSize: 11, color: "var(--slop-text-muted)", lineHeight: 1.4 }}>{step.description}</div>
              <SendButton
                tx={{ to: step.to, data: step.data, value: hexValueToDecimal(step.value), chainId: step.chainId }}
                wallet={wallet}
                mesh={mesh}
                label={`Send step ${i + 1} to multisig`}
              />
            </div>
          ))}
          <div style={{ fontSize: 10, color: "var(--slop-text-muted)", fontStyle: "italic" }}>
            Each step queues separately — execute them in order from the Transactions tab.
          </div>
        </>
      ) : null}
    </div>
  );
};

export default WalletTxCard;

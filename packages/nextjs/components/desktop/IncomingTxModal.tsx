"use client";

import { useEffect, useMemo, useState } from "react";
import { Address } from "@scaffold-ui/components";
import { type Address as AddressType, type Hex, formatEther } from "viem";
import {
  useAccount,
  useChainId,
  useChains,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from "wagmi";
import { Button } from "~~/components/ui";
import type { ForwardedTx } from "~~/hooks/usePeerMesh";

// Modal that surfaces captured eth_sendTransaction requests forwarded to
// us because someone is impersonating our wallet address. Each forward is
// either Sent (via wagmi, which prompts the real wallet) or Rejected.
// Once handled, the entry is removed from `incomingForwards` via dismiss.

export type IncomingTxModalProps = {
  incomingForwards: ForwardedTx[];
  dismissIncomingForward: (id: string) => void;
};

export const IncomingTxModal = ({ incomingForwards, dismissIncomingForward }: IncomingTxModalProps) => {
  // Render only the oldest pending forward to keep the UI focused. Once
  // dismissed, the next one (if any) takes its place.
  const next = incomingForwards[incomingForwards.length - 1] ?? null;
  if (!next) return null;
  return <IncomingTxCard key={next.id} forward={next} onResolve={() => dismissIncomingForward(next.id)} />;
};

type CardProps = {
  forward: ForwardedTx;
  onResolve: () => void;
};

type ParsedTx = {
  to: AddressType | null;
  value: bigint;
  data: Hex;
};

function parseTx(forward: ForwardedTx): ParsedTx | null {
  if (forward.method !== "eth_sendTransaction") return null;
  const p = forward.params?.[0];
  if (!p || typeof p !== "object") return null;
  const raw = p as { to?: unknown; value?: unknown; data?: unknown };
  const to = typeof raw.to === "string" && /^0x[0-9a-fA-F]{40}$/.test(raw.to) ? (raw.to as AddressType) : null;
  let value = 0n;
  if (typeof raw.value === "string" && raw.value !== "0x") {
    try {
      value = BigInt(raw.value);
    } catch {
      /* keep 0n */
    }
  }
  const data = (typeof raw.data === "string" ? raw.data : "0x") as Hex;
  return { to, value, data };
}

const IncomingTxCard = ({ forward, onResolve }: CardProps) => {
  const { address: connectedAddress } = useAccount();
  const currentChainId = useChainId();
  const chains = useChains();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const { sendTransactionAsync, isPending: sending } = useSendTransaction();
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const { isLoading: waiting, data: receipt } = useWaitForTransactionReceipt({ hash: txHash ?? undefined });
  const [err, setErr] = useState<string | null>(null);

  const parsed = useMemo(() => parseTx(forward), [forward]);

  // Wagmi's `chains` is the wallet's connected chain list. We use it to
  // look up a human label for the target chain and to know which chains
  // we can switch to. If the dapp's target isn't configured, we can still
  // show the chainId but the "Switch" button won't be useful.
  const targetChain = useMemo(
    () => (forward.chainId != null ? (chains.find(c => c.id === forward.chainId) ?? null) : null),
    [forward.chainId, chains],
  );
  const chainMismatch = forward.chainId != null && currentChainId !== forward.chainId;

  const onSwitch = async () => {
    setErr(null);
    if (forward.chainId == null) return;
    try {
      await switchChainAsync({ chainId: forward.chainId });
    } catch (e) {
      setErr(String(e).slice(0, 200));
    }
  };

  useEffect(() => {
    if (!receipt) return;
    // Auto-close on confirmation.
    const id = setTimeout(onResolve, 1500);
    return () => clearTimeout(id);
  }, [receipt, onResolve]);

  const onSend = async () => {
    setErr(null);
    if (!parsed?.to) {
      setErr("No target address in tx — can't send.");
      return;
    }
    try {
      const hash = await sendTransactionAsync({
        to: parsed.to,
        value: parsed.value,
        data: parsed.data,
        // Pin to the target chain — wagmi will refuse to broadcast on a
        // different chain, which is what we want to avoid replaying a
        // mainnet swap onto Base (or vice versa).
        ...(forward.chainId != null ? { chainId: forward.chainId } : {}),
      });
      setTxHash(hash);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    }
  };

  const onReject = () => {
    onResolve();
  };

  const supported = forward.method === "eth_sendTransaction";
  const valueEth = (() => {
    if (!parsed) return "—";
    try {
      return formatEther(parsed.value);
    } catch {
      return parsed.value.toString();
    }
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        style={{
          width: 460,
          maxWidth: "92vw",
          background: "#0a0612",
          border: "1px solid rgba(255,62,201,0.4)",
          borderRadius: 6,
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            fontSize: 11,
            color: "var(--slop-text-muted)",
          }}
        >
          Incoming transaction
        </div>

        <div style={{ fontSize: 13, lineHeight: 1.4 }}>
          {forward.fromHandle ? <strong>{forward.fromHandle}</strong> : "A peer"} captured a dapp transaction while
          impersonating your wallet. Sign it with{" "}
          {connectedAddress ? (
            <Address address={connectedAddress as AddressType} size="xs" onlyEnsOrAddress />
          ) : (
            <em>your connected wallet</em>
          )}{" "}
          to broadcast it.
        </div>

        {forward.chainId != null ? (
          <div
            style={{
              fontSize: 12,
              padding: 8,
              background: chainMismatch ? "rgba(255,206,106,0.08)" : "rgba(123,232,138,0.06)",
              border: `1px solid ${chainMismatch ? "rgba(255,206,106,0.3)" : "rgba(123,232,138,0.25)"}`,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              color: chainMismatch ? "#ffce6a" : "#7be88a",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>network</span>
              <span>
                {targetChain?.name ?? `chain ${forward.chainId}`}
                {chainMismatch ? (
                  <span style={{ marginLeft: 6, color: "var(--slop-text-muted)" }}>
                    · wallet on {chains.find(c => c.id === currentChainId)?.name ?? `chain ${currentChainId}`}
                  </span>
                ) : null}
              </span>
            </div>
            {chainMismatch ? (
              <Button onClick={onSwitch} disabled={switching || !targetChain}>
                {switching ? "Switching…" : `Switch to ${targetChain?.name ?? `chain ${forward.chainId}`}`}
              </Button>
            ) : null}
          </div>
        ) : null}

        {!supported ? (
          <div
            style={{
              fontSize: 11,
              padding: 8,
              background: "rgba(255,206,106,0.08)",
              border: "1px solid rgba(255,206,106,0.3)",
              borderRadius: 4,
              color: "#ffce6a",
            }}
          >
            Method <code>{forward.method}</code> isn&apos;t supported yet — only <code>eth_sendTransaction</code> can be
            forwarded for now.
          </div>
        ) : !parsed ? (
          <div style={{ fontSize: 11, color: "#ff7676" }}>Malformed payload — can&apos;t decode tx params.</div>
        ) : (
          <div
            style={{
              fontSize: 12,
              padding: 10,
              background: "rgba(255,62,201,0.06)",
              border: "1px solid rgba(255,62,201,0.2)",
              borderRadius: 4,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ color: "var(--slop-text-muted)" }}>to</span>
              {parsed.to ? <Address address={parsed.to} size="xs" onlyEnsOrAddress /> : <span>—</span>}
            </div>
            <div>
              <span style={{ color: "var(--slop-text-muted)" }}>value</span> {valueEth} ETH
            </div>
            <details>
              <summary style={{ cursor: "pointer", color: "var(--slop-text-muted)", fontSize: 11 }}>calldata</summary>
              <div style={{ fontFamily: "monospace", fontSize: 10, wordBreak: "break-all", marginTop: 4 }}>
                {parsed.data}
              </div>
            </details>
          </div>
        )}

        {txHash ? (
          <div style={{ fontSize: 11, color: "var(--slop-text-muted)" }}>
            tx submitted — {receipt ? "confirmed" : waiting ? "waiting for inclusion…" : "broadcast"}
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 10,
                wordBreak: "break-all",
                color: "var(--slop-magenta, #ff3ec9)",
              }}
            >
              {txHash}
            </div>
          </div>
        ) : null}

        {err ? (
          <div
            style={{
              fontSize: 11,
              color: "#ff7676",
              padding: 6,
              background: "rgba(255,118,118,0.08)",
              borderRadius: 3,
            }}
          >
            {err}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <Button onClick={onReject} disabled={sending || waiting}>
            {receipt ? "Close" : "Reject"}
          </Button>
          {supported && !receipt ? (
            <Button
              variant="primary"
              onClick={onSend}
              disabled={sending || waiting || !parsed?.to || !connectedAddress || chainMismatch}
              title={chainMismatch ? "Switch your wallet to the target network first." : undefined}
            >
              {sending ? "Confirm in wallet…" : waiting ? "Waiting…" : chainMismatch ? "Wrong network" : "Send"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default IncomingTxModal;

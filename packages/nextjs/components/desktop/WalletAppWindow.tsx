"use client";

import { useState } from "react";
import { type Address, isAddress, parseEther } from "viem";
import { useAccount, useBalance, useChainId, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import { PersonalWalletCard } from "~~/components/PersonalWalletCard";
import { usePersonalWallet } from "~~/hooks/usePersonalWallet";

// The personal ("single-player") Wallet desktop app. Auth-aware:
//   - passkey session → their personal smart-wallet (PersonalWalletCard)
//   - connected EOA  → controls that wallet directly (balance + send)
//   - neither        → prompt to sign in / connect
// The shared/multisig builder lives in the separate "Bank" app.

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  10: "Optimism",
  42161: "Arbitrum",
  137: "Polygon",
  100: "Gnosis",
};

export function WalletAppWindow() {
  const pw = usePersonalWallet();
  const { address, isConnected } = useAccount();

  if (pw.isPasskey) {
    return (
      <div style={{ padding: 12, display: "grid", placeItems: "center" }}>
        <PersonalWalletCard />
      </div>
    );
  }
  if (isConnected && address) {
    return <ConnectedWallet address={address} />;
  }
  return (
    <div
      style={{
        padding: 20,
        color: "var(--slop-text-muted, #999)",
        fontFamily: "var(--slop-font, monospace)",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      Connect a wallet or sign in with a passkey to use your wallet.
    </div>
  );
}

function ConnectedWallet({ address }: { address: Address }) {
  const chainId = useChainId();
  const { data: bal } = useBalance({ address });
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const { sendTransaction, data: hash, isPending, error, reset } = useSendTransaction();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const validTo = isAddress(to);
  const validAmt = /^\d*\.?\d+$/.test(amount) && Number(amount) > 0;
  const canSend = validTo && validAmt && !isPending && !confirming;

  const send = () => {
    if (!canSend) return;
    sendTransaction({ to: to as Address, value: parseEther(amount) });
  };

  const muted: React.CSSProperties = { color: "var(--slop-text-muted, #999)", fontSize: 11 };
  const field: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    fontFamily: "var(--slop-font, monospace)",
    fontSize: 12,
    background: "var(--slop-panel-2, #26262c)",
    color: "var(--slop-text, #eee)",
    border: "1px solid var(--slop-border, #444)",
    borderRadius: 6,
    padding: "8px 10px",
    marginTop: 4,
  };

  return (
    <div
      style={{
        padding: 16,
        fontFamily: "var(--slop-font, monospace)",
        color: "var(--slop-text, #eee)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <span style={{ fontWeight: 600 }}>Your wallet</span>
        <span style={{ ...muted, color: "var(--slop-accent, #7cf)" }}>
          connected · {CHAIN_NAMES[chainId] ?? `chain ${chainId}`}
        </span>
      </div>

      <div style={muted}>Address</div>
      <div style={{ fontSize: 12, wordBreak: "break-all", marginTop: 2 }}>{address}</div>

      <div style={{ marginTop: 14 }}>
        <div style={muted}>Balance</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {bal ? `${Number(bal.formatted).toFixed(5)} ${bal.symbol}` : "…"}
        </div>
      </div>

      <div style={{ marginTop: 18, borderTop: "1px solid var(--slop-border, #444)", paddingTop: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Send</div>
        <div style={muted}>To</div>
        <input
          value={to}
          onChange={e => setTo(e.target.value.trim())}
          placeholder="0x…"
          spellCheck={false}
          style={{ ...field, borderColor: to && !validTo ? "var(--slop-warn, #e6a700)" : "var(--slop-border, #444)" }}
        />
        <div style={{ ...muted, marginTop: 10 }}>Amount ({bal?.symbol ?? "ETH"})</div>
        <input
          value={amount}
          onChange={e => setAmount(e.target.value.trim())}
          placeholder="0.0"
          inputMode="decimal"
          style={field}
        />
        <button
          onClick={send}
          disabled={!canSend}
          style={{
            width: "100%",
            marginTop: 12,
            fontFamily: "inherit",
            fontSize: 13,
            fontWeight: 600,
            background: canSend ? "var(--slop-accent, #2b6cff)" : "var(--slop-panel-2, #26262c)",
            color: canSend ? "#fff" : "var(--slop-text-muted, #999)",
            border: "1px solid var(--slop-border, #444)",
            borderColor: canSend ? "transparent" : "var(--slop-border, #444)",
            borderRadius: 6,
            padding: "10px 12px",
            cursor: canSend ? "pointer" : "default",
          }}
        >
          {isPending ? "Confirm in wallet…" : confirming ? "Sending…" : "Send"}
        </button>

        {isSuccess && (
          <div style={{ ...muted, color: "var(--slop-accent, #7cf)", marginTop: 10 }}>
            ✓ sent —{" "}
            <button
              onClick={() => {
                setTo("");
                setAmount("");
                reset();
              }}
              style={{
                background: "none",
                border: "none",
                color: "var(--slop-accent, #7cf)",
                cursor: "pointer",
                font: "inherit",
                textDecoration: "underline",
                padding: 0,
              }}
            >
              send another
            </button>
          </div>
        )}
        {error && (
          <div style={{ ...muted, color: "var(--slop-warn, #e6a700)", marginTop: 10, wordBreak: "break-word" }}>
            {error.message.split("\n")[0]}
          </div>
        )}
      </div>
    </div>
  );
}

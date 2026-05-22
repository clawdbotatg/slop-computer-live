"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { WalletTxCard } from "./WalletTxCard";
import { LoadingBar } from "~~/components/ui";
import type { PeerMeshState, WalletChatMessage, WalletRecord } from "~~/hooks/usePeerMesh";

// Multiplayer AI-wallet chat. The whole room shares one conversation —
// mesh.walletChat. Any peer types a message, the relay runs the agentic
// intent engine, and the answer (plus any transaction card) broadcasts
// to everyone. Replaces the per-iframe localStorage chat the embedded
// wallet used to keep.

const ACCENT = "var(--slop-magenta, #ff3ec9)";

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const MessageBubble = ({
  msg,
  wallet,
  mesh,
}: {
  msg: WalletChatMessage;
  wallet: WalletRecord;
  mesh: PeerMeshState;
}) => {
  const isUser = msg.role === "user";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", gap: 2 }}>
      <div
        style={{
          fontSize: 9,
          color: "var(--slop-text-muted)",
          fontFamily: "var(--slop-font-display)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          display: "flex",
          gap: 6,
        }}
      >
        <span>{isUser ? (msg.sender ?? "guest") : "wallet ai"}</span>
        <span style={{ opacity: 0.6 }}>{fmtTime(msg.ts)}</span>
      </div>
      <div
        style={{
          maxWidth: "90%",
          padding: "8px 10px",
          borderRadius: 8,
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: isUser ? "rgba(255,62,201,0.14)" : "rgba(255,255,255,0.04)",
          border: `1px solid ${isUser ? "rgba(255,62,201,0.3)" : "rgba(255,255,255,0.08)"}`,
          color: msg.error ? "#ff9a9a" : "var(--slop-text)",
        }}
      >
        {msg.content || (msg.error ? "(error)" : "…")}
      </div>
      {msg.error ? <div style={{ fontSize: 10, color: "#ff7676", maxWidth: "90%" }}>{msg.error}</div> : null}
      {!isUser && (msg.transaction || msg.multistep) ? (
        <div style={{ width: "90%" }}>
          <WalletTxCard message={msg} wallet={wallet} mesh={mesh} />
        </div>
      ) : null}
    </div>
  );
};

export const WalletChatPanel = ({ mesh, wallet }: { mesh: PeerMeshState; wallet: WalletRecord }) => {
  const { messages, processing } = mesh.walletChat;
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  // The chat operates against the multisig as the wallet, on its
  // most-recently-deployed chain (the agent can still target other
  // deployed chains in a transaction it builds).
  const primaryChainId = useMemo<number | null>(() => {
    const ids = Object.keys(wallet.deployments)
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => wallet.deployments[b].deployedAt - wallet.deployments[a].deployedAt);
    return ids[0] ?? null;
  }, [wallet.deployments]);

  // Pin to bottom whenever a message lands or the spinner toggles.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, processing]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || processing || primaryChainId == null) return;
    mesh.walletChatSend(text, wallet.address, primaryChainId);
    setDraft("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Header — operating wallet + reset */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "6px 10px",
          borderBottom: "1px solid rgba(255,62,201,0.18)",
          background: "rgba(0,0,0,0.25)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
          Talking to the multisig — ask it to swap, send, bridge, check balances…
        </span>
        {messages.length > 0 ? (
          <button
            type="button"
            onClick={() => mesh.walletChatReset()}
            disabled={processing}
            title={processing ? "wait for the current turn to finish" : "clear the conversation for everyone"}
            style={{
              flexShrink: 0,
              padding: "3px 8px",
              fontSize: 9,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              background: "transparent",
              color: "var(--slop-text-muted)",
              border: "1px solid rgba(255,62,201,0.3)",
              borderRadius: 3,
              cursor: processing ? "not-allowed" : "pointer",
              opacity: processing ? 0.5 : 1,
            }}
          >
            Reset
          </button>
        ) : null}
      </div>

      {/* Message list */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              margin: "auto",
              textAlign: "center",
              color: "var(--slop-text-muted)",
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>👛</div>
            Ask the wallet anything — &ldquo;swap 0.1 ETH to USDC&rdquo;, &ldquo;what do I hold?&rdquo;,
            <br />
            &ldquo;send 5 USDC to vitalik.eth&rdquo;, &ldquo;register a name on ENS&rdquo;.
            <br />
            <span style={{ fontSize: 11, opacity: 0.8 }}>Everyone in the room sees the conversation.</span>
          </div>
        ) : (
          messages.map(m => <MessageBubble key={m.id} msg={m} wallet={wallet} mesh={mesh} />)
        )}
        {processing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div
              style={{
                fontSize: 9,
                color: "var(--slop-text-muted)",
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              wallet ai
            </div>
            <LoadingBar cells={14} caption="thinking" />
          </div>
        ) : null}
      </div>

      {/* Composer */}
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderTop: "1px solid rgba(255,62,201,0.18)",
          background: "rgba(0,0,0,0.25)",
          flexShrink: 0,
        }}
      >
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={primaryChainId == null ? "deploy the multisig on a chain first…" : "message the wallet…"}
          disabled={primaryChainId == null}
          spellCheck={false}
          style={{
            flex: 1,
            padding: "8px 10px",
            fontSize: 13,
            fontFamily: "var(--slop-font-body)",
            background: "#06030d",
            color: "var(--slop-text)",
            border: "1px solid var(--slop-border, #2a1d4a)",
            borderRadius: 4,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!draft.trim() || processing || primaryChainId == null}
          style={{
            padding: "0 14px",
            fontSize: 11,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            fontWeight: 700,
            background: !draft.trim() || processing || primaryChainId == null ? "rgba(255,62,201,0.25)" : ACCENT,
            color: "#06030d",
            border: "none",
            borderRadius: 4,
            cursor: !draft.trim() || processing || primaryChainId == null ? "not-allowed" : "pointer",
          }}
        >
          {processing ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
};

export default WalletChatPanel;

"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { LoadingBar } from "~~/components/ui";
import type { VoteE3Telemetry } from "~~/hooks/usePeerMesh";

// The nerdy protocol panel for a Sepolia E3 poll — shows exactly what's
// happening on-chain: the committee, the threshold key, every tx as an
// Etherscan link, an animated progress bar through the E3 lifecycle,
// and a live scrolling log. We are NOT hiding the tech; the waiting is
// the decentralization, so we narrate it.

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// The ordered pipeline. Each stage gets an equal slice of the bar; the
// voting stage additionally fills by the window countdown.
const STAGES: { key: VoteE3Telemetry["stage"]; label: string }[] = [
  { key: "requesting", label: "Request E3" },
  { key: "sortition", label: "Sortition" },
  { key: "dkg", label: "Distributed key-gen" },
  { key: "open", label: "Voting open" },
  { key: "tallying", label: "Homomorphic tally" },
  { key: "publishing", label: "Publish tally" },
  { key: "decrypting", label: "Threshold decrypt" },
  { key: "revealed", label: "Revealed" },
];

function etherscanTx(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}
function etherscanAddr(addr: string): string {
  return `https://sepolia.etherscan.io/address/${addr}`;
}
function short(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

export const VotingE3Panel = ({ e3 }: { e3: VoteE3Telemetry }) => {
  // Re-render each second so the voting-window countdown + bar animate.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (e3.stage === "revealed" || e3.stage === "failed") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [e3.stage]);

  const stageIdx = Math.max(
    0,
    STAGES.findIndex(s => s.key === e3.stage),
  );
  const failed = e3.stage === "failed";

  // Progress: each completed stage = one slot; during "open" fill the
  // slot by the voting-window countdown.
  let progress = stageIdx / (STAGES.length - 1);
  let countdown: number | null = null;
  if (e3.stage === "open" && e3.windowStart && e3.windowEnd) {
    const total = e3.windowEnd - e3.windowStart;
    const elapsed = Math.min(Math.max(now / 1000 - e3.windowStart, 0), total);
    countdown = Math.max(0, Math.round(e3.windowEnd - now / 1000));
    const slot = 1 / (STAGES.length - 1);
    progress = stageIdx / (STAGES.length - 1) + (total > 0 ? (elapsed / total) * slot : 0);
  }

  const chip = (text: string, href?: string) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        style={{ fontFamily: MONO, fontSize: 10, color: "var(--slop-cyan, #3ee9ff)", wordBreak: "break-all" }}
      >
        {text}
      </a>
    ) : (
      <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--slop-text-muted)" }}>{text}</span>
    );

  return (
    <div
      style={{
        border: "1px solid var(--slop-cyan, #3ee9ff)",
        borderRadius: 6,
        background: "#06030d",
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 9,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            padding: "2px 6px",
            borderRadius: 3,
            background: "var(--slop-cyan, #3ee9ff)",
            color: "#06030d",
          }}
        >
          ⛓ The Interfold · Sepolia E3
        </span>
        {e3.e3Id ? chip(`E3 #${e3.e3Id}`, e3.requestTx ? etherscanTx(e3.requestTx) : undefined) : null}
      </div>

      {/* Animated progress bar */}
      <LoadingBar
        cells={20}
        progress={Math.min(100, progress * 100)}
        style={{ fontSize: 13, ...(failed ? ({ "--slop-magenta": "#ff6b6b" } as CSSProperties) : {}) }}
      />

      {/* Stage stepper */}
      <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
        {STAGES.map((s, i) => {
          const done = i < stageIdx || e3.stage === "revealed";
          const active = i === stageIdx && !failed;
          return (
            <span
              key={s.key}
              style={{
                fontSize: 8.5,
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                padding: "1px 4px",
                borderRadius: 2,
                color: active ? "#06030d" : done ? "var(--slop-lime, #b6ff3e)" : "var(--slop-text-muted)",
                background: active ? "var(--slop-magenta, #ff3ec9)" : "transparent",
                border: active ? "none" : "1px solid var(--slop-border, #2a1d4a)",
              }}
            >
              {done ? "✓ " : active ? "▸ " : ""}
              {s.label}
            </span>
          );
        })}
      </div>

      {/* Current narration + countdown */}
      <div style={{ fontSize: 11, fontFamily: MONO, color: failed ? "#ff6b6b" : "var(--slop-cyan, #3ee9ff)" }}>
        {failed ? `❌ ${e3.error ?? e3.message}` : e3.message}
        {countdown !== null ? (
          <span style={{ color: "var(--slop-text)" }}>
            {" "}
            · voting closes in {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
          </span>
        ) : null}
      </div>

      {/* Committee + key facts */}
      {e3.committee.length > 0 ? (
        <div
          style={{ fontSize: 10, color: "var(--slop-text-muted)", display: "flex", flexDirection: "column", gap: 2 }}
        >
          <div>
            🖧 committee ({e3.committee.length} public ciphernodes · {e3.keyBytes.toLocaleString()}-byte threshold key):
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 12 }}>
            {e3.committee.map(addr => (
              <span key={addr}>{chip(short(addr), etherscanAddr(addr))}</span>
            ))}
          </div>
        </div>
      ) : null}

      {/* On-chain tx receipts */}
      {(e3.ballotTxs.length > 0 || e3.outputTx) && (
        <div
          style={{ fontSize: 10, color: "var(--slop-text-muted)", display: "flex", flexDirection: "column", gap: 1 }}
        >
          {e3.ballotTxs.map((b, i) => (
            <div key={b.txHash}>
              📥 ballot #{i + 1} → {chip(short(b.txHash), etherscanTx(b.txHash))}
            </div>
          ))}
          {e3.outputTx ? <div>📤 encrypted tally → {chip(short(e3.outputTx), etherscanTx(e3.outputTx))}</div> : null}
        </div>
      )}

      {/* Trust model — honest, always visible. Two distinct guarantees:
          privacy is cryptographically real; tally integrity is not yet
          proven (dev-mode RISC Zero proof + a mock verifier on our
          program). We show both so nobody mistakes one for the other. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          fontSize: 9.5,
          fontFamily: MONO,
          paddingTop: 4,
          borderTop: "1px dashed var(--slop-border, #2a1d4a)",
        }}
      >
        <span style={{ color: "var(--slop-lime, #b6ff3e)" }}>
          🔒 ballot privacy: REAL — threshold-encrypted, decrypted only by the public committee
        </span>
        <span style={{ color: "#f5a623" }}>
          ⚠ tally integrity: DEV-MODE — the relay&apos;s count is{" "}
          <a
            href="https://docs.boundless.network"
            target="_blank"
            rel="noreferrer"
            style={{ color: "#f5a623", textDecoration: "underline" }}
          >
            not yet proven
          </a>{" "}
          (stubbed RISC Zero proof; real proving pending Boundless)
        </span>
      </div>

      {/* Live protocol log (nerd feed) */}
      {e3.log.length > 0 ? (
        <details style={{ fontSize: 10 }}>
          <summary style={{ cursor: "pointer", color: "var(--slop-text-muted)", fontFamily: MONO }}>
            ▾ protocol log ({e3.log.length})
          </summary>
          <div
            style={{
              maxHeight: 120,
              overflowY: "auto",
              marginTop: 4,
              padding: 4,
              background: "#0a061a",
              borderRadius: 3,
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
          >
            {e3.log.map((l, i) => (
              <div key={i} style={{ fontFamily: MONO, color: "var(--slop-text-muted)", display: "flex", gap: 6 }}>
                <span style={{ opacity: 0.6, flexShrink: 0 }}>
                  {new Date(l.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <span style={{ minWidth: 0, wordBreak: "break-word" }}>
                  {l.text}
                  {l.txHash ? <> {chip("↗", etherscanTx(l.txHash))}</> : null}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
};

export default VotingE3Panel;

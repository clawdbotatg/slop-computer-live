"use client";

import { useMemo, useRef, useState } from "react";
import { SlopAddress } from "~~/components/ui";
import type { PeerMeshState, VotePoll } from "~~/hooks/usePeerMesh";
import {
  COMMITTEE_SIZE,
  COMMITTEE_THRESHOLD,
  aggregateBallots,
  combineShares,
  dropShares,
  encryptBallot,
  loadShares,
  partialDecrypt,
  runKeyCeremony,
  saveShares,
} from "~~/utils/votingCrypto";

// Voting Booth — private voting on The Interfold's cryptography stack
// (threshold BFV via the vendored fhe.rs wasm, see public/fhe-wasm/).
//
// The pitch: the relay collects every ballot but cannot read a single
// one. Ballots are encrypted in each voter's browser under a committee
// public key; homomorphic addition tallies them WITHOUT decrypting; a
// 3-of-5 threshold ceremony decrypts only the aggregate. Individual
// ballots stay ciphertext forever.
//
// Phase-1 trust model (disclosed in the ⓘ panel): the 5 committee
// parties are simulated in the poll creator's browser, and the relay
// trusts the creator's posted tally. The real protocol (CRISP) adds
// on-chain E3s, staked ciphernodes, RISC Zero proofs of the tally, and
// ZK ballot-validity proofs.

export type VotingWindowProps = {
  mesh: PeerMeshState;
};

type CeremonyPhase =
  | { step: "idle" }
  | { step: "dkg" }
  | { step: "encrypting" }
  | { step: "fetching" }
  | { step: "aggregating"; count: number }
  | { step: "share"; index: number }
  | { step: "combining" }
  | { step: "error"; message: string };

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export const VotingWindow = ({ mesh }: VotingWindowProps) => {
  const [creating, setCreating] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [phase, setPhase] = useState<CeremonyPhase>({ step: "idle" });
  const [showInfo, setShowInfo] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const busyRef = useRef(false);

  const me = mesh.peers.find(p => p.id === mesh.myId) ?? null;
  const myKey = me?.address?.toLowerCase() ?? me?.anonId ?? null;

  const polls = useMemo(() => [...mesh.votingPolls].reverse(), [mesh.votingPolls]);
  const activeId = expandedId ?? polls.find(p => p.status !== "revealed")?.id ?? polls[0]?.id ?? null;

  const busy = phase.step !== "idle" && phase.step !== "error";

  const createPoll = async () => {
    const q = question.trim();
    const opts = options.map(o => o.trim()).filter(Boolean);
    if (!q || opts.length < 2 || busyRef.current) return;
    busyRef.current = true;
    setPhase({ step: "dkg" });
    try {
      const { pubKeyB64, shares } = await runKeyCeremony();
      saveShares(pubKeyB64, shares);
      mesh.voteCreate({
        question: q,
        options: opts,
        pubKey: pubKeyB64,
        committeeSize: COMMITTEE_SIZE,
        threshold: COMMITTEE_THRESHOLD,
      });
      setCreating(false);
      setQuestion("");
      setOptions(["", ""]);
      setPhase({ step: "idle" });
    } catch (err) {
      setPhase({ step: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      busyRef.current = false;
    }
  };

  const castBallot = async (poll: VotePoll, choice: number) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase({ step: "fetching" });
    try {
      const pubKey = await mesh.voteRequestPubKey(poll.id);
      setPhase({ step: "encrypting" });
      const ct = await encryptBallot(pubKey, choice, poll.options.length);
      const result = await mesh.voteCast(poll.id, ct);
      if (result !== "ok") throw new Error(`ballot rejected: ${result}`);
      setPhase({ step: "idle" });
    } catch (err) {
      setPhase({ step: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      busyRef.current = false;
    }
  };

  const revealTally = async (poll: VotePoll) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase({ step: "fetching" });
    try {
      const payload = await mesh.voteRequestBallots(poll.id);
      const shares = loadShares(payload.pubKey);
      if (!shares)
        throw new Error("committee shares not found in this browser — only the poll creator's browser can reveal");
      const cts = payload.ballots.map(b => b.ct);
      if (!cts.length) throw new Error("no ballots to tally");
      setPhase({ step: "aggregating", count: cts.length });
      const tallyCt = await aggregateBallots(cts);
      const decShares: Uint8Array[] = [];
      for (let i = 0; i < COMMITTEE_THRESHOLD; i++) {
        setPhase({ step: "share", index: i + 1 });
        decShares.push(await partialDecrypt(shares[i].b64, tallyCt));
      }
      setPhase({ step: "combining" });
      const tally = await combineShares(decShares, tallyCt, poll.options.length);
      mesh.voteReveal(poll.id, tally);
      dropShares(payload.pubKey);
      setPhase({ step: "idle" });
    } catch (err) {
      setPhase({ step: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      busyRef.current = false;
    }
  };

  const phaseLabel = (): string | null => {
    switch (phase.step) {
      case "dkg":
        return `🔑 key ceremony — ${COMMITTEE_SIZE} committee parties generating a ${COMMITTEE_THRESHOLD}-of-${COMMITTEE_SIZE} threshold key…`;
      case "fetching":
        return "…";
      case "encrypting":
        return "🔒 encrypting your ballot in this browser…";
      case "aggregating":
        return `∑ homomorphically adding ${phase.count} encrypted ballots (no decryption)…`;
      case "share":
        return `🗝 committee member ${phase.index}/${COMMITTEE_THRESHOLD} contributing a decryption share…`;
      case "combining":
        return "✨ combining shares — decrypting ONLY the aggregate…";
      default:
        return null;
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "6px 8px",
    fontSize: 13,
    fontFamily: "var(--slop-font-body)",
    background: "#0e0820",
    color: "var(--slop-text)",
    border: "1px solid var(--slop-border, #2a1d4a)",
    borderRadius: 4,
    outline: "none",
  };

  const chipStyle = (bg: string): React.CSSProperties => ({
    fontSize: 9,
    fontFamily: "var(--slop-font-display)",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "2px 6px",
    borderRadius: 3,
    background: bg,
    color: "#06030d",
  });

  const buttonStyle = (active: boolean): React.CSSProperties => ({
    padding: "6px 12px",
    fontSize: 11,
    fontFamily: "var(--slop-font-display)",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    background: active ? "var(--slop-magenta, #ff3ec9)" : "transparent",
    color: active ? "#06030d" : "var(--slop-text-muted)",
    border: "1px solid var(--slop-border, #2a1d4a)",
    borderRadius: 4,
    cursor: active ? "pointer" : "not-allowed",
  });

  const renderPoll = (poll: VotePoll) => {
    const isActive = poll.id === activeId;
    const isCreator = myKey !== null && poll.creatorKey === myKey;
    const myBallot = myKey ? poll.ballots.find(b => b.voterKey === myKey) : undefined;
    const total = poll.tally ? poll.tally.reduce((a, b) => a + b, 0) : 0;

    if (!isActive) {
      return (
        <button
          key={poll.id}
          type="button"
          onClick={() => setExpandedId(poll.id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            textAlign: "left",
            padding: "6px 8px",
            background: "rgba(255,255,255,0.02)",
            border: "1px solid var(--slop-border, #2a1d4a)",
            borderRadius: 4,
            color: "var(--slop-text-muted)",
            fontSize: 12,
            fontFamily: "var(--slop-font-body)",
            cursor: "pointer",
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {poll.question}
          </span>
          <span
            style={chipStyle(
              poll.status === "open"
                ? "var(--slop-lime, #b6ff3e)"
                : poll.status === "closed"
                  ? "#f5a623"
                  : "var(--slop-cyan, #3ee9ff)",
            )}
          >
            {poll.status}
          </span>
        </button>
      );
    }

    return (
      <div
        key={poll.id}
        style={{
          border: "1px solid var(--slop-border, #2a1d4a)",
          borderRadius: 6,
          background: "rgba(255,255,255,0.03)",
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, wordBreak: "break-word" }}>{poll.question}</div>
            <div
              style={{
                fontSize: 10,
                color: "var(--slop-text-muted)",
                marginTop: 2,
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
              }}
            >
              <span>
                by{" "}
                <SlopAddress
                  address={poll.address}
                  handle={poll.handle}
                  anonId={poll.anonId}
                  fallback={poll.creatorKey}
                  customNames={mesh.customNames}
                />
              </span>
              <span>
                · {poll.ballots.length} encrypted ballot{poll.ballots.length === 1 ? "" : "s"}
              </span>
              <span>
                · {poll.committee.threshold}-of-{poll.committee.size} threshold key
              </span>
            </div>
          </div>
          <span
            style={chipStyle(
              poll.status === "open"
                ? "var(--slop-lime, #b6ff3e)"
                : poll.status === "closed"
                  ? "#f5a623"
                  : "var(--slop-cyan, #3ee9ff)",
            )}
          >
            {poll.status}
          </span>
        </div>

        {poll.status === "revealed" && poll.tally ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {poll.options.map((opt, i) => {
              const count = poll.tally?.[i] ?? 0;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, marginBottom: 2, wordBreak: "break-word" }}>{opt}</div>
                    <div style={{ height: 10, background: "#0e0820", borderRadius: 3, overflow: "hidden" }}>
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          background: "linear-gradient(90deg, var(--slop-magenta, #ff3ec9), var(--slop-cyan, #3ee9ff))",
                          transition: "width 600ms ease",
                        }}
                      />
                    </div>
                  </div>
                  <div style={{ fontSize: 12, fontFamily: MONO, width: 64, textAlign: "right" }}>
                    {count} · {pct}%
                  </div>
                </div>
              );
            })}
            <div style={{ fontSize: 10, color: "var(--slop-text-muted)", fontStyle: "italic", marginTop: 2 }}>
              Only the aggregate was decrypted — every individual ballot below is ciphertext forever.
            </div>
            {poll.anchoring ? (
              <div style={{ fontSize: 10, fontFamily: MONO, color: "var(--slop-cyan, #3ee9ff)" }}>
                ⚓ anchoring result on-chain…
              </div>
            ) : poll.anchor ? (
              <div style={{ fontSize: 10, fontFamily: MONO }}>
                ⚓ anchored on {poll.anchor.chain === "mainnet" ? "Ethereum mainnet" : poll.anchor.chain}
                {" — "}
                {poll.anchor.explorerUrl ? (
                  <a
                    href={poll.anchor.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--slop-cyan, #3ee9ff)", wordBreak: "break-all" }}
                  >
                    {poll.anchor.txHash.slice(0, 10)}…{poll.anchor.txHash.slice(-6)}
                  </a>
                ) : (
                  <span style={{ wordBreak: "break-all" }}>{poll.anchor.txHash}</span>
                )}
              </div>
            ) : null}
          </div>
        ) : poll.status === "open" && !myBallot ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {poll.options.map((opt, i) => (
              <button
                key={i}
                type="button"
                disabled={busy || !myKey}
                onClick={() => castBallot(poll, i)}
                style={{
                  padding: "8px 10px",
                  textAlign: "left",
                  fontSize: 13,
                  fontFamily: "var(--slop-font-body)",
                  background: "#0e0820",
                  color: "var(--slop-text)",
                  border: "1px solid var(--slop-border, #2a1d4a)",
                  borderRadius: 4,
                  cursor: busy || !myKey ? "not-allowed" : "pointer",
                  wordBreak: "break-word",
                }}
              >
                🔒 {opt}
              </button>
            ))}
            <div style={{ fontSize: 10, color: "var(--slop-text-muted)", fontStyle: "italic" }}>
              Your choice is encrypted in this browser before it leaves — the server never sees it.
            </div>
          </div>
        ) : poll.status === "open" && myBallot ? (
          <div style={{ fontSize: 12, color: "var(--slop-lime, #b6ff3e)" }}>
            ✓ Your encrypted ballot is in. What the server got:{" "}
            <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--slop-text-muted)", wordBreak: "break-all" }}>
              {myBallot.preview}… ({(myBallot.size / 1024).toFixed(0)} KB of ciphertext)
            </span>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
            Poll closed — waiting for the committee to reveal the tally.
          </div>
        )}

        {poll.ballots.length > 0 && poll.status !== "revealed" ? (
          <div
            style={{
              background: "#06030d",
              border: "1px dashed var(--slop-border, #2a1d4a)",
              borderRadius: 4,
              padding: 6,
              maxHeight: 110,
              overflowY: "auto",
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--slop-text-muted)",
                marginBottom: 4,
              }}
            >
              👁 attacker view — everything the server stores
            </div>
            {poll.ballots.map(b => (
              <div
                key={b.voterKey}
                style={{ display: "flex", gap: 6, fontSize: 10, alignItems: "baseline", marginBottom: 2 }}
              >
                <span style={{ flexShrink: 0 }}>
                  <SlopAddress
                    address={b.address}
                    handle={b.handle}
                    anonId={b.anonId}
                    fallback={b.voterKey}
                    customNames={mesh.customNames}
                  />
                </span>
                <span
                  style={{
                    fontFamily: MONO,
                    color: "var(--slop-text-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {b.preview}…
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {isCreator && poll.status === "open" ? (
          <button type="button" disabled={busy} onClick={() => mesh.voteClose(poll.id)} style={buttonStyle(!busy)}>
            Close voting
          </button>
        ) : null}
        {isCreator && poll.status === "closed" ? (
          <button
            type="button"
            disabled={busy || poll.ballots.length === 0}
            onClick={() => revealTally(poll)}
            style={buttonStyle(!busy && poll.ballots.length > 0)}
          >
            🗝 Reveal tally ({poll.committee.threshold}-of-{poll.committee.size} ceremony)
          </button>
        ) : null}
        {isCreator ? (
          <button
            type="button"
            onClick={() => mesh.voteRemove(poll.id)}
            style={{
              alignSelf: "flex-end",
              background: "transparent",
              border: "none",
              color: "var(--slop-text-muted)",
              fontSize: 10,
              cursor: "pointer",
              padding: 0,
            }}
          >
            remove poll
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {showInfo ? (
          <div
            style={{
              border: "1px solid var(--slop-cyan, #3ee9ff)",
              borderRadius: 6,
              padding: 10,
              fontSize: 11,
              lineHeight: 1.5,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div
              style={{
                fontFamily: "var(--slop-font-display)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                fontSize: 10,
              }}
            >
              How private is this?
            </div>
            <div>
              <b>Real:</b> ballots are encrypted in your browser with threshold BFV (the same fhe.rs library that powers{" "}
              <a
                href="https://theinterfold.com"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--slop-cyan, #3ee9ff)" }}
              >
                The Interfold
              </a>
              &apos;s ciphernodes). The server stores only ciphertext and cannot read any ballot. The tally is computed
              by homomorphic addition — encrypted ballots are summed <i>without being decrypted</i> — and a{" "}
              {COMMITTEE_THRESHOLD}-of-
              {COMMITTEE_SIZE} committee ceremony decrypts only that aggregate.
            </div>
            <div>
              <b>Simulated (this demo):</b> the {COMMITTEE_SIZE} committee members run inside the poll creator&apos;s
              browser rather than as independent staked ciphernodes; the server trusts the creator&apos;s posted tally
              (no RISC Zero proof); and there&apos;s no ZK proof a ballot encrypts a valid one-hot vote. The production
              protocol —{" "}
              <a
                href="https://docs.theinterfold.com/CRISP/introduction"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--slop-cyan, #3ee9ff)" }}
              >
                CRISP
              </a>{" "}
              — closes all three gaps with on-chain E3s.
            </div>
            <button
              type="button"
              onClick={() => setShowInfo(false)}
              style={{ ...buttonStyle(true), alignSelf: "flex-start" }}
            >
              Got it
            </button>
          </div>
        ) : null}

        {creating ? (
          <div
            style={{
              border: "1px solid var(--slop-border, #2a1d4a)",
              borderRadius: 6,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <input
              type="text"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="the question…"
              maxLength={280}
              style={inputStyle}
            />
            {options.map((opt, i) => (
              <div key={i} style={{ display: "flex", gap: 4 }}>
                <input
                  type="text"
                  value={opt}
                  onChange={e => setOptions(prev => prev.map((o, j) => (j === i ? e.target.value : o)))}
                  placeholder={`option ${i + 1}`}
                  maxLength={120}
                  style={inputStyle}
                />
                {options.length > 2 ? (
                  <button
                    type="button"
                    onClick={() => setOptions(prev => prev.filter((_, j) => j !== i))}
                    aria-label="remove option"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--slop-text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
            {options.length < 8 ? (
              <button
                type="button"
                onClick={() => setOptions(prev => [...prev, ""])}
                style={{
                  alignSelf: "flex-start",
                  background: "transparent",
                  border: "1px dashed var(--slop-border, #2a1d4a)",
                  borderRadius: 4,
                  color: "var(--slop-text-muted)",
                  fontSize: 11,
                  padding: "4px 8px",
                  cursor: "pointer",
                }}
              >
                + option
              </button>
            ) : null}
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                disabled={busy || !question.trim() || options.filter(o => o.trim()).length < 2}
                onClick={createPoll}
                style={buttonStyle(!busy && !!question.trim() && options.filter(o => o.trim()).length >= 2)}
              >
                🔑 Run key ceremony &amp; open poll
              </button>
              <button type="button" disabled={busy} onClick={() => setCreating(false)} style={buttonStyle(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {polls.length === 0 && !creating ? (
          <div
            style={{
              color: "var(--slop-text-muted)",
              fontSize: 12,
              fontStyle: "italic",
              padding: 12,
              textAlign: "center",
            }}
          >
            No polls yet. Create one — the server won&apos;t be able to read a single ballot.
          </div>
        ) : (
          polls.map(renderPoll)
        )}
      </div>

      {phaseLabel() ? (
        <div
          style={{
            padding: "6px 8px",
            fontSize: 11,
            fontFamily: MONO,
            color: "var(--slop-cyan, #3ee9ff)",
            borderTop: "1px solid var(--slop-border, #2a1d4a)",
            background: "#0a061a",
          }}
        >
          {phaseLabel()}
        </div>
      ) : null}
      {phase.step === "error" ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "6px 8px",
            fontSize: 11,
            color: "#ff6b6b",
            borderTop: "1px solid var(--slop-border, #2a1d4a)",
            background: "#0a061a",
          }}
        >
          <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>⚠ {phase.message}</span>
          <button
            type="button"
            onClick={() => setPhase({ step: "idle" })}
            style={{ background: "transparent", border: "none", color: "var(--slop-text-muted)", cursor: "pointer" }}
          >
            ×
          </button>
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          borderTop: "1px solid var(--slop-border, #2a1d4a)",
          background: "#06030d",
        }}
      >
        {!creating ? (
          <button
            type="button"
            disabled={busy || !myKey}
            onClick={() => setCreating(true)}
            style={buttonStyle(!busy && !!myKey)}
          >
            New poll
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setShowInfo(v => !v)}
          style={{
            marginLeft: "auto",
            marginRight: 50,
            background: "transparent",
            border: "none",
            color: "var(--slop-cyan, #3ee9ff)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          ⓘ how private is this?
        </button>
      </div>
    </div>
  );
};

export default VotingWindow;

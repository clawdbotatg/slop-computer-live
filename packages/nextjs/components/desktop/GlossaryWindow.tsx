"use client";

import { useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import type { GlossaryTerm, PeerMeshState } from "~~/hooks/usePeerMesh";
import { useSyncedScroll } from "~~/hooks/useSyncedScroll";

// Shared glossary — type a term, hit Add, and the relay's AI fills in a
// one-sentence TLDR a moment later. All terms are visible to every peer.
// While the AI request is in flight an entry shows status="pending" and
// renders a small loader; once it resolves the TLDR text replaces it.

export type GlossaryWindowProps = {
  mesh: PeerMeshState;
};

export const GlossaryWindow = ({ mesh }: GlossaryWindowProps) => {
  const { glossary, glossaryAdd, glossaryRegenerate, glossaryDelete } = mesh;
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Multiplayer scroll sync — the glossary list follows whoever
  // scrolled most recently in the room.
  const onScroll = useSyncedScroll(mesh, "glossary", listRef);

  // Newest-first, but stable: createdTs is server-stamped at add-time and
  // never updates, unlike updatedTs which bumps when the AI TLDR lands.
  const sorted = useMemo(() => [...glossary].sort((a, b) => b.createdTs - a.createdTs), [glossary]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    glossaryAdd(trimmed);
    setDraft("");
    inputRef.current?.focus();
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
      {/* Add bar */}
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderBottom: "1px solid var(--slop-border, #2a1d4a)",
          background: "#0a061a",
          flexShrink: 0,
        }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="add a term — e.g. EIP-712, MEV, MUD…"
          spellCheck={false}
          style={{
            flex: 1,
            background: "#06030d",
            color: "var(--slop-text)",
            border: "1px solid rgba(255,62,201,0.25)",
            borderRadius: 4,
            padding: "5px 8px",
            font: "inherit",
            fontSize: 13,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          style={{
            padding: "5px 12px",
            fontSize: 10,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            background: draft.trim() ? "var(--slop-magenta, #ff3ec9)" : "rgba(255,62,201,0.25)",
            color: "#06030d",
            border: "none",
            borderRadius: 4,
            cursor: draft.trim() ? "pointer" : "not-allowed",
            fontWeight: 700,
          }}
        >
          Add
        </button>
      </form>

      {/* List */}
      <div ref={listRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {sorted.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: "center",
              color: "var(--slop-text-muted)",
              fontSize: 12,
            }}
          >
            no terms yet — add one above and the AI will write a one-liner for it.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {sorted.map(t => (
              <GlossaryRow
                key={t.id}
                entry={t}
                onRegenerate={() => glossaryRegenerate(t.id)}
                onDelete={() => glossaryDelete(t.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const GlossaryRow = ({
  entry,
  onRegenerate,
  onDelete,
}: {
  entry: GlossaryTerm;
  onRegenerate: () => void;
  onDelete: () => void;
}) => {
  const status = entry.status;
  const tldr = entry.tldr;

  return (
    <li
      style={{
        padding: "10px 12px",
        borderBottom: "1px solid var(--slop-border, #2a1d4a)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontWeight: 700,
            fontSize: 13,
            color: "var(--slop-magenta, #ff3ec9)",
            wordBreak: "break-word",
          }}
        >
          {entry.term}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onRegenerate}
          aria-label="regenerate TLDR"
          title="regenerate TLDR"
          style={iconButtonStyle}
        >
          ↻
        </button>
        <button type="button" onClick={onDelete} aria-label="delete term" title="delete term" style={iconButtonStyle}>
          ×
        </button>
      </div>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.4,
          color: status === "ready" ? "var(--slop-text)" : "var(--slop-text-muted)",
          fontStyle: status === "pending" ? "italic" : "normal",
        }}
      >
        {status === "pending" ? "thinking…" : tldr || "(no definition)"}
      </div>
      <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
        {entry.address ? (
          <Address address={entry.address as AddressType} size="xs" onlyEnsOrAddress />
        ) : (
          <span>{entry.handle ?? "anon"}</span>
        )}
      </div>
    </li>
  );
};

const iconButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,62,201,0.3)",
  color: "var(--slop-text-muted)",
  width: 22,
  height: 22,
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

export default GlossaryWindow;

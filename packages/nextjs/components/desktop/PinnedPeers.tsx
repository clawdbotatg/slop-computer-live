"use client";

import { useEffect, useRef, useState } from "react";
import { SlopAddress } from "~~/components/ui";
import { type Peer, peerLabel } from "~~/hooks/usePeerMesh";

// Always-visible "who's here" panel pinned to the top-right of the
// viewport, sitting just under the menubar. Replaces the old
// (X guests ▾) dropdown that used to live in the menubar itself.
// Position is per-peer (fixed in viewport coords), not in the shared
// slot system — every viewer has their own top-right corner.
//
// Z-index sits between desktop icons (z=1) and the menubar
// dropdowns (9100), so a sign-out / power dropdown opening will
// naturally overlay the list. Windows can still cover it (windows
// can climb past 50), matching the trash can's behavior.

export type PinnedPeersProps = {
  peers: Peer[];
  myId: string | null;
  customNames: Record<string, string>;
  onSetCustomName: (name: string | null) => void;
};

const MENUBAR_HEIGHT = 38;
const TOP_GAP = 10;
const MAX_NAME_LEN = 30;

export const PinnedPeers = ({ peers, myId, customNames, onSetCustomName }: PinnedPeersProps) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const me = peers.find(p => p.id === myId) ?? null;
  const myLower = me?.address?.toLowerCase() ?? null;
  const myCurrentName = myLower ? (customNames[myLower] ?? "") : "";
  const canEdit = !!me?.address;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = () => {
    if (!canEdit) return;
    setDraft(myCurrentName);
    setEditing(true);
  };

  const commit = () => {
    const trimmed = draft.trim();
    onSetCustomName(trimmed === "" ? null : trimmed.slice(0, MAX_NAME_LEN));
    setEditing(false);
  };

  const cancel = () => setEditing(false);

  return (
    <div
      style={{
        position: "fixed",
        top: MENUBAR_HEIGHT + TOP_GAP,
        right: 14,
        zIndex: 50,
        minWidth: 220,
        maxWidth: 300,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        background: "linear-gradient(180deg, rgba(20,10,40,0.92) 0%, rgba(6,3,13,0.92) 100%)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255,62,201,0.45)",
        borderRadius: 8,
        boxShadow: "0 8px 24px #000a, 0 0 16px rgba(255,62,201,0.18)",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        fontSize: 12,
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontFamily: "var(--slop-font-display)",
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--slop-text-muted)",
          paddingBottom: 4,
          borderBottom: "1px solid rgba(255,62,201,0.18)",
        }}
      >
        {peers.length} guest{peers.length === 1 ? "" : "s"}
      </div>
      {peers.length === 0 ? (
        <div style={{ color: "var(--slop-text-muted)", fontStyle: "italic", padding: "4px 2px" }}>just you so far.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {peers.map(p => {
            const isMe = p.id === myId;
            const showEditor = isMe && editing;
            return (
              <li
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 4,
                  background: isMe ? "rgba(255,62,201,0.14)" : "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(255,255,255,0.04)",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                    flex: 1,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    fontWeight: p.role === "host" ? 600 : undefined,
                  }}
                >
                  {showEditor ? (
                    <input
                      ref={inputRef}
                      className="slop-textfield"
                      value={draft}
                      maxLength={MAX_NAME_LEN}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commit();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancel();
                        }
                      }}
                      onBlur={commit}
                      placeholder={peerLabel(p, customNames)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12,
                        padding: "2px 4px",
                      }}
                    />
                  ) : (
                    <>
                      <SlopAddress address={p.address} handle={p.handle} fallback={p.id} customNames={customNames} />
                      {isMe && canEdit ? (
                        <button
                          type="button"
                          onClick={startEdit}
                          aria-label="edit name"
                          title="edit your name"
                          style={{
                            background: "transparent",
                            border: 0,
                            cursor: "pointer",
                            padding: 0,
                            margin: "0 0 0 2px",
                            lineHeight: 1,
                            fontSize: 11,
                          }}
                        >
                          ✏️
                        </button>
                      ) : null}
                    </>
                  )}
                </span>
                <span
                  style={{
                    color: "var(--slop-text-muted)",
                    fontSize: 10,
                    fontFamily: "var(--slop-font-display)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    flexShrink: 0,
                  }}
                >
                  {p.role}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default PinnedPeers;

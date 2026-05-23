"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Peer, PeerMeshState } from "~~/hooks/usePeerMesh";

// Static on-screen "headline" — single line of text the host writes
// during a live show (or that an AI agent could write from the
// transcript). Pinned above the Twitter timeline bar; collapses to
// zero height on every peer when empty so it doesn't take up space
// until a headline is actually set.
//
// Edit UX (host only):
//   - empty + host: a small "+ HEADLINE" pill in the bottom-left
//     corner is the only visible affordance. Click to open the
//     editor inline.
//   - filled + host: click the banner text to edit it.
//   - filled + non-host (and empty + non-host): read-only / nothing.
//
// State is relay-broadcast via mesh.headlineState — no optimistic
// update; the WS echo is the source of truth.

const BAR_HEIGHT = 44;
// Sized for broadcast capture (1920×1080) — 33px reads at a glance
// from across the room without dwarfing the bars stacked below it.
const FONT_SIZE = 33;
// TimelineBar (24) + HeadlinesBar (24) + TickerBar (28) = 76. Sit
// directly on top.
const STACK_BOTTOM = 76;

export type MarqueeHeadlineProps = {
  mesh: PeerMeshState;
};

export const MarqueeHeadline = ({ mesh }: MarqueeHeadlineProps) => {
  const text = mesh.headlineState?.text ?? "";
  const isHost = useMemo(
    () => (mesh.peers as Peer[]).some(p => p.id === mesh.myId && p.role === "host"),
    [mesh.peers, mesh.myId],
  );

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus + select-all when editing opens. Selecting the existing
  // text lets the host either retype from scratch (just start typing)
  // or tweak (arrow keys / click to deselect first).
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  if (!isHost && !text) return null;

  const openEditor = () => {
    if (!isHost) return;
    setDraft(text);
    setEditing(true);
  };

  const commit = () => {
    mesh.setHeadline(draft);
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
    setDraft("");
  };

  // Empty + host: just the small "+ HEADLINE" affordance, no full bar.
  // Visual footprint stays near-zero so an unused headline doesn't eat
  // broadcast pixels.
  if (!text && !editing) {
    return (
      <button
        type="button"
        onClick={openEditor}
        aria-label="Add headline"
        title="Add headline"
        style={{
          position: "fixed",
          left: 8,
          bottom: STACK_BOTTOM + 6,
          zIndex: 60,
          padding: "2px 10px",
          background: "rgba(124,77,255,0.18)",
          border: "1px dashed rgba(124,77,255,0.55)",
          borderRadius: 4,
          color: "rgba(220,210,255,0.75)",
          fontFamily: "var(--slop-font-display)",
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          cursor: "pointer",
          appearance: "none",
          WebkitAppearance: "none",
          pointerEvents: "auto",
        }}
      >
        + headline
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: STACK_BOTTOM,
        height: BAR_HEIGHT,
        background: "linear-gradient(180deg, rgba(6,8,24,0.96) 0%, rgba(10,15,36,0.96) 100%)",
        borderTop: "1px solid rgba(124,77,255,0.30)",
        borderBottom: "1px solid rgba(124,77,255,0.18)",
        zIndex: 60,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        userSelect: "none",
        // Outer bar passes drags through (same convention as the other
        // bars); editable area below re-enables pointer events.
        pointerEvents: "none",
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={280}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          placeholder="headline…"
          style={{
            width: "min(90vw, 1400px)",
            background: "transparent",
            border: "none",
            outline: "none",
            textAlign: "center",
            color: "var(--slop-text)",
            fontFamily: "var(--slop-font-display)",
            fontSize: FONT_SIZE,
            letterSpacing: "0.04em",
            textShadow: "0 1px 0 rgba(0,0,0,0.55)",
            caretColor: "var(--slop-cyan)",
            pointerEvents: "auto",
          }}
        />
      ) : (
        <button
          type="button"
          onClick={openEditor}
          // Disable click for non-hosts so the cursor doesn't promise
          // an edit affordance they don't have. Non-hosts still see
          // the text — it's just static.
          disabled={!isHost}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--slop-text)",
            fontFamily: "var(--slop-font-display)",
            fontSize: FONT_SIZE,
            letterSpacing: "0.04em",
            textShadow: "0 1px 0 rgba(0,0,0,0.55)",
            padding: "0 24px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "min(90vw, 1400px)",
            cursor: isHost ? "text" : "default",
            pointerEvents: "auto",
            appearance: "none",
            WebkitAppearance: "none",
          }}
        >
          {text}
        </button>
      )}
    </div>
  );
};

export default MarqueeHeadline;

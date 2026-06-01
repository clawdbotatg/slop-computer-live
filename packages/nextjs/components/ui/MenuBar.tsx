"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LivePulse } from "./LivePulse";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import { sessionLabel, useSession } from "~~/hooks/useSession";
import { readStoredRoomPassword } from "~~/utils/roomPassword";

export type MenuItem = {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  shortcut?: string;
  divider?: boolean;
  /** When present, this row becomes a parent that opens a flyout panel to
   *  the right on hover (its own onClick is ignored). An empty array
   *  renders an "(empty)" placeholder. */
  submenu?: MenuItem[];
  /** Renders a small ✕ affordance on the row that fires this instead of
   *  the row's onClick (and leaves the menu open). Used for delete-in-place
   *  rows like saved layouts. */
  onDelete?: () => void;
  /** Makes the row a drag SOURCE and drop TARGET for manual reordering.
   *  Fires when something is dropped on this row — `position` is
   *  "before" (top half) or "after" (bottom half), `draggedLabel` is
   *  the moved row's label. The caller closes over its own row identity
   *  to know which row was the drop target. */
  onReorder?: (draggedLabel: string, position: "before" | "after") => void;
};

export type Menu = {
  label: string;
  items: MenuItem[];
};

interface MenuBarProps {
  brand?: string;
  isLive?: boolean;
  right?: React.ReactNode;
  className?: string;
  /** Cascading menus rendered to the right of the brand. */
  menus?: Menu[];
  /** Connection status pulse on the far right uses this; the peer list
   *  itself moved out of the menubar — see `<PinnedPeers>` for the
   *  always-visible top-right HUD. */
  meshConnected?: boolean;
  /** True when this client is the god-mode streaming box. Renders 🛰️
   *  in the menubar at all times so the operator can confirm STT is
   *  wired up at a glance. */
  godActive?: boolean;
  /** True when god-mode has at least one server-side STT recorder open
   *  — i.e. a peer in the room is currently being transcribed. Drives
   *  the cyan halo behind 🛰️ that grows + glows during speech and
   *  shrinks during silence. */
  godListening?: boolean;
  /** True when the local browser supports Web Speech and this peer
   *  is wired up to broadcast in-browser STT captions (own desktop
   *  session, not god-mode). Renders 🎙️ in the menubar so the
   *  speaker can confirm at a glance that captions are flying off
   *  their own machine and not waiting on the god-mode round trip. */
  localSttSupported?: boolean;
  /** True while a SpeechRecognition session is actively running.
   *  Drives the magenta halo around 🎙️. */
  localSttListening?: boolean;
  /** Last recognizer error, surfaced in the title attribute so the
   *  user can hover the 🎙️ to see why captions stopped (denied
   *  perms, recognizer crash, no-speech). `null` means everything
   *  is healthy. */
  localSttError?: string | null;
  /** Monotonically-incrementing counter — bumps on every Web Speech
   *  `onresult` event. Drives a brief flash on the 🎙️ halo so the
   *  speaker can confirm interims are firing word-by-word and the
   *  caption pipeline isn't actually stalled waiting on a sentence-
   *  end finalize. */
  localSttResultTick?: number;
  /** Optional session-wallet chip. If a wallet address is supplied
   *  we render the Address component as a clickable chip; otherwise
   *  a "Deploy wallet" link. Clicking either opens the wallet window. */
  walletAddress?: string | null;
  onWalletClick?: () => void;
  /** God-mode only: when provided, render a 🔊 button on the far
   *  right that pops the audio-mixer / EQ panel in a separate window.
   *  null/undefined hides it. */
  onEqClick?: (() => void) | null;
  /** Room slug — surfaced in the SlopMenu dropdown as a clickable
   *  link to slop.computer/<slug> (not live.slop.computer). */
  slug?: string;
}

export const MenuBar = ({
  brand = "slop.computer",
  isLive = false,
  right,
  className = "",
  menus = [],
  meshConnected,
  godActive = false,
  godListening = false,
  localSttSupported = false,
  localSttListening = false,
  localSttError = null,
  localSttResultTick = 0,
  walletAddress,
  onWalletClick,
  onEqClick = null,
  slug,
}: MenuBarProps) => {
  const { session, signOut } = useSession();

  // Pulse the 🎙️ halo briefly on every Web Speech result event so the
  // user can see word-by-word firing. Holds for 220ms past the latest
  // tick, then settles back to the calm "listening" state.
  const [sttPulse, setSttPulse] = useState(false);
  useEffect(() => {
    if (!localSttResultTick) return;
    setSttPulse(true);
    const id = window.setTimeout(() => setSttPulse(false), 220);
    return () => window.clearTimeout(id);
  }, [localSttResultTick]);

  const authNode = session.authenticated ? (
    <PowerMenu
      onSignOut={async () => {
        await signOut();
        window.location.href = process.env.NEXT_PUBLIC_AUDIENCE_URL || "https://slop.computer/";
      }}
    />
  ) : (
    <Link href="/join" className="slop-menubar__item" style={{ textDecoration: "none", color: "inherit" }}>
      {sessionLabel(session)}
    </Link>
  );

  // Right-to-left: Online/Offline (far right) · Sign out. The
  // guest list used to live here as a dropdown — it's now a
  // separate always-visible <PinnedPeers> panel rendered in
  // page.tsx, pinned to the top-right just below the menubar.
  return (
    <div className={`slop-menubar ${className}`.trim()}>
      <SlopMenu brand={brand} slug={slug} />
      {/* Brand replaced by SlopMenu (the apple-menu equivalent). */}
      {menus.map(menu => (
        <Dropdown key={menu.label} menu={menu} />
      ))}
      <span className="flex-1" />
      {right ?? (
        <span className="slop-menubar__status" style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
          {onWalletClick ? (
            <button
              type="button"
              onClick={onWalletClick}
              className="slop-menubar__item"
              // Anchor the flying /tip card animates toward (see FlyingTipCard).
              id="slop-multisig-anchor"
              title={walletAddress ? "Open session wallet" : "No wallet deployed yet — click to deploy"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                color: "inherit",
                font: "inherit",
                letterSpacing: "inherit",
                textTransform: "inherit",
                cursor: "pointer",
                margin: 0,
                border: 0,
                background: "transparent",
                padding: "0 8px",
              }}
            >
              {walletAddress ? (
                <Address address={walletAddress as AddressType} size="xs" onlyEnsOrAddress />
              ) : (
                <span style={{ color: "var(--slop-magenta, #ff3ec9)" }}>[ deploy wallet ]</span>
              )}
            </button>
          ) : null}
          {authNode}
          {onEqClick ? (
            <button
              type="button"
              onClick={onEqClick}
              className="slop-menubar__item"
              title="Open audio mixer + EQ in a new window"
              aria-label="audio mixer"
              style={{
                cursor: "pointer",
                fontSize: 14,
                padding: "0 6px",
                background: "transparent",
                border: 0,
                color: "inherit",
                font: "inherit",
                letterSpacing: "inherit",
                textTransform: "inherit",
                margin: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              🔊
            </button>
          ) : null}
          {godActive ? (
            <span
              className="slop-menubar__item"
              style={{
                cursor: "help",
                fontSize: 14,
                padding: "0 6px",
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title={
                godListening
                  ? "god is listening — server-side STT is actively transcribing a peer right now"
                  : "god-mode STT wired up — waiting for someone to talk"
              }
              aria-label={godListening ? "god is listening" : "god-mode STT idle"}
            >
              {/* Cyan halo behind the satellite. Faint at idle so the
                  operator can see the wiring is up; expands + glows
                  whenever a peer's audio is being captured. */}
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  width: godListening ? 24 : 8,
                  height: godListening ? 24 : 8,
                  borderRadius: "50%",
                  background: "var(--slop-cyan)",
                  opacity: godListening ? 0.55 : 0.18,
                  boxShadow: godListening ? "0 0 14px 2px var(--slop-cyan)" : "0 0 4px var(--slop-cyan)",
                  transform: "translate(-50%, -50%)",
                  transition: "width 220ms ease, height 220ms ease, opacity 220ms ease, box-shadow 220ms ease",
                  pointerEvents: "none",
                  zIndex: 0,
                }}
              />
              <span style={{ position: "relative", zIndex: 1 }}>🛰️</span>
            </span>
          ) : null}
          {localSttSupported ? (
            <span
              className="slop-menubar__item"
              style={{
                cursor: "help",
                fontSize: 14,
                padding: "0 6px",
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                // Honest indicator. Full opacity when local STT is actively
                // running (listening) — your captions ride your browser.
                // Half when it's merely *supported* but idle (gate closed:
                // mic unpublished, self-muted, or captions/STT off) so you can
                // see local COULD engage but isn't — you're on the slower
                // god-mode round-trip until it does.
                opacity: localSttListening ? 1 : 0.5,
                transition: "opacity 280ms ease",
              }}
              title={
                localSttError
                  ? `local STT error: ${localSttError} — falling back to god-mode captions for this speaker`
                  : localSttListening
                    ? "🎙️ local Web Speech STT is live — your captions ride your browser, not the server"
                    : "🎙️ local STT wired up — will engage when you start talking"
              }
              aria-label={localSttListening ? "local STT listening" : "local STT idle"}
            >
              {/* Magenta halo to distinguish from god-mode's cyan one.
                  Calm size when idle, swells when the recognizer is
                  running, and FLASHES bright + larger on every onresult
                  tick so word-by-word interim activity reads visually. */}
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  width: sttPulse ? 30 : localSttListening ? 22 : 8,
                  height: sttPulse ? 30 : localSttListening ? 22 : 8,
                  borderRadius: "50%",
                  background: "var(--slop-magenta, #ff3ec9)",
                  opacity: localSttError ? 0.4 : sttPulse ? 0.85 : localSttListening ? 0.5 : 0.18,
                  boxShadow: sttPulse
                    ? "0 0 20px 4px var(--slop-magenta, #ff3ec9)"
                    : localSttListening
                      ? "0 0 12px 2px var(--slop-magenta, #ff3ec9)"
                      : "0 0 4px var(--slop-magenta, #ff3ec9)",
                  transform: "translate(-50%, -50%)",
                  // Snappy on the way in (pulse hit), gentle on settle —
                  // matches how the eye expects a recognition flash to
                  // feel.
                  transition: sttPulse
                    ? "width 80ms ease-out, height 80ms ease-out, opacity 80ms ease-out, box-shadow 80ms ease-out"
                    : "width 280ms ease-in, height 280ms ease-in, opacity 280ms ease-in, box-shadow 280ms ease-in",
                  pointerEvents: "none",
                  zIndex: 0,
                  filter: localSttError ? "grayscale(0.5)" : "none",
                }}
              />
              <span
                style={{
                  position: "relative",
                  zIndex: 1,
                  opacity: localSttError ? 0.5 : 1,
                }}
              >
                🎙️
              </span>
            </span>
          ) : null}
          <span
            className="slop-menubar__item"
            style={{ cursor: "help" }}
            title={
              meshConnected !== undefined
                ? meshConnected
                  ? "Online — connected to the slop relay over a WebSocket. Mesh signaling, cursor sync, and shared layout updates all flow."
                  : "Offline — WebSocket to the relay is down. Auto-reconnecting every 2s. Check your network or auth."
                : isLive
                  ? "On Air — the show is live (contract isLive() = true)."
                  : "Off Air — the show is not currently broadcasting."
            }
          >
            <LivePulse live={isLive || (meshConnected ?? false)} />
          </span>
        </span>
      )}
    </div>
  );
};

// Shared dropdown-panel chrome — reused by both the root menu panel and any
// flyout submenu so they stay visually identical.
const MENU_PANEL_STYLE: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(20,10,40,0.96) 0%, rgba(6,3,13,0.96) 100%)",
  backdropFilter: "blur(12px)",
  border: "1px solid rgba(255,62,201,0.5)",
  borderRadius: 8,
  boxShadow: "0 12px 32px #000c, 0 0 24px rgba(255,62,201,0.3)",
  padding: 4,
  zIndex: 9100,
  color: "var(--slop-text)",
  textTransform: "none",
};

const rowStyle = (disabled?: boolean): React.CSSProperties => ({
  display: "flex",
  width: "100%",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "5px 12px",
  background: "transparent",
  border: 0,
  color: disabled ? "var(--slop-text-muted)" : "var(--slop-text)",
  font: "inherit",
  cursor: disabled ? "not-allowed" : "pointer",
  borderRadius: 4,
  textAlign: "left",
  letterSpacing: "0.04em",
});

const highlightRow = (el: HTMLElement) => {
  el.style.background = "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-magenta-dim, #c41a96) 100%)";
  el.style.color = "#fff";
};
const unhighlightRow = (el: HTMLElement, disabled?: boolean) => {
  el.style.background = "transparent";
  el.style.color = disabled ? "var(--slop-text-muted)" : "var(--slop-text)";
};

// One row of a dropdown — a plain action, or (if it has `submenu`) a parent
// that opens a flyout panel to the right on hover. Recurses for nested
// submenus. `closeRoot` collapses the whole menu after a leaf action fires.
function MenuRow({ item, closeRoot }: { item: MenuItem; closeRoot: () => void }) {
  const [subOpen, setSubOpen] = useState(false);
  // Drag-reorder state: which half of THIS row the drag cursor is in,
  // null when nothing is hovering. Drives the magenta insertion line
  // and the "before/after" decision on drop.
  const [dragOver, setDragOver] = useState<"before" | "after" | null>(null);
  const hasSub = Array.isArray(item.submenu);
  const reorderable = !!item.onReorder;

  if (item.divider) {
    return (
      <div
        style={{
          height: 1,
          background:
            "repeating-linear-gradient(90deg, rgba(255,62,201,0.4) 0, rgba(255,62,201,0.4) 4px, transparent 4px, transparent 8px)",
          margin: "4px 6px",
        }}
      />
    );
  }

  // Drop-target handlers live on the wrapper so moving within the row's
  // children doesn't bounce dragLeave. Drag-source handlers stay on the
  // button — only the button is `draggable`.
  const onDragOver = (e: React.DragEvent) => {
    if (!reorderable) return;
    // Only accept the drop if there's actually a payload from a sibling
    // row. (Files dragged from the OS would also fire onDragOver here;
    // checking types keeps them from being treated as reorders.)
    if (!Array.from(e.dataTransfer.types).includes("application/x-slop-menu-row")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    const next: "before" | "after" = e.clientY < mid ? "before" : "after";
    if (next !== dragOver) setDragOver(next);
  };
  const onDragLeave = () => setDragOver(null);
  const onDrop = (e: React.DragEvent) => {
    if (!reorderable) return;
    e.preventDefault();
    const dragged = e.dataTransfer.getData("application/x-slop-menu-row");
    const pos = dragOver;
    setDragOver(null);
    if (!dragged || dragged === item.label || !pos) return;
    item.onReorder?.(dragged, pos);
  };
  const onDragStart = (e: React.DragEvent) => {
    if (!reorderable) return;
    // Custom MIME type so we can distinguish reorder drags from OS file
    // drops landing on the desktop (Desktop.tsx wires its own onDrop).
    e.dataTransfer.setData("application/x-slop-menu-row", item.label);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragEnd = () => setDragOver(null);

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={hasSub ? () => setSubOpen(true) : undefined}
      onMouseLeave={hasSub ? () => setSubOpen(false) : undefined}
      onDragOver={reorderable ? onDragOver : undefined}
      onDragLeave={reorderable ? onDragLeave : undefined}
      onDrop={reorderable ? onDrop : undefined}
    >
      <button
        type="button"
        disabled={item.disabled}
        draggable={reorderable}
        onDragStart={reorderable ? onDragStart : undefined}
        onDragEnd={reorderable ? onDragEnd : undefined}
        onClick={() => {
          if (hasSub) return; // parent rows only fly out — they don't act
          closeRoot();
          item.onClick?.();
        }}
        style={{ ...rowStyle(item.disabled), cursor: reorderable ? "grab" : rowStyle(item.disabled).cursor }}
        onMouseEnter={e => {
          if (!item.disabled) highlightRow(e.currentTarget);
        }}
        onMouseLeave={e => unhighlightRow(e.currentTarget, item.disabled)}
      >
        <span style={{ whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 8 }}>
          {item.label}
          {item.onDelete ? (
            <span
              role="button"
              aria-label={`Delete ${item.label}`}
              title="Delete"
              onClick={e => {
                e.stopPropagation();
                item.onDelete?.();
              }}
              style={{ opacity: 0.55, fontSize: 11, padding: "0 2px", cursor: "pointer" }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLSpanElement).style.opacity = "1";
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLSpanElement).style.opacity = "0.55";
              }}
            >
              ✕
            </span>
          ) : null}
        </span>
        {hasSub ? (
          <span aria-hidden style={{ marginLeft: 24 }}>
            ▸
          </span>
        ) : item.shortcut ? (
          <span style={{ marginLeft: 24, color: "var(--slop-text-muted)", whiteSpace: "nowrap" }}>{item.shortcut}</span>
        ) : null}
      </button>
      {dragOver ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 4,
            right: 4,
            [dragOver === "before" ? "top" : "bottom"]: -1,
            height: 2,
            background: "var(--slop-cyan)",
            boxShadow: "0 0 6px var(--slop-cyan)",
            pointerEvents: "none",
            zIndex: 2,
          }}
        />
      ) : null}
      {hasSub && subOpen && !item.disabled ? (
        <div style={{ ...MENU_PANEL_STYLE, position: "absolute", top: -4, left: "100%", minWidth: 200 }}>
          {item.submenu!.length === 0 ? (
            <div
              style={{
                padding: "6px 12px",
                color: "var(--slop-text-muted)",
                fontSize: 12,
                fontStyle: "italic",
                whiteSpace: "nowrap",
              }}
            >
              (empty)
            </div>
          ) : (
            item.submenu!.map((sub, i) => <MenuRow key={i} item={sub} closeRoot={closeRoot} />)
          )}
        </div>
      ) : null}
    </div>
  );
}

function Dropdown({ menu }: { menu: Menu }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="slop-menubar__item"
        style={{
          color: "inherit",
          font: "inherit",
          letterSpacing: "inherit",
          textTransform: "inherit",
          cursor: "pointer",
          margin: 0,
        }}
      >
        {menu.label} <span aria-hidden>▾</span>
      </button>
      {open ? (
        <div style={{ ...MENU_PANEL_STYLE, position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 260 }}>
          {menu.items.map((item, i) => (
            <MenuRow key={i} item={item} closeRoot={() => setOpen(false)} />
          ))}
        </div>
      ) : null}
    </span>
  );
}

function PowerMenu({ onSignOut }: { onSignOut: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const itemStyle: React.CSSProperties = {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    padding: "6px 12px",
    background: "transparent",
    border: 0,
    color: "var(--slop-text)",
    font: "inherit",
    cursor: "pointer",
    borderRadius: 4,
    letterSpacing: "0.04em",
  };
  const onItemHover = (e: React.MouseEvent<HTMLButtonElement>) => {
    (e.currentTarget as HTMLButtonElement).style.background =
      "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-magenta-dim, #c41a96) 100%)";
    (e.currentTarget as HTMLButtonElement).style.color = "#fff";
  };
  const onItemLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    (e.currentTarget as HTMLButtonElement).style.background = "transparent";
    (e.currentTarget as HTMLButtonElement).style.color = "var(--slop-text)";
  };

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="Power menu"
        title="Power"
        className="slop-menubar__item"
        style={{
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
          margin: 0,
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          aria-hidden
        >
          {/* IEC power glyph: arc opening at top, vertical line through the gap. */}
          <path d="M5.5 9 A 8 8 0 1 0 18.5 9" />
          <line x1="12" y1="3.5" x2="12" y2="12.5" />
        </svg>
      </button>
      {open ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 160,
            background: "linear-gradient(180deg, rgba(20,10,40,0.96) 0%, rgba(6,3,13,0.96) 100%)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255,62,201,0.5)",
            borderRadius: 8,
            boxShadow: "0 12px 32px #000c, 0 0 24px rgba(255,62,201,0.3)",
            padding: 4,
            zIndex: 9100,
            color: "var(--slop-text)",
            textTransform: "none",
          }}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void onSignOut();
            }}
            style={itemStyle}
            onMouseEnter={onItemHover}
            onMouseLeave={onItemLeave}
          >
            [ sign out ]
          </button>
        </div>
      ) : null}
    </span>
  );
}

// "Apple-menu" equivalent: the slop.computer brand + a dropdown with the
// session-wide actions. The dropdown leads with the room slug (clickable —
// opens the public slop.computer/<slug> URL, not the live. subdomain) and
// is followed by [ copy skill ] which mints an agent token and copies a
// fetchable skill URL to the clipboard for pasting into a local LLM.
function SlopMenu({ brand, slug }: { brand: string; slug?: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const [linkStatus, setLinkStatus] = useState<"idle" | "copied" | "failed">("idle");
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Copy a shareable link to this room on the live. subdomain (the current
  // origin) with the room password baked into `?invite=` so the recipient
  // clears the password gate on landing. The password is whatever this
  // browser cached when it last passed the gate — the same value
  // PasswordGate replays on mount.
  const copyLink = async () => {
    if (!slug) return;
    try {
      const password = readStoredRoomPassword(slug);
      const base = `${window.location.origin}/${slug}`;
      const url = password ? `${base}?invite=${encodeURIComponent(password)}` : base;
      await navigator.clipboard.writeText(url);
      setLinkStatus("copied");
      setTimeout(() => {
        setLinkStatus("idle");
        setOpen(false);
      }, 1200);
    } catch {
      setLinkStatus("failed");
      setTimeout(() => setLinkStatus("idle"), 1500);
    }
  };

  const copySkill = async () => {
    setStatus("copying");
    try {
      const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
      // Mint the token scoped to the current room — the relay locks the
      // agent token to whatever slug is passed here, so it must carry the
      // room or the agent ends up scoped to the debug sandbox instead.
      const tokenSlugParam = slug ? `?slug=${encodeURIComponent(slug)}` : "";
      const tokenRes = await fetch(`${RELAY_HTTP}/v1/agent-token${tokenSlugParam}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
      const { token } = (await tokenRes.json()) as { token: string };
      // Copy a single URL (with the token as auth + embed) rather than the
      // full markdown body. Way nicer for "follow this skill: <url>" agent
      // prompts than pasting a multi-KB markdown file.
      // Bake in the current room's slug so every example in the served
      // skill is pre-filled with the room the host is actually in —
      // no `<slug>` placeholders for the agent to substitute.
      const slugParam = slug ? `&slug=${encodeURIComponent(slug)}` : "";
      const url = `${RELAY_HTTP}/v1/skill?token=${encodeURIComponent(token)}${slugParam}`;
      await navigator.clipboard.writeText(url);
      setStatus("copied");
      setTimeout(() => {
        setStatus("idle");
        setOpen(false);
      }, 1200);
    } catch {
      setStatus("failed");
      setTimeout(() => setStatus("idle"), 1500);
    }
  };

  const itemStyle: React.CSSProperties = {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "flex-start",
    padding: "5px 12px",
    background: "transparent",
    border: 0,
    color: "var(--slop-text)",
    font: "inherit",
    cursor: "pointer",
    borderRadius: 4,
    letterSpacing: "0.04em",
    textAlign: "left",
  };

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="slop-menubar__brand slop-menubar__item"
        style={{
          color: "inherit",
          font: "inherit",
          letterSpacing: "inherit",
          textTransform: "inherit",
          cursor: "pointer",
          margin: 0,
          /* leave padding to .slop-menubar__item — overriding it nuked the brand spacing */
        }}
      >
        <img src="/logo-mark.png" alt="" className="slop-menubar__brand-icon" width={22} height={22} aria-hidden />
        <span>{brand}</span>
      </button>
      {open ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: 260,
            background: "linear-gradient(180deg, rgba(20,10,40,0.96) 0%, rgba(6,3,13,0.96) 100%)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255,62,201,0.5)",
            borderRadius: 8,
            boxShadow: "0 12px 32px #000c, 0 0 24px rgba(255,62,201,0.3)",
            padding: 4,
            zIndex: 9100,
            color: "var(--slop-text)",
            textTransform: "none",
          }}
        >
          {slug ? (
            <a
              href={`https://slop.computer/${slug}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              style={{
                ...itemStyle,
                textDecoration: "none",
                color: "var(--slop-cyan, #3fcfff)",
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLAnchorElement).style.background =
                  "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-magenta-dim, #c41a96) 100%)";
                (e.currentTarget as HTMLAnchorElement).style.color = "#fff";
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLAnchorElement).style.background = "transparent";
                (e.currentTarget as HTMLAnchorElement).style.color = "var(--slop-cyan, #3fcfff)";
              }}
            >
              {slug}
            </a>
          ) : null}
          {slug ? (
            <div
              style={{
                height: 1,
                margin: "4px 8px",
                background: "rgba(255,62,201,0.3)",
              }}
            />
          ) : null}
          {slug ? (
            <button
              type="button"
              onClick={copyLink}
              style={itemStyle}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-magenta-dim, #c41a96) 100%)";
                (e.currentTarget as HTMLButtonElement).style.color = "#fff";
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                (e.currentTarget as HTMLButtonElement).style.color = "var(--slop-text)";
              }}
            >
              {linkStatus === "copied" ? "link copied!" : linkStatus === "failed" ? "copy failed" : "copy link"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={copySkill}
            disabled={status === "copying"}
            style={itemStyle}
            onMouseEnter={e => {
              if (status === "copying") return;
              (e.currentTarget as HTMLButtonElement).style.background =
                "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-magenta-dim, #c41a96) 100%)";
              (e.currentTarget as HTMLButtonElement).style.color = "#fff";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--slop-text)";
            }}
          >
            {status === "copying"
              ? "copying…"
              : status === "copied"
                ? "copied!"
                : status === "failed"
                  ? "failed — see console"
                  : "copy skill"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new Event("slop:open-command-palette"));
            }}
            style={{ ...itemStyle, justifyContent: "space-between" }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-magenta-dim, #c41a96) 100%)";
              (e.currentTarget as HTMLButtonElement).style.color = "#fff";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--slop-text)";
            }}
          >
            <span style={{ whiteSpace: "nowrap" }}>command palette</span>
            <span style={{ marginLeft: 24, color: "var(--slop-text-muted)", whiteSpace: "nowrap" }}>⌃⇧Space</span>
          </button>
          <a
            href="https://github.com/clawdbotatg/slop-computer-live"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            style={{ ...itemStyle, textDecoration: "none" }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLAnchorElement).style.background =
                "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-magenta-dim, #c41a96) 100%)";
              (e.currentTarget as HTMLAnchorElement).style.color = "#fff";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLAnchorElement).style.background = "transparent";
              (e.currentTarget as HTMLAnchorElement).style.color = "var(--slop-text)";
            }}
          >
            source code
          </a>
        </div>
      ) : null}
    </span>
  );
}

export default MenuBar;

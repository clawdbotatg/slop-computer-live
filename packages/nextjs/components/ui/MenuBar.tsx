"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LivePulse } from "./LivePulse";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import { sessionLabel, useSession } from "~~/hooks/useSession";

export type MenuItem = {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  shortcut?: string;
  divider?: boolean;
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
  /** Optional session-wallet chip. If a wallet address is supplied
   *  we render the Address component as a clickable chip; otherwise
   *  a "Deploy wallet" link. Clicking either opens the wallet window. */
  walletAddress?: string | null;
  onWalletClick?: () => void;
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
  walletAddress,
  onWalletClick,
  slug,
}: MenuBarProps) => {
  const { session, signOut } = useSession();

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
          {menu.items.map((item, i) =>
            item.divider ? (
              <div
                key={i}
                style={{
                  height: 1,
                  background:
                    "repeating-linear-gradient(90deg, rgba(255,62,201,0.4) 0, rgba(255,62,201,0.4) 4px, transparent 4px, transparent 8px)",
                  margin: "4px 6px",
                }}
              />
            ) : (
              <button
                key={i}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick?.();
                }}
                style={{
                  display: "flex",
                  width: "100%",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "5px 12px",
                  background: "transparent",
                  border: 0,
                  color: item.disabled ? "var(--slop-text-muted)" : "var(--slop-text)",
                  font: "inherit",
                  cursor: item.disabled ? "not-allowed" : "pointer",
                  borderRadius: 4,
                  textAlign: "left",
                  letterSpacing: "0.04em",
                }}
                onMouseEnter={e => {
                  if (item.disabled) return;
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-magenta-dim, #c41a96) 100%)";
                  (e.currentTarget as HTMLButtonElement).style.color = "#fff";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  (e.currentTarget as HTMLButtonElement).style.color = item.disabled
                    ? "var(--slop-text-muted)"
                    : "var(--slop-text)";
                }}
              >
                <span style={{ whiteSpace: "nowrap" }}>{item.label}</span>
                {item.shortcut ? (
                  <span style={{ marginLeft: 24, color: "var(--slop-text-muted)", whiteSpace: "nowrap" }}>
                    {item.shortcut}
                  </span>
                ) : null}
              </button>
            ),
          )}
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
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const copySkill = async () => {
    setStatus("copying");
    try {
      const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
      const tokenRes = await fetch(`${RELAY_HTTP}/v1/agent-token`, { credentials: "include", cache: "no-store" });
      if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
      const { token } = (await tokenRes.json()) as { token: string };
      // Copy a single URL (with the token as auth + embed) rather than the
      // full markdown body. Way nicer for "follow this skill: <url>" agent
      // prompts than pasting a multi-KB markdown file.
      const url = `${RELAY_HTTP}/v1/skill?token=${encodeURIComponent(token)}`;
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
              [ {slug} ]
            </a>
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
              ? "[ copying… ]"
              : status === "copied"
                ? "[ copied! ]"
                : status === "failed"
                  ? "[ failed — see console ]"
                  : "[ copy skill ]"}
          </button>
        </div>
      ) : null}
    </span>
  );
}

export default MenuBar;

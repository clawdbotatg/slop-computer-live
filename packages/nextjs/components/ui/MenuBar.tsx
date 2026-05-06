"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BandFlag } from "./BandFlag";
import { LivePulse } from "./LivePulse";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import type { Peer } from "~~/hooks/usePeerMesh";
import { sessionLabel, useSession } from "~~/hooks/useSession";
import { bandsFromIdentity } from "~~/utils/blockieBands";

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
  /** Pass mesh state when on the desktop view to render the guest dropdown. */
  peers?: Peer[];
  myId?: string | null;
  meshConnected?: boolean;
}

export const MenuBar = ({
  brand = "slop.computer",
  isLive = false,
  right,
  className = "",
  menus = [],
  peers,
  myId,
  meshConnected,
}: MenuBarProps) => {
  const { session, signOut } = useSession();

  const authNode = session.authenticated ? (
    <button
      type="button"
      onClick={async () => {
        await signOut();
        window.location.href = process.env.NEXT_PUBLIC_AUDIENCE_URL || "https://slop.computer/";
      }}
      className="slop-menubar__item"
      style={{
        color: "var(--slop-text-muted)",
        cursor: "pointer",
        fontSize: "inherit",
        fontFamily: "inherit",
        textDecoration: "underline",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      sign out
    </button>
  ) : (
    <Link href="/join" className="slop-menubar__item" style={{ textDecoration: "none", color: "inherit" }}>
      {sessionLabel(session)}
    </Link>
  );

  // Right-to-left: Online/Offline (far right) · Sign out · (XX guests ▾)
  return (
    <div className={`slop-menubar ${className}`.trim()}>
      <span className="slop-menubar__brand slop-menubar__item">
        <img src="/logo-mark.png" alt="" className="slop-menubar__brand-icon" width={22} height={22} aria-hidden />
        <span>{brand}</span>
      </span>
      {menus.map(menu => (
        <Dropdown key={menu.label} menu={menu} />
      ))}
      <span className="flex-1" />
      {right ?? (
        <span className="slop-menubar__status" style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
          {peers !== undefined ? <PeersDropdown peers={peers} myId={myId ?? null} /> : null}
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
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }} className="slop-menubar__item">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: "transparent",
          border: 0,
          color: "inherit",
          font: "inherit",
          letterSpacing: "inherit",
          textTransform: "inherit",
          cursor: "pointer",
          padding: 0,
          margin: 0,
          lineHeight: 1,
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
            minWidth: 220,
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
                <span>{item.label}</span>
                {item.shortcut ? (
                  <span style={{ marginLeft: 24, color: "var(--slop-text-muted)" }}>{item.shortcut}</span>
                ) : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </span>
  );
}

function PeersDropdown({ peers, myId }: { peers: Peer[]; myId: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }} className="slop-menubar__item">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: "transparent",
          border: 0,
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
          padding: 0,
          margin: 0,
          letterSpacing: "0.04em",
          lineHeight: 1,
        }}
      >
        ({peers.length} guest{peers.length === 1 ? "" : "s"}) <span aria-hidden>▾</span>
      </button>
      {open ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 240,
            background: "linear-gradient(180deg, rgba(20,10,40,0.96) 0%, rgba(6,3,13,0.96) 100%)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255,62,201,0.5)",
            borderRadius: 8,
            boxShadow: "0 12px 32px #000c, 0 0 24px rgba(255,62,201,0.3)",
            padding: 4,
            zIndex: 9100,
            color: "var(--slop-text)",
          }}
        >
          {peers.length === 0 ? (
            <div style={{ padding: "6px 12px", color: "var(--slop-text-muted)", fontSize: 12 }}>just you so far.</div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {peers.map(p => {
                const isMe = p.id === myId;
                return (
                  <li
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "5px 10px",
                      borderRadius: 4,
                      background: isMe ? "rgba(255,62,201,0.12)" : "transparent",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontWeight: p.role === "host" ? 600 : undefined,
                      }}
                    >
                      {p.role === "host" ? <span aria-hidden>★</span> : null}
                      {p.handle ? (
                        <span>{p.handle}</span>
                      ) : p.address ? (
                        <Address address={p.address as AddressType} size="xs" onlyEnsOrAddress />
                      ) : (
                        <span>{p.id.slice(0, 6)}</span>
                      )}
                      {isMe ? <span style={{ color: "var(--slop-text-muted)" }}>(you)</span> : null}
                      <BandFlag bands={bandsFromIdentity({ address: p.address, handle: p.handle, fallback: p.id })} />
                    </span>
                    <span style={{ color: "var(--slop-text-muted)", fontSize: 11, flexShrink: 0 }}>{p.role}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}

export default MenuBar;

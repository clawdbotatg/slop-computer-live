"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LivePulse } from "./LivePulse";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import type { Peer } from "~~/hooks/usePeerMesh";
import { sessionLabel, useSession } from "~~/hooks/useSession";

interface MenuBarProps {
  brand?: string;
  items?: string[];
  isLive?: boolean;
  right?: React.ReactNode;
  className?: string;
  /** Pass mesh state when on the desktop view to render the guest dropdown. */
  peers?: Peer[];
  myId?: string | null;
  meshConnected?: boolean;
}

const DEFAULT_ITEMS = ["File", "Live", "Wallet"];

export const MenuBar = ({
  brand = "Slop",
  items = DEFAULT_ITEMS,
  isLive = false,
  right,
  className = "",
  peers,
  myId,
  meshConnected,
}: MenuBarProps) => {
  const { session, signOut } = useSession();

  const identity =
    session.authenticated && session.address ? (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {session.isAdmin ? "ADMIN" : "GUEST"} ·
        <Address address={session.address as AddressType} size="xs" onlyEnsOrAddress />
      </span>
    ) : (
      <>{sessionLabel(session)}</>
    );

  const authNode = session.authenticated ? (
    <span
      className="slop-menubar__item"
      style={{
        color: session.isAdmin ? "var(--slop-magenta, #ff3ec9)" : undefined,
        fontWeight: session.isAdmin ? 600 : undefined,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {identity}
      <button
        type="button"
        onClick={() => {
          void signOut();
        }}
        style={{
          marginLeft: 8,
          background: "transparent",
          border: 0,
          color: "var(--slop-text-muted)",
          cursor: "pointer",
          fontSize: "inherit",
          fontFamily: "inherit",
          padding: 0,
          textDecoration: "underline",
        }}
      >
        sign out
      </button>
    </span>
  ) : (
    <Link href="/join" className="slop-menubar__item" style={{ textDecoration: "none", color: "inherit" }}>
      {sessionLabel(session)}
    </Link>
  );

  return (
    <div className={`slop-menubar ${className}`.trim()}>
      <span className="slop-menubar__brand slop-menubar__item">{brand}</span>
      {items.map(item => (
        <span key={item} className="slop-menubar__item">
          {item} <span aria-hidden>▾</span>
        </span>
      ))}
      <span className="flex-1" />
      {right ?? (
        <span className="slop-menubar__status" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {peers !== undefined ? <PeersDropdown peers={peers} myId={myId ?? null} /> : null}
          <LivePulse live={isLive || (meshConnected ?? false)} />
          <span>
            {meshConnected !== undefined ? (meshConnected ? "Online" : "Offline") : isLive ? "On Air" : "Offline"}
          </span>
          {authNode}
        </span>
      )}
    </div>
  );
};

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
    <span ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: "transparent",
          border: 0,
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
          padding: "0 6px",
          letterSpacing: "0.04em",
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

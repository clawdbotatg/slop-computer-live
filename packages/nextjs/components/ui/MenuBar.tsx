"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { LivePulse } from "./LivePulse";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import { sessionLabel, useSession } from "~~/hooks/useSession";

interface MenuBarProps {
  brand?: string;
  items?: string[];
  isLive?: boolean;
  right?: React.ReactNode;
  className?: string;
}

const DEFAULT_ITEMS = ["File", "Live", "Wallet"];

export const MenuBar = ({
  brand = "Slop",
  items = DEFAULT_ITEMS,
  isLive = false,
  right,
  className = "",
}: MenuBarProps) => {
  const [now, setNow] = useState<Date | null>(null);
  const { session, signOut } = useSession();

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const clock = now ? now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

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
          <LivePulse live={isLive} />
          <span>{isLive ? "On Air" : "Offline"}</span>
          {authNode}
          <span style={{ color: "var(--slop-text-muted)" }} suppressHydrationWarning>
            {clock}
          </span>
        </span>
      )}
    </div>
  );
};

export default MenuBar;

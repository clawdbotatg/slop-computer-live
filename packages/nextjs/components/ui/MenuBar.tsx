"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { LivePulse } from "./LivePulse";

const MENUS = ["Slop", "File", "Live", "Wallet"] as const;

type MenuBarProps = {
  isLive?: boolean;
  right?: ReactNode;
};

export const MenuBar = ({ isLive = false, right }: MenuBarProps) => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const clock = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 22,
        background: "var(--slop-panel-light)",
        borderTop: "1px solid var(--slop-bevel-light)",
        borderBottom: "1px solid var(--slop-bevel-dark)",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-display)",
        fontSize: 12,
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        gap: 14,
        userSelect: "none",
        zIndex: 9000,
      }}
    >
      <span aria-hidden style={{ fontSize: 11 }}>
        ◆
      </span>
      {MENUS.map(label => (
        <span key={label} style={{ cursor: "default" }}>
          {label}
        </span>
      ))}
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <LivePulse live={isLive} />
        <span style={{ fontFamily: "var(--slop-font-body)", color: "var(--slop-text-muted)" }}>
          {isLive ? "ON AIR" : "OFFLINE"}
        </span>
      </span>
      {right}
      <span style={{ fontFamily: "var(--slop-font-body)", color: "var(--slop-text-muted)" }}>{clock}</span>
    </div>
  );
};

export default MenuBar;

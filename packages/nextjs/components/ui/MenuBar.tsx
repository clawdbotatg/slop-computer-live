"use client";

import React, { useEffect, useState } from "react";
import { LivePulse } from "./LivePulse";

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

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const clock = now ? now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

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
        <span className="slop-menubar__status">
          <LivePulse live={isLive} />
          <span>{isLive ? "On Air" : "Offline"}</span>
          <span style={{ color: "var(--slop-text-muted)" }}>{clock}</span>
        </span>
      )}
    </div>
  );
};

export default MenuBar;

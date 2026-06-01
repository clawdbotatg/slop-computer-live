"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { TipCard } from "~~/hooks/usePeerMesh";

// Short chain tags to match the user's "0.001 base eth" phrasing.
const CHAIN_TAGS: Record<number, string> = { 1: "eth", 8453: "base", 100: "gnosis" };

const centerOf = (el: Element | null): { x: number; y: number } | null => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

type Geom = { startX: number; startY: number; dx: number; dy: number };

// A celebratory card that springs up over the chat window and flies into the
// multisig address in the menu bar, fading as it lands — "the tip going to
// the vault." Pure CSS transition (no animation lib), matching the house
// ClickRipple/Cursor style. Self-removed by the mesh after ~2.6s.
export const FlyingTipCard = ({ tip, customNames }: { tip: TipCard; customNames: Record<string, string> }) => {
  const name = useMemo(() => {
    const key = (tip.address ?? tip.anonId ?? "").toLowerCase();
    const custom = customNames[key] ?? customNames[tip.anonId ?? ""];
    if (custom) return custom;
    if (tip.handle) return tip.handle;
    if (tip.address) return `${tip.address.slice(0, 6)}…${tip.address.slice(-4)}`;
    return "someone";
  }, [tip, customNames]);

  const chain = CHAIN_TAGS[tip.chainId] ?? "";
  const [geom, setGeom] = useState<Geom | null>(null);
  const [flying, setFlying] = useState(false);

  // Measure start (top of chat window) + end (multisig anchor) before paint.
  useLayoutEffect(() => {
    const chatEl = document.getElementById("slop-chat-window");
    const anchorEl = document.getElementById("slop-multisig-anchor");
    let start = centerOf(chatEl);
    if (chatEl) {
      const r = chatEl.getBoundingClientRect();
      start = { x: r.left + r.width / 2, y: r.top + 28 }; // emerge near the top
    }
    start ??= { x: window.innerWidth * 0.28, y: window.innerHeight - 130 };
    const end = centerOf(anchorEl) ?? { x: window.innerWidth - 80, y: 16 };
    setGeom({ startX: start.x, startY: start.y, dx: end.x - start.x, dy: end.y - start.y });
  }, []);

  // Once mounted at the start position, kick the transition next frame.
  useEffect(() => {
    if (!geom) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setFlying(true)));
    return () => cancelAnimationFrame(id);
  }, [geom]);

  if (!geom) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: geom.startX,
        top: geom.startY,
        zIndex: 2147483646,
        pointerEvents: "none",
        whiteSpace: "nowrap",
        willChange: "transform, opacity",
        transform: flying
          ? `translate(calc(-50% + ${geom.dx}px), calc(-50% + ${geom.dy}px)) scale(0.35)`
          : "translate(-50%, -50%) scale(1)",
        opacity: flying ? 0 : 1,
        transition: "transform 2200ms cubic-bezier(0.45, 0, 0.35, 1), opacity 700ms ease-in 1500ms",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          background: "linear-gradient(135deg, var(--slop-magenta, #ff3ec9), var(--slop-cyan, #00e5ff))",
          color: "#06030d",
          fontFamily: "var(--slop-font-display)",
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: "0.02em",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.45)",
          boxShadow: "0 4px 22px rgba(255,62,201,0.55)",
        }}
      >
        🎉 {name} tipped {tip.amountEth} {chain} ETH
      </span>
    </div>
  );
};

export default FlyingTipCard;

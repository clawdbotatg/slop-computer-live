"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { EmojiConfetti } from "~~/components/ui/EmojiConfetti";
import type { TipCard } from "~~/hooks/usePeerMesh";

// How long the card takes to fly from the chat window to the vault. Slow +
// deliberate so the tip reads as a real event, not a flicker. Confetti fires
// the moment it lands. Keep mesh's tip-prune TTL comfortably above this.
const FLY_MS = 3200;

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
  const [landed, setLanded] = useState(false);

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
  // When it lands at the vault, fire the confetti.
  useEffect(() => {
    if (!geom) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setFlying(true)));
    const land = setTimeout(() => setLanded(true), FLY_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(land);
    };
  }, [geom]);

  if (!geom) return null;

  const endX = geom.startX + geom.dx;
  const endY = geom.startY + geom.dy;

  return (
    <>
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
            ? `translate(calc(-50% + ${geom.dx}px), calc(-50% + ${geom.dy}px)) scale(0.45)`
            : "translate(-50%, -50%) scale(1)",
          opacity: flying ? 0 : 1,
          transition: `transform ${FLY_MS}ms cubic-bezier(0.42, 0, 0.3, 1), opacity 900ms ease-in ${FLY_MS - 900}ms`,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 9,
            padding: "11px 20px",
            background: "linear-gradient(135deg, var(--slop-magenta, #ff3ec9), var(--slop-cyan, #00e5ff))",
            color: "#06030d",
            fontFamily: "var(--slop-font-display)",
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: "0.02em",
            borderRadius: 9,
            border: "1.5px solid rgba(255,255,255,0.5)",
            boxShadow: "0 6px 34px rgba(255,62,201,0.6)",
          }}
        >
          🎉 {name} tipped {tip.amountEth} {chain} ETH
        </span>
      </div>
      {landed && <EmojiConfetti x={endX} y={endY} amountEth={tip.amountEth} />}
    </>
  );
};

export default FlyingTipCard;

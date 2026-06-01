"use client";

import { useEffect, useMemo, useState } from "react";

// Emoji palettes by tip size — a small tip gets a modest sparkle, a whale
// tip gets the full money-cannon. Bigger tiers are supersets so the vibe
// escalates rather than swaps.
const SMALL = ["🎉", "💸", "✨", "🪙"];
const MED = ["🎉", "💸", "✨", "🪙", "💵", "🎊", "🤑"];
const BIG = ["🎉", "💸", "✨", "🪙", "💵", "🎊", "🤑", "💎", "🚀", "👑", "🔥", "🤩"];

// Map a tip amount (ETH) to a confetti burst. Log scale anchored at the
// 0.001 ETH tip threshold: ~0.001 → small spritz, 0.01 → 10×, 0.1 → 100×,
// each decade adding pieces and unlocking richer emoji.
export function confettiForAmount(amountEth: string): { count: number; emojis: string[] } {
  const amt = Number(amountEth) || 0;
  const decades = Math.max(0, Math.log10(amt / 0.001)); // 0 at .001, 1 at .01, 2 at .1, 3 at 1…
  const count = Math.round(Math.min(120, 16 + decades * 30));
  const emojis = amt >= 0.1 ? BIG : amt >= 0.01 ? MED : SMALL;
  return { count, emojis };
}

type Piece = {
  id: number;
  emoji: string;
  dx: number;
  dy: number;
  rot: number;
  size: number;
  delay: number;
  duration: number;
};

// A single emoji that drops from a point and falls down the viewport, fading
// as it goes — the same gravity tween the confetti burst uses, but one piece
// at a time. Used to "drip" emoji off the flying tip card as it crosses the
// screen. Self-contained; the parent unmounts it when the drip's done.
export const FallingEmoji = ({ x, y, emoji, size = 24 }: { x: number; y: number; emoji: string; size?: number }) => {
  const target = useMemo(() => {
    const fall = window.innerHeight - y + 100;
    return {
      dx: (Math.random() - 0.5) * 160,
      dy: fall * (0.6 + Math.random() * 0.45),
      rot: (Math.random() - 0.5) * 420,
      duration: 2200 + Math.random() * 1300,
    };
    // x/y are the spawn origin — captured once; later parent re-renders
    // (new drips) must not retarget an in-flight piece.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [go, setGo] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGo(true)));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <span
      style={{
        position: "fixed",
        left: x,
        top: y,
        fontSize: size,
        lineHeight: 1,
        zIndex: 2147483646,
        pointerEvents: "none",
        willChange: "transform, opacity",
        transform: go ? `translate(${target.dx}px, ${target.dy}px) rotate(${target.rot}deg)` : "translate(0px, 0px)",
        opacity: go ? 0 : 1,
        transition: `transform ${target.duration}ms cubic-bezier(0.5, 0, 0.85, 0.4), opacity ${Math.round(target.duration * 0.55)}ms ease-in ${Math.round(target.duration * 0.45)}ms`,
      }}
    >
      {emoji}
    </span>
  );
};

// A burst of falling emoji that erupts from a point (the wallet anchor) and
// rains down the full viewport so everyone on the stream sees the tip land.
// Pure CSS transitions (matching FlyingTipCard / ClickRipple house style) —
// each piece tweens from the origin to a drifted spot below the fold, fading
// out as it falls. Self-contained; the parent unmounts it via mesh prune.
export const EmojiConfetti = ({ x, y, amountEth }: { x: number; y: number; amountEth: string }) => {
  const pieces = useMemo<Piece[]>(() => {
    const { count, emojis } = confettiForAmount(amountEth);
    const fall = window.innerHeight - y + 120; // clear the bottom edge
    const spread = Math.min(window.innerWidth * 0.95, 760);
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      emoji: emojis[Math.floor(Math.random() * emojis.length)] ?? "🎉",
      dx: (Math.random() - 0.5) * spread,
      dy: fall * (0.72 + Math.random() * 0.5),
      rot: (Math.random() - 0.5) * 760,
      size: 20 + Math.random() * 26,
      delay: Math.random() * 380,
      duration: 2400 + Math.random() * 1700,
    }));
  }, [x, y, amountEth]);

  const [go, setGo] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGo(true)));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div style={{ position: "fixed", left: x, top: y, zIndex: 2147483646, pointerEvents: "none" }}>
      {pieces.map(p => (
        <span
          key={p.id}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            fontSize: p.size,
            lineHeight: 1,
            willChange: "transform, opacity",
            transform: go ? `translate(${p.dx}px, ${p.dy}px) rotate(${p.rot}deg)` : "translate(0px, 0px) rotate(0deg)",
            opacity: go ? 0 : 1,
            // ease-in fall ≈ gravity; opacity holds, then fades over the back half.
            transition: `transform ${p.duration}ms cubic-bezier(0.5, 0, 0.85, 0.4) ${p.delay}ms, opacity ${Math.round(p.duration * 0.55)}ms ease-in ${Math.round(p.delay + p.duration * 0.45)}ms`,
          }}
        >
          {p.emoji}
        </span>
      ))}
    </div>
  );
};

export default EmojiConfetti;

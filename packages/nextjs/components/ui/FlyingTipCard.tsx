"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmojiConfetti, FallingEmoji, confettiForAmount } from "~~/components/ui/EmojiConfetti";
import { useEthPrice } from "~~/hooks/useEthPrice";
import type { TipCard } from "~~/hooks/usePeerMesh";
import { usdSuffixFromEth } from "~~/utils/usd";

// How long the card takes to fly from the chat window to the vault. Slow +
// deliberate so the tip reads as a real event, not a flicker. Confetti fires
// the moment it lands. Keep mesh's tip-prune TTL comfortably above this.
const FLY_MS = 6500;

// How often (ms) we drip emoji off the card as it crosses the screen, and how
// many to shed each tick — a dense trail that rains down as the card travels.
const DRIP_EVERY_MS = 80;
const DRIP_PER_TICK = 2;
// How long a dripped emoji lives (covers its full fall + fade).
const DRIP_TTL_MS = 3800;

type Drip = { id: number; x: number; y: number; emoji: string };

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
  const ethUsd = useEthPrice();
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
  const [drips, setDrips] = useState<Drip[]>([]);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const dripIdRef = useRef(0);

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
  // When it lands at the vault, fire the confetti — and announce the
  // landing so the wallet surfaces (window portfolio + menubar chip)
  // can pull the freshly-bumped balance. They debounce against Zerion's
  // ~5-15s indexer lag themselves; this is just the "a tip just hit the
  // vault" signal.
  useEffect(() => {
    if (!geom) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setFlying(true)));
    const land = setTimeout(() => {
      setLanded(true);
      window.dispatchEvent(
        new CustomEvent("slop-tip-landed", { detail: { chainId: tip.chainId, amountEth: tip.amountEth } }),
      );
    }, FLY_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(land);
    };
  }, [geom, tip.chainId, tip.amountEth]);

  // While the card is in flight, sample its live position (getBoundingClientRect
  // reflects the in-progress CSS transform) and shed an emoji every so often —
  // a trail that drips off the card and falls down the screen, same gravity
  // tween as the landing confetti. Emoji palette scales with tip size.
  useEffect(() => {
    if (!flying) return;
    const { emojis } = confettiForAmount(tip.amountEth);
    let raf = 0;
    let last = 0;
    let stopped = false;
    const loop = (t: number) => {
      if (stopped) return;
      if (t - last >= DRIP_EVERY_MS) {
        last = t;
        const el = cardRef.current;
        if (el) {
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const fresh: Drip[] = [];
          for (let i = 0; i < DRIP_PER_TICK; i++) {
            dripIdRef.current += 1;
            const id = dripIdRef.current;
            const emoji = emojis[Math.floor(Math.random() * emojis.length)] ?? "✨";
            // scatter the spawn point across the card so the trail has width
            const x = cx + (Math.random() - 0.5) * r.width;
            const y = cy + (Math.random() - 0.5) * r.height;
            fresh.push({ id, x, y, emoji });
            setTimeout(() => setDrips(prev => prev.filter(d => d.id !== id)), DRIP_TTL_MS);
          }
          setDrips(prev => [...prev, ...fresh]);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const stop = setTimeout(() => {
      stopped = true;
      cancelAnimationFrame(raf);
    }, FLY_MS);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(stop);
    };
  }, [flying, tip.amountEth]);

  if (!geom) return null;

  const endX = geom.startX + geom.dx;
  const endY = geom.startY + geom.dy;

  return (
    <>
      <div
        ref={cardRef}
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
          🎉 {name} tipped {tip.amountEth} {chain} ETH{usdSuffixFromEth(tip.amountEth, ethUsd)}
        </span>
      </div>
      {drips.map(d => (
        <FallingEmoji key={d.id} x={d.x} y={d.y} emoji={d.emoji} size={22} />
      ))}
      {landed && <EmojiConfetti x={endX} y={endY} amountEth={tip.amountEth} />}
    </>
  );
};

export default FlyingTipCard;

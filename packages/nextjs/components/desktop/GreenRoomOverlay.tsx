"use client";

import { useEffect, useRef, useState } from "react";
import { DesktopBackground } from "~~/components/ui/DesktopBackground";
import type { ClockCountdownState } from "~~/hooks/usePeerMesh";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

type Props = {
  /** True while the operator is in the green room. Drives the fade; the
   *  overlay stays mounted either way so the cross-fade plays both
   *  directions. */
  visible: boolean;
  slug: string;
  /** Saved card artifact version (cache-buster). `null` = the room never
   *  generated a card, so we show a template panel instead. The artifact
   *  already has its title baked in, so we render it straight — no overlay. */
  cardVersion: number | null;
  /** Shared countdown. Rendered big when running / paused / done; hidden
   *  when idle so the card takes the whole stage. */
  countdown: ClockCountdownState;
};

/** Seconds remaining for a countdown, or null when there's nothing to show. */
function countdownSecs(c: ClockCountdownState, now: number): number | null {
  if (c.phase === "running") return Math.max(0, Math.ceil((c.endAt - now) / 1000));
  if (c.phase === "paused") return c.remainingSecs;
  if (c.phase === "done") return 0;
  return null;
}

function fmtHMS(total: number): string {
  const s = Math.max(0, total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Full-screen "green room" / standby curtain rendered ON TOP of the live
 * god-mode desktop. The headless broadcaster captures the god-mode browser,
 * so whatever this paints is exactly what the world sees on the stream —
 * letting the operator hold a clean preview card + countdown while chatting
 * backstage, then fade away to reveal the real desktop on spacebar.
 *
 * The desktop keeps running underneath (mesh, music, everything) — we only
 * mask the pixels. `pointerEvents: none` so the operator can still click
 * through if they need to.
 */
export function GreenRoomOverlay({ visible, slug, cardVersion, countdown }: Props) {
  const [now, setNow] = useState(0);
  const [cardBroke, setCardBroke] = useState(false);

  // Tick once a second while a running countdown is on screen so the
  // remaining time repaints. Paused / done / idle don't need a ticker.
  const ticking = visible && countdown.phase === "running";
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [ticking]);

  // Reset the broken-image fallback whenever a fresh artifact lands.
  const lastVersion = useRef<number | null>(cardVersion);
  useEffect(() => {
    if (lastVersion.current !== cardVersion) {
      lastVersion.current = cardVersion;
      setCardBroke(false);
    }
  }, [cardVersion]);

  const cardUrl =
    cardVersion != null && !cardBroke
      ? `${RELAY_HTTP}/v1/cards/${encodeURIComponent(slug)}/card.png?v=${cardVersion}`
      : null;

  const secs = countdownSecs(countdown, now || Date.now());
  const showCountdown = secs !== null;
  const countdownDone = countdown.phase === "done" || secs === 0;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        // Above windows (2^31 cursor is masked separately in Desktop by not
        // rendering the local god cursor while in the green room).
        zIndex: 2_000_000,
        opacity: visible ? 1 : 0,
        transition: "opacity 600ms ease",
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Same ambient backdrop as the real desktop. */}
      <DesktopBackground />

      {/* Top-left logo + empty menu bar — a believable but inert chrome. */}
      <div className="slop-menubar" style={{ position: "relative", zIndex: 2 }}>
        <span
          className="slop-menubar__brand slop-menubar__item"
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          <img src="/logo-mark.png" alt="" className="slop-menubar__brand-icon" width={22} height={22} aria-hidden />
          <span>slop.computer</span>
        </span>
        <span className="flex-1" />
      </div>

      {/* Card stage — big, with breathing room so a little background shows
          around it. Saved artifact only (title already baked in). */}
      <div
        style={{
          position: "relative",
          zIndex: 2,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 28,
          padding: "3vh 4vw 4vh",
          minHeight: 0,
        }}
      >
        {cardUrl ? (
          <img
            src={cardUrl}
            alt=""
            onError={() => setCardBroke(true)}
            style={{
              maxWidth: "82vw",
              maxHeight: showCountdown ? "56vh" : "72vh",
              objectFit: "contain",
              borderRadius: 18,
              boxShadow: "0 24px 80px #000b, 0 0 60px rgba(255,62,201,0.28)",
              border: "1px solid rgba(255,62,201,0.35)",
            }}
          />
        ) : (
          // No artifact yet → a template panel so standby still looks staged.
          <div
            style={{
              width: "min(70vw, 900px)",
              aspectRatio: "16 / 9",
              maxHeight: showCountdown ? "56vh" : "72vh",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 18,
              borderRadius: 18,
              border: "1px solid rgba(255,62,201,0.35)",
              background: "linear-gradient(160deg, rgba(40,18,70,0.85), rgba(8,4,16,0.92))",
              boxShadow: "0 24px 80px #000b, 0 0 60px rgba(255,62,201,0.28)",
            }}
          >
            <img src="/logo-mark.png" alt="" width={120} height={120} style={{ opacity: 0.95 }} aria-hidden />
            <div
              style={{
                fontSize: "clamp(28px, 5vw, 64px)",
                fontWeight: 800,
                letterSpacing: "0.04em",
                color: "var(--slop-text, #f4ecff)",
                textShadow: "0 0 24px rgba(124,77,255,0.55)",
              }}
            >
              {slug}
            </div>
          </div>
        )}

        {showCountdown ? (
          <div
            style={{
              fontVariantNumeric: "tabular-nums",
              fontWeight: 800,
              lineHeight: 1,
              fontSize: "clamp(48px, 12vw, 180px)",
              color: countdownDone ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-cyan, #3fcfff)",
              textShadow: countdownDone ? "0 0 40px rgba(255,62,201,0.7)" : "0 0 40px rgba(63,207,255,0.55)",
              transform: countdownDone ? "scale(1.04)" : "none",
              transition: "transform 300ms ease, color 300ms ease",
            }}
          >
            {countdownDone ? "LIVE" : fmtHMS(secs as number)}
          </div>
        ) : null}
      </div>

      {/* Big bottom-right wordmark, matching the desktop's brand corner. */}
      <div
        style={{
          position: "fixed",
          right: "3vw",
          bottom: "3vh",
          zIndex: 2,
          fontSize: "clamp(28px, 6vw, 84px)",
          fontWeight: 900,
          letterSpacing: "0.02em",
          color: "rgba(244,236,255,0.18)",
          textShadow: "0 0 30px rgba(124,77,255,0.25)",
          userSelect: "none",
        }}
      >
        slop.computer
      </div>
    </div>
  );
}

export default GreenRoomOverlay;

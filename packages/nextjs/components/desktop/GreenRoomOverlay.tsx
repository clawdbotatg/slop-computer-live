"use client";

import { useEffect, useRef, useState } from "react";
import { TimelineBar } from "~~/components/desktop/TimelineBar";
import { DesktopBackground } from "~~/components/ui/DesktopBackground";
import type { ClockCountdownState, PeerMeshState } from "~~/hooks/usePeerMesh";
import { audioBus } from "~~/utils/audioBus";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// Bottom band reserved for the music visualizer + timeline ticker, so the
// card sits clear above them.
const TICKER_H = 44;
const VIZ_H = 140;

type Props = {
  /** True while the operator is in the green room. Drives the fade; the
   *  overlay stays mounted either way so the cross-fade plays both
   *  directions. */
  visible: boolean;
  slug: string;
  /** card.png artifact version (cache-buster / existence hint). `null` =
   *  the room never generated a card. */
  cardVersion: number | null;
  /** Shared countdown. Rendered big when running / paused / done; hidden
   *  when idle so the card takes the whole stage. */
  countdown: ClockCountdownState;
  /** Mesh — drives the timeline ticker (and is handy for future bits). */
  mesh: PeerMeshState;
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
 * Music spectrum stretched across the bottom of the standby curtain, so the
 * stream visibly shows there's audio playing. Reads the shared AudioBus
 * "music" analyser (god-mode is the bus owner, and this overlay only renders
 * in god-mode) — the same node SlopAmp's own viz uses. Draws straight to
 * canvas in a RAF loop; no React re-renders. Silent / no music = flat.
 */
function BottomVisualizer({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = () => {
      if (!analyserRef.current) analyserRef.current = audioBus().getAnalyser("music");
      const analyser = analyserRef.current;
      const canvas = canvasRef.current;
      if (analyser && canvas) {
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
          canvas.width = cssW * dpr;
          canvas.height = cssH * dpr;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const W = canvas.width;
          const H = canvas.height;
          ctx.clearRect(0, 0, W, H);
          const bins = analyser.frequencyBinCount;
          const data = new Uint8Array(bins);
          analyser.getByteFrequencyData(data);
          const start = 1; // skip DC bin
          const used = bins - start;
          const gap = Math.max(1, dpr);
          const barW = (W - gap * (used + 1)) / used;
          for (let i = 0; i < used; i++) {
            const v = (data[i + start] ?? 0) / 255;
            const h = Math.max(dpr, v * H);
            const x = gap + i * (barW + gap);
            const grad = ctx.createLinearGradient(0, H, 0, H - h);
            grad.addColorStop(0, "rgba(188,255,91,0.85)"); // lime
            grad.addColorStop(0.55, "rgba(255,174,0,0.85)"); // amber
            grad.addColorStop(1, "rgba(255,62,201,0.9)"); // magenta
            ctx.fillStyle = grad;
            ctx.fillRect(x, H - h, barW, h);
          }
        }
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: TICKER_H,
        width: "100%",
        height: VIZ_H,
        zIndex: 1,
        opacity: 0.92,
        pointerEvents: "none",
        // Fade the bars into the backdrop at the top so they don't end in a
        // hard line under the card.
        maskImage: "linear-gradient(0deg, #000 40%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(0deg, #000 40%, transparent 100%)",
      }}
    />
  );
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
export function GreenRoomOverlay({ visible, slug, cardVersion, countdown, mesh }: Props) {
  const [now, setNow] = useState(0);
  // Card source falls back through tiers: 0 = published unfurl (title baked
  // in by the disk/save icon), 1 = raw card.png (no title), 2 = template.
  const [cardTier, setCardTier] = useState(0);
  // Bumped each time we (re)enter standby so the 1h-cached published.png is
  // re-fetched — a freshly saved card shows up without a hard reload.
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Tick once a second while a running countdown is on screen so the
  // remaining time repaints. Paused / done / idle don't need a ticker.
  const ticking = visible && countdown.phase === "running";
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [ticking]);

  // On entering standby, refetch the card from the top tier (the operator
  // may have just re-saved it). cardVersion changes also reset the tier.
  useEffect(() => {
    if (visible) {
      setCardTier(0);
      setRefreshNonce(Date.now());
    }
  }, [visible]);
  useEffect(() => {
    setCardTier(0);
  }, [cardVersion]);

  const enc = encodeURIComponent(slug);
  const buster = `${cardVersion ?? 0}-${refreshNonce}`;
  const cardUrl =
    cardTier === 0
      ? `${RELAY_HTTP}/v1/cards/${enc}/published.png?v=${buster}`
      : cardTier === 1 && cardVersion != null
        ? `${RELAY_HTTP}/v1/cards/${enc}/card.png?v=${cardVersion}`
        : null;

  const onCardError = () => {
    // published → raw → template.
    setCardTier(t => (t === 0 && cardVersion != null ? 1 : 2));
  };

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
      <div className="slop-menubar" style={{ position: "relative", zIndex: 3 }}>
        <span
          className="slop-menubar__brand slop-menubar__item"
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          <img src="/logo-mark.png" alt="" className="slop-menubar__brand-icon" width={22} height={22} aria-hidden />
          <span>slop.computer</span>
        </span>
        <span className="flex-1" />
      </div>

      {/* Card stage — big, sitting above the reserved bottom band (viz +
          ticker). Prefers the saved unfurl (title baked in). */}
      <div
        style={{
          position: "relative",
          zIndex: 3,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          padding: "1.5vh 2vw",
          paddingBottom: TICKER_H + VIZ_H + 16,
          minHeight: 0,
        }}
      >
        {cardUrl ? (
          <img
            src={cardUrl}
            alt=""
            onError={onCardError}
            style={{
              maxWidth: "96vw",
              maxHeight: showCountdown ? "58vh" : "76vh",
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
              width: "min(92vw, 1320px)",
              aspectRatio: "16 / 9",
              maxHeight: showCountdown ? "58vh" : "76vh",
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

      {/* Bottom band: music spectrum (rising bars) above a slightly-bigger
          timeline ticker pinned to the very bottom. Both sit behind the
          wordmark. */}
      <BottomVisualizer active={visible} />
      <TimelineBar
        mesh={mesh}
        onOpenUrl={() => {}}
        bottom={0}
        height={TICKER_H}
        zIndex={2}
        fontScale={1.5}
        hideBadge
        nonInteractive
      />

      {/* Big bottom-right wordmark, matching the desktop's brand corner.
          Raised above the ticker, on top of the viz. */}
      <div
        style={{
          position: "fixed",
          right: "3vw",
          bottom: TICKER_H + 12,
          zIndex: 5,
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

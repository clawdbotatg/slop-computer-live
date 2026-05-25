"use client";

import { useEffect, useRef, useState } from "react";
import {
  AUDIO_BUS_CHANNEL,
  type AudioBusSnapshot,
  type BusInboundMessage,
  type BusOutboundMessage,
} from "~~/utils/audioBus";

// The /eq popup. Opens in a separate OS window from the desktop tab
// (window.open from MenuBar's 🔊 button) and talks to the opener over
// BroadcastChannel — no shared JS state. Stays cheap to render so the
// broadcaster can leave it open on a second monitor and twiddle bands
// during the show.
//
// Layout: narrow + tall column. Every control is a horizontal slider
// stacked vertically. Live RMS meters under each source row let the
// operator see which feed is hot vs quiet at a glance — the whole
// point is "equalize visually."
//
// Why a real window instead of an in-page panel: the spectator tab is
// what Chromium captures for the stream, so any control surface
// rendered inside it would also be in the broadcast. A popup keeps
// the EQ off-air.

// Bus owns the canonical 6-band peaking layout (60/170/350/1k/3.5k/10k
// Hz). These are the slider labels.
const BAND_LABELS = ["60", "170", "350", "1k", "3.5k", "10k"];

const cssVar = (name: string, fallback: string): string => `var(--slop-${name}, ${fallback})`;

const EqPopupPage = () => {
  const [snap, setSnap] = useState<AudioBusSnapshot | null>(null);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  // Open the channel, request a snapshot, and listen for updates.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      setConnected(false);
      return;
    }
    const channel = new BroadcastChannel(AUDIO_BUS_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (ev: MessageEvent<BusOutboundMessage>) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === "snapshot") {
        setSnap(msg.snapshot);
        setConnected(true);
      } else if (msg.type === "levels") {
        setLevels(msg.levels);
        // A levels frame is also proof the opener is alive — flips the
        // status pip without needing to wait for a mutation snapshot.
        setConnected(true);
      }
    };
    // Kick the opener for current state. If the opener isn't listening
    // (closed, navigating, not on /eq-aware page) we just stay in the
    // "waiting" UI state until a snapshot lands.
    const reqMsg: BusInboundMessage = { type: "request-snapshot" };
    try {
      channel.postMessage(reqMsg);
    } catch {
      /* channel closed */
    }
    // Re-ping every 1.5s while we have no snapshot — covers the case
    // where the user opens this popup before the opener's bus owner
    // has mounted (e.g. they navigated to /eq directly).
    const pingTimer = window.setInterval(() => {
      if (!channelRef.current) return;
      try {
        channelRef.current.postMessage(reqMsg);
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => {
      window.clearInterval(pingTimer);
      try {
        channel.close();
      } catch {
        /* ignore */
      }
      channelRef.current = null;
    };
  }, []);

  const post = (msg: BusInboundMessage) => {
    const ch = channelRef.current;
    if (!ch) return;
    try {
      ch.postMessage(msg);
    } catch {
      /* channel closed */
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: cssVar("bg", "#06030d"),
        color: cssVar("text", "#e8e0ff"),
        fontFamily: "var(--slop-font-display, ui-monospace, monospace)",
        padding: "10px 8px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
        <h1
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            margin: 0,
            color: cssVar("magenta", "#ff3ec9"),
          }}
        >
          EQ
        </h1>
        <span
          style={{
            fontSize: 8,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: connected ? cssVar("lime", "#bcff5b") : cssVar("text-muted", "#7878a0"),
          }}
          title={connected ? "Receiving snapshots + levels from the desktop tab" : "Waiting for the desktop tab"}
        >
          {connected ? "● live" : "○ wait"}
        </span>
      </div>

      {/* Master EQ — 6 horizontal sliders stacked. */}
      <section style={panelStyle}>
        <div style={sectionHeaderStyle}>
          <span>master</span>
          <button type="button" style={resetBtnStyle} onClick={() => post({ type: "reset-eq" })}>
            rst
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 6 }}>
          {BAND_LABELS.map((label, i) => {
            const band = snap?.bands[i];
            const value = band?.gain ?? 0;
            return (
              <div
                key={label}
                style={{
                  display: "grid",
                  gridTemplateColumns: "28px 1fr 28px",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span
                  style={{
                    fontSize: 9,
                    color: cssVar("text-muted", "#7878a0"),
                    letterSpacing: "0.04em",
                  }}
                >
                  {label}
                </span>
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={0.5}
                  value={value}
                  disabled={!snap}
                  onChange={e => post({ type: "set-band-gain", bandIndex: i, db: parseFloat(e.target.value) })}
                  style={{ width: "100%", accentColor: cssVar("cyan", "#3fcfff"), margin: 0 }}
                />
                <span
                  style={{
                    fontSize: 8,
                    color: value === 0 ? cssVar("text-muted", "#7878a0") : cssVar("cyan", "#3fcfff"),
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {value > 0 ? "+" : ""}
                  {value.toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>
        <div
          style={{
            marginTop: 8,
            paddingTop: 6,
            borderTop: `1px dashed ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
            display: "grid",
            gridTemplateColumns: "28px 1fr 28px",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span style={{ fontSize: 9, color: cssVar("magenta", "#ff3ec9"), letterSpacing: "0.04em" }}>amp</span>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={snap?.masterGain ?? 1}
            disabled={!snap}
            onChange={e => post({ type: "set-master-gain", gain: parseFloat(e.target.value) })}
            style={{ width: "100%", accentColor: cssVar("magenta", "#ff3ec9"), margin: 0 }}
          />
          <span
            style={{
              fontSize: 8,
              color: cssVar("magenta", "#ff3ec9"),
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {snap ? `${Math.round(snap.masterGain * 100)}` : "—"}
          </span>
        </div>
      </section>

      {/* Per-source mixer — mute + label + LIVE meter + gain. */}
      <section style={panelStyle}>
        <div style={sectionHeaderStyle}>
          <span>sources</span>
          <span style={{ fontSize: 8, color: cssVar("text-muted", "#7878a0") }}>
            {snap ? snap.sources.length : "—"}
          </span>
        </div>
        {snap && snap.sources.length === 0 ? (
          <div
            style={{
              padding: "10px 2px",
              fontSize: 9,
              color: cssVar("text-muted", "#7878a0"),
              textAlign: "center",
            }}
          >
            no audio yet
          </div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {snap?.sources.map(src => {
            const rms = levels[src.id] ?? 0;
            return (
              <SourceRow
                key={src.id}
                id={src.id}
                label={src.label}
                gain={src.gain}
                muted={src.muted}
                rms={rms}
                onToggleMute={() => post({ type: "set-source-muted", id: src.id, muted: !src.muted })}
                onSetGain={g => post({ type: "set-source-gain", id: src.id, gain: g })}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
};

// Single source row. Mute button + label on top, level meter under
// it, gain slider at the bottom. Tightly stacked so a half-dozen of
// these fit in a 600px-tall column without scrolling.
const SourceRow = ({
  label,
  gain,
  muted,
  rms,
  onToggleMute,
  onSetGain,
}: {
  id: string;
  label: string;
  gain: number;
  muted: boolean;
  rms: number; // 0..1
  onToggleMute: () => void;
  onSetGain: (g: number) => void;
}) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        padding: "5px 6px",
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
        borderRadius: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          type="button"
          onClick={onToggleMute}
          title={muted ? "unmute" : "mute"}
          aria-label={muted ? "unmute" : "mute"}
          style={{
            width: 18,
            height: 18,
            flexShrink: 0,
            background: muted ? cssVar("magenta", "#ff3ec9") : "transparent",
            color: muted ? "#fff" : cssVar("text", "#e8e0ff"),
            border: `1px solid ${muted ? cssVar("magenta", "#ff3ec9") : cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
            borderRadius: 3,
            cursor: "pointer",
            fontSize: 9,
            lineHeight: 1,
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {muted ? "M" : "•"}
        </button>
        <span
          style={{
            fontSize: 9,
            letterSpacing: "0.04em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
            opacity: muted ? 0.5 : 1,
          }}
          title={label}
        >
          {label}
        </span>
      </div>
      <LevelMeter rms={rms} muted={muted} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 24px", alignItems: "center", gap: 4 }}>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={gain}
          disabled={muted}
          onChange={e => onSetGain(parseFloat(e.target.value))}
          style={{ width: "100%", accentColor: cssVar("cyan", "#3fcfff"), margin: 0 }}
        />
        <span
          style={{
            fontSize: 8,
            color: muted ? cssVar("text-muted", "#7878a0") : cssVar("cyan", "#3fcfff"),
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {Math.round(gain * 100)}
        </span>
      </div>
    </div>
  );
};

// Horizontal RMS meter. Lime up to ~0.5, amber to ~0.8, red beyond —
// gives "balanced / hot / clipping" reading at a glance so the operator
// can visually equalize sources that are clearly louder or quieter.
const LevelMeter = ({ rms, muted }: { rms: number; muted: boolean }) => {
  // Light perceptual curve — RMS values cluster low; sqrt expands the
  // useful range so a half-loud speaker isn't a tiny sliver.
  const norm = muted ? 0 : Math.min(1, Math.sqrt(Math.max(0, rms)) * 1.4);
  const pct = `${(norm * 100).toFixed(1)}%`;
  // Hot/clipping threshold — 0.8 perceptual ≈ ~0.5 raw RMS, which is
  // peaking territory for speech.
  const hot = norm > 0.8;
  const warm = norm > 0.55;
  const color = muted
    ? cssVar("text-muted", "#7878a0")
    : hot
      ? cssVar("red", "#ff5577")
      : warm
        ? cssVar("amber", "#ffae00")
        : cssVar("lime", "#bcff5b");
  return (
    <div
      style={{
        width: "100%",
        height: 5,
        background: "rgba(0,0,0,0.45)",
        border: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
        borderRadius: 2,
        overflow: "hidden",
        position: "relative",
      }}
      aria-label="audio level"
    >
      <div
        style={{
          width: pct,
          height: "100%",
          background: color,
          // No transition — we want the meter to feel instant.
          // 15Hz updates already smooth via Analyser's smoothing.
          boxShadow: hot ? `0 0 4px ${color}` : "none",
        }}
      />
    </div>
  );
};

const panelStyle: React.CSSProperties = {
  background: cssVar("panel", "#0a0f24"),
  border: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
  borderRadius: 4,
  padding: "6px 7px 8px",
};

const sectionHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 8,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: cssVar("text-muted", "#7878a0"),
  borderBottom: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
  paddingBottom: 4,
};

const resetBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: 0,
  color: cssVar("magenta", "#ff3ec9"),
  cursor: "pointer",
  fontSize: 8,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  fontFamily: "inherit",
  padding: 0,
};

export default EqPopupPage;

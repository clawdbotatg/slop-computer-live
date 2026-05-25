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
// Why a real window instead of an in-page panel: the spectator tab is
// what Chromium captures for the stream, so any control surface
// rendered inside it would also be in the broadcast. A popup keeps
// the EQ off-air.

// We render 6 peaking bands the bus owns. Same frequencies as utils/
// audioBus.ts — duplicated here only as the labels for the slider
// column. The bus is the canonical source.
const BAND_LABELS = ["60", "170", "350", "1k", "3.5k", "10k"];

const cssVar = (name: string, fallback: string): string => `var(--slop-${name}, ${fallback})`;

const EqPopupPage = () => {
  const [snap, setSnap] = useState<AudioBusSnapshot | null>(null);
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
      if (!msg || msg.type !== "snapshot") return;
      setSnap(msg.snapshot);
      setConnected(true);
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
        padding: 16,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1
          style={{
            fontSize: 14,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            margin: 0,
            color: cssVar("magenta", "#ff3ec9"),
          }}
        >
          [ outgoing audio · EQ ]
        </h1>
        <span
          style={{
            fontSize: 9,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: connected ? cssVar("lime", "#bcff5b") : cssVar("text-muted", "#7878a0"),
          }}
          title={connected ? "Receiving snapshots from the desktop tab" : "Waiting for the desktop tab to come online"}
        >
          {connected ? "● live" : "○ waiting"}
        </span>
      </div>

      {/* Master EQ section */}
      <section style={panelStyle}>
        <div style={sectionHeaderStyle}>
          <span>master</span>
          <button type="button" style={resetBtnStyle} onClick={() => post({ type: "reset-eq" })}>
            [ reset ]
          </button>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${BAND_LABELS.length}, 1fr)`,
            gap: 8,
            paddingTop: 8,
          }}
        >
          {BAND_LABELS.map((label, i) => {
            const band = snap?.bands[i];
            const value = band?.gain ?? 0;
            return (
              <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={0.5}
                  value={value}
                  disabled={!snap}
                  onChange={e => post({ type: "set-band-gain", bandIndex: i, db: parseFloat(e.target.value) })}
                  style={{
                    appearance: "slider-vertical" as React.CSSProperties["appearance"],
                    writingMode: "vertical-lr",
                    direction: "rtl" as const,
                    width: 22,
                    height: 130,
                    accentColor: cssVar("cyan", "#3fcfff"),
                  }}
                />
                <span style={{ fontSize: 9, color: cssVar("text-muted", "#7878a0"), letterSpacing: "0.06em" }}>
                  {label}
                </span>
                <span style={{ fontSize: 9, color: cssVar("cyan", "#3fcfff") }}>
                  {value > 0 ? "+" : ""}
                  {value.toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
            <span style={{ color: cssVar("text-muted", "#7878a0") }}>master gain</span>
            <span style={{ color: cssVar("magenta", "#ff3ec9") }}>
              {snap ? `${(snap.masterGain * 100).toFixed(0)}%` : "—"}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={snap?.masterGain ?? 1}
            disabled={!snap}
            onChange={e => post({ type: "set-master-gain", gain: parseFloat(e.target.value) })}
            style={{ width: "100%", accentColor: cssVar("magenta", "#ff3ec9") }}
          />
        </div>
      </section>

      {/* Per-source mixer */}
      <section style={panelStyle}>
        <div style={sectionHeaderStyle}>
          <span>sources</span>
          <span style={{ fontSize: 9, color: cssVar("text-muted", "#7878a0") }}>
            {snap ? `${snap.sources.length} active` : "—"}
          </span>
        </div>
        {snap && snap.sources.length === 0 ? (
          <div
            style={{
              padding: "16px 4px",
              fontSize: 11,
              color: cssVar("text-muted", "#7878a0"),
              textAlign: "center",
            }}
          >
            no audio sources active yet
          </div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {snap?.sources.map(src => (
            <div
              key={src.id}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                background: "rgba(255,255,255,0.03)",
                border: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
                borderRadius: 4,
              }}
            >
              <button
                type="button"
                onClick={() => post({ type: "set-source-muted", id: src.id, muted: !src.muted })}
                title={src.muted ? "unmute this source" : "mute this source"}
                aria-label={src.muted ? "unmute" : "mute"}
                style={{
                  width: 28,
                  height: 28,
                  background: src.muted ? cssVar("magenta", "#ff3ec9") : "transparent",
                  color: src.muted ? "#fff" : cssVar("text", "#e8e0ff"),
                  border: `1px solid ${src.muted ? cssVar("magenta", "#ff3ec9") : cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 14,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {src.muted ? "🔇" : "🔊"}
              </button>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={src.label}
                >
                  {src.label}
                </span>
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.01}
                  value={src.gain}
                  disabled={src.muted}
                  onChange={e => post({ type: "set-source-gain", id: src.id, gain: parseFloat(e.target.value) })}
                  style={{ width: "100%", accentColor: cssVar("cyan", "#3fcfff") }}
                />
              </div>
              <span
                style={{
                  fontSize: 10,
                  color: src.muted ? cssVar("text-muted", "#7878a0") : cssVar("cyan", "#3fcfff"),
                  minWidth: 38,
                  textAlign: "right",
                }}
              >
                {(src.gain * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

const panelStyle: React.CSSProperties = {
  background: cssVar("panel", "#0a0f24"),
  border: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
  borderRadius: 6,
  padding: 12,
};

const sectionHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 10,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: cssVar("text-muted", "#7878a0"),
  borderBottom: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
  paddingBottom: 6,
};

const resetBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: 0,
  color: cssVar("magenta", "#ff3ec9"),
  cursor: "pointer",
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  fontFamily: "inherit",
  padding: 0,
};

export default EqPopupPage;

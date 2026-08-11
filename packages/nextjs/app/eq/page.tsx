"use client";

import { useEffect, useRef, useState } from "react";
import { StreamMonitor } from "~~/components/StreamMonitor";
import {
  AUDIO_BUS_CHANNEL,
  AUTO_GAIN_MAX,
  type AudioBusSnapshot,
  type BusInboundMessage,
  type BusOutboundMessage,
  type CompositeHealth,
  type VideoHealthRow,
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
  const [videoRows, setVideoRows] = useState<VideoHealthRow[]>([]);
  const [health, setHealth] = useState<CompositeHealth | null>(null);
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
      } else if (msg.type === "video-stats") {
        setVideoRows(msg.rows);
        setConnected(true);
      } else if (msg.type === "composite-health") {
        setHealth(msg.health);
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
        // Fill the popup window. The stream monitor lives in a
        // bottom-fixed flex region so it stays put while the EQ
        // section above scrolls when sources stack up.
        minHeight: "100vh",
        height: "100vh",
        background: cssVar("bg", "#06030d"),
        color: cssVar("text", "#e8e0ff"),
        fontFamily: "var(--slop-font-display, ui-monospace, monospace)",
        padding: "10px 8px",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
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
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                cursor: "pointer",
                color: snap?.autoEnabled ? cssVar("lime", "#bcff5b") : cssVar("text-muted", "#7878a0"),
              }}
              title={
                snap?.autoEnabled
                  ? "Auto-level on: source gains continuously match the loudest to a shared target. Drag a slider to take manual control."
                  : "Auto-level off: manual gain control. Toggle to re-engage."
              }
            >
              <input
                type="checkbox"
                checked={!!snap?.autoEnabled}
                disabled={!snap}
                onChange={e => post({ type: "set-auto-enabled", enabled: e.target.checked })}
                style={{ accentColor: cssVar("lime", "#bcff5b"), margin: 0 }}
              />
              auto
            </label>
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

        {/* Video health — one row per video publication. `out` is the
            publisher's own encode report (fanned out via the relay);
            `in` is what the spectator tab is receiving. The qual badge
            is the money read: CPU = their machine can't keep up, NET =
            their uplink can't, TURN = the leg detours through the
            relay box instead of a direct path. */}
        <section style={panelStyle}>
          <div style={sectionHeaderStyle}>
            <span>video</span>
          </div>
          <CompositeLine health={health} />
          {videoRows.length === 0 ? (
            <div
              style={{
                padding: "10px 2px",
                fontSize: 9,
                color: cssVar("text-muted", "#7878a0"),
                textAlign: "center",
              }}
            >
              no video yet
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {videoRows.map(row => (
                <VideoRow key={row.key} row={row} />
              ))}
            </div>
          )}
        </section>
      </div>
      {/* Stream monitor — pinned to the bottom outside the scrollable
          EQ region. Self-contained: pulls the HLS feed and renders
          its own status pill + stats. */}
      <StreamMonitor />
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
          max={AUTO_GAIN_MAX}
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

const fmtRes = (w: number | null, h: number | null): string => (w != null && h != null ? `${w}×${h}` : "—");
const fmtFps = (fps: number | null): string => (fps != null ? `${fps}fps` : "—");
const fmtKbps = (kbps: number | null): string => (kbps != null ? `${kbps}k` : "—");

// The broadcast machine's own paint rate, above the per-feed rows.
// Read this FIRST: if it has dipped, every feed below will look starved
// whether or not it actually is, because the tab OBS captures never drew
// the frames that arrived. Feeds starve one at a time; the composite
// takes them all down together.
const CompositeLine = ({ health }: { health: CompositeHealth | null }) => {
  const stale = health != null && Date.now() - health.at > 10_000;
  // 24 fps is where a 30 fps capture starts reading as judder on the
  // broadcast rather than as a soft frame here and there.
  const bad = health != null && (health.hidden || health.fps < 24 || health.hitches > 0);
  const color = bad ? cssVar("red", "#ff5577") : cssVar("text-muted", "#7878a0");
  const label = health?.hidden
    ? "TAB HIDDEN — Chrome throttles rendering; un-occlude the captured window"
    : health == null
      ? "waiting"
      : `${health.fps.toFixed(0)} fps · worst ${health.worstFrameMs.toFixed(0)}ms${
          health.hitches > 0 ? ` · ${health.hitches} hitch${health.hitches === 1 ? "" : "es"}` : ""
        }`;
  return (
    <div
      title="How fast this god-mode tab is painting — the ceiling on everything OBS captures. Dips here mean the broadcast machine stalled, not that a guest's feed degraded."
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        marginTop: 6,
        padding: "4px 6px",
        fontSize: 8,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.03em",
        color,
        opacity: stale ? 0.4 : 1,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
        borderRadius: 4,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      <span style={{ fontSize: 9, flexShrink: 0 }}>🖼</span>
      <span style={{ flexShrink: 0 }}>composite</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </div>
  );
};

// One video publication: label + warning badges on top, then the
// publisher's encode line (out) and the received line (in). A report
// that hasn't refreshed in 10s renders dimmed — the publisher likely
// dropped or stopped sampling.
const VideoRow = ({ row }: { row: VideoHealthRow }) => {
  const now = Date.now();
  const outStale = row.out != null && now - row.out.at > 10_000;
  const badges: { text: string; color: string; title: string }[] = [];
  if (row.out?.qual === "cpu") {
    badges.push({
      text: "CPU",
      color: cssVar("red", "#ff5577"),
      title: "Publisher's encoder is CPU-starved — their machine can't keep up. Expect blur/blockiness.",
    });
  } else if (row.out?.qual === "bandwidth") {
    badges.push({
      text: "NET",
      color: cssVar("amber", "#ffae00"),
      title: "Publisher's uplink can't carry the target bitrate — the encoder is throttling.",
    });
  } else if (row.out?.qual === "other") {
    badges.push({
      text: "ENC",
      color: cssVar("amber", "#ffae00"),
      title: "Encoder degraded for an unspecified reason.",
    });
  }
  if (row.out?.relayed) {
    badges.push({
      text: "TURN",
      color: cssVar("amber", "#ffae00"),
      title: "This leg runs through the TURN relay instead of a direct path — extra latency + bandwidth cap.",
    });
  } else if (row.out?.path === "wan") {
    // Not relayed, but not on the wire either: a srflx pair leaves the
    // building and hairpins back, spending the uplink on what may be a
    // three-foot hop. Worth seeing even though nothing is "wrong".
    badges.push({
      text: "WAN",
      color: cssVar("amber", "#ffae00"),
      title:
        "Direct, but via public addresses — the bytes leave the building and come back, spending uplink. A host-to-host (LAN) pair would not.",
    });
  } else if (row.out?.path === "lan") {
    badges.push({
      text: "LAN",
      color: cssVar("lime", "#7CFF6B"),
      title: "Host-to-host: this leg never leaves the local wire and costs no uplink.",
    });
  }
  const statLine: React.CSSProperties = {
    display: "flex",
    gap: 6,
    fontSize: 8,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "0.03em",
    color: cssVar("text", "#e8e0ff"),
    opacity: outStale ? 0.4 : 1,
    whiteSpace: "nowrap",
  };
  const dim: React.CSSProperties = { color: cssVar("text-muted", "#7878a0") };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "5px 6px",
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
        borderRadius: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 9, flexShrink: 0 }} title={row.kind}>
          {row.kind === "screen" ? "🖥" : "🎥"}
        </span>
        <span
          style={{
            fontSize: 9,
            letterSpacing: "0.04em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={row.label}
        >
          {row.label}
        </span>
        {badges.map(b => (
          <span
            key={b.text}
            title={b.title}
            style={{
              fontSize: 7,
              letterSpacing: "0.08em",
              color: "#000",
              background: b.color,
              borderRadius: 2,
              padding: "1px 3px",
              flexShrink: 0,
            }}
          >
            {b.text}
          </span>
        ))}
        {row.wsRttMs != null ? (
          <span style={{ fontSize: 8, ...dim, flexShrink: 0 }} title="Publisher's round-trip to the relay">
            {row.wsRttMs}ms
          </span>
        ) : null}
      </div>
      <div style={statLine} title="What the publisher reports encoding (toward the broadcast leg)">
        <span style={dim}>out</span>
        {row.out ? (
          <>
            <span>{fmtRes(row.out.width, row.out.height)}</span>
            <span>{fmtFps(row.out.fps)}</span>
            <span>{fmtKbps(row.out.kbps)}</span>
            <span style={dim}>{row.out.codec ?? "—"}</span>
            {outStale ? <span style={dim}>stale</span> : null}
          </>
        ) : (
          <span style={dim}>no report</span>
        )}
      </div>
      <div style={statLine} title="What this (spectator) tab is receiving">
        <span style={dim}>in</span>
        {row.in ? (
          <>
            <span>{fmtRes(row.in.width, row.in.height)}</span>
            <span>{fmtFps(row.in.fps)}</span>
            <span>{fmtKbps(row.in.kbps)}</span>
          </>
        ) : (
          <span style={dim}>not receiving</span>
        )}
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

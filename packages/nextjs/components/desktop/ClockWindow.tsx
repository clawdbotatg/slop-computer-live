"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";

// Per-user clock app with three modes selected via tabs at the bottom:
//   - Time     — current time, with quick-pick world clocks
//   - Timer    — stopwatch (start / stop / reset, supports lap-style runs
//                via reset between starts)
//   - Countdown — type a duration, count down to zero (silent finish)
//
// All state is local. The "now" wall-clock tick (250ms) drives both
// the time display and the running stopwatch/countdown displays.

// --- helpers ----------------------------------------------------------------

function parseDuration(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":").map(p => p.trim());
  if (parts.some(p => p === "" || !/^\d+$/.test(p))) return null;
  const nums = parts.map(p => Number(p));
  if (nums.some(n => !Number.isFinite(n) || n < 0)) return null;
  let seconds = 0;
  if (nums.length === 1) seconds = nums[0] ?? 0;
  else if (nums.length === 2) seconds = (nums[0] ?? 0) * 60 + (nums[1] ?? 0);
  else if (nums.length === 3) seconds = (nums[0] ?? 0) * 3600 + (nums[1] ?? 0) * 60 + (nums[2] ?? 0);
  else return null;
  if (seconds <= 0) return null;
  return seconds;
}

function formatHMS(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

function formatHMSWithMillis(totalMs: number): string {
  const totalSecs = Math.floor(totalMs / 1000);
  const ms = Math.floor((totalMs % 1000) / 10); // 2-digit centiseconds
  return `${formatHMS(totalSecs)}.${ms.toString().padStart(2, "0")}`;
}

// --- world clocks -----------------------------------------------------------

type ZoneEntry = { id: string; label: string; tz: string };

const ZONES: ZoneEntry[] = [
  { id: "local", label: "Local", tz: "local" },
  { id: "utc", label: "UTC", tz: "UTC" },
  { id: "nyc", label: "New York", tz: "America/New_York" },
  { id: "la", label: "Los Angeles", tz: "America/Los_Angeles" },
  { id: "london", label: "London", tz: "Europe/London" },
  { id: "berlin", label: "Berlin", tz: "Europe/Berlin" },
  { id: "tokyo", label: "Tokyo", tz: "Asia/Tokyo" },
  { id: "shanghai", label: "Shanghai", tz: "Asia/Shanghai" },
];

function timeInZone(date: Date, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  };
  if (tz !== "local") opts.timeZone = tz;
  try {
    return new Intl.DateTimeFormat(undefined, opts).format(date);
  } catch {
    // Invalid timeZone (very old browser) — fall back to UTC.
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: "UTC" }).format(date);
  }
}

// --- state types (shared via the mesh) -------------------------------------

type StopwatchState =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number; pausedElapsedMs: number }
  | { phase: "paused"; pausedElapsedMs: number };

type CountdownState =
  | { phase: "idle" }
  | { phase: "running"; totalSecs: number; endAt: number }
  | { phase: "paused"; totalSecs: number; remainingSecs: number }
  | { phase: "done"; totalSecs: number };

type Tab = "time" | "timer" | "countdown";

// --- component --------------------------------------------------------------

// Multiplayer: tab pick, selected zone, stopwatch + countdown state ALL
// flow through `mesh.clockState`. The relay persists it and broadcasts on
// every change so every viewer sees the same display. Wall-clock-anchored
// fields (`startedAt`, `endAt`) mean each peer's UI computes the same
// remaining/elapsed from their own Date.now(), so we don't have to sync
// per-tick — just on state transitions.
//
// `countdownInput` (the typed duration BEFORE start) stays local: there's
// no value in two peers fighting over a draft. It's only used to compute
// `totalSecs` when one of them hits Start, which IS broadcast.

export const ClockWindow = ({ mesh }: { mesh: PeerMeshState }) => {
  const [now, setNow] = useState(() => Date.now());
  const tab = mesh.clockState.tab;
  const selectedZone = mesh.clockState.selectedZone;
  const stopwatch = mesh.clockState.stopwatch;
  const countdown = mesh.clockState.countdown;
  const [countdownInput, setCountdownInput] = useState("10:00");

  const setTab = useCallback((t: Tab) => mesh.setClockState({ tab: t }), [mesh]);
  const setSelectedZone = useCallback((zone: string) => mesh.setClockState({ selectedZone: zone }), [mesh]);
  const setStopwatch = useCallback((s: StopwatchState) => mesh.setClockState({ stopwatch: s }), [mesh]);
  const setCountdown = useCallback((c: CountdownState) => mesh.setClockState({ countdown: c }), [mesh]);

  const finishedRef = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Auto-finish countdown — every peer detects the transition locally
  // (since endAt is wall-clock) at the exact same moment. Whoever's tick
  // fires first pushes the "done" state to the mesh; subsequent peers
  // find phase already "done" and skip. No sound — finish is silent.
  useEffect(() => {
    if (countdown.phase !== "running") return;
    if (now < countdown.endAt) return;
    if (finishedRef.current) return;
    finishedRef.current = true;
    setCountdown({ phase: "done", totalSecs: countdown.totalSecs });
  }, [now, countdown, setCountdown]);
  useEffect(() => {
    if (countdown.phase !== "done") finishedRef.current = false;
  }, [countdown.phase]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {tab === "time" ? (
          <TimePanel now={now} selectedZone={selectedZone} onPick={setSelectedZone} />
        ) : tab === "timer" ? (
          <TimerPanel now={now} state={stopwatch} onChange={setStopwatch} />
        ) : (
          <CountdownPanel
            now={now}
            input={countdownInput}
            onInput={setCountdownInput}
            state={countdown}
            onChange={setCountdown}
          />
        )}
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          borderTop: "1px solid var(--slop-border, #2a1d4a)",
          background: "#0a061a",
        }}
      >
        {(["time", "timer", "countdown"] as const).map(t => {
          const active = t === tab;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                padding: "8px 4px",
                fontSize: 10,
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                background: active ? "rgba(255,62,201,0.15)" : "transparent",
                color: active ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-text-muted)",
                border: "none",
                borderTop: active ? "2px solid var(--slop-magenta, #ff3ec9)" : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              {t}
            </button>
          );
        })}
      </div>
    </div>
  );
};

// --- Time panel -------------------------------------------------------------

const TimePanel = ({
  now,
  selectedZone,
  onPick,
}: {
  now: number;
  selectedZone: string;
  onPick: (id: string) => void;
}) => {
  const date = useMemo(() => new Date(now), [now]);
  const zone = ZONES.find(z => z.id === selectedZone) ?? ZONES[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          gap: 4,
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "var(--slop-text-muted)",
          }}
        >
          {zone.label}
        </div>
        <div style={{ fontSize: 36, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
          {timeInZone(date, zone.tz)}
        </div>
        <div style={{ fontSize: 12, color: "var(--slop-text-muted)" }}>
          {date.toLocaleDateString(undefined, {
            ...(zone.tz !== "local" ? { timeZone: zone.tz } : {}),
            weekday: "short",
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 4,
          padding: 8,
          borderTop: "1px solid var(--slop-border, #2a1d4a)",
        }}
      >
        {ZONES.map(z => {
          const active = z.id === selectedZone;
          return (
            <button
              key={z.id}
              type="button"
              onClick={() => onPick(z.id)}
              style={{
                padding: "5px 8px",
                fontSize: 10,
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                textAlign: "left",
                background: active ? "var(--slop-magenta, #ff3ec9)" : "transparent",
                color: active ? "#06030d" : "var(--slop-text)",
                border: "1px solid var(--slop-border, #2a1d4a)",
                borderRadius: 3,
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span>{z.label}</span>
              <span
                style={{
                  fontSize: 9,
                  fontFamily: "var(--slop-font-body)",
                  color: active ? "#06030d" : "var(--slop-text-muted)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {timeInZone(date, z.tz)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// --- Timer (stopwatch) panel ------------------------------------------------

const TimerPanel = ({
  now,
  state,
  onChange,
}: {
  now: number;
  state: StopwatchState;
  onChange: (s: StopwatchState) => void;
}) => {
  const elapsedMs =
    state.phase === "running"
      ? state.pausedElapsedMs + (now - state.startedAt)
      : state.phase === "paused"
        ? state.pausedElapsedMs
        : 0;
  const isRunning = state.phase === "running";
  const isPaused = state.phase === "paused";

  const start = () => {
    if (state.phase === "running") return;
    onChange({
      phase: "running",
      startedAt: Date.now(),
      pausedElapsedMs: state.phase === "paused" ? state.pausedElapsedMs : 0,
    });
  };
  const stop = () => {
    if (state.phase !== "running") return;
    onChange({
      phase: "paused",
      pausedElapsedMs: state.pausedElapsedMs + (Date.now() - state.startedAt),
    });
  };
  const reset = () => {
    onChange({ phase: "idle" });
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        gap: 14,
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontFamily: "var(--slop-font-display)",
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: isRunning ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-text-muted)",
        }}
      >
        {isRunning ? "Running" : isPaused ? "Paused" : "Ready"}
      </div>
      <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
        {formatHMSWithMillis(elapsedMs)}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {!isRunning ? (
          <button type="button" onClick={start} style={primaryBtnStyle(true)}>
            {isPaused ? "Resume" : "Start"}
          </button>
        ) : (
          <button type="button" onClick={stop} style={primaryBtnStyle(true)}>
            Stop
          </button>
        )}
        <button type="button" onClick={reset} style={secondaryBtnStyle} disabled={state.phase === "idle"}>
          Reset
        </button>
      </div>
    </div>
  );
};

// --- Countdown panel --------------------------------------------------------

const COUNTDOWN_PRESETS: { label: string; secs: number }[] = [
  { label: "30s", secs: 30 },
  { label: "1m", secs: 60 },
  { label: "5m", secs: 5 * 60 },
  { label: "10m", secs: 10 * 60 },
  { label: "25m", secs: 25 * 60 },
];

const CountdownPanel = ({
  now,
  input,
  onInput,
  state,
  onChange,
}: {
  now: number;
  input: string;
  onInput: (s: string) => void;
  state: CountdownState;
  onChange: (s: CountdownState) => void;
}) => {
  const remaining = useMemo(() => {
    if (state.phase === "running") return Math.max(0, Math.ceil((state.endAt - now) / 1000));
    if (state.phase === "paused") return state.remainingSecs;
    if (state.phase === "done") return 0;
    return parseDuration(input) ?? 0;
  }, [state, now, input]);

  const parsed = parseDuration(input);
  const isRunning = state.phase === "running";
  const isPaused = state.phase === "paused";
  const isDone = state.phase === "done";

  // Scale the big number to fill the window. Measure the wrapping flex area, then
  // pick a font size constrained by both width (digit count) and available height
  // (reserving space for the input/presets when idle).
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (r) setStageSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const display = formatHMS(remaining);
  const reservedH = state.phase === "idle" ? 130 : 28; // status label + (input + presets when idle)
  const availH = Math.max(0, stageSize.h - reservedH);
  // ~0.6em per char is a decent approximation for bold tabular digits + colons.
  const byWidth = stageSize.w > 0 ? (stageSize.w * 0.92) / (display.length * 0.6) : 44;
  const byHeight = availH > 0 ? availH * 0.9 : 44;
  const numberFontSize = Math.max(28, Math.min(byWidth, byHeight, 320));

  const startFrom = (secs: number) => {
    if (secs <= 0) return;
    onChange({ phase: "running", totalSecs: secs, endAt: Date.now() + secs * 1000 });
  };
  const start = () => {
    const s = parseDuration(input);
    if (s) startFrom(s);
  };
  const pause = () => {
    if (state.phase !== "running") return;
    const remainingSecs = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
    onChange({ phase: "paused", totalSecs: state.totalSecs, remainingSecs });
  };
  const resume = () => {
    if (state.phase !== "paused") return;
    onChange({ phase: "running", totalSecs: state.totalSecs, endAt: Date.now() + state.remainingSecs * 1000 });
  };
  const reset = () => onChange({ phase: "idle" });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        ref={stageRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 14,
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: isDone ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-text-muted)",
          }}
        >
          {isDone ? "Time's up" : isPaused ? "Paused" : isRunning ? "Counting down" : "Set timer"}
        </div>
        <div
          aria-live="polite"
          style={{
            fontSize: numberFontSize,
            fontWeight: 800,
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
            color: isDone ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-text)",
            transform: isDone ? `scale(${1 + ((now / 400) % 1 > 0.5 ? 0.04 : 0)})` : "none",
            transition: "transform 0.15s",
            whiteSpace: "nowrap",
          }}
        >
          {display}
        </div>

        {state.phase === "idle" ? (
          <>
            <input
              type="text"
              value={input}
              onChange={e => onInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && parsed) start();
              }}
              placeholder="MM:SS or H:MM:SS"
              spellCheck={false}
              style={{
                width: 160,
                padding: "6px 10px",
                fontSize: 16,
                fontVariantNumeric: "tabular-nums",
                fontFamily: "var(--slop-font-body)",
                background: "#0e0820",
                color: parsed ? "var(--slop-text)" : "#ff6b6b",
                border: `1px solid ${parsed ? "var(--slop-border, #2a1d4a)" : "#ff6b6b"}`,
                borderRadius: 4,
                outline: "none",
                textAlign: "center",
              }}
            />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
              {COUNTDOWN_PRESETS.map(p => (
                <button key={p.label} type="button" onClick={() => startFrom(p.secs)} style={presetBtnStyle}>
                  {p.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderTop: "1px solid var(--slop-border, #2a1d4a)",
          justifyContent: "center",
        }}
      >
        {state.phase === "idle" ? (
          <button type="button" onClick={start} disabled={!parsed} style={primaryBtnStyle(Boolean(parsed))}>
            Start
          </button>
        ) : null}
        {isRunning ? (
          <button type="button" onClick={pause} style={primaryBtnStyle(true)}>
            Pause
          </button>
        ) : null}
        {isPaused ? (
          <button type="button" onClick={resume} style={primaryBtnStyle(true)}>
            Resume
          </button>
        ) : null}
        {state.phase !== "idle" ? (
          <button type="button" onClick={reset} style={secondaryBtnStyle}>
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
};

// --- shared button styles ---------------------------------------------------

function primaryBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    fontSize: 11,
    fontFamily: "var(--slop-font-display)",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    background: enabled ? "var(--slop-magenta, #ff3ec9)" : "transparent",
    color: enabled ? "#06030d" : "var(--slop-text-muted)",
    border: "1px solid var(--slop-border, #2a1d4a)",
    borderRadius: 4,
    cursor: enabled ? "pointer" : "not-allowed",
  };
}

const secondaryBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 11,
  fontFamily: "var(--slop-font-display)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  background: "transparent",
  color: "var(--slop-text)",
  border: "1px solid var(--slop-border, #2a1d4a)",
  borderRadius: 4,
  cursor: "pointer",
};

const presetBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  fontFamily: "var(--slop-font-display)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  background: "transparent",
  color: "var(--slop-text-muted)",
  border: "1px solid var(--slop-border, #2a1d4a)",
  borderRadius: 3,
  cursor: "pointer",
};

export default ClockWindow;

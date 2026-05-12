"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Local clock + countdown timer. State is per-user (each peer has their
// own timer; nothing is shared via the mesh). Two displays stacked:
//   - Wall-clock at top, refreshed every second
//   - Countdown below, with an input that accepts SS, MM:SS, or H:MM:SS
//
// When a running countdown reaches zero we beep via Web Audio (a short
// 880Hz square-wave envelope — works in every modern browser without
// loading an audio file) and visually pulse the display.

const FINISH_TONE_DURATION_MS = 800;

// Parse a duration string. Accepts:
//   "90"        → 90 seconds
//   "1:30"      → 1m 30s
//   "10:00"     → 10m 0s
//   "1:30:00"   → 1h 30m 0s
// Returns null if the input doesn't fit any of those shapes.
function parseDuration(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":").map(p => p.trim());
  if (parts.some(p => p === "" || !/^\d+$/.test(p))) return null;
  const nums = parts.map(p => Number(p));
  if (nums.some(n => !Number.isFinite(n) || n < 0)) return null;
  let seconds = 0;
  if (nums.length === 1) {
    seconds = nums[0] ?? 0;
  } else if (nums.length === 2) {
    seconds = (nums[0] ?? 0) * 60 + (nums[1] ?? 0);
  } else if (nums.length === 3) {
    seconds = (nums[0] ?? 0) * 3600 + (nums[1] ?? 0) * 60 + (nums[2] ?? 0);
  } else {
    return null;
  }
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

function playFinishTone() {
  try {
    const Ctx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    // Quick attack, hold, release envelope so it doesn't click.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.25, now + 0.02);
    gain.gain.setValueAtTime(0.25, now + 0.5);
    gain.gain.linearRampToValueAtTime(0, now + FINISH_TONE_DURATION_MS / 1000);
    osc.start(now);
    osc.stop(now + FINISH_TONE_DURATION_MS / 1000 + 0.05);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {
    /* AudioContext blocked / unavailable — silent finish is acceptable */
  }
}

type CountdownState =
  | { phase: "idle" }
  | { phase: "running"; totalSecs: number; endAt: number /* ms epoch */ }
  | { phase: "paused"; totalSecs: number; remainingSecs: number }
  | { phase: "done"; totalSecs: number };

export const ClockWindow = () => {
  const [now, setNow] = useState(() => Date.now());
  const [input, setInput] = useState("10:00");
  const [state, setState] = useState<CountdownState>({ phase: "idle" });
  const finishedRef = useRef(false);

  // 250ms tick. Fine-grained enough that countdown seconds tick over
  // smoothly even when the user's tab is mid-rerender for some other
  // reason, but light enough to never matter.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Auto-finish when a running timer hits zero.
  useEffect(() => {
    if (state.phase !== "running") return;
    if (now < state.endAt) return;
    if (finishedRef.current) return;
    finishedRef.current = true;
    setState({ phase: "done", totalSecs: state.totalSecs });
    playFinishTone();
  }, [now, state]);

  // Reset the finished-once guard whenever we leave the "done" state.
  useEffect(() => {
    if (state.phase !== "done") finishedRef.current = false;
  }, [state.phase]);

  const wallClock = useMemo(() => {
    const d = new Date(now);
    const hh = d.getHours();
    const mm = d.getMinutes().toString().padStart(2, "0");
    const ss = d.getSeconds().toString().padStart(2, "0");
    const ampm = hh >= 12 ? "PM" : "AM";
    const h12 = ((hh + 11) % 12) + 1;
    return `${h12}:${mm}:${ss} ${ampm}`;
  }, [now]);

  const remaining = useMemo(() => {
    if (state.phase === "running") return Math.max(0, Math.ceil((state.endAt - now) / 1000));
    if (state.phase === "paused") return state.remainingSecs;
    if (state.phase === "done") return 0;
    return parseDuration(input) ?? 0;
  }, [state, now, input]);

  const parsedInput = parseDuration(input);

  const start = () => {
    const secs = parseDuration(input);
    if (!secs) return;
    setState({ phase: "running", totalSecs: secs, endAt: Date.now() + secs * 1000 });
  };
  const resume = () => {
    if (state.phase !== "paused") return;
    setState({
      phase: "running",
      totalSecs: state.totalSecs,
      endAt: Date.now() + state.remainingSecs * 1000,
    });
  };
  const pause = () => {
    if (state.phase !== "running") return;
    const remainingSecs = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
    setState({ phase: "paused", totalSecs: state.totalSecs, remainingSecs });
  };
  const reset = () => {
    setState({ phase: "idle" });
  };
  const addSeconds = (extra: number) => {
    if (state.phase === "running") {
      setState({ phase: "running", totalSecs: state.totalSecs + extra, endAt: state.endAt + extra * 1000 });
    } else if (state.phase === "paused") {
      setState({
        phase: "paused",
        totalSecs: state.totalSecs + extra,
        remainingSecs: Math.max(0, state.remainingSecs + extra),
      });
    } else if (state.phase === "done") {
      // From "done", +1 minute reanimates the timer with a fresh 60s.
      setState({ phase: "running", totalSecs: extra, endAt: Date.now() + extra * 1000 });
    } else {
      // idle: extend the parsed input as a convenience.
      const cur = parseDuration(input) ?? 0;
      const next = cur + extra;
      setInput(formatHMS(next));
    }
  };

  const isRunning = state.phase === "running";
  const isPaused = state.phase === "paused";
  const isDone = state.phase === "done";

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
      {/* Wall clock */}
      <div
        style={{
          padding: "10px 12px 6px",
          borderBottom: "1px solid var(--slop-border, #2a1d4a)",
          textAlign: "center",
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
          Now
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
          {wallClock}
        </div>
      </div>

      {/* Countdown */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 12,
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
            fontSize: 48,
            fontWeight: 800,
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
            color: isDone ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-text)",
            // Subtle pulse when done — relies on the now-tick re-render.
            transform: isDone ? `scale(${1 + ((now / 400) % 1 > 0.5 ? 0.04 : 0)})` : "none",
            transition: "transform 0.15s",
          }}
        >
          {formatHMS(remaining)}
        </div>

        {state.phase === "idle" ? (
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && parsedInput) start();
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
              color: parsedInput ? "var(--slop-text)" : "#ff6b6b",
              border: `1px solid ${parsedInput ? "var(--slop-border, #2a1d4a)" : "#ff6b6b"}`,
              borderRadius: 4,
              outline: "none",
              textAlign: "center",
            }}
          />
        ) : null}

        {/* Quick-add buttons */}
        <div style={{ display: "flex", gap: 6 }}>
          {[60, 5 * 60, 15 * 60].map(s => (
            <button
              key={s}
              type="button"
              onClick={() => addSeconds(s)}
              style={{
                padding: "4px 8px",
                fontSize: 10,
                fontFamily: "var(--slop-font-display)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                background: "transparent",
                color: "var(--slop-text-muted)",
                border: "1px solid var(--slop-border, #2a1d4a)",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              +{s >= 60 ? `${s / 60}m` : `${s}s`}
            </button>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderTop: "1px solid var(--slop-border, #2a1d4a)",
          background: "#0a061a",
          justifyContent: "center",
        }}
      >
        {state.phase === "idle" ? (
          <button type="button" onClick={start} disabled={!parsedInput} style={primaryBtnStyle(Boolean(parsedInput))}>
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

export default ClockWindow;

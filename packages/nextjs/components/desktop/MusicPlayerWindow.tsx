"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Music player window body — designed to live inside a <SlotWindow>. The
// parent supplies the titlebar / drag / resize chrome; this component owns
// the <audio> element, playlist state, spectrum visualizer, and transport
// controls. Aesthetic: classic Winamp 2.x main-window — big amber LCD time
// digits, lime track marquee, kbps/kHz/STEREO info, green→amber→magenta
// spectrum, tight pixel transport buttons, horizontal volume + balance,
// playlist as a separate beveled panel below.

type Track = { title: string; artist: string; src: string };

const PLAYLIST_URL = "/music/playlist.json";
const VOLUME_KEY = "slop-music-volume-v1";

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return "00:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

export const MusicPlayerWindow = () => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.7);
  const [balance, setBalance] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Restore the last-set volume on mount so the user's preference survives
  // close/reopen.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(VOLUME_KEY);
      if (raw) {
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) setVolume(parsed);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Pull the playlist.json once. Errors surface in the LCD area; the rest
  // of the UI keeps working (transport buttons just no-op).
  useEffect(() => {
    let cancelled = false;
    fetch(PLAYLIST_URL, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { tracks?: unknown }) => {
        if (cancelled) return;
        if (!Array.isArray(data.tracks)) throw new Error("no tracks");
        const valid = (data.tracks as Track[]).filter(t => typeof t?.src === "string" && typeof t?.title === "string");
        setTracks(valid);
        if (valid.length === 0) setError("playlist is empty");
      })
      .catch(err => {
        if (!cancelled) setError(`couldn't load playlist: ${(err as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = tracks[index] ?? null;

  // ---- Web Audio graph -------------------------------------------------
  // analyser for the spectrum, plus a stereo panner for the BAL slider.
  // Built lazily *inside the user gesture* (togglePlay) — Chrome's
  // autoplay policy keeps a context created outside a gesture in the
  // "suspended" state, which silently swallows all audio routed through
  // it. That's the bug that made playback look dead in v1.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const pannerRef = useRef<StereoPannerNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const setupGraph = useCallback(() => {
    const a = audioRef.current;
    if (!a || audioCtxRef.current) return;
    type Ctor = new () => AudioContext;
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!C) return;
    try {
      const ctx = new C();
      const src = ctx.createMediaElementSource(a);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.78;
      const panner = ctx.createStereoPanner();
      // src → panner → analyser → destination. Analyser is a pass-through
      // so audio still hits the speakers; panner gives BAL a real effect.
      src.connect(panner);
      panner.connect(analyser);
      analyser.connect(ctx.destination);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      pannerRef.current = panner;
    } catch (err) {
      // createMediaElementSource throws if called twice on the same
      // element. Not fatal — playback still works through the default
      // route, we just lose the visualizer + balance.
      console.warn("music graph init failed", err);
    }
  }, []);

  // Push volume into the live element AND persist.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    try {
      window.localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
      /* ignore */
    }
  }, [volume]);

  // Push balance into the panner if the graph is up.
  useEffect(() => {
    const p = pannerRef.current;
    if (p) p.pan.value = Math.max(-1, Math.min(1, balance));
  }, [balance]);

  // Manage src + state imperatively. Setting src declaratively in JSX
  // would re-mount the audio element on every track switch, which kills
  // the MediaElementSourceNode (Web Audio refuses to attach twice).
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!current) {
      a.removeAttribute("src");
      setPosition(0);
      setDuration(0);
      return;
    }
    a.src = current.src;
    a.load();
    if (playing) {
      // Resume / kick the context — switching tracks while playing.
      audioCtxRef.current?.resume().catch(() => undefined);
      a.play().catch(err => {
        setPlaying(false);
        setError(`can't autoplay: ${(err as Error).message}`);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.src]);

  // Lifecycle event listeners.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      if (!seeking) setPosition(a.currentTime);
    };
    const onMeta = () => setDuration(a.duration || 0);
    const onEnded = () => {
      setIndex(i => (tracks.length > 0 ? (i + 1) % tracks.length : 0));
    };
    const onErr = () => {
      const msg = a.error?.message || "unknown error";
      setError(`playback error on "${current?.title ?? "?"}": ${msg}`);
      setPlaying(false);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onErr);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onErr);
    };
  }, [tracks.length, current?.title, seeking]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || !current) return;
    setError(null);
    // Build the Web Audio graph + resume the context inside this user
    // gesture so the autoplay policy doesn't keep us suspended.
    setupGraph();
    audioCtxRef.current?.resume().catch(() => undefined);
    if (a.paused) {
      a.play()
        .then(() => setPlaying(true))
        .catch(err => setError(`play failed: ${(err as Error).message}`));
    } else {
      a.pause();
      setPlaying(false);
    }
  }, [current, setupGraph]);

  const stop = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.pause();
    a.currentTime = 0;
    setPlaying(false);
    setPosition(0);
  }, []);

  const next = useCallback(() => {
    if (tracks.length === 0) return;
    setIndex(i => (i + 1) % tracks.length);
  }, [tracks.length]);

  const prev = useCallback(() => {
    if (tracks.length === 0) return;
    // > 3s into the track? rewind. Else jump to previous. (Winamp default.)
    const a = audioRef.current;
    if (a && a.currentTime > 3) {
      a.currentTime = 0;
      setPosition(0);
      return;
    }
    setIndex(i => (i - 1 + tracks.length) % tracks.length);
  }, [tracks.length]);

  const playIndex = useCallback(
    (i: number) => {
      setupGraph();
      audioCtxRef.current?.resume().catch(() => undefined);
      setIndex(i);
      setPlaying(true);
      setError(null);
    },
    [setupGraph],
  );

  // RAF spectrum loop. Renders to canvas in-place; no React re-renders.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
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
        const ctx2d = canvas.getContext("2d");
        if (ctx2d) {
          const W = canvas.width;
          const H = canvas.height;
          ctx2d.clearRect(0, 0, W, H);
          const bins = analyser.frequencyBinCount;
          const data = new Uint8Array(bins);
          analyser.getByteFrequencyData(data);
          const start = 1; // skip DC bin
          const used = Math.min(bins - start, 19); // Winamp main viz is ~19 bars
          const totalGap = (used + 1) * dpr;
          const barW = (W - totalGap) / used;
          // Draw bars in the classic Winamp gradient: lime at the bottom
          // climbing through amber to magenta at the peak.
          for (let i = 0; i < used; i++) {
            const v = (data[i + start] ?? 0) / 255;
            const segments = Math.max(1, Math.floor(v * 14));
            const segH = H / 14;
            const x = dpr + i * (barW + dpr);
            for (let s = 0; s < segments; s++) {
              const t = s / 14;
              const color = t < 0.45 ? "#bcff5b" : t < 0.75 ? "#ffae00" : "#ff3ec9";
              ctx2d.fillStyle = color;
              const y = H - (s + 1) * segH + dpr * 0.5;
              ctx2d.fillRect(x, y, barW, Math.max(1, segH - dpr));
            }
          }
        }
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  // Cleanup AudioContext on unmount.
  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  // Track meta line — what we know about the current track. We don't
  // probe the file, just show the playlist.json metadata; the bitrate /
  // sample-rate are placeholders that still read like a Winamp readout.
  const lcdTrackText = useMemo(() => {
    if (error) return error;
    if (!current) return tracks.length === 0 ? "loading playlist…" : "no track";
    return `${index + 1}. ${current.artist} - ${current.title}  (${fmtTime(duration)})`;
  }, [current, error, tracks.length, index, duration]);

  const shownPosition = seeking ? seekValue : position;
  const seekMax = duration > 0 ? duration : 1;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "linear-gradient(180deg, #14091e 0%, #06030d 100%)",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-display)",
        userSelect: "none",
      }}
    >
      {/* Same-origin source — no crossOrigin attribute, since the dev
          server doesn't emit CORS headers and the visualizer doesn't need
          it for local playback. */}
      <audio ref={audioRef} preload="metadata" />

      {/* === Top LCD panel ============================================== */}
      <div
        style={{
          margin: 6,
          padding: "6px 8px 4px",
          background: "#000",
          borderTop: "1px solid #000",
          borderLeft: "1px solid #000",
          borderRight: "1px solid rgba(255,255,255,0.18)",
          borderBottom: "1px solid rgba(255,255,255,0.18)",
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 8,
          alignItems: "center",
        }}
      >
        {/* Big amber LCD time digits, like Winamp's clock readout. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 78 }}>
          <div
            style={{
              fontFamily: "var(--slop-font-display)",
              fontSize: 28,
              lineHeight: 1,
              color: playing ? "var(--slop-amber, #ffae00)" : "rgba(255,174,0,0.35)",
              letterSpacing: "0.04em",
              fontVariantNumeric: "tabular-nums",
              textShadow: playing
                ? "0 0 6px rgba(255,174,0,0.55), 0 0 14px rgba(255,174,0,0.25)"
                : "0 0 4px rgba(255,174,0,0.2)",
            }}
          >
            {fmtTime(shownPosition)}
          </div>
          <div
            style={{
              fontSize: 9,
              color: "rgba(188,255,91,0.8)",
              letterSpacing: "0.08em",
            }}
          >
            -{fmtTime(Math.max(0, duration - shownPosition))}
          </div>
        </div>

        {/* Right column: spectrum on top, info row + marquee below. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 6,
              alignItems: "stretch",
            }}
          >
            <canvas ref={canvasRef} style={{ width: "100%", height: 28, display: "block" }} aria-hidden />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                justifyContent: "space-between",
                fontSize: 9,
                color: "rgba(188,255,91,0.75)",
                letterSpacing: "0.06em",
                lineHeight: 1.1,
              }}
            >
              <div>256 kbps</div>
              <div>44 khz</div>
              <div style={{ color: playing ? "var(--slop-lime, #bcff5b)" : "rgba(188,255,91,0.3)" }}>STEREO</div>
            </div>
          </div>
          <Marquee text={lcdTrackText} color={error ? "var(--slop-red, #ff5577)" : "var(--slop-lime, #bcff5b)"} />
        </div>
      </div>

      {/* === Seek bar ================================================== */}
      <div style={{ padding: "0 8px" }}>
        <input
          type="range"
          min={0}
          max={seekMax}
          step={0.1}
          value={shownPosition}
          onChange={e => setSeekValue(parseFloat(e.target.value))}
          onMouseDown={() => {
            setSeekValue(position);
            setSeeking(true);
          }}
          onMouseUp={e => {
            const v = parseFloat((e.target as HTMLInputElement).value);
            if (audioRef.current && Number.isFinite(v)) {
              audioRef.current.currentTime = v;
              setPosition(v);
            }
            setSeeking(false);
          }}
          disabled={!current || duration === 0}
          aria-label="seek"
          className="slop-music-range slop-music-range--seek"
          style={{ width: "100%" }}
        />
      </div>

      {/* === Transport + sliders row =================================== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          alignItems: "center",
          gap: 10,
          padding: "4px 8px 6px",
        }}
      >
        <div style={{ display: "flex", gap: 2 }}>
          <TBtn label="prev" onClick={prev} disabled={tracks.length === 0} icon="prev" />
          <TBtn label="play" onClick={togglePlay} disabled={!current} icon={playing ? "pause" : "play"} accent />
          <TBtn label="stop" onClick={stop} disabled={!current} icon="stop" />
          <TBtn label="next" onClick={next} disabled={tracks.length === 0} icon="next" />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto 1fr",
            alignItems: "center",
            columnGap: 4,
            fontSize: 9,
            color: "rgba(188,255,91,0.65)",
            letterSpacing: "0.08em",
          }}
        >
          <span>VOL</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={e => setVolume(parseFloat(e.target.value))}
            aria-label="volume"
            className="slop-music-range"
            style={{ width: "100%" }}
          />
          <span style={{ marginLeft: 4 }}>BAL</span>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={balance}
            onChange={e => setBalance(parseFloat(e.target.value))}
            onDoubleClick={() => setBalance(0)}
            aria-label="balance"
            className="slop-music-range"
            style={{ width: "100%" }}
            title="double-click to center"
          />
        </div>
      </div>

      {/* === Playlist (separate beveled panel) ========================= */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          margin: "0 6px 6px",
          background: "#000",
          borderTop: "1px solid #000",
          borderLeft: "1px solid #000",
          borderRight: "1px solid rgba(255,255,255,0.18)",
          borderBottom: "1px solid rgba(255,255,255,0.18)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "3px 8px",
            fontSize: 9,
            color: "rgba(188,255,91,0.6)",
            letterSpacing: "0.1em",
            background: "linear-gradient(180deg, rgba(124,77,255,0.35) 0%, rgba(0,0,0,0.6) 100%)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          PLAYLIST EDITOR — {tracks.length} ITEM{tracks.length === 1 ? "" : "S"}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {tracks.length === 0 ? (
            <div
              style={{
                padding: 16,
                fontSize: 10,
                color: "var(--slop-text-muted)",
                textAlign: "center",
              }}
            >
              {error ?? "loading…"}
            </div>
          ) : (
            tracks.map((t, i) => {
              const active = i === index;
              return (
                <div
                  key={t.src}
                  onDoubleClick={() => playIndex(i)}
                  onClick={() => setIndex(i)}
                  title={`double-click to play • ${t.src}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "26px 1fr auto",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 8px",
                    fontSize: 10,
                    cursor: "pointer",
                    background: active
                      ? "linear-gradient(180deg, rgba(255,62,201,0.35) 0%, rgba(124,77,255,0.25) 100%)"
                      : i % 2 === 0
                        ? "transparent"
                        : "rgba(255,255,255,0.02)",
                    color: active ? "var(--slop-lime, #bcff5b)" : "rgba(188,255,91,0.75)",
                    letterSpacing: "0.04em",
                  }}
                >
                  <span
                    style={{
                      color: active ? "var(--slop-amber, #ffae00)" : "rgba(255,174,0,0.55)",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {String(i + 1).padStart(2, "0")}.
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textTransform: "uppercase",
                    }}
                  >
                    {t.artist} - {t.title}
                  </span>
                  <span
                    style={{
                      color: active && playing ? "var(--slop-amber, #ffae00)" : "rgba(255,174,0,0.4)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {active ? fmtTime(duration) : "--:--"}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

// --- Transport button -------------------------------------------------
// Pixel-perfect tiny chrome key. Renders a glyph composed of CSS shapes
// (no fonts) so the prev/next/play/stop icons read as real pixel art at
// any zoom. Accent variant lights the play button up in magenta.
type Icon = "prev" | "play" | "pause" | "stop" | "next";

const TBtn = ({
  label,
  onClick,
  disabled,
  accent,
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  icon: Icon;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    style={{
      width: accent ? 28 : 22,
      height: 18,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      background: accent
        ? "linear-gradient(180deg, var(--slop-magenta) 0%, var(--slop-magenta-dim) 100%)"
        : "linear-gradient(180deg, #2a2050 0%, #0a0820 100%)",
      borderTop: "1px solid rgba(255,255,255,0.22)",
      borderLeft: "1px solid rgba(255,255,255,0.22)",
      borderRight: "1px solid #000",
      borderBottom: "1px solid #000",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.45 : 1,
      padding: 0,
    }}
  >
    <Glyph icon={icon} accent={!!accent} />
  </button>
);

// Tiny pixel-style transport glyphs rendered as CSS — no font dependency,
// always crisp. Each icon is a flex row of two halves (skip-back/skip-fwd)
// or a triangle / two bars / a square.
const Glyph = ({ icon, accent }: { icon: Icon; accent: boolean }) => {
  const fg = accent ? "#fff" : "var(--slop-lime, #bcff5b)";
  switch (icon) {
    case "play":
      return (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 0,
            height: 0,
            borderLeft: `7px solid ${fg}`,
            borderTop: "5px solid transparent",
            borderBottom: "5px solid transparent",
            marginLeft: 2,
          }}
        />
      );
    case "pause":
      return (
        <span aria-hidden style={{ display: "inline-flex", gap: 2 }}>
          <span style={{ width: 3, height: 10, background: fg }} />
          <span style={{ width: 3, height: 10, background: fg }} />
        </span>
      );
    case "stop":
      return <span aria-hidden style={{ width: 9, height: 9, background: fg, display: "inline-block" }} />;
    case "prev":
      return (
        <span aria-hidden style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
          <span style={{ width: 2, height: 10, background: fg }} />
          <span
            style={{
              width: 0,
              height: 0,
              borderRight: `6px solid ${fg}`,
              borderTop: "5px solid transparent",
              borderBottom: "5px solid transparent",
            }}
          />
        </span>
      );
    case "next":
      return (
        <span aria-hidden style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
          <span
            style={{
              width: 0,
              height: 0,
              borderLeft: `6px solid ${fg}`,
              borderTop: "5px solid transparent",
              borderBottom: "5px solid transparent",
            }}
          />
          <span style={{ width: 2, height: 10, background: fg }} />
        </span>
      );
  }
};

// --- Marquee ----------------------------------------------------------
// CSS scroller that only animates when text overflows its container.
// Re-measures on text or container resize so swapping tracks recomputes.
const Marquee = ({ text, color }: { text: string; color: string }) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;
    const measure = () => setOverflow(inner.scrollWidth > wrap.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [text]);

  return (
    <div
      ref={wrapRef}
      style={{
        overflow: "hidden",
        whiteSpace: "nowrap",
        fontSize: 11,
        color,
        letterSpacing: "0.06em",
        textShadow: `0 0 6px ${color}`,
        textTransform: "uppercase",
      }}
    >
      <div
        ref={innerRef}
        style={{
          display: "inline-block",
          paddingRight: overflow ? 40 : 0,
          animation: overflow ? "slop-music-marquee 14s linear infinite" : "none",
        }}
      >
        {overflow ? `${text}    •    ${text}` : text}
      </div>
    </div>
  );
};

export default MusicPlayerWindow;

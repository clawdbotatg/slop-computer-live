"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MusicState, PeerMeshState } from "~~/hooks/usePeerMesh";

// Music player window body — designed to live inside a <SharedAppWindow>.
// Aesthetic: classic Winamp 2.x main-window — big amber LCD time digits,
// lime track marquee, kbps/kHz/STEREO info, lime→amber→magenta spectrum,
// tight pixel transport buttons, horizontal volume + balance, playlist
// as a separate beveled panel below.
//
// Multiplayer: the *playback* state (which track, playing/paused, where
// in the track) lives in mesh.musicState so every peer hears the same
// thing. Per-user state stays local: volume, balance, the visualiser
// graph (we don't pipe audio through the mesh — each peer plays the
// same MP3 from their own browser).

type Track = { title: string; artist: string; src: string };

const PLAYLIST_URL = "/music/playlist.json";
const VOLUME_KEY = "slop-music-volume-v1";
const MUTE_KEY = "slop-music-mute-v1";
/** Tolerance, in seconds, between local audio.currentTime and the
 *  position predicted from the shared state before we force a seek.
 *  Keep this loose — re-seeking too aggressively makes the audio judder
 *  every time the network burps. */
const SYNC_TOLERANCE_SEC = 1.5;

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return "00:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

/** Where in the track should we be RIGHT NOW given the shared snapshot? */
const livePosition = (state: MusicState | null): number => {
  if (!state) return 0;
  if (!state.playing) return state.position;
  return state.position + Math.max(0, (Date.now() - state.at) / 1000);
};

export const MusicPlayerWindow = ({ mesh }: { mesh: PeerMeshState }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [duration, setDuration] = useState(0);
  const [balance, setBalance] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Volume is shared via mesh.musicState.volume. We keep a local "draft"
  // value for smooth slider feedback during a drag — the broadcast only
  // fires on mouseup. localStorage seeds the initial value when the
  // shared state is null (relay just restarted, no one playing).
  const [volumeDraft, setVolumeDraft] = useState(0.7);
  const [volumeDragging, setVolumeDragging] = useState(false);
  // Per-user local mute. Doesn't touch the shared volume or playback —
  // just silences this peer's <audio> element so they can step away
  // without making everyone else stop. Persisted across reloads.
  const [selfMuted, setSelfMuted] = useState(false);
  // Smooth display tick — re-render every 100ms while playing so the LCD
  // and seek thumb advance without us having to spam the network.
  const [displayPosition, setDisplayPosition] = useState(0);

  // Derived: current track + play state come straight from the mesh.
  const ms = mesh.musicState;
  const playing = !!ms?.playing;
  const index = ms?.index ?? 0;

  // Seed the volume draft from localStorage so a fresh peer who joins
  // when the mesh has no music state has a sensible slider position.
  // Same idea for the per-user mute flag.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(VOLUME_KEY);
      if (raw) {
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) setVolumeDraft(parsed);
      }
      if (window.localStorage.getItem(MUTE_KEY) === "1") setSelfMuted(true);
    } catch {
      /* ignore */
    }
  }, []);

  // Push the per-user mute into the live audio element + persist.
  // audio.muted is independent of audio.volume — toggling this on
  // silences playback without changing the shared loudness.
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = selfMuted;
    try {
      if (selfMuted) window.localStorage.setItem(MUTE_KEY, "1");
      else window.localStorage.removeItem(MUTE_KEY);
    } catch {
      /* ignore */
    }
  }, [selfMuted]);

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
  // Built lazily *inside the user gesture* (any transport click) — Chrome
  // keeps a context created outside a gesture in the "suspended" state,
  // which silently swallows all audio routed through it.
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
      src.connect(panner);
      panner.connect(analyser);
      analyser.connect(ctx.destination);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      pannerRef.current = panner;
    } catch (err) {
      console.warn("music graph init failed", err);
    }
  }, []);

  // The slider's displayed value: while the user is mid-drag, that's
  // their in-flight draft; otherwise it's whatever the mesh says
  // everyone is currently listening at, falling back to the draft when
  // no music state exists yet.
  const sharedVolume = ms?.volume;
  const shownVolume = volumeDragging ? volumeDraft : (sharedVolume ?? volumeDraft);

  // Push the shown volume into the live audio element + persist locally
  // (so a returning peer, joining when no music state is set, lands at
  // the volume they last used).
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = shownVolume;
    try {
      window.localStorage.setItem(VOLUME_KEY, String(shownVolume));
    } catch {
      /* ignore */
    }
  }, [shownVolume]);

  // When the mesh-shared volume changes (someone else dragged + released
  // their slider), keep our local draft in sync so the slider thumb
  // doesn't snap back to the old draft on the next mouseup.
  useEffect(() => {
    if (sharedVolume == null) return;
    if (volumeDragging) return;
    setVolumeDraft(sharedVolume);
  }, [sharedVolume, volumeDragging]);

  // Push balance into the panner if the graph is up.
  useEffect(() => {
    const p = pannerRef.current;
    if (p) p.pan.value = Math.max(-1, Math.min(1, balance));
  }, [balance]);

  // ---- The single source of truth: mesh.musicState ---------------------
  // Whenever the shared snapshot changes (or the audio element is replaced),
  // bring our local <audio> in line:
  //   - load the right track
  //   - jump to the predicted position if we've drifted too far
  //   - play / pause to match the shared `playing` flag
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !current) return;

    // Source mismatch → load the correct track. Setting `src` cancels any
    // in-flight load so this is safe to call repeatedly with the same value.
    if (!a.src.endsWith(current.src)) {
      a.src = current.src;
      a.load();
    }

    const target = livePosition(ms);
    if (Math.abs(a.currentTime - target) > SYNC_TOLERANCE_SEC && Number.isFinite(target)) {
      try {
        a.currentTime = target;
      } catch {
        /* readyState too low — the loadeddata listener below will retry */
      }
    }

    if (playing && a.paused) {
      audioCtxRef.current?.resume().catch(() => undefined);
      a.play().catch(err => {
        // First time round we may be outside a user gesture (e.g. another
        // peer pressed play before we ever interacted). Surface a hint
        // and stay paused locally; the next click on play will work
        // because Chrome counts that as a gesture.
        setError(`tap play to join — ${(err as Error).message}`);
      });
    } else if (!playing && !a.paused) {
      a.pause();
    }
    // Re-run whenever the snapshot changes meaningfully OR the current
    // track src flips. We DON'T depend on `livePosition` itself — we
    // re-sync on snapshot edges and trust the audio element to drift
    // smoothly between them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms?.src, ms?.index, ms?.playing, ms?.position, ms?.at, current?.src]);

  // Lifecycle event listeners — drive *local* state (duration, error)
  // and broadcast on track-end so all peers advance together.
  const lastEndedRef = useRef<{ src: string; at: number } | null>(null);
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onMeta = () => setDuration(a.duration || 0);
    const onLoaded = () => {
      // After a fresh load, snap to the shared target position once
      // metadata is available (in case the earlier setCurrentTime in the
      // sync effect was rejected for readyState reasons).
      const target = livePosition(mesh.musicState);
      if (Math.abs(a.currentTime - target) > SYNC_TOLERANCE_SEC && Number.isFinite(target)) {
        try {
          a.currentTime = target;
        } catch {
          /* still not seekable, give up — playback will start from 0 */
        }
      }
    };
    const onEnded = () => {
      // Multiple peers fire `ended` at roughly the same wall-clock time,
      // and they all compute the same next-index payload — so a flurry
      // of identical music_state messages lands at the relay and fans
      // back out. Last-write-wins is harmless when the writes match.
      // Dedupe per-track-per-second locally so we don't double-broadcast
      // if the audio element fires ended twice (some browsers do).
      if (tracks.length === 0) return;
      const stamp = lastEndedRef.current;
      if (current && stamp && stamp.src === current.src && Date.now() - stamp.at < 1000) return;
      if (current) lastEndedRef.current = { src: current.src, at: Date.now() };
      const nextIndex = (index + 1) % tracks.length;
      mesh.setMusicState({
        src: tracks[nextIndex]?.src ?? null,
        index: nextIndex,
        playing: true,
        position: 0,
        at: Date.now(),
        // Carry the current shared volume forward so this auto-advance
        // doesn't reset everyone's loudness.
        volume: mesh.musicState?.volume ?? shownVolume,
      });
    };
    const onErr = () => {
      const m = a.error?.message || "unknown error";
      setError(`playback error on "${current?.title ?? "?"}": ${m}`);
    };
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("loadeddata", onLoaded);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onErr);
    return () => {
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("loadeddata", onLoaded);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onErr);
    };
    // shownVolume isn't in deps on purpose — the captured value is only
    // used as a fallback in `onEnded` if mesh.musicState.volume is also
    // missing, so a stale read is harmless. Re-binding listeners on
    // every volume tick would be wasteful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, current, index, mesh]);

  // Smooth UI tick — every 100ms while playing, recompute the displayed
  // position. Doesn't touch the network; just re-renders the LCD/seek.
  useEffect(() => {
    if (!playing) {
      setDisplayPosition(ms?.position ?? 0);
      return;
    }
    const tick = () => setDisplayPosition(livePosition(mesh.musicState));
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [playing, ms?.position, ms?.at, ms?.src, mesh]);

  // ---- Transport actions: every click broadcasts a new snapshot ------
  // None of these touch the audio element directly. The mesh-sync effect
  // above is the single place that decides what the audio plays.
  const broadcast = useCallback(
    (patch: Partial<MusicState>) => {
      setupGraph();
      audioCtxRef.current?.resume().catch(() => undefined);
      setError(null);
      const cur = mesh.musicState;
      const now = Date.now();
      // The shared snapshot encodes "at moment T, position was P".
      // Whenever we re-broadcast, `at` jumps to `now`, so `position`
      // MUST also jump forward by however long it's been playing —
      // otherwise volume-only updates (which keep cur.position) make
      // peers compute "play head is at the OLD position" and the audio
      // visibly rewinds. Compute the live head once and let callers
      // override only when they really mean to (seek, stop, track-jump).
      const livePos = livePosition(cur);
      const fallback: MusicState = {
        src: current?.src ?? null,
        index,
        playing: false,
        position: livePos,
        at: now,
        volume: shownVolume,
      };
      mesh.setMusicState({
        ...fallback,
        ...cur,
        ...patch,
        // patch.position wins (caller is intentionally seeking); else
        // use the live head, never the stale cur.position.
        position: patch.position ?? livePos,
        at: patch.at ?? now,
      });
    },
    [mesh, current, index, setupGraph, shownVolume],
  );

  const togglePlay = useCallback(() => {
    if (!current) return;
    const a = audioRef.current;
    const at = livePosition(mesh.musicState);
    broadcast({
      src: current.src,
      index,
      playing: !playing,
      // Capture a fresh position from the local audio element if we have
      // one, otherwise from the shared snapshot. Either is "now".
      position: a && Number.isFinite(a.currentTime) ? a.currentTime : at,
    });
  }, [broadcast, current, index, playing, mesh]);

  const stop = useCallback(() => {
    if (!current) return;
    broadcast({ src: current.src, index, playing: false, position: 0 });
  }, [broadcast, current, index]);

  const next = useCallback(() => {
    if (tracks.length === 0) return;
    const i = (index + 1) % tracks.length;
    broadcast({ src: tracks[i]?.src ?? null, index: i, playing, position: 0 });
  }, [broadcast, tracks, index, playing]);

  const prev = useCallback(() => {
    if (tracks.length === 0) return;
    // > 3s into the track? rewind. Else jump to previous. (Winamp default.)
    const a = audioRef.current;
    if (a && a.currentTime > 3 && current) {
      broadcast({ src: current.src, index, playing, position: 0 });
      return;
    }
    const i = (index - 1 + tracks.length) % tracks.length;
    broadcast({ src: tracks[i]?.src ?? null, index: i, playing, position: 0 });
  }, [broadcast, tracks, index, playing, current]);

  const playIndex = useCallback(
    (i: number) => {
      if (tracks.length === 0) return;
      broadcast({ src: tracks[i]?.src ?? null, index: i, playing: true, position: 0 });
    },
    [broadcast, tracks],
  );

  // ---- RAF spectrum loop. Renders to canvas in-place; no React re-renders.
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

  const lcdTrackText = useMemo(() => {
    if (error) return error;
    if (!current) return tracks.length === 0 ? "loading playlist…" : "no track";
    return `${index + 1}. ${current.artist} - ${current.title}  (${fmtTime(duration)})`;
  }, [current, error, tracks.length, index, duration]);

  const shownPosition = seeking ? seekValue : displayPosition;
  const seekMax = duration > 0 ? duration : 1;

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "linear-gradient(180deg, #14091e 0%, #06030d 100%)",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-display)",
        userSelect: "none",
      }}
    >
      {/* Same-origin source — no crossOrigin attribute so the dev server's
          missing CORS headers can't stall the load. */}
      <audio ref={audioRef} preload="metadata" />

      {/* Per-user local mute — overlaid in the top-right of the player
          window, same idea as AudioVisualizer / camera's "your side"
          mute button. Doesn't broadcast; only silences this peer's
          <audio> element. Shared playback / volume continue normally. */}
      <button
        type="button"
        onClick={() => setSelfMuted(m => !m)}
        aria-label={selfMuted ? "unmute (local)" : "mute (local)"}
        title={selfMuted ? "unmute (only affects you)" : "mute (only affects you)"}
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          zIndex: 10,
          width: 26,
          height: 26,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          background: selfMuted ? "var(--slop-magenta, #ff3ec9)" : "rgba(6,3,13,0.7)",
          border: `1px solid ${selfMuted ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-bevel-light, #4a4a4a)"}`,
          color: "#fff",
          backdropFilter: "blur(4px)",
        }}
      >
        {selfMuted ? <SpeakerOffIcon /> : <SpeakerIcon />}
      </button>

      {/* === Top LCD panel ============================================== */}
      <div
        style={{
          margin: 6,
          // extra right padding reserves space for the absolute-positioned
          // mute button so it doesn't sit on top of the "STEREO" text
          padding: "6px 36px 4px 8px",
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
            setSeekValue(displayPosition);
            setSeeking(true);
          }}
          onMouseUp={e => {
            const v = parseFloat((e.target as HTMLInputElement).value);
            setSeeking(false);
            if (!current || !Number.isFinite(v)) return;
            // Broadcast the seek; the sync effect re-positions every peer
            // (including us) and resumes playback if we were playing.
            broadcast({ src: current.src, index, playing, position: v });
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
            value={shownVolume}
            // Smooth feedback while dragging — change the local audio
            // immediately so the dragger hears their own change. No
            // network traffic until they let go.
            onChange={e => {
              setVolumeDraft(parseFloat(e.target.value));
            }}
            onMouseDown={() => setVolumeDragging(true)}
            onMouseUp={e => {
              const v = parseFloat((e.target as HTMLInputElement).value);
              setVolumeDragging(false);
              if (Number.isFinite(v)) broadcast({ volume: v });
            }}
            // Touch support (mobile/tablet) — same handshake.
            onTouchStart={() => setVolumeDragging(true)}
            onTouchEnd={() => {
              setVolumeDragging(false);
              broadcast({ volume: volumeDraft });
            }}
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
                  onClick={() => playIndex(i)}
                  title={`click to play • ${t.src}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "26px 1fr auto",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 8px",
                    fontSize: 10,
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

// Tiny speaker glyphs for the per-user mute button. ~14px viewBox so
// they read at 14px target size against either dark or magenta.
const SpeakerIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M2 5 H 4 L 7 2.5 V 11.5 L 4 9 H 2 Z" fill="currentColor" stroke="none" />
    <path d="M9 5 Q 10.5 7 9 9" />
    <path d="M10.5 3.5 Q 13 7 10.5 10.5" />
  </svg>
);

const SpeakerOffIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M2 5 H 4 L 7 2.5 V 11.5 L 4 9 H 2 Z" fill="currentColor" stroke="none" />
    <line x1="9" y1="4.5" x2="13" y2="9.5" />
    <line x1="13" y1="4.5" x2="9" y2="9.5" />
  </svg>
);

export default MusicPlayerWindow;

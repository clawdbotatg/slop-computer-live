"use client";

import { useEffect, useRef, useState } from "react";

// Compact stream-health widget for the /eq popup. Plays the HLS feed
// via hls.js (muted, tiny preview) and surfaces enough numbers that
// an operator mid-show can tell at a glance whether the outgoing
// broadcast is alive and healthy: bitrate, resolution, fps, dropped
// frames, fragment age.
//
// Same hls.js pattern as the frontpage's HlsPlayer — try hls.js
// first, fall back to native HLS on Safari, mute+autoplay+playsInline
// so it starts without a user gesture.

const HLS_URL = process.env.NEXT_PUBLIC_HLS_URL ?? "https://media.slop.computer/hls/live/index.m3u8";

type Status = "loading" | "live" | "idle" | "error";

type Stats = {
  /** Video pixel dimensions reported by the <video> element. */
  width: number | null;
  height: number | null;
  /** Decoded frame rate (rolling average over the last sample window). */
  fps: number | null;
  /** Manifest-reported level bitrate, bits/sec. */
  bitrate: number | null;
  /** Audio track bitrate when hls.js exposes it. */
  audioBitrate: number | null;
  /** Seconds of media currently buffered ahead of the playhead. */
  buffered: number | null;
  /** ms since the most-recent fragment landed. Climbs while the
   *  publisher is silent / disconnected. */
  fragAgeMs: number | null;
  /** Total dropped frames since playback started. */
  droppedFrames: number | null;
  /** Last hls.js error message, if any. Clears on next clean load. */
  lastError: string | null;
};

const EMPTY_STATS: Stats = {
  width: null,
  height: null,
  fps: null,
  bitrate: null,
  audioBitrate: null,
  buffered: null,
  fragAgeMs: null,
  droppedFrames: null,
  lastError: null,
};

const cssVar = (name: string, fallback: string): string => `var(--slop-${name}, ${fallback})`;

export const StreamMonitor = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastFragAtRef = useRef<number | null>(null);
  const lastFpsSampleRef = useRef<{ at: number; total: number } | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let destroy: (() => void) | undefined;

    // Patch onto stats from any code path without re-rendering twice.
    const patch = (partial: Partial<Stats>) => {
      if (cancelled) return;
      setStats(prev => ({ ...prev, ...partial }));
    };

    import("hls.js")
      .then(mod => {
        if (cancelled) return;
        const Hls = mod.default;
        if (Hls.isSupported()) {
          const hls = new Hls({
            // Lighter buffer than default — we just want stats, not
            // smooth playback. Smaller buffer means fragAgeMs reacts
            // faster when the publisher stops pushing.
            maxBufferLength: 8,
            maxMaxBufferLength: 16,
          });
          hls.loadSource(HLS_URL);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            // Manifest loaded but no fragments yet — still "loading".
            if (cancelled) return;
            patch({ lastError: null });
          });
          hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
            const lvl = data?.details;
            if (lvl?.targetduration) {
              // ignore — we use FRAG_LOADED for fragAge
            }
            const levels = hls.levels;
            const currentLvl = levels[hls.currentLevel] ?? levels[0];
            if (currentLvl) {
              patch({
                bitrate: currentLvl.bitrate || null,
                width: currentLvl.width || null,
                height: currentLvl.height || null,
              });
            }
          });
          hls.on(Hls.Events.AUDIO_TRACK_LOADED, () => {
            const tracks = hls.audioTracks;
            const cur = tracks[hls.audioTrack] ?? tracks[0];
            // hls.js may not expose per-track bitrate cleanly; best-
            // effort. Most MediaMTX configs put audio inside the
            // muxed TS so this stays null and that's fine.
            if (cur && "bitrate" in cur && typeof cur.bitrate === "number") {
              patch({ audioBitrate: cur.bitrate });
            }
          });
          hls.on(Hls.Events.FRAG_LOADED, () => {
            lastFragAtRef.current = Date.now();
            if (cancelled) return;
            setStatus("live");
            patch({ lastError: null });
          });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (cancelled) return;
            // Non-fatal network blips happen during normal HLS — only
            // flip to error on FATAL. Other errors get logged into
            // lastError for visibility but don't trip the UI red.
            if (data.fatal) {
              setStatus("error");
              patch({ lastError: `${data.type}: ${data.details}` });
            } else {
              patch({ lastError: data.details ?? null });
            }
          });

          destroy = () => hls.destroy();
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari native HLS. We can still read videoWidth/Height +
          // dropped frames; bitrate is opaque to us.
          video.src = HLS_URL;
        } else {
          setStatus("error");
          patch({ lastError: "HLS not supported in this browser" });
        }
      })
      .catch(err => {
        if (cancelled) return;
        setStatus("error");
        patch({ lastError: (err as Error).message });
      });

    // Element-level metadata + dropped frames + fps + buffered + age.
    // Polled at 1Hz — once per second is plenty for a status widget.
    const tick = window.setInterval(() => {
      if (cancelled) return;
      const w = video.videoWidth || null;
      const h = video.videoHeight || null;
      // Buffered ahead of playhead. .buffered ranges can be empty
      // when nothing's loaded; guard defensively.
      let buf: number | null = null;
      try {
        if (video.buffered.length > 0) {
          const end = video.buffered.end(video.buffered.length - 1);
          buf = Math.max(0, end - video.currentTime);
        }
      } catch {
        /* ignore */
      }
      // Dropped + decoded frame counts. Most browsers support this.
      let dropped: number | null = null;
      let fps: number | null = null;
      try {
        const q = video.getVideoPlaybackQuality?.();
        if (q) {
          dropped = q.droppedVideoFrames;
          const now = Date.now();
          const last = lastFpsSampleRef.current;
          if (last) {
            const dt = (now - last.at) / 1000;
            if (dt > 0) {
              fps = (q.totalVideoFrames - last.total) / dt;
            }
          }
          lastFpsSampleRef.current = { at: now, total: q.totalVideoFrames };
        }
      } catch {
        /* ignore */
      }
      const fragAt = lastFragAtRef.current;
      const fragAge = fragAt == null ? null : Date.now() - fragAt;

      // Status state machine. We've already set "live" on FRAG_LOADED.
      // If the last fragment is >10s stale, treat as idle (publisher
      // probably stopped). Reset to live the moment a new fragment
      // arrives (handled in the FRAG_LOADED handler above).
      if (fragAt == null) {
        // Either still loading the manifest, or never got a fragment.
        // We never overwrite "error" from here.
        setStatus(s => (s === "error" ? "error" : "loading"));
      } else if (fragAge !== null && fragAge > 10_000) {
        setStatus(s => (s === "error" ? "error" : "idle"));
      }

      patch({
        width: w,
        height: h,
        buffered: buf,
        droppedFrames: dropped,
        fps: fps != null && Number.isFinite(fps) ? fps : null,
        fragAgeMs: fragAge,
      });
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(tick);
      destroy?.();
    };
  }, []);

  return (
    <section
      style={{
        background: cssVar("panel", "#0a0f24"),
        border: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
        borderRadius: 4,
        padding: "6px 7px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 8,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: cssVar("text-muted", "#7878a0"),
          borderBottom: `1px solid ${cssVar("bevel-light", "rgba(255,255,255,0.18)")}`,
          paddingBottom: 4,
        }}
      >
        <span>stream</span>
        <StatusPill status={status} />
      </div>

      {/* Tiny preview — confirms there's an actual picture, not
          just metadata. Muted + playsInline to autoplay without
          gesture; the EQ popup is opened from a user click so
          autoplay is allowed but mute is safer. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        controls={false}
        style={{
          width: "100%",
          aspectRatio: "16 / 9",
          background: "#000",
          borderRadius: 2,
          objectFit: "cover",
          display: "block",
        }}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <StatLine label="res" value={stats.width && stats.height ? `${stats.width}×${stats.height}` : "—"} />
        <StatLine label="fps" value={stats.fps != null ? stats.fps.toFixed(1) : "—"} />
        <StatLine label="vbr" value={stats.bitrate != null ? `${Math.round(stats.bitrate / 1000)}k` : "—"} />
        {stats.audioBitrate != null ? (
          <StatLine label="abr" value={`${Math.round(stats.audioBitrate / 1000)}k`} />
        ) : null}
        <StatLine label="buf" value={stats.buffered != null ? `${stats.buffered.toFixed(1)}s` : "—"} />
        <StatLine
          label="age"
          value={stats.fragAgeMs != null ? `${(stats.fragAgeMs / 1000).toFixed(1)}s` : "—"}
          // Highlight age in amber when growing past 4s — a healthy
          // publisher lands fragments every ~2s, so >4s means
          // something stalled.
          warn={stats.fragAgeMs != null && stats.fragAgeMs > 4000}
        />
        <StatLine
          label="drop"
          value={stats.droppedFrames != null ? String(stats.droppedFrames) : "—"}
          warn={stats.droppedFrames != null && stats.droppedFrames > 0}
        />
      </div>

      {stats.lastError ? (
        <div
          style={{
            fontSize: 8,
            color: cssVar("red", "#ff5577"),
            wordBreak: "break-word",
            lineHeight: 1.3,
          }}
          title={stats.lastError}
        >
          {stats.lastError}
        </div>
      ) : null}
    </section>
  );
};

const StatusPill = ({ status }: { status: Status }) => {
  const map: Record<Status, { label: string; color: string }> = {
    loading: { label: "load", color: cssVar("text-muted", "#7878a0") },
    live: { label: "● live", color: cssVar("lime", "#bcff5b") },
    idle: { label: "○ idle", color: cssVar("amber", "#ffae00") },
    error: { label: "✗ err", color: cssVar("red", "#ff5577") },
  };
  const { label, color } = map[status];
  return (
    <span
      style={{
        fontSize: 8,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {label}
    </span>
  );
};

const StatLine = ({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) => (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: "32px 1fr",
      fontSize: 9,
      letterSpacing: "0.04em",
      color: warn ? cssVar("amber", "#ffae00") : cssVar("text-muted", "#7878a0"),
      fontVariantNumeric: "tabular-nums",
    }}
  >
    <span>{label}</span>
    <span style={{ color: warn ? cssVar("amber", "#ffae00") : cssVar("text", "#e8e0ff"), textAlign: "right" }}>
      {value}
    </span>
  </div>
);

export default StreamMonitor;

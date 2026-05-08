"use client";

import { useEffect, useRef, useState } from "react";
import type { Bands } from "~~/utils/blockieBands";

export type AudioVisualizerProps = {
  stream: MediaStream;
  bands: Bands;
  /** Mute the *local playback* on self-published streams to avoid feedback. */
  muted?: boolean;
  /** Optional per-user avatar to render behind the visualizer. */
  avatarUrl?: string | null;
  /** When true, show the mute toggle button (only the publisher should
   *  see + control it). */
  isMine?: boolean;
};

// Layered visualizer using all three blockie palette colors so the window
// reads as the peer's full identity:
//   - waveform line (band1) — sweeps across the window
//   - inner dot (band2) — solid fill at the center
//   - halo / outer glow (band3) — wraps the dot, intensifies with amplitude
//
// All animation is ref-driven (no React re-renders at 60Hz). One AnalyserNode
// drives the whole thing from a single time-domain buffer.
export const AudioVisualizer = ({
  stream,
  bands,
  muted = false,
  avatarUrl = null,
  isMine = false,
}: AudioVisualizerProps) => {
  const circleRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Local mute toggle — flips track.enabled on the outgoing audio track(s)
  // so peers receive silence (and the visualizer naturally flatlines).
  // Doesn't unpublish — the stream stays alive for instant un-mute.
  const [selfMuted, setSelfMuted] = useState(false);
  useEffect(() => {
    if (!isMine) return;
    for (const t of stream.getAudioTracks()) t.enabled = !selfMuted;
  }, [stream, selfMuted, isMine]);

  useEffect(() => {
    if (audioRef.current && audioRef.current.srcObject !== stream) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);

  useEffect(() => {
    type AudioContextCtor = new () => AudioContext;
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      void ctx.close();
      return;
    }
    const analyser = ctx.createAnalyser();
    // 2048 samples gives a smoother waveform than 1024 without measurable cost.
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);

    const buf = new Uint8Array(analyser.fftSize);
    const lineColor = bands.band1; // waveform
    const dotColor = bands.band2; // inner circle fill
    // band3 is used as a hard ring border on the circle element itself,
    // not in the RAF — see the JSX below.
    let raf = 0;

    const loop = () => {
      analyser.getByteTimeDomainData(buf);

      // ---- circle: scale with RMS ----
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = ((buf[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const amp = Math.min(1, rms * 3);
      const circle = circleRef.current;
      if (circle) {
        circle.style.transform = `scale(${1 + amp * 0.6})`;
        circle.style.opacity = `${0.7 + amp * 0.3}`;
        // Soft glow in band2 (dot color) so the dot has dimensional bloom.
        // The hard band3 ring is a static border on the element itself.
        circle.style.boxShadow = `0 0 ${16 + amp * 60}px ${dotColor}`;
      }

      // ---- waveform: paint time-domain across the canvas ----
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        if (cssW > 0 && cssH > 0) {
          const targetW = Math.round(cssW * dpr);
          const targetH = Math.round(cssH * dpr);
          if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
          }
          const cctx = canvas.getContext("2d");
          if (cctx) {
            cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            cctx.clearRect(0, 0, cssW, cssH);
            cctx.lineWidth = 2;
            cctx.strokeStyle = lineColor;
            cctx.shadowColor = lineColor;
            cctx.shadowBlur = 6;
            cctx.beginPath();
            const step = cssW / buf.length;
            for (let i = 0; i < buf.length; i++) {
              const v = ((buf[i] ?? 128) - 128) / 128; // -1 .. 1
              const y = cssH / 2 + v * cssH * 0.4;
              if (i === 0) cctx.moveTo(0, y);
              else cctx.lineTo(i * step, y);
            }
            cctx.stroke();
          }
        }
      }

      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
      void ctx.close();
    };
  }, [stream, bands.band1, bands.band2, bands.band3]);

  // When an avatar is present the avatar gets the top ~80% of the window and
  // the viz collapses into a thin strip at the bottom. Without an avatar the
  // viz fills the whole window and is vertically centered.
  const hasAvatar = !!avatarUrl;
  const vizLayerStyle: React.CSSProperties = hasAvatar
    ? {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: "22%",
        // Subtle gradient mask so the line + dot pop against the photo.
        background: "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.45) 100%)",
      }
    : { position: "absolute", inset: 0 };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        background: "#06030d",
        overflow: "hidden",
      }}
    >
      <audio ref={audioRef} autoPlay muted={muted} style={{ display: "none" }} />
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            // Light touch — keep the photo readable, just shave a hint
            // off the brightness so the visualizer's glow stays legible.
            filter: "blur(0.5px) brightness(0.92)",
            pointerEvents: "none",
            userSelect: "none",
          }}
        />
      ) : null}
      <div style={vizLayerStyle}>
        {/* Centering wrapper — the circle's own transform is the scale */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            ref={circleRef}
            style={{
              width: "min(15%, 36px)",
              aspectRatio: "1",
              borderRadius: "50%",
              background: bands.band2,
              // Hard band3 ring + soft band2 glow — gives all three colors
              // distinct visual roles even when band2 and band3 are HSL-close.
              border: `3px solid ${bands.band3}`,
              boxSizing: "border-box",
              boxShadow: `0 0 16px ${bands.band2}`,
              transition: "transform 60ms linear, opacity 60ms linear, box-shadow 60ms linear",
              willChange: "transform, opacity, box-shadow",
            }}
          />
        </div>
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
      </div>
      {isMine ? (
        <button
          type="button"
          onClick={() => setSelfMuted(m => !m)}
          aria-label={selfMuted ? "unmute" : "mute"}
          title={selfMuted ? "unmute" : "mute"}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            background: selfMuted ? "var(--slop-magenta, #ff3ec9)" : "rgba(6,3,13,0.7)",
            border: `1px solid ${selfMuted ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-bevel-light, #4a4a4a)"}`,
            color: "#fff",
            cursor: "pointer",
            zIndex: 5,
            backdropFilter: "blur(4px)",
          }}
        >
          {selfMuted ? <MicOffIcon /> : <MicIcon />}
        </button>
      ) : null}
    </div>
  );
};

// Mac OS 9-flavored monochrome icons. ~16px viewBox, drawn so they read
// at 16px target size against either a dark or magenta background.
const MicIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden
  >
    <rect x="6" y="2" width="4" height="7" rx="2" fill="currentColor" stroke="none" />
    <path d="M3.5 7.5 A 4.5 4.5 0 0 0 12.5 7.5" />
    <line x1="8" y1="12" x2="8" y2="14.5" />
    <line x1="5.5" y1="14.5" x2="10.5" y2="14.5" />
  </svg>
);

const MicOffIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden
  >
    <rect x="6" y="2" width="4" height="7" rx="2" fill="currentColor" stroke="none" />
    <path d="M3.5 7.5 A 4.5 4.5 0 0 0 12.5 7.5" />
    <line x1="8" y1="12" x2="8" y2="14.5" />
    <line x1="5.5" y1="14.5" x2="10.5" y2="14.5" />
    {/* slash */}
    <line x1="2" y1="2" x2="14" y2="14" stroke="#000" strokeWidth="2.6" />
    <line x1="2" y1="2" x2="14" y2="14" />
  </svg>
);

export default AudioVisualizer;

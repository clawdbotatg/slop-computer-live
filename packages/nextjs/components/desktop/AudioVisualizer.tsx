"use client";

import { useEffect, useRef } from "react";
import type { Bands } from "~~/utils/blockieBands";

export type AudioVisualizerProps = {
  stream: MediaStream;
  bands: Bands;
  /** Mute the audio element on self-published streams to avoid feedback. */
  muted?: boolean;
  /** Optional per-user avatar to render behind the visualizer. */
  avatarUrl?: string | null;
};

// Layered visualizer using all three blockie palette colors so the window
// reads as the peer's full identity:
//   - waveform line (band1) — sweeps across the window
//   - inner dot (band2) — solid fill at the center
//   - halo / outer glow (band3) — wraps the dot, intensifies with amplitude
//
// All animation is ref-driven (no React re-renders at 60Hz). One AnalyserNode
// drives the whole thing from a single time-domain buffer.
export const AudioVisualizer = ({ stream, bands, muted = false, avatarUrl = null }: AudioVisualizerProps) => {
  const circleRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

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
            // Slight blur + dark tint so the visualizer reads on top.
            filter: "blur(4px) brightness(0.55)",
            transform: "scale(1.05)", // hide blur edges from cropping into the frame
            pointerEvents: "none",
            userSelect: "none",
          }}
        />
      ) : null}
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
  );
};

export default AudioVisualizer;

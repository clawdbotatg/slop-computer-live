"use client";

import { useEffect, useRef } from "react";
import type { Bands } from "~~/utils/blockieBands";

export type AudioVisualizerProps = {
  stream: MediaStream;
  bands: Bands;
  /** Mute the audio element on self-published streams to avoid feedback. */
  muted?: boolean;
};

// Pulsing circle that breathes with the audio amplitude. Used as the body
// of audio-kind windows in the desktop. Streams are observed via an
// AnalyserNode reading time-domain data each frame; the circle's
// transform.scale + box-shadow ride the RMS so loud speech = bigger ring.
//
// Note: we intentionally drive the DOM via a ref each animation frame
// rather than React state — re-rendering at 60Hz would tank perf in busy
// rooms. A hidden <audio> element handles actual playback so callers
// don't have to wire that separately.
export const AudioVisualizer = ({ stream, bands, muted = false }: AudioVisualizerProps) => {
  const circleRef = useRef<HTMLDivElement>(null);
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
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const loop = () => {
      analyser.getByteTimeDomainData(buf);
      // RMS of centered samples — robust against DC offset, scales with
      // perceived loudness better than peak.
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = ((buf[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      // RMS for normal speech sits around 0.05-0.2; multiply so a quiet
      // talker still moves the ring noticeably and a yell pegs it.
      const amp = Math.min(1, rms * 3);
      const el = circleRef.current;
      if (el) {
        const scale = 1 + amp * 0.55;
        el.style.transform = `scale(${scale})`;
        el.style.opacity = `${0.55 + amp * 0.45}`;
        el.style.boxShadow = `0 0 ${24 + amp * 60}px ${bands.band1}, 0 0 ${60 + amp * 80}px ${bands.band2}`;
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
  }, [stream, bands.band1, bands.band2]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#06030d",
        position: "relative",
      }}
    >
      <audio ref={audioRef} autoPlay muted={muted} style={{ display: "none" }} />
      <div
        ref={circleRef}
        style={{
          width: "min(40%, 120px)",
          aspectRatio: "1",
          borderRadius: "50%",
          background: `radial-gradient(circle at 30% 30%, ${bands.band1} 0%, ${bands.band2} 60%, ${bands.band3} 100%)`,
          boxShadow: `0 0 24px ${bands.band1}, 0 0 60px ${bands.band2}`,
          transition: "transform 60ms linear, opacity 60ms linear",
          willChange: "transform, opacity",
        }}
      />
    </div>
  );
};

export default AudioVisualizer;

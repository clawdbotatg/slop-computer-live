"use client";

import { useEffect, useRef } from "react";
import { usePageVisible } from "~~/hooks/usePageVisible";

// A small magenta ball that pulses with the live RMS amplitude of a mic
// stream. Bound to whichever stream the parent passes; cleanly tears the
// AudioContext + AnalyserNode down when the stream changes or the
// component unmounts. Used in the audio + video share dialogs to give
// the user instant feedback ("tap the mic, watch the ball").
export const AmplitudeBall = ({ stream }: { stream: MediaStream | null }) => {
  const ballRef = useRef<HTMLDivElement>(null);
  const pageVisible = usePageVisible();

  useEffect(() => {
    if (!stream || !pageVisible) return;
    type Ctor = new () => AudioContext;
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!C) return;
    const ctx = new C();
    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      void ctx.close();
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const loop = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = ((buf[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const amp = Math.min(1, rms * 5);
      const el = ballRef.current;
      if (el) {
        // Wide dynamic range: shrinks below baseline when silent, blooms
        // way past when loud — gives clear visual confirmation of "is the
        // mic actually picking me up?"
        el.style.transform = `scale(${0.45 + amp * 2.1})`;
        el.style.boxShadow = `0 0 ${2 + amp * 50}px var(--slop-magenta, #ff3ec9)`;
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
  }, [stream, pageVisible]);

  return (
    <div
      style={{
        width: 28,
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        ref={ballRef}
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: "var(--slop-magenta, #ff3ec9)",
          boxShadow: "0 0 6px var(--slop-magenta, #ff3ec9)",
          transition: "transform 60ms linear, box-shadow 60ms linear",
          willChange: "transform, box-shadow",
        }}
      />
    </div>
  );
};

export default AmplitudeBall;

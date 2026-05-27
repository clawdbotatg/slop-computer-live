"use client";

import { useEffect, useRef, useState } from "react";
import { useAudioBusStream } from "~~/hooks/useAudioBus";
import { useEnsAvatarFromAddress } from "~~/hooks/useEnsAvatarFromAddress";
import { ACTIVATED_EVENT } from "~~/hooks/useUserGesture";
import { useRoomSlug } from "~~/lib/room-slug";
import type { Bands } from "~~/utils/blockieBands";

// Persisted alongside the resume flags so reload preserves the
// publisher's self-mute state. **Scoped to the current room slug** —
// switching from /main to /ep0 shouldn't auto-mute based on another
// room's state. Cleared by Desktop.tsx when the audio publication is
// fully stopped (not when it's merely re-acquired by auto-resume).
const AUDIO_MUTED_KEY_BASE = "slop-audio-muted-v1";
export const audioMutedKey = (slug: string) => `${AUDIO_MUTED_KEY_BASE}:${slug}`;

export type AudioVisualizerProps = {
  stream: MediaStream;
  bands: Bands;
  /** Mute the *local playback* on self-published streams to avoid feedback. */
  muted?: boolean;
  /** Optional per-user avatar to render behind the visualizer. When this
   *  is null/empty, the component falls back to the publisher's ENS
   *  avatar (resolved from `address`) before giving up to a plain bg. */
  avatarUrl?: string | null;
  /** Publisher's wallet address — used as the source for the ENS avatar
   *  fallback when no avatar has been uploaded. */
  address?: string | null;
  /** True when the publisher has explicitly opted out of any avatar.
   *  Suppresses both the upload preview AND the ENS fallback. */
  hidden?: boolean;
  /** When true, show the mute toggle button (only the publisher should
   *  see + control it). */
  isMine?: boolean;
  /** Optional. When provided, render a gear (settings) button next to the
   *  mute toggle. Click handler should re-open the share dialog in edit
   *  mode so the user can hot-swap mic / avatar without dropping the call. */
  onSettings?: () => void;
  /** When true, hydrate the publisher's self-mute state from
   *  AUDIO_MUTED_STORAGE_KEY on mount and write changes back so reload
   *  preserves it. Only set for the publisher's own audio publication;
   *  remote views use ephemeral local-only state. */
  persistMute?: boolean;
  /** When set, register the inner `<audio>` element with the shared
   *  AudioBus under this id so the god-mode EQ popup can see it. Only
   *  set on the spectator/streaming session — non-god viewers leave
   *  this null and the element plays directly to default output. */
  audioBusId?: string | null;
  /** Human-readable label shown in the /eq popup row. Usually the
   *  peer's name or wallet short-address. */
  audioBusLabel?: string;
  /** When false, render no overlay buttons at all — pure avatar +
   *  waveform visuals. Used when VideoView embeds this as the
   *  audio-only backdrop for a camera publication (the camera window
   *  owns the mute / mode controls, so a second set here would
   *  duplicate them). Defaults to true. */
  controls?: boolean;
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
  address = null,
  hidden = false,
  isMine = false,
  onSettings,
  persistMute = false,
  audioBusId = null,
  audioBusLabel = "audio",
  controls = true,
}: AudioVisualizerProps) => {
  const slug = useRoomSlug();
  const storageKey = audioMutedKey(slug);
  const ensAvatar = useEnsAvatarFromAddress(address);
  const effectiveAvatar = hidden ? null : avatarUrl || ensAvatar;
  const circleRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Held outside the analyser useEffect so the slop:activated listener
  // below can resume() it after a reload-without-gesture leaves it in
  // the suspended state (analyser → silent input → flat visualizer).
  const audioCtxRef = useRef<AudioContext | null>(null);

  // For *my* publication: mute = flip track.enabled so peers hear silence.
  // For *someone else's* publication: mute = my local <audio> element
  // is muted via the JSX prop below — their stream is unchanged; only I
  // stop hearing it. Two mechanisms, single UI affordance.
  //
  // Lazy init from localStorage when persistence is on, so the initial
  // track.enabled effect below sees the resumed selfMuted=true and
  // mutes the just-re-acquired mic before peers hear a sample.
  const [selfMuted, setSelfMuted] = useState<boolean>(() => {
    if (!persistMute || typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!isMine) return;
    for (const t of stream.getAudioTracks()) t.enabled = !selfMuted;
    // Notify any listeners (Desktop's useLiveTranscript gate, etc.) so
    // the local STT pipeline can shut off when the user mutes — Web
    // Speech opens its own internal mic capture and ignores
    // track.enabled, so without this signal the recognizer keeps
    // broadcasting captions for someone who muted themselves.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("slop-audio-muted-change", { detail: { slug, muted: selfMuted } }));
    }
  }, [stream, selfMuted, isMine, slug]);
  useEffect(() => {
    if (!persistMute || typeof window === "undefined") return;
    try {
      if (selfMuted) window.localStorage.setItem(storageKey, "1");
      else window.localStorage.removeItem(storageKey);
    } catch {
      /* quota / private mode */
    }
  }, [selfMuted, persistMute, storageKey]);

  // Spacebar mute toggle (dispatched by Desktop's global key handler).
  // Only my own publication responds, and only when it owns its
  // controls — an embedded-for-visuals instance leaves the mic to the
  // camera window. The track.enabled effect above does the actual mute.
  useEffect(() => {
    if (!isMine || !controls) return;
    const onToggle = () => setSelfMuted(m => !m);
    window.addEventListener("slop-toggle-mic", onToggle);
    return () => window.removeEventListener("slop-toggle-mic", onToggle);
  }, [isMine, controls]);

  useEffect(() => {
    if (audioRef.current && audioRef.current.srcObject !== stream) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);

  // God-mode only — route this peer's playback through the shared
  // AudioBus by tapping the MediaStream directly (NOT the audio
  // element — Chromium gives silent output for createMediaElementSource
  // on srcObject-bound elements). The element below is force-muted
  // while the bus is active so the bus is the only audible path.
  // No-op when audioBusId is null (non-spectator sessions).
  const busActive = !!audioBusId;
  useAudioBusStream(stream, audioBusId ?? "", audioBusLabel, busActive);

  useEffect(() => {
    type AudioContextCtor = new () => AudioContext;
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    audioCtxRef.current = ctx;
    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      void ctx.close();
      audioCtxRef.current = null;
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
    // not in the loop — see the JSX below.
    // 24Hz instead of rAF (60Hz). On a 60px tile the eye can't see a
    // difference, and at 4-6 audio tiles per call this halves the
    // per-tile canvas-paint cost.
    const FRAME_INTERVAL_MS = 1000 / 24;
    let timer: ReturnType<typeof setTimeout> | null = null;

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

      timer = setTimeout(loop, FRAME_INTERVAL_MS);
    };
    loop();

    return () => {
      if (timer !== null) clearTimeout(timer);
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
      void ctx.close();
      if (audioCtxRef.current === ctx) audioCtxRef.current = null;
    };
  }, [stream, bands.band1, bands.band2, bands.band3]);

  // Reload-without-gesture lands here with a suspended AudioContext
  // (analyser sees silence → flat visualizer) and possibly a paused
  // <audio> element (Chrome may reject autoPlay even on srcObject
  // streams without user activation). The page-level EntryGate fires
  // slop:activated on the user's first click; resume the context and
  // kick the audio in the same gesture so playback + viz wake up.
  useEffect(() => {
    const onActivated = () => {
      audioCtxRef.current?.resume().catch(() => undefined);
      const a = audioRef.current;
      if (a && a.paused) a.play().catch(() => undefined);
    };
    window.addEventListener(ACTIVATED_EVENT, onActivated);
    return () => window.removeEventListener(ACTIVATED_EVENT, onActivated);
  }, []);

  // When an avatar is present the avatar gets the top ~80% of the window and
  // the viz collapses into a thin strip at the bottom. Without an avatar the
  // viz fills the whole window and is vertically centered.
  const hasAvatar = !!effectiveAvatar;
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
      {/* `muted` prop = self-published feedback prevention. `selfMuted`
          on a remote stream = "I don't want to hear this peer." Either
          one mutes the local element. */}
      <audio ref={audioRef} autoPlay muted={muted || (!isMine && selfMuted) || busActive} style={{ display: "none" }} />
      {effectiveAvatar ? (
        <img
          src={effectiveAvatar}
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
      {/* Remote-stream-only: per-user "mute on my side" speaker. Same
          affordance the music player uses, applied to other peers'
          mics so a single user can step out without making everyone
          else go silent. */}
      {controls && !isMine ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            gap: 6,
            zIndex: 5,
          }}
        >
          <button
            type="button"
            onClick={() => setSelfMuted(m => !m)}
            aria-label={selfMuted ? "unmute (local)" : "mute (local)"}
            title={selfMuted ? "unmute (only on your side)" : "mute (only on your side)"}
            style={overlayBtnStyle(selfMuted)}
          >
            {selfMuted ? <SpeakerOffIcon /> : <SpeakerIcon />}
          </button>
        </div>
      ) : null}

      {controls && isMine ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            gap: 6,
            zIndex: 5,
          }}
        >
          {avatarUrl ? (
            <button
              type="button"
              onClick={async () => {
                const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
                try {
                  await fetch(`${RELAY_HTTP}/v1/avatars`, { method: "DELETE", credentials: "include" });
                } catch {
                  /* no-op — broadcast won't fire, but a refresh will resync */
                }
              }}
              aria-label="remove image"
              title="remove image"
              style={overlayBtnStyle(false)}
            >
              <TrashIcon />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setSelfMuted(m => !m)}
            aria-label={selfMuted ? "unmute" : "mute"}
            title={selfMuted ? "unmute" : "mute"}
            style={overlayBtnStyle(selfMuted)}
          >
            {selfMuted ? <MicOffIcon /> : <MicIcon />}
          </button>
          {onSettings ? (
            <button
              type="button"
              onClick={onSettings}
              aria-label="audio settings"
              title="audio settings"
              style={overlayBtnStyle(false)}
            >
              <GearIcon />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// Shared overlay-button styling — used for both the mute toggle and the
// remove-image button on the audio window. `active` flips the styling to
// the magenta "this is on" state used by the muted variant.
const overlayBtnStyle = (active: boolean): React.CSSProperties => ({
  width: 32,
  height: 32,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: active ? "var(--slop-magenta, #ff3ec9)" : "rgba(6,3,13,0.7)",
  border: `1px solid ${active ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-bevel-light, #4a4a4a)"}`,
  color: "#fff",
  cursor: "pointer",
  backdropFilter: "blur(4px)",
});

// Mac OS 9-flavored monochrome icons. ~16px viewBox, drawn so they read
// at 16px target size against either a dark or magenta background.
const TrashIcon = () => (
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
    <path d="M3 4 H 13" />
    <path d="M6 4 V 2.5 H 10 V 4" />
    <path d="M4.5 4 L 5 13.5 H 11 L 11.5 4" />
    <line x1="6.5" y1="6.5" x2="6.5" y2="11.5" />
    <line x1="9.5" y1="6.5" x2="9.5" y2="11.5" />
  </svg>
);

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

const GearIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <line x1="2" y1="4" x2="14" y2="4" />
    <line x1="2" y1="8" x2="14" y2="8" />
    <line x1="2" y1="12" x2="14" y2="12" />
    <circle cx="10" cy="4" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="5" cy="8" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="11" cy="12" r="1.7" fill="currentColor" stroke="none" />
  </svg>
);

// Per-user "mute on my side" speaker — same glyph the music player uses.
const SpeakerIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M2.5 6 H 4.5 L 7.5 3 V 13 L 4.5 10 H 2.5 Z" fill="currentColor" stroke="none" />
    <path d="M9.5 6 Q 11 8 9.5 10" />
    <path d="M11 4.5 Q 13.5 8 11 11.5" />
  </svg>
);

const SpeakerOffIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M2.5 6 H 4.5 L 7.5 3 V 13 L 4.5 10 H 2.5 Z" fill="currentColor" stroke="none" />
    <line x1="9.5" y1="5.5" x2="14" y2="10.5" />
    <line x1="14" y1="5.5" x2="9.5" y2="10.5" />
  </svg>
);

export default AudioVisualizer;

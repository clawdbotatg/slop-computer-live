"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AmplitudeBall } from "~~/components/desktop/AmplitudeBall";
import { DenoiseToggle } from "~~/components/desktop/DenoiseToggle";
import { Bevel, Button } from "~~/components/ui";
import { type CameraResolution, MEDIA_PREF_KEYS } from "~~/hooks/useLocalMedia";
import { useMediaDevices } from "~~/hooks/useMediaDevices";

// First-visit A/V lobby. Shown ONCE, before the user has ever shared
// audio or video from this browser: a full-screen, single-purpose page
// that asks "audio or video?", lets them pick devices with live feedback
// (camera preview + mic level meter), hand-holds through permission
// problems, and only then drops them into the desktop with their share
// already live. Success writes AV_LOBBY_DONE (in Desktop) so the lobby
// never appears again — repeat visitors get the lightweight hint arrow
// instead. See the wiring + flag logic in Desktop.tsx.

export type LobbyChoice = "video" | "audio";

export type MediaLobbyProps = {
  /** Start the real publication (Desktop runs startCamera/startAudio).
   *  Resolves true on success — the lobby closes itself via Desktop
   *  marking it done; false keeps the lobby up with an error. */
  onCommit: (choice: LobbyChoice) => Promise<boolean>;
  /** "Just watching" — enter without sharing. Session-only: the flag is
   *  NOT written, so the lobby returns on the next visit. */
  onSkip: () => void;
};

const RESOLUTIONS: { value: CameraResolution; label: string }[] = [
  { value: "auto", label: "Auto (browser picks)" },
  { value: "480p", label: "480p · 640×480" },
  { value: "720p", label: "720p · 1280×720" },
  { value: "1080p", label: "1080p · 1920×1080" },
];

const labelFor = (d: MediaDeviceInfo, fallback: string) => d.label || `${fallback} (${d.deviceId.slice(0, 6)}…)`;

const previewResolutionConstraints = (res: CameraResolution): MediaTrackConstraints => {
  switch (res) {
    case "1080p":
      return { width: { ideal: 1920 }, height: { ideal: 1080 } };
    case "720p":
      return { width: { ideal: 1280 }, height: { ideal: 720 } };
    case "480p":
      return { width: { ideal: 640 }, height: { ideal: 480 } };
    default:
      return {};
  }
};

// DOMException.name from a failed getUserMedia — the key that picks
// which troubleshooting panel to show.
type MediaFailure = { name: string; message: string } | null;

const failureFrom = (err: unknown): MediaFailure => ({
  name: (err as { name?: string })?.name ?? "Error",
  message: (err as Error)?.message ?? "could not access device",
});

const isMac = () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    // iPadOS 13+ masquerades as a Mac but has touch.
    (/Mac/i.test(navigator.platform) && navigator.maxTouchPoints > 1));

/** Step-by-step "here's how to fix it" panel, keyed on the gUM error.
 *  This is the whole point of the lobby: when something's broken, tell
 *  the user exactly where to click instead of showing a raw error. */
const PermissionHelp = ({ failure, kind, onRetry }: { failure: MediaFailure; kind: string; onRetry: () => void }) => {
  if (!failure) return null;
  const denied = failure.name === "NotAllowedError" || failure.name === "PermissionDeniedError";
  const missing = failure.name === "NotFoundError" || failure.name === "OverconstrainedError";
  const busy = failure.name === "NotReadableError" || failure.name === "AbortError";
  return (
    <div
      style={{
        marginTop: 12,
        padding: "12px 14px",
        border: "1px solid var(--slop-magenta, #ff3ec9)",
        background: "rgba(255,62,201,0.08)",
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        {denied
          ? `Your browser is blocking the ${kind} 🚫`
          : missing
            ? `No ${kind} found 🔍`
            : busy
              ? `Something else is using your ${kind} 🔒`
              : `Couldn't start the ${kind}`}
      </div>
      {denied ? (
        <ol style={{ margin: 0, paddingLeft: 18, color: "var(--slop-text-muted)" }}>
          {isIOS() ? (
            <li>
              iPhone/iPad: open <strong>Settings → Apps → Safari</strong> (or your browser) and allow{" "}
              <strong>Camera</strong> and <strong>Microphone</strong>, then reload this page.
            </li>
          ) : (
            <>
              <li>
                Click the <strong>🎥 / 🔒 icon</strong> at the left end of the address bar and set{" "}
                <strong>Camera</strong> and <strong>Microphone</strong> to <strong>Allow</strong>.
              </li>
              {isMac() ? (
                <li>
                  Still blank? macOS itself may be blocking the browser: open{" "}
                  <strong>System Settings → Privacy &amp; Security → Camera / Microphone</strong>, switch your browser
                  on, then quit and reopen it.
                </li>
              ) : (
                <li>
                  Still blank? Your OS may be blocking the browser — check the system privacy settings for camera and
                  microphone.
                </li>
              )}
            </>
          )}
          <li>Then hit try again below.</li>
        </ol>
      ) : missing ? (
        <p style={{ margin: 0, color: "var(--slop-text-muted)" }}>
          Plug one in (or pick a different device from the dropdown above), then try again.
        </p>
      ) : busy ? (
        <p style={{ margin: 0, color: "var(--slop-text-muted)" }}>
          Another app (Zoom, OBS, FaceTime…) probably has it. Close that app — or pick a different device above — and
          try again.
        </p>
      ) : (
        <p style={{ margin: 0, color: "var(--slop-text-muted)" }}>{failure.message}</p>
      )}
      <div style={{ marginTop: 8 }}>
        <Button onClick={onRetry}>Try again</Button>
      </div>
    </div>
  );
};

/** Mic level meter + "we can hear you" confirmation. The AmplitudeBall
 *  gives instant motion feedback; this adds the explicit sentence the
 *  first-timer needs. Latches to "heard you" once the level clears the
 *  threshold so a pause between sentences doesn't flip it back. */
const MicCheck = ({ stream }: { stream: MediaStream | null }) => {
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);

  useEffect(() => {
    setHeard(false);
    setLevel(0);
    if (!stream) return;
    type Ctor = new () => AudioContext;
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!C) return;
    const ctx = new C();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      setLevel(peak);
      if (peak > 0.08) setHeard(true);
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    return () => {
      window.cancelAnimationFrame(raf);
      src.disconnect();
      void ctx.close().catch(() => undefined);
    };
  }, [stream]);

  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          height: 10,
          borderRadius: 5,
          background: "rgba(255,255,255,0.08)",
          overflow: "hidden",
          border: "1px solid var(--slop-bevel-light, #4a4a4a)",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, Math.round(level * 140))}%`,
            background: heard
              ? "linear-gradient(90deg, #7be88a, #bcff5b)"
              : "linear-gradient(90deg, var(--slop-cyan, #3fcfff), var(--slop-magenta, #ff3ec9))",
            transition: "width 80ms linear",
          }}
        />
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 12,
          color: heard ? "#7be88a" : "var(--slop-text-muted)",
          fontWeight: heard ? 700 : undefined,
        }}
      >
        {stream ? (heard ? "✓ we can hear you!" : "say something — the bar should move…") : "waiting for microphone…"}
      </div>
    </div>
  );
};

const VideoPreview = ({ stream }: { stream: MediaStream | null }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  return (
    <div
      style={{
        width: "100%",
        aspectRatio: "16 / 9",
        background: "#06030d",
        border: "1px solid var(--slop-bevel-light, #4a4a4a)",
        position: "relative",
        overflow: "hidden",
        borderRadius: 4,
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
      {stream ? (
        <div
          style={{
            position: "absolute",
            left: 8,
            bottom: 6,
            fontSize: 11,
            fontWeight: 700,
            color: "#7be88a",
            background: "rgba(6,3,13,0.7)",
            padding: "2px 8px",
            borderRadius: 4,
          }}
        >
          ✓ this is what the room will see
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--slop-text-muted)",
            fontSize: 12,
          }}
        >
          waiting for camera…
        </div>
      )}
    </div>
  );
};

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      fontSize: 11,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "var(--slop-text-muted)",
      marginBottom: 4,
    }}
  >
    {children}
  </div>
);

const Select = ({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) => (
  <select
    value={value}
    onChange={e => onChange(e.target.value)}
    style={{
      width: "100%",
      padding: "6px 8px",
      background: "#06030d",
      border: "1px solid var(--slop-bevel-light)",
      color: "var(--slop-text)",
      fontFamily: "var(--slop-font-body)",
      fontSize: 13,
    }}
  >
    {children}
  </select>
);

export const MediaLobby = ({ onCommit, onSkip }: MediaLobbyProps) => {
  const [step, setStep] = useState<"choice" | LobbyChoice>("choice");
  const { cameras, mics, refresh } = useMediaDevices();

  // Device prefs — same keys the share dialogs and useLocalMedia read,
  // so whatever the user picks here IS the device the real share uses.
  const [cameraId, setCameraId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(MEDIA_PREF_KEYS.cameraId) ?? "";
  });
  const [resolution, setResolution] = useState<CameraResolution>(() => {
    if (typeof window === "undefined") return "auto";
    return (window.localStorage.getItem(MEDIA_PREF_KEYS.cameraRes) as CameraResolution) ?? "auto";
  });
  const [micId, setMicId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(MEDIA_PREF_KEYS.micId) ?? "";
  });
  const [denoise, setDenoise] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(MEDIA_PREF_KEYS.denoise) !== "0";
  });

  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [videoFailure, setVideoFailure] = useState<MediaFailure>(null);
  const [audioFailure, setAudioFailure] = useState<MediaFailure>(null);
  // Bumped by "Try again" — both acquire effects depend on it, so a
  // retry re-runs getUserMedia with the current selections.
  const [retryNonce, setRetryNonce] = useState(0);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState("");

  // Live refs so commit() can stop the previews synchronously before
  // starting the real capture (some cameras are single-client).
  const videoStreamRef = useRef<MediaStream | null>(null);
  videoStreamRef.current = videoStream;
  const audioStreamRef = useRef<MediaStream | null>(null);
  audioStreamRef.current = audioStream;

  // Camera preview — only while on the video step. Same lifecycle as
  // VideoShareDialog's: reacquire on camera/resolution change, refresh
  // the device list post-permission so labels populate.
  useEffect(() => {
    if (step !== "video") return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    const acquire = async () => {
      setVideoFailure(null);
      try {
        const video: MediaTrackConstraints = {
          ...previewResolutionConstraints(resolution),
          ...(cameraId ? { deviceId: { exact: cameraId } } : {}),
        };
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        setVideoStream(stream);
        refresh();
      } catch (err) {
        if (!cancelled) setVideoFailure(failureFrom(err));
      }
    };
    void acquire();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach(t => t.stop());
      setVideoStream(null);
    };
  }, [step, cameraId, resolution, refresh, retryNonce]);

  // Mic preview — on both setup steps (video bundles the mic). Kept
  // independent of the camera so a camera denial doesn't kill the mic
  // check and vice versa.
  useEffect(() => {
    if (step === "choice") return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    const acquire = async () => {
      setAudioFailure(null);
      try {
        const audio: MediaTrackConstraints | true = micId ? { deviceId: { exact: micId } } : true;
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        setAudioStream(stream);
        refresh();
      } catch (err) {
        if (!cancelled) setAudioFailure(failureFrom(err));
      }
    };
    void acquire();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach(t => t.stop());
      setAudioStream(null);
    };
  }, [step, micId, refresh, retryNonce]);

  const retry = useCallback(() => setRetryNonce(n => n + 1), []);

  const labelsHidden =
    (step === "video" && cameras.length > 0 && !cameras.some(c => c.label)) ||
    (mics.length > 0 && !mics.some(m => m.label));

  // Persist the picks with the exact same rules as the share dialogs
  // (labels ride along so heal-by-label works when deviceIds rotate).
  const savePrefs = useCallback(
    (choice: LobbyChoice) => {
      if (typeof window === "undefined") return;
      try {
        if (choice === "video") {
          if (cameraId) window.localStorage.setItem(MEDIA_PREF_KEYS.cameraId, cameraId);
          else window.localStorage.removeItem(MEDIA_PREF_KEYS.cameraId);
          if (resolution === "auto") window.localStorage.removeItem(MEDIA_PREF_KEYS.cameraRes);
          else window.localStorage.setItem(MEDIA_PREF_KEYS.cameraRes, resolution);
          const cameraLabel = cameras.find(d => d.deviceId === cameraId)?.label;
          if (cameraId && cameraLabel) window.localStorage.setItem(MEDIA_PREF_KEYS.cameraLabel, cameraLabel);
          else if (!cameraId) window.localStorage.removeItem(MEDIA_PREF_KEYS.cameraLabel);
        }
        if (micId) window.localStorage.setItem(MEDIA_PREF_KEYS.micId, micId);
        else window.localStorage.removeItem(MEDIA_PREF_KEYS.micId);
        const micLabel = mics.find(d => d.deviceId === micId)?.label;
        if (micId && micLabel) window.localStorage.setItem(MEDIA_PREF_KEYS.micLabel, micLabel);
        else if (!micId) window.localStorage.removeItem(MEDIA_PREF_KEYS.micLabel);
        if (denoise) window.localStorage.removeItem(MEDIA_PREF_KEYS.denoise);
        else window.localStorage.setItem(MEDIA_PREF_KEYS.denoise, "0");
      } catch {
        /* private mode — prefs just won't stick */
      }
    },
    [cameraId, resolution, micId, denoise, cameras, mics],
  );

  const commit = useCallback(
    async (choice: LobbyChoice) => {
      setCommitError("");
      setCommitting(true);
      savePrefs(choice);
      // Release the preview devices BEFORE the real capture starts —
      // some cameras (esp. on Windows) refuse a second simultaneous
      // client. The effect cleanups also stop these; stopping twice is
      // harmless.
      videoStreamRef.current?.getTracks().forEach(t => t.stop());
      audioStreamRef.current?.getTracks().forEach(t => t.stop());
      const ok = await onCommit(choice);
      if (!ok) {
        setCommitError("couldn't start the share — check the device help above, then try again.");
        setCommitting(false);
        retry();
      }
      // On success Desktop unmounts the lobby; no local cleanup needed.
    },
    [onCommit, savePrefs, retry],
  );

  const choiceCard = (opts: { icon: string; title: string; body: string; onClick: () => void }): React.ReactElement => (
    <button
      type="button"
      onClick={opts.onClick}
      style={{
        flex: "1 1 220px",
        maxWidth: 300,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        padding: "26px 20px",
        cursor: "pointer",
        background: "linear-gradient(180deg, rgba(40,18,70,0.75), rgba(8,4,16,0.85))",
        border: "1px solid rgba(255,62,201,0.4)",
        borderRadius: 10,
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        boxShadow: "0 8px 24px #0008",
        transition: "transform 120ms ease, border-color 120ms ease",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = "translateY(-3px)";
        e.currentTarget.style.borderColor = "var(--slop-cyan, #3fcfff)";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = "";
        e.currentTarget.style.borderColor = "rgba(255,62,201,0.4)";
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={opts.icon} alt="" width={72} height={72} draggable={false} />
      <div
        style={{
          fontFamily: "var(--slop-font-display)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontSize: 16,
          fontWeight: 700,
        }}
      >
        {opts.title}
      </div>
      <div style={{ fontSize: 12, color: "var(--slop-text-muted)", lineHeight: 1.5 }}>{opts.body}</div>
    </button>
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9990,
        background: "rgba(8,4,18,0.82)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        overflowY: "auto",
        padding: "4vh 16px 40px",
      }}
    >
      <Bevel style={{ padding: 24, maxWidth: 620, width: "100%", margin: "auto 0" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-mark.png"
          alt="slop"
          width={72}
          height={72}
          style={{ display: "block", margin: "0 auto 12px", imageRendering: "pixelated" }}
        />

        {step === "choice" ? (
          <>
            <h1
              style={{
                margin: 0,
                marginBottom: 8,
                textAlign: "center",
                fontFamily: "var(--slop-font-display)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontSize: 22,
              }}
            >
              Welcome to the slop computer
            </h1>
            <p
              style={{
                textAlign: "center",
                color: "var(--slop-text-muted)",
                fontSize: 13,
                marginTop: 0,
                marginBottom: 22,
                lineHeight: 1.6,
              }}
            >
              This is a live shared desktop — when you&apos;re in, you&apos;re on the show.
              <br />
              <strong style={{ color: "var(--slop-text)" }}>Are you sharing your video, or just your audio?</strong>
            </p>
            <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
              {choiceCard({
                icon: "/icons/video.png",
                title: "My video",
                body: "Camera + mic. The room sees and hears you.",
                onClick: () => setStep("video"),
              })}
              {choiceCard({
                icon: "/icons/mic.png",
                title: "Just my audio",
                body: "Mic only. The room hears you — no camera.",
                onClick: () => setStep("audio"),
              })}
            </div>
            <p style={{ textAlign: "center", fontSize: 11, color: "var(--slop-text-muted)", marginTop: 18 }}>
              You can switch, stop, or reconfigure anytime once you&apos;re inside.
            </p>
            <p style={{ textAlign: "center", marginTop: 4, marginBottom: 0 }}>
              <button
                type="button"
                onClick={onSkip}
                style={{
                  background: "transparent",
                  border: 0,
                  color: "var(--slop-text-muted)",
                  textDecoration: "underline",
                  cursor: "pointer",
                  fontSize: 11,
                  fontFamily: "var(--slop-font-body)",
                }}
              >
                I&apos;m just here to watch — skip for now
              </button>
            </p>
          </>
        ) : (
          <>
            <h1
              style={{
                margin: 0,
                marginBottom: 6,
                textAlign: "center",
                fontFamily: "var(--slop-font-display)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontSize: 19,
              }}
            >
              {step === "video" ? "Set up your video" : "Set up your audio"}
            </h1>
            <p
              style={{
                textAlign: "center",
                color: "var(--slop-text-muted)",
                fontSize: 12,
                marginTop: 0,
                marginBottom: 14,
              }}
            >
              {step === "video"
                ? "Check the preview, pick your camera and mic, and make sure the meter hears you."
                : "Pick your mic and make sure the meter hears you."}
            </p>

            {labelsHidden ? (
              <p style={{ color: "var(--slop-text-muted)", fontSize: 11, fontStyle: "italic", marginTop: 0 }}>
                tip: device names stay hidden until you grant permission once — your browser should be asking right now.
              </p>
            ) : null}

            {step === "video" ? (
              <>
                <VideoPreview stream={videoStream} />
                <PermissionHelp failure={videoFailure} kind="camera" onRetry={retry} />
                <div style={{ marginTop: 12 }}>
                  <FieldLabel>Camera</FieldLabel>
                  <Select value={cameraId} onChange={setCameraId}>
                    <option value="">Default</option>
                    {cameras.map(d => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {labelFor(d, "Camera")}
                      </option>
                    ))}
                  </Select>
                </div>
                <div style={{ marginTop: 12 }}>
                  <FieldLabel>Resolution</FieldLabel>
                  <Select value={resolution} onChange={v => setResolution(v as CameraResolution)}>
                    {RESOLUTIONS.map(r => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            ) : null}

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
              <div style={{ flex: 1 }}>
                <FieldLabel>Microphone</FieldLabel>
                <Select value={micId} onChange={setMicId}>
                  <option value="">Default</option>
                  {mics.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {labelFor(d, "Microphone")}
                    </option>
                  ))}
                </Select>
              </div>
              <div style={{ paddingTop: 18 }}>
                <AmplitudeBall stream={audioStream} />
              </div>
            </div>
            <MicCheck stream={audioStream} />
            <PermissionHelp failure={audioFailure} kind="microphone" onRetry={retry} />

            <DenoiseToggle denoise={denoise} setDenoise={setDenoise} />

            {commitError ? (
              <p style={{ color: "var(--slop-magenta, #ff3ec9)", fontSize: 12, marginTop: 10, marginBottom: 0 }}>
                {commitError}
              </p>
            ) : null}

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                marginTop: 18,
              }}
            >
              <Button onClick={() => setStep("choice")} disabled={committing}>
                ← Back
              </Button>
              <Button
                variant="primary"
                onClick={() => void commit(step)}
                disabled={committing || (step === "video" ? !videoStream : !audioStream)}
              >
                {committing ? "Starting…" : step === "video" ? "Share video & enter →" : "Share audio & enter →"}
              </Button>
            </div>
          </>
        )}

        <p
          style={{
            textAlign: "center",
            fontSize: 10,
            color: "var(--slop-text-muted)",
            marginTop: 16,
            marginBottom: 0,
            opacity: 0.8,
          }}
        >
          the room can see you&apos;re in the lobby getting set up — take your time.
        </p>
      </Bevel>
    </div>
  );
};

export default MediaLobby;

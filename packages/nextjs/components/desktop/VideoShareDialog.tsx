"use client";

import { useEffect, useRef, useState } from "react";
import { AmplitudeBall } from "~~/components/desktop/AmplitudeBall";
import { DenoiseToggle } from "~~/components/desktop/DenoiseToggle";
import { Bevel, Button } from "~~/components/ui";
import { type CameraResolution, MEDIA_PREF_KEYS } from "~~/hooks/useLocalMedia";
import { useMediaDevices } from "~~/hooks/useMediaDevices";

const RESOLUTIONS: { value: CameraResolution; label: string }[] = [
  { value: "auto", label: "Auto (browser picks)" },
  { value: "480p", label: "480p · 640×480" },
  { value: "720p", label: "720p · 1280×720" },
  { value: "1080p", label: "1080p · 1920×1080" },
];

const labelFor = (d: MediaDeviceInfo, fallback: string) => d.label || `${fallback} (${d.deviceId.slice(0, 6)}…)`;

const resolutionConstraints = (res: CameraResolution): MediaTrackConstraints => {
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

export type VideoShareSubmit = {
  cameraId: string;
  resolution: CameraResolution;
  micId: string;
};

export type VideoShareDialogProps = {
  mode: "create" | "edit";
  onClose: () => void;
  /** Called with the chosen camera + resolution + mic. The parent starts
   *  (create) or hot-swaps (edit) the camera publication and the audio
   *  publication. Audio is only started in create mode if it isn't
   *  already running. */
  onSubmit: (sel: VideoShareSubmit) => void;
};

// Pre-share dialog: pick a camera + resolution + mic, watch the live video
// preview and the amplitude ball next to the mic dropdown, then commit.
// Reused for "edit" — same UI, button label flips, parent hot-swaps via
// mesh.replaceTrack on both publications.
export const VideoShareDialog = ({ mode, onClose, onSubmit }: VideoShareDialogProps) => {
  const { cameras, mics, refresh } = useMediaDevices();
  // Lazy init from localStorage so the preview-stream effects don't fire
  // twice on mount (once with defaults, then again post-hydration). The
  // dialogs only render client-side so SSR mismatch isn't a concern.
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
  // RNNoise toggle — default on, persisted as "0" when off. Applies on
  // next acquire (the dialog's Save → parent's start/replace path).
  const [denoise, setDenoise] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(MEDIA_PREF_KEYS.denoise) !== "0";
  });
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [videoError, setVideoError] = useState<string>("");
  const [audioError, setAudioError] = useState<string>("");

  // (Re)acquire the video preview when camera or resolution changes.
  // Forces a device refresh on success to populate labels post-permission.
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    const acquire = async () => {
      setVideoError("");
      try {
        const video: MediaTrackConstraints = {
          ...resolutionConstraints(resolution),
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
        if (!cancelled) setVideoError((err as Error).message || "could not access camera");
      }
    };
    void acquire();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach(t => t.stop());
      setVideoStream(null);
    };
  }, [cameraId, resolution, refresh]);

  // Same lifecycle for the mic preview — kept independent so a camera
  // permission denial doesn't tear down the mic preview and vice versa.
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    const acquire = async () => {
      setAudioError("");
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
        if (!cancelled) setAudioError((err as Error).message || "could not access mic");
      }
    };
    void acquire();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach(t => t.stop());
      setAudioStream(null);
    };
  }, [micId, refresh]);

  const labelsHidden =
    (cameras.length > 0 && !cameras.some(c => c.label)) || (mics.length > 0 && !mics.some(m => m.label));

  const save = () => {
    if (typeof window === "undefined") return;
    if (cameraId) window.localStorage.setItem(MEDIA_PREF_KEYS.cameraId, cameraId);
    else window.localStorage.removeItem(MEDIA_PREF_KEYS.cameraId);
    if (resolution === "auto") window.localStorage.removeItem(MEDIA_PREF_KEYS.cameraRes);
    else window.localStorage.setItem(MEDIA_PREF_KEYS.cameraRes, resolution);
    if (micId) window.localStorage.setItem(MEDIA_PREF_KEYS.micId, micId);
    else window.localStorage.removeItem(MEDIA_PREF_KEYS.micId);
    // Labels ride along with the ids: deviceIds rotate per-origin, labels
    // don't — useLocalMedia re-finds the device by label when the id dies.
    // (id set but not in the list = stale selection — keep the old label,
    // it's the only thing left that can re-find the device.)
    const cameraLabel = cameras.find(d => d.deviceId === cameraId)?.label;
    if (cameraId && cameraLabel) window.localStorage.setItem(MEDIA_PREF_KEYS.cameraLabel, cameraLabel);
    else if (!cameraId) window.localStorage.removeItem(MEDIA_PREF_KEYS.cameraLabel);
    const micLabel = mics.find(d => d.deviceId === micId)?.label;
    if (micId && micLabel) window.localStorage.setItem(MEDIA_PREF_KEYS.micLabel, micLabel);
    else if (!micId) window.localStorage.removeItem(MEDIA_PREF_KEYS.micLabel);
    if (denoise) window.localStorage.removeItem(MEDIA_PREF_KEYS.denoise);
    else window.localStorage.setItem(MEDIA_PREF_KEYS.denoise, "0");
    onSubmit({ cameraId, resolution, micId });
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <Bevel style={{ padding: 18, maxWidth: 560, width: "100%" }}>
        <h2
          style={{
            margin: 0,
            marginBottom: 8,
            fontFamily: "var(--slop-font-display)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            fontSize: 18,
          }}
        >
          {mode === "create" ? "Share video" : "Video settings"}
        </h2>
        {labelsHidden ? (
          <p style={{ color: "var(--slop-text-muted)", fontSize: 11, fontStyle: "italic" }}>
            tip: device names are hidden until you grant camera + mic permission once
          </p>
        ) : null}

        <VideoPreview stream={videoStream} />
        {videoError ? (
          <p style={{ color: "var(--slop-magenta, #ff3ec9)", fontSize: 11, marginTop: 6 }}>{videoError}</p>
        ) : null}

        <Field label="Camera">
          <Select value={cameraId} onChange={setCameraId}>
            <option value="">Default</option>
            {cameras.map(d => (
              <option key={d.deviceId} value={d.deviceId}>
                {labelFor(d, "Camera")}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Resolution">
          <Select value={resolution} onChange={v => setResolution(v as CameraResolution)}>
            {RESOLUTIONS.map(r => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
          <label style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--slop-text-muted)",
                marginBottom: 4,
              }}
            >
              Microphone
            </div>
            <Select value={micId} onChange={setMicId}>
              <option value="">Default</option>
              {mics.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {labelFor(d, "Microphone")}
                </option>
              ))}
            </Select>
          </label>
          <div style={{ paddingTop: 18 }}>
            <AmplitudeBall stream={audioStream} />
          </div>
        </div>
        {audioError ? (
          <p style={{ color: "var(--slop-magenta, #ff3ec9)", fontSize: 11, marginTop: 6 }}>{audioError}</p>
        ) : null}

        <DenoiseToggle denoise={denoise} setDenoise={setDenoise} />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!videoStream}>
            {mode === "create" ? "Share Video" : "Save"}
          </Button>
        </div>
      </Bevel>
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
        marginTop: 10,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
        }}
      />
      {!stream ? (
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
      ) : null}
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label style={{ display: "block", marginTop: 12 }}>
    <div
      style={{
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--slop-text-muted)",
        marginBottom: 4,
      }}
    >
      {label}
    </div>
    {children}
  </label>
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

export default VideoShareDialog;

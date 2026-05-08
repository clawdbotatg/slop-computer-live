"use client";

import { useEffect, useState } from "react";
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

export type DeviceSettingsModalProps = {
  onClose: () => void;
  /**
   * Called after prefs are saved. The desktop hot-swaps any active streams
   * here (stop + restart) so the new device choice applies immediately.
   */
  onSaved: () => void;
};

export const DeviceSettingsModal = ({ onClose, onSaved }: DeviceSettingsModalProps) => {
  const { mics, cameras } = useMediaDevices();
  const [micId, setMicId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [cameraRes, setCameraRes] = useState<CameraResolution>("auto");

  // Hydrate from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setMicId(window.localStorage.getItem(MEDIA_PREF_KEYS.micId) ?? "");
    setCameraId(window.localStorage.getItem(MEDIA_PREF_KEYS.cameraId) ?? "");
    setCameraRes((window.localStorage.getItem(MEDIA_PREF_KEYS.cameraRes) as CameraResolution) ?? "auto");
  }, []);

  const labelsHidden =
    (mics.length > 0 && !mics.some(m => m.label)) || (cameras.length > 0 && !cameras.some(c => c.label));

  const save = () => {
    if (typeof window === "undefined") return;
    const set = (k: string, v: string) => {
      if (v) window.localStorage.setItem(k, v);
      else window.localStorage.removeItem(k);
    };
    set(MEDIA_PREF_KEYS.micId, micId);
    set(MEDIA_PREF_KEYS.cameraId, cameraId);
    set(MEDIA_PREF_KEYS.cameraRes, cameraRes === "auto" ? "" : cameraRes);
    onSaved();
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
      <Bevel style={{ padding: 18, maxWidth: 480, width: "100%" }}>
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
          Devices
        </h2>
        <p style={{ color: "var(--slop-text-muted)", marginTop: 0, fontSize: 12 }}>
          Saved per-browser. Applies on next start; if you&apos;re currently sharing, the stream restarts on save.
        </p>

        {labelsHidden ? (
          <p style={{ color: "var(--slop-text-muted)", fontSize: 11, fontStyle: "italic" }}>
            tip: device names are hidden until you grant mic/camera permission once
          </p>
        ) : null}

        <Field label="Microphone">
          <Select value={micId} onChange={setMicId}>
            <option value="">Default</option>
            {mics.map(d => (
              <option key={d.deviceId} value={d.deviceId}>
                {labelFor(d, "Microphone")}
              </option>
            ))}
          </Select>
        </Field>

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

        <Field label="Camera resolution">
          <Select value={cameraRes} onChange={v => setCameraRes(v as CameraResolution)}>
            {RESOLUTIONS.map(r => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </div>
      </Bevel>
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

export default DeviceSettingsModal;

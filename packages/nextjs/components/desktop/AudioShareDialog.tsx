"use client";

import { useEffect, useRef, useState } from "react";
import { AmplitudeBall } from "~~/components/desktop/AmplitudeBall";
import { uploadAvatar } from "~~/components/desktop/AudioDropZone";
import { DenoiseToggle } from "~~/components/desktop/DenoiseToggle";
import { Bevel, Button } from "~~/components/ui";
import { MEDIA_PREF_KEYS } from "~~/hooks/useLocalMedia";
import { useMediaDevices } from "~~/hooks/useMediaDevices";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

const labelFor = (d: MediaDeviceInfo, fallback: string) => d.label || `${fallback} (${d.deviceId.slice(0, 6)}…)`;

export type AudioShareDialogProps = {
  mode: "create" | "edit";
  /** Currently uploaded avatar (if any). When set, the preview shows
   *  this image and a remove (×) button is rendered. */
  avatarUrl?: string | null;
  /** ENS-derived fallback URL used in the preview only when no upload
   *  exists — peers see the same fallback live, so the dialog should
   *  show what they'd see. The remove button is NOT shown for this
   *  state since "removing" an ENS avatar isn't meaningful. */
  ensAvatarUrl?: string | null;
  /** True when the user has explicitly hidden their avatar (no image
   *  shown to peers regardless of ENS). */
  hidden?: boolean;
  onClose: () => void;
  /** Called with the chosen mic deviceId (or "" for default). The parent
   *  starts (create) or hot-swaps (edit) the publication using this id. */
  onSubmit: (micId: string) => void;
};

// Pre-share dialog: pick a mic, watch the visualizer ball pulse to confirm
// it's the right device, optionally drop in an avatar, then commit.
// Reused for "edit" — same UI, different button label, parent hot-swaps.
export const AudioShareDialog = ({
  mode,
  avatarUrl: initialAvatarUrl,
  ensAvatarUrl = null,
  hidden: initialHidden = false,
  onClose,
  onSubmit,
}: AudioShareDialogProps) => {
  const { mics, refresh } = useMediaDevices();
  // Lazy init from localStorage so the preview-stream effect doesn't fire
  // twice on mount (once with "" → default mic, then again after a state
  // update with the saved id) — that would otherwise flash a brief
  // "Default" preview before the saved device kicked in.
  const [micId, setMicId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(MEDIA_PREF_KEYS.micId) ?? "";
  });
  // RNNoise toggle — default on, persisted as "0" when off. See
  // VideoShareDialog for the same shape.
  const [denoise, setDenoise] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(MEDIA_PREF_KEYS.denoise) !== "0";
  });
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [previewError, setPreviewError] = useState<string>("");
  // Three states tracked separately:
  //  - uploadedAvatar: user-uploaded URL, if any
  //  - hidden: explicit opt-out (suppresses both upload + ENS)
  //  - ensAvatarUrl (prop): ENS fallback when nothing else is set
  // Displayed = uploaded || (hidden ? null : ENS)
  const [uploadedAvatar, setUploadedAvatar] = useState<string | null>(initialAvatarUrl ?? null);
  const [hidden, setHidden] = useState<boolean>(initialHidden);
  const displayedAvatar = uploadedAvatar || (hidden ? null : ensAvatarUrl);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  // Drag-hover state is owned by the dialog (not by AvatarDrop) so the
  // entire modal acts as a drop target — dropping anywhere in the modal
  // uploads the image. The dashed AvatarDrop region still lights up to
  // give the user a clear target, but missing it doesn't crash the page
  // by letting the browser navigate to the dropped file.
  const [avatarHover, setAvatarHover] = useState(false);
  const dragDepthRef = useRef(0);

  // (Re)acquire the preview stream whenever the selected mic changes.
  // The visualizer ball is bound to this stream — switching mics gives
  // the user instant feedback (tap the new mic, watch the ball pulse).
  // After a successful acquire we also force-refresh the device list:
  // labels only become available post-permission, and Chrome doesn't
  // always fire `devicechange` for that case so the dropdown can land
  // empty even though the user has multiple mics.
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    const acquire = async () => {
      setPreviewError("");
      try {
        const audio: MediaTrackConstraints | true = micId ? { deviceId: { exact: micId } } : true;
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        setPreviewStream(stream);
        refresh();
      } catch (err) {
        if (!cancelled) setPreviewError((err as Error).message || "could not access mic");
      }
    };
    void acquire();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach(t => t.stop());
      setPreviewStream(null);
    };
  }, [micId, refresh]);

  const labelsHidden = mics.length > 0 && !mics.some(m => m.label);

  const save = () => {
    if (typeof window === "undefined") return;
    if (micId) window.localStorage.setItem(MEDIA_PREF_KEYS.micId, micId);
    else window.localStorage.removeItem(MEDIA_PREF_KEYS.micId);
    // Label rides along with the id: deviceIds rotate per-origin, labels
    // don't — useLocalMedia re-finds the device by label when the id dies.
    // (id set but not in the list = stale selection — keep the old label,
    // it's the only thing left that can re-find the device.)
    const micLabel = mics.find(d => d.deviceId === micId)?.label;
    if (micId && micLabel) window.localStorage.setItem(MEDIA_PREF_KEYS.micLabel, micLabel);
    else if (!micId) window.localStorage.removeItem(MEDIA_PREF_KEYS.micLabel);
    if (denoise) window.localStorage.removeItem(MEDIA_PREF_KEYS.denoise);
    else window.localStorage.setItem(MEDIA_PREF_KEYS.denoise, "0");
    onSubmit(micId);
    onClose();
  };

  const handleFile = async (file: File) => {
    setUploadingAvatar(true);
    try {
      const { url } = await uploadAvatar(file);
      // The relay's URL already carries `?v=<Date.now()>` as a cache
      // buster — re-busting with `?t=...` here produced `?v=...?t=...`
      // (two query starts), a malformed URL the browser 404'd on.
      setUploadedAvatar(url);
      // Uploading clears the hidden marker — server already does this,
      // local state mirrors so the preview reflects immediately.
      setHidden(false);
    } catch (err) {
      console.warn("avatar upload failed", err);
    } finally {
      setUploadingAvatar(false);
    }
  };

  // × button on an uploaded image: clear the upload, return to ENS
  // fallback (or empty). Preserves the hidden marker if it was set.
  const removeUpload = async () => {
    try {
      await fetch(`${RELAY_HTTP}/v1/avatars`, { method: "DELETE", credentials: "include" });
    } catch {
      /* no-op */
    }
    setUploadedAvatar(null);
    setHidden(false);
  };

  // Trash button: opt out of any avatar (including ENS). Server writes
  // a `.hidden` marker and removes any image. Peers stop showing
  // anything for this user.
  const hideAvatar = async () => {
    try {
      await fetch(`${RELAY_HTTP}/v1/avatars/hide`, { method: "POST", credentials: "include" });
    } catch {
      /* no-op */
    }
    setUploadedAvatar(null);
    setHidden(true);
  };

  // Restore: lifts the hidden marker by hitting DELETE (clean slate).
  // The user's ENS image (if any) shows up again on the next render.
  const unhideAvatar = async () => {
    try {
      await fetch(`${RELAY_HTTP}/v1/avatars`, { method: "DELETE", credentials: "include" });
    } catch {
      /* no-op */
    }
    setHidden(false);
  };

  // Dialog-level drag/drop. Without these, dropping a file anywhere on
  // the dialog backdrop falls through to the browser default (navigate
  // to the file → blows away the page). Depth counter handles the
  // dragenter-on-every-child quirk.
  const onDialogDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setAvatarHover(true);
  };
  const onDialogDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDialogDragLeave = () => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setAvatarHover(false);
  };
  const onDialogDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setAvatarHover(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      onDragEnter={onDialogDragEnter}
      onDragOver={onDialogDragOver}
      onDragLeave={onDialogDragLeave}
      onDrop={onDialogDrop}
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
          {mode === "create" ? "Share audio" : "Audio settings"}
        </h2>
        <p style={{ color: "var(--slop-text-muted)", marginTop: 0, fontSize: 12 }}>
          Pick a mic and tap to test — the ball pulses with your voice.
        </p>

        {labelsHidden ? (
          <p style={{ color: "var(--slop-text-muted)", fontSize: 11, fontStyle: "italic" }}>
            tip: device names are hidden until you grant mic permission once
          </p>
        ) : null}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 12,
          }}
        >
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
            <AmplitudeBall stream={previewStream} />
          </div>
        </div>
        {previewError ? (
          <p style={{ color: "var(--slop-magenta, #ff3ec9)", fontSize: 11, marginTop: 6 }}>{previewError}</p>
        ) : null}

        <DenoiseToggle denoise={denoise} setDenoise={setDenoise} />

        <div style={{ marginTop: 14 }}>
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--slop-text-muted)",
              marginBottom: 4,
            }}
          >
            PFP Image (optional)
          </div>
          <AvatarDrop
            avatarUrl={displayedAvatar}
            canRemoveUpload={!!uploadedAvatar}
            canHide={!hidden && !!displayedAvatar}
            isHidden={hidden}
            canUnhide={hidden && !!ensAvatarUrl}
            uploading={uploadingAvatar}
            hover={avatarHover}
            onFile={handleFile}
            onRemoveUpload={removeUpload}
            onHide={hideAvatar}
            onUnhide={unhideAvatar}
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!previewStream}>
            {mode === "create" ? "Share Audio" : "Save"}
          </Button>
        </div>
      </Bevel>
    </div>
  );
};

// Dashed-border target that lights up when the user drags a file into
// the dialog. Drop handling lives on the dialog itself (so dropping
// anywhere in the modal works, not just inside this small rectangle) —
// this component is purely visual + a click-to-pick fallback.
//  - canRemoveUpload (×): clear the user's upload, fall back to ENS
//  - canHide (trash): opt out entirely (no upload, no ENS) — peers see nothing
//  - canUnhide: lifted when in hidden state and an ENS image is available
const AvatarDrop = ({
  avatarUrl,
  canRemoveUpload,
  canHide,
  isHidden,
  canUnhide,
  uploading,
  hover,
  onFile,
  onRemoveUpload,
  onHide,
  onUnhide,
}: {
  avatarUrl: string | null;
  canRemoveUpload: boolean;
  canHide: boolean;
  isHidden: boolean;
  canUnhide: boolean;
  uploading: boolean;
  hover: boolean;
  onFile: (file: File) => void;
  onRemoveUpload: () => void;
  onHide: () => void;
  onUnhide: () => void;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onClick={() => inputRef.current?.click()}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: 10,
        border: `2px dashed ${hover ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-bevel-light, #4a4a4a)"}`,
        background: hover ? "rgba(255,62,201,0.10)" : "rgba(6,3,13,0.4)",
        cursor: "pointer",
        minHeight: 70,
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          draggable={false}
          style={{
            width: 48,
            height: 48,
            objectFit: "cover",
            border: "1px solid var(--slop-bevel-light, #4a4a4a)",
          }}
        />
      ) : (
        <div
          style={{
            width: 48,
            height: 48,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--slop-bevel-light, #4a4a4a)",
            color: "var(--slop-text-muted)",
            fontSize: 22,
          }}
          aria-hidden
        >
          +
        </div>
      )}
      <div style={{ flex: 1, fontSize: 12, color: "var(--slop-text-muted)" }}>
        {uploading
          ? "uploading…"
          : isHidden
            ? canUnhide
              ? "hidden — drop to upload, or restore ENS image"
              : "hidden — drop or click to upload an image"
            : avatarUrl
              ? "drag image to replace, or click to choose"
              : "drag an image here, or click to choose"}
      </div>
      <div style={{ display: "flex", gap: 6 }} onClick={e => e.stopPropagation()}>
        {canRemoveUpload ? (
          <button
            type="button"
            onClick={onRemoveUpload}
            aria-label="remove uploaded image"
            title="remove uploaded image"
            style={smallBtnStyle}
          >
            ×
          </button>
        ) : null}
        {canHide ? (
          <button
            type="button"
            onClick={onHide}
            aria-label="hide avatar entirely"
            title="hide avatar entirely (no image at all)"
            style={smallBtnStyle}
          >
            <SmallTrashIcon />
          </button>
        ) : null}
        {canUnhide ? (
          <button
            type="button"
            onClick={onUnhide}
            aria-label="restore ENS image"
            title="restore ENS image"
            style={{ ...smallBtnStyle, width: "auto", padding: "0 8px", fontSize: 11 }}
          >
            ENS
          </button>
        ) : null}
      </div>
    </div>
  );
};

const smallBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "1px solid var(--slop-bevel-light, #4a4a4a)",
  color: "var(--slop-text)",
  cursor: "pointer",
};

const SmallTrashIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
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

export default AudioShareDialog;

"use client";

import { useCallback, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { LocalStreamHandle, StreamKind } from "~~/components/desktop/MyCamera";
import { denoiseStream } from "~~/utils/noiseSuppression";

export type UseLocalMedia = {
  // Resolve to true on success, false on failure. The error is also
  // recorded in `error` for display, but the boolean lets callers (the
  // reload auto-resume) retry a contended device instead of giving up.
  startCamera: () => Promise<boolean>;
  startScreen: () => Promise<boolean>;
  startAudio: () => Promise<boolean>;
  stop: (kind: StreamKind) => void;
  stopById: (id: string) => void;
  hasScreen: (id: string) => boolean;
  // Stream id of the most recently launched screen share, or null. Used
  // by the Screen-icon double-click to focus-then-new: the first
  // double-click pulls this share forward, a subsequent click (once it's
  // already frontmost) opens a second picker.
  lastScreenId: string | null;
  activeCamera: boolean;
  activeScreen: boolean;
  activeAudio: boolean;
  busy: StreamKind | null;
  error: string;
};

// Internal state shape. Screen is a list because the user can launch
// multiple concurrent getDisplayMedia captures (double-clicking the
// Screen icon while already sharing brings up a second picker). Camera
// and audio remain single-slot — multiple cameras don't make sense and
// multiple mics would just mix the same user's voice with itself.
type ActiveState = {
  camera: string | null;
  screen: string[];
  audio: string | null;
};

export type CameraResolution = "auto" | "480p" | "720p" | "1080p";

// localStorage keys for device + resolution preferences. Read at every
// start so the user's last choice carries across reloads, sessions, and
// browsers (a fresh address gets browser defaults).
export const MEDIA_PREF_KEYS = {
  micId: "slop-pref-mic-id",
  cameraId: "slop-pref-camera-id",
  cameraRes: "slop-pref-camera-res",
  // Human-readable device names saved next to the ids. Chrome's per-origin
  // deviceIds rotate (site-data clear, profile change) while labels stay
  // stable, so a label match lets us re-adopt the same physical device —
  // and heal the stored id — instead of silently capturing the OS default
  // (which on a Mac with an iPhone nearby is the Continuity phone mic).
  micLabel: "slop-pref-mic-label",
  cameraLabel: "slop-pref-camera-label",
  // RNNoise denoise: ON unless explicitly opted out. The pref is stored
  // as "0" when off, anything else (incl. missing) is on — matches the
  // "default-on" UX the share dialogs render.
  denoise: "slop-pref-denoise",
} as const;

const readPref = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writePref = (key: string, value: string) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — pref just won't stick */
  }
};

// Default ON — missing key means "user hasn't touched it, leave denoise on".
export const readDenoisePref = (): boolean => readPref(MEDIA_PREF_KEYS.denoise) !== "0";

// Audio constraints with the standard WebRTC DSP pipeline pinned ON.
// Browsers default these to true today but spelling them out is free
// insurance against a future default flip + a clearer signal of intent
// in the diff. `voiceIsolation` is a Chrome-experimental flag — most
// browsers ignore the unknown key, Chrome 124+ uses Google's on-device
// model as an additional layer on top of RNNoise.
const buildAudioConstraints = (micId: string | null): MediaTrackConstraints => {
  return {
    ...(micId ? { deviceId: { exact: micId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    // Cast — voiceIsolation isn't in the standard TS lib yet.
    ...({ voiceIsolation: true } as Record<string, boolean>),
  };
};

// Screen capture, capped at the source. `getDisplayMedia({video:true})`
// hands Chrome the display's NATIVE frame — on a Retina Mac that is a
// 3456x2234 (or larger) surface at up to 60 fps — and a full mesh then
// encodes one copy of it PER PEER. That is the dominant CPU cost on a
// publisher's machine and it starves every other encoder it owns,
// including its own camera. Capping here is worth more than any
// per-sender cap because it applies once, upstream of all N encoders.
//
// 1080p is already above what the broadcast composite draws a screen
// window at, and 15 fps matches SCREEN_BROADCAST_MAX_FRAMERATE in
// usePeerMesh — there is no point capturing frames every sender is
// about to throw away. `max` (not `ideal`) so a display that cannot go
// lower still gets downscaled rather than silently ignoring us.
export const SCREEN_CONSTRAINTS: DisplayMediaStreamOptions = {
  video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 } },
  audio: true,
};

// Capture framerate cap. Plenty of webcams happily hand back 60 fps,
// which doubles the encode cost of every leg in the mesh for frames no
// sender will ever transmit (CAMERA_MAX_FRAMERATE is 30).
const CAMERA_CAPTURE_FRAMERATE = { max: 30 };

export const resolutionConstraints = (res: string | null): MediaTrackConstraints => {
  switch (res) {
    case "1080p":
      return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: CAMERA_CAPTURE_FRAMERATE };
    case "720p":
      return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: CAMERA_CAPTURE_FRAMERATE };
    case "480p":
      return { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: CAMERA_CAPTURE_FRAMERATE };
    default:
      // No explicit preference → capture at 480p so first-time users
      // don't burn capture CPU on a 1080p source the encoder is going
      // to scale down anyway. Anyone can pick higher from VideoShareDialog.
      return { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: CAMERA_CAPTURE_FRAMERATE };
  }
};

// A saved device pref re-anchored against the live device list.
type ResolvedDevice = { id: string | null; label: string | null; lost: boolean };

// Verify a saved deviceId still exists before capture; if it doesn't but a
// device with the saved LABEL does, adopt that one (and heal the stored id).
// `lost: true` means the physical device is really gone — the caller falls
// back to generic capture and must say so out loud, never silently.
// Pre-permission Chrome hides real ids/labels from enumerateDevices, so an
// all-blank list is treated as "can't verify, trust the saved id".
const resolveSavedDevice = async (
  kind: "audioinput" | "videoinput",
  idKey: string,
  labelKey: string,
): Promise<ResolvedDevice> => {
  const savedId = readPref(idKey);
  const savedLabel = readPref(labelKey);
  if (!savedId) return { id: null, label: null, lost: false };
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === kind);
    if (!devices.some(d => d.deviceId)) return { id: savedId, label: savedLabel, lost: false };
    if (devices.some(d => d.deviceId === savedId)) return { id: savedId, label: savedLabel, lost: false };
    const byLabel = savedLabel ? devices.find(d => d.label === savedLabel) : undefined;
    if (byLabel) {
      writePref(idKey, byLabel.deviceId);
      return { id: byLabel.deviceId, label: savedLabel, lost: false };
    }
    return { id: null, label: savedLabel, lost: true };
  } catch {
    return { id: savedId, label: savedLabel, lost: false };
  }
};

// Single visible surface for every "couldn't honor your saved device"
// case. Deduped by toast id so the resume retry ladder (up to 8 attempts)
// doesn't stack copies.
const warnDeviceFallback = (msg: string) => {
  toast(msg, {
    id: "media-device-fallback",
    duration: 8000,
    position: "top-center",
    icon: "🎤",
    style: {
      background: "var(--slop-bg-panel, #1a0d2e)",
      border: "1px solid var(--slop-magenta, #ff3ec9)",
      color: "var(--slop-text, #fff)",
      fontFamily: "var(--slop-font-display)",
      fontSize: 12,
      letterSpacing: "0.04em",
      maxWidth: 380,
    },
  });
};

const warnLostDevices = (lost: { camera?: ResolvedDevice; mic?: ResolvedDevice }) => {
  const parts: string[] = [];
  if (lost.camera?.lost) parts.push(lost.camera.label ? `camera "${lost.camera.label}"` : "saved camera");
  if (lost.mic?.lost) parts.push(lost.mic.label ? `mic "${lost.mic.label}"` : "saved mic");
  if (!parts.length) return;
  warnDeviceFallback(
    `your ${parts.join(" and ")} wasn't found — using the system default. re-pick it in the Share dialog.`,
  );
};

// Backfill saved labels from a live capture: prefs written before labels
// existed (or by older builds) get their label stored on the next
// successful pinned acquire, so heal-by-label works without the user ever
// re-visiting a Share dialog.
const backfillDeviceLabels = (stream: MediaStream) => {
  const a = stream.getAudioTracks()[0];
  if (a?.label && a.getSettings().deviceId === readPref(MEDIA_PREF_KEYS.micId)) {
    writePref(MEDIA_PREF_KEYS.micLabel, a.label);
  }
  const v = stream.getVideoTracks()[0];
  if (v?.label && v.getSettings().deviceId === readPref(MEDIA_PREF_KEYS.cameraId)) {
    writePref(MEDIA_PREF_KEYS.cameraLabel, v.label);
  }
};

type DroppedPin = "camera" | "mic" | "camera + mic";

const warnDroppedPin = (dropped: DroppedPin) =>
  warnDeviceFallback(
    `your saved ${dropped} couldn't be opened — using the system default. re-pick it in the Share dialog.`,
  );

const isMissingDeviceError = (err: unknown): boolean => {
  const name = (err as { name?: string })?.name ?? "";
  return name === "OverconstrainedError" || name === "NotFoundError";
};

const hasPin = (c: MediaStreamConstraints["audio"]): boolean => !!c && typeof c === "object" && "deviceId" in c;

// Strip only the deviceId pin; keeps resolution / DSP flags intact.
const stripPin = (c: MediaStreamConstraints["audio"]): MediaStreamConstraints["audio"] => {
  if (!c || typeof c !== "object") return c;
  const rest = { ...(c as MediaTrackConstraints) };
  delete (rest as Record<string, unknown>).deviceId;
  return Object.keys(rest).length ? rest : true;
};

// getUserMedia with staged retry: the strict saved-device constraint goes
// first; when a pinned device is gone (unplugged, id rotated) the browser
// throws OverconstrainedError/NotFoundError and retries drop the pins ONE
// KIND AT A TIME. A stale camera id must never cost the user their chosen
// mic — the old strip-everything fallback is exactly how the OS-default
// "iPhone Microphone" (Continuity) snuck into broadcasts. Every dropped
// pin is reported via onFallback so the swap is visible, never silent.
const tryGetUserMedia = async (
  constraints: MediaStreamConstraints,
  onFallback: (dropped: DroppedPin) => void = warnDroppedPin,
): Promise<MediaStream> => {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (!isMissingDeviceError(err)) throw err;
    const audioPinned = hasPin(constraints.audio);
    const videoPinned = hasPin(constraints.video);
    // No pins to blame — the failure is about the device kind itself
    // (e.g. no camera at all); retrying the same constraints is pointless.
    if (!audioPinned && !videoPinned) throw err;
    const stages: { c: MediaStreamConstraints; dropped: DroppedPin }[] = [];
    if (audioPinned && videoPinned) {
      stages.push({ c: { audio: constraints.audio, video: stripPin(constraints.video) }, dropped: "camera" });
      stages.push({ c: { audio: stripPin(constraints.audio), video: constraints.video }, dropped: "mic" });
    }
    stages.push({
      c: { audio: stripPin(constraints.audio), video: stripPin(constraints.video) },
      dropped: audioPinned && videoPinned ? "camera + mic" : videoPinned ? "camera" : "mic",
    });
    let lastErr: unknown = err;
    for (const stage of stages) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(stage.c);
        onFallback(stage.dropped);
        return stream;
      } catch (stageErr) {
        if (!isMissingDeviceError(stageErr)) throw stageErr;
        lastErr = stageErr;
      }
    }
    throw lastErr;
  }
};

/**
 * Wrap getUserMedia / getDisplayMedia so the menubar's Share dropdown can
 * trigger camera + screen + audio capture without owning the React state.
 */
export function useLocalMedia(
  addStream: (h: LocalStreamHandle) => void,
  stopStream: (id: string) => void,
): UseLocalMedia {
  const [activeIds, setActiveIds] = useState<ActiveState>({
    camera: null,
    screen: [],
    audio: null,
  });
  const [busy, setBusy] = useState<StreamKind | null>(null);
  const [error, setError] = useState<string>("");
  // In-flight guard for single-slot kinds (camera/audio). `activeIds`
  // only flips AFTER getUserMedia resolves + publishes, so two acquire
  // calls racing during the async window (e.g. the immediate pre-gesture
  // resume attempt overlapping the gesture-gated retry, or a manual
  // Resume click landing mid-retry) would BOTH grab a stream and publish
  // a duplicate window — exactly the bug that got the old Resume button
  // pulled (63efeff). This ref flips synchronously at acquire start so
  // the second caller no-ops. Not in any dep array — a ref, read live.
  const inFlightRef = useRef<{ camera: boolean; audio: boolean }>({ camera: false, audio: false });

  const acquire = useCallback(
    async (kind: StreamKind, getStream: () => Promise<MediaStream>) => {
      // Camera/audio are single-slot: bail if one is already running OR
      // mid-acquisition. Screen is multi-slot — every call opens a fresh
      // picker. Already active counts as success for the caller's retry
      // bookkeeping.
      if (kind !== "screen" && (activeIds[kind] || inFlightRef.current[kind])) return true;
      if (kind !== "screen") inFlightRef.current[kind] = true;
      setError("");
      setBusy(kind);
      try {
        const raw = await getStream();
        if (kind === "camera" || kind === "audio") backfillDeviceLabels(raw);
        // Conditionally wrap mic-bearing kinds (camera + audio, NOT
        // screen — screen audio is system audio, not voice, and RNNoise
        // would mangle music/game audio). Falls back to the raw stream
        // if the worklet pipeline can't initialize.
        let stream = raw;
        let dispose: (() => void) | undefined;
        if ((kind === "camera" || kind === "audio") && readDenoisePref()) {
          const denoised = await denoiseStream(raw);
          if (denoised) {
            stream = denoised.stream;
            dispose = denoised.dispose;
          }
        }
        const handle: LocalStreamHandle = { id: stream.id, kind, stream, dispose };
        setActiveIds(s =>
          kind === "screen" ? { ...s, screen: [...s.screen, handle.id] } : { ...s, [kind]: handle.id },
        );
        addStream(handle);
        // If the user kills the stream from the browser UI (e.g. closes the
        // screen-share picker, revokes mic), drop the publication.
        // Listen on BOTH the cleaned stream (video pass-through, synthetic
        // audio) AND the raw stream's audio tracks — with denoise on, a
        // mic revoke ends the raw audio track but not the synthetic one
        // until the denoise pipeline tears it down internally.
        const watchedTracks = new Set<MediaStreamTrack>(stream.getTracks());
        if (stream !== raw) {
          for (const t of raw.getAudioTracks()) watchedTracks.add(t);
        }
        watchedTracks.forEach(t =>
          t.addEventListener("ended", () => {
            // "All ended" means the publication is fully dead. We check
            // the cleaned stream + the raw audio tracks together — if
            // any of them is still live, the pub can keep going (e.g.
            // mic revoked but camera still streaming).
            const cleanedDone = stream.getTracks().every(x => x.readyState === "ended");
            const rawAudioDone = stream === raw || raw.getAudioTracks().every(x => x.readyState === "ended");
            if (cleanedDone && rawAudioDone) {
              setActiveIds(s =>
                kind === "screen" ? { ...s, screen: s.screen.filter(x => x !== handle.id) } : { ...s, [kind]: null },
              );
              stopStream(handle.id);
            }
          }),
        );
        return true;
      } catch (e) {
        setError(`${kind}: ${(e as Error).message}`);
        return false;
      } finally {
        setBusy(null);
        if (kind !== "screen") inFlightRef.current[kind] = false;
      }
    },
    [activeIds, addStream, stopStream],
  );

  const startCamera = useCallback(
    () =>
      acquire("camera", async () => {
        const res = readPref(MEDIA_PREF_KEYS.cameraRes);
        // Re-anchor the saved ids against the live device list first —
        // a rotated id gets healed by label match here, so the strict
        // gUM below almost never has to fall back.
        const [cam, mic] = await Promise.all([
          resolveSavedDevice("videoinput", MEDIA_PREF_KEYS.cameraId, MEDIA_PREF_KEYS.cameraLabel),
          resolveSavedDevice("audioinput", MEDIA_PREF_KEYS.micId, MEDIA_PREF_KEYS.micLabel),
        ]);
        warnLostDevices({ camera: cam, mic });
        const video: MediaTrackConstraints = {
          ...resolutionConstraints(res),
          ...(cam.id ? { deviceId: { exact: cam.id } } : {}),
        };
        // Camera bundles audio so peers hear the speaker through the same
        // window they see them in (no separate audio publication needed).
        // Share → Audio kicks off a standalone audio-only pub for the
        // avatar / no-camera flow.
        return tryGetUserMedia({ video, audio: buildAudioConstraints(mic.id) });
      }),
    [acquire],
  );
  const startScreen = useCallback(
    () => acquire("screen", () => navigator.mediaDevices.getDisplayMedia(SCREEN_CONSTRAINTS)),
    [acquire],
  );
  const startAudio = useCallback(
    () =>
      acquire("audio", async () => {
        const mic = await resolveSavedDevice("audioinput", MEDIA_PREF_KEYS.micId, MEDIA_PREF_KEYS.micLabel);
        warnLostDevices({ mic });
        return tryGetUserMedia({ video: false, audio: buildAudioConstraints(mic.id) });
      }),
    [acquire],
  );

  const stop = useCallback(
    (kind: StreamKind) => {
      if (kind === "screen") {
        const ids = activeIds.screen;
        if (ids.length === 0) return;
        setActiveIds(s => ({ ...s, screen: [] }));
        for (const id of ids) stopStream(id);
        return;
      }
      const id = activeIds[kind];
      if (!id) return;
      setActiveIds(s => ({ ...s, [kind]: null }));
      stopStream(id);
    },
    [activeIds, stopStream],
  );

  // Stop one specific stream by id. Used by closeWindow for screens
  // (so closing one screen window doesn't kill the user's other screens).
  const stopById = useCallback(
    (id: string) => {
      if (activeIds.screen.includes(id)) {
        setActiveIds(s => ({ ...s, screen: s.screen.filter(x => x !== id) }));
        stopStream(id);
        return;
      }
      if (activeIds.camera === id) {
        setActiveIds(s => ({ ...s, camera: null }));
        stopStream(id);
        return;
      }
      if (activeIds.audio === id) {
        setActiveIds(s => ({ ...s, audio: null }));
        stopStream(id);
      }
    },
    [activeIds, stopStream],
  );

  const hasScreen = useCallback((id: string) => activeIds.screen.includes(id), [activeIds.screen]);

  return {
    startCamera,
    startScreen,
    startAudio,
    stop,
    stopById,
    hasScreen,
    // Insertion-ordered, so the last element is the most recent share.
    lastScreenId: activeIds.screen.length > 0 ? activeIds.screen[activeIds.screen.length - 1] : null,
    activeCamera: !!activeIds.camera,
    activeScreen: activeIds.screen.length > 0,
    activeAudio: !!activeIds.audio,
    busy,
    error,
  };
}

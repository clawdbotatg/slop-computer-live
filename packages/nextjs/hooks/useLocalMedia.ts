"use client";

import { useCallback, useState } from "react";
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

export const resolutionConstraints = (res: string | null): MediaTrackConstraints => {
  switch (res) {
    case "1080p":
      return { width: { ideal: 1920 }, height: { ideal: 1080 } };
    case "720p":
      return { width: { ideal: 1280 }, height: { ideal: 720 } };
    case "480p":
      return { width: { ideal: 640 }, height: { ideal: 480 } };
    default:
      // No explicit preference → capture at 480p so first-time users
      // don't burn capture CPU on a 1080p source the encoder is going
      // to scale down anyway. Anyone can pick higher from VideoShareDialog.
      return { width: { ideal: 854 }, height: { ideal: 480 } };
  }
};

// getUserMedia with retry: try the strict preferred-device constraint
// first; if the device is gone (unplugged, switched profile) browser
// throws OverconstrainedError — drop the deviceId and retry generic.
const tryGetUserMedia = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
    // Strip deviceId and retry. Keeps resolution / boolean flags.
    const fallback: MediaStreamConstraints = {};
    if (constraints.audio && typeof constraints.audio === "object") {
      const a = { ...(constraints.audio as MediaTrackConstraints) };
      delete (a as Record<string, unknown>).deviceId;
      fallback.audio = Object.keys(a).length ? a : true;
    } else if (constraints.audio) {
      fallback.audio = constraints.audio;
    }
    if (constraints.video && typeof constraints.video === "object") {
      const v = { ...(constraints.video as MediaTrackConstraints) };
      delete (v as Record<string, unknown>).deviceId;
      fallback.video = Object.keys(v).length ? v : true;
    } else if (constraints.video) {
      fallback.video = constraints.video;
    }
    return await navigator.mediaDevices.getUserMedia(fallback);
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

  const acquire = useCallback(
    async (kind: StreamKind, getStream: () => Promise<MediaStream>) => {
      // Camera/audio are single-slot: bail if one is already running.
      // Screen is multi-slot — every call opens a fresh picker. Already
      // active counts as success for the caller's retry bookkeeping.
      if (kind !== "screen" && activeIds[kind]) return true;
      setError("");
      setBusy(kind);
      try {
        const raw = await getStream();
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
      }
    },
    [activeIds, addStream, stopStream],
  );

  const startCamera = useCallback(
    () =>
      acquire("camera", () => {
        const cameraId = readPref(MEDIA_PREF_KEYS.cameraId);
        const res = readPref(MEDIA_PREF_KEYS.cameraRes);
        const micId = readPref(MEDIA_PREF_KEYS.micId);
        const video: MediaTrackConstraints = {
          ...resolutionConstraints(res),
          ...(cameraId ? { deviceId: { exact: cameraId } } : {}),
        };
        // Camera bundles audio so peers hear the speaker through the same
        // window they see them in (no separate audio publication needed).
        // Share → Audio kicks off a standalone audio-only pub for the
        // avatar / no-camera flow.
        return tryGetUserMedia({ video, audio: buildAudioConstraints(micId) });
      }),
    [acquire],
  );
  const startScreen = useCallback(
    () => acquire("screen", () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })),
    [acquire],
  );
  const startAudio = useCallback(
    () =>
      acquire("audio", () => {
        const micId = readPref(MEDIA_PREF_KEYS.micId);
        return tryGetUserMedia({ video: false, audio: buildAudioConstraints(micId) });
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

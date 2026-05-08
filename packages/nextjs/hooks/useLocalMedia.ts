"use client";

import { useCallback, useState } from "react";
import type { LocalStreamHandle, StreamKind } from "~~/components/desktop/MyCamera";

export type UseLocalMedia = {
  startCamera: () => Promise<void>;
  startScreen: () => Promise<void>;
  startAudio: () => Promise<void>;
  stop: (kind: StreamKind) => void;
  activeCamera: boolean;
  activeScreen: boolean;
  activeAudio: boolean;
  busy: StreamKind | null;
  error: string;
};

export type CameraResolution = "auto" | "480p" | "720p" | "1080p";

// localStorage keys for device + resolution preferences. Read at every
// start so the user's last choice carries across reloads, sessions, and
// browsers (a fresh address gets browser defaults).
export const MEDIA_PREF_KEYS = {
  micId: "slop-pref-mic-id",
  cameraId: "slop-pref-camera-id",
  cameraRes: "slop-pref-camera-res",
} as const;

const readPref = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
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
      return {};
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
  const [activeIds, setActiveIds] = useState<Record<StreamKind, string | null>>({
    camera: null,
    screen: null,
    audio: null,
  });
  const [busy, setBusy] = useState<StreamKind | null>(null);
  const [error, setError] = useState<string>("");

  const acquire = useCallback(
    async (kind: StreamKind, getStream: () => Promise<MediaStream>) => {
      if (activeIds[kind]) return;
      setError("");
      setBusy(kind);
      try {
        const stream = await getStream();
        const handle: LocalStreamHandle = { id: stream.id, kind, stream };
        setActiveIds(s => ({ ...s, [kind]: handle.id }));
        addStream(handle);
        // If the user kills the stream from the browser UI (e.g. closes the
        // screen-share picker, revokes mic), drop the publication.
        const tracks = stream.getTracks();
        tracks.forEach(t =>
          t.addEventListener("ended", () => {
            // Only stop if all tracks are ended (mic+cam can end independently).
            if (stream.getTracks().every(x => x.readyState === "ended")) {
              setActiveIds(s => ({ ...s, [kind]: null }));
              stopStream(handle.id);
            }
          }),
        );
      } catch (e) {
        setError(`${kind}: ${(e as Error).message}`);
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
        const audio: MediaTrackConstraints | true = micId ? { deviceId: { exact: micId } } : true;
        // Camera bundles audio so peers hear the speaker through the same
        // window they see them in (no separate audio publication needed).
        // Share → Audio kicks off a standalone audio-only pub for the
        // avatar / no-camera flow.
        return tryGetUserMedia({ video, audio });
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
        const audio: MediaTrackConstraints | true = micId ? { deviceId: { exact: micId } } : true;
        return tryGetUserMedia({ video: false, audio });
      }),
    [acquire],
  );

  const stop = useCallback(
    (kind: StreamKind) => {
      const id = activeIds[kind];
      if (!id) return;
      setActiveIds(s => ({ ...s, [kind]: null }));
      stopStream(id);
    },
    [activeIds, stopStream],
  );

  return {
    startCamera,
    startScreen,
    startAudio,
    stop,
    activeCamera: !!activeIds.camera,
    activeScreen: !!activeIds.screen,
    activeAudio: !!activeIds.audio,
    busy,
    error,
  };
}

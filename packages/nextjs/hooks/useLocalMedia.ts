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
    () => acquire("camera", () => navigator.mediaDevices.getUserMedia({ video: true, audio: true })),
    [acquire],
  );
  const startScreen = useCallback(
    () => acquire("screen", () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })),
    [acquire],
  );
  const startAudio = useCallback(
    () => acquire("audio", () => navigator.mediaDevices.getUserMedia({ video: false, audio: true })),
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

"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "~~/components/ui";

type Kind = "cam" | "screen";

export type LocalStreamHandle = {
  id: string;
  kind: Kind;
  stream: MediaStream;
};

type Props = {
  onStream: (handle: LocalStreamHandle) => void;
  onStop: (id: string) => void;
};

export const MyCameraControls = ({ onStream, onStop }: Props) => {
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<Kind | null>(null);
  const [activeIds, setActiveIds] = useState<Record<Kind, string | null>>({ cam: null, screen: null });

  const startCam = async () => {
    setError("");
    setBusy("cam");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const handle: LocalStreamHandle = { id: stream.id, kind: "cam", stream };
      setActiveIds(s => ({ ...s, cam: handle.id }));
      onStream(handle);
    } catch (e) {
      setError(`camera: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const startScreen = async () => {
    setError("");
    setBusy("screen");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const handle: LocalStreamHandle = { id: stream.id, kind: "screen", stream };
      setActiveIds(s => ({ ...s, screen: handle.id }));
      onStream(handle);
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setActiveIds(s => ({ ...s, screen: null }));
        onStop(handle.id);
      });
    } catch (e) {
      setError(`screen: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ margin: 0, color: "var(--slop-text-muted)", fontSize: 12 }}>
        Publish your camera, microphone, or screen. Each becomes a shared window everyone on the desktop can see.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button onClick={startCam} disabled={busy !== null || activeIds.cam !== null} variant="primary">
          {activeIds.cam ? "Camera live" : "Start camera"}
        </Button>
        <Button onClick={startScreen} disabled={busy !== null || activeIds.screen !== null}>
          {activeIds.screen ? "Screen live" : "Start screen share"}
        </Button>
      </div>
      {error ? <p style={{ margin: 0, color: "#ff7b9c", fontSize: 12 }}>{error}</p> : null}
    </div>
  );
};

type StreamProps = {
  stream: MediaStream;
  muted?: boolean;
  onStop: () => void;
};

export const StreamView = ({ stream, muted = true, onStop }: StreamProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <video
        ref={videoRef}
        autoPlay
        muted={muted}
        playsInline
        style={{ flex: 1, minHeight: 0, width: "100%", background: "#000", objectFit: "cover" }}
      />
      <div style={{ padding: 6, display: "flex", justifyContent: "flex-end", background: "var(--slop-panel)" }}>
        <Button onClick={onStop}>Stop</Button>
      </div>
    </div>
  );
};

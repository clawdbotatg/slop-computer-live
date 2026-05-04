"use client";

import { useEffect, useRef } from "react";
import { Button } from "~~/components/ui";

export type StreamKind = "camera" | "screen" | "audio";

export type LocalStreamHandle = {
  id: string;
  kind: StreamKind;
  stream: MediaStream;
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

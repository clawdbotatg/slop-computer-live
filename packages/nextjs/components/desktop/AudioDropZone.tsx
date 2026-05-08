"use client";

import { useState } from "react";
import type { ReactNode } from "react";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

const MAX_DIM = 512;
const JPEG_QUALITY = 0.85;

// Downscale a user-supplied image to a square-ish 512px-max JPEG, then
// upload to the relay. The relay overwrites the previous file for this
// user (filename keyed by lowercased address / slugified handle) so a
// re-upload doesn't grow the disk and a user can iterate freely.
async function downscaleToJpeg(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("invalid image"));
      i.src = url;
    });
    const ratio = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * ratio));
    const h = Math.max(1, Math.round(img.naturalHeight * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas-2d unavailable");
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("jpeg encode failed"))), "image/jpeg", JPEG_QUALITY),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadAvatar(file: File): Promise<{ url: string; key: string }> {
  if (!file.type.startsWith("image/")) throw new Error("not-an-image");
  const blob = await downscaleToJpeg(file);
  const res = await fetch(`${RELAY_HTTP}/v1/avatars`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "image/jpeg" },
    body: blob,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { url: string; key: string };
}

export type AudioDropZoneProps = {
  isMine: boolean;
  onFile: (file: File) => void;
  children: ReactNode;
};

// Drop target that wraps the AudioVisualizer for self-publications. Other
// peers' audio windows still render the visualizer (passed in as children)
// but don't accept drops — only the publisher controls their avatar.
export const AudioDropZone = ({ isMine, onFile, children }: AudioDropZoneProps) => {
  const [hover, setHover] = useState(false);

  if (!isMine) {
    return <>{children}</>;
  }

  const handleEnter = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      setHover(true);
    }
  };
  const handleOver = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const handleLeave = (e: React.DragEvent) => {
    // dragleave also fires when entering a child element. Use
    // relatedTarget — the next element under the pointer — to
    // distinguish "left the wrapper" from "moved onto a child".
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setHover(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setHover(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  };

  return (
    <div
      onDragEnter={handleEnter}
      onDragOver={handleOver}
      onDragLeave={handleLeave}
      onDrop={handleDrop}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      {children}
      {hover ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(255,62,201,0.18)",
            border: "2px dashed var(--slop-magenta, #ff3ec9)",
            color: "#fff",
            fontFamily: "var(--slop-font-display)",
            fontSize: 13,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          drop image
        </div>
      ) : null}
    </div>
  );
};

export default AudioDropZone;

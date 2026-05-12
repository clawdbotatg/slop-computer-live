"use client";

import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "~~/hooks/usePeerMesh";

// One file-icon on the desktop. Visually mirrors DesktopIcon (the app
// icon) so the desktop reads as a uniform grid of "things" — apps,
// files, mixed together. Single-click selects, double-click downloads,
// "×" button (visible on hover, only for the uploader or host) deletes.
//
// Drag-to-move is wired identically to DesktopIcon: position lives in
// the shared slot system keyed `file-<id>`, so moving the file is
// visible to every peer and persists across reloads.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

export type DesktopFileProps = {
  file: FileEntry;
  x: number;
  y: number;
  zIndex?: number;
  /** True if the local viewer uploaded this file OR is host. The relay
   *  enforces this server-side too, but we hide the × button when the
   *  caller can't delete anyway. */
  canDelete: boolean;
  onMove: (pos: { x: number; y: number }) => void;
  onDelete: () => void;
};

const ICON_SIZE = 88;
const TEXT_LINES = 22; // ~2 lines for filename label

// Pick an emoji-style icon glyph based on mime/extension. Good enough
// for the v1 desktop look without shipping a sprite sheet.
function glyphFor(file: FileEntry): string {
  const mime = (file.mime ?? "").toLowerCase();
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "🖼";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf" || ext === "pdf") return "📕";
  if (["zip", "tar", "gz", "rar", "7z"].includes(ext)) return "🗜";
  if (["txt", "md", "rtf"].includes(ext)) return "📄";
  if (["json", "yaml", "yml", "toml", "xml"].includes(ext)) return "📋";
  if (["js", "ts", "tsx", "jsx", "py", "rs", "go", "sh", "html", "css"].includes(ext)) return "📜";
  return "📁";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const DesktopFile = ({ file, x, y, zIndex = 1, canDelete, onMove, onDelete }: DesktopFileProps) => {
  const [hover, setHover] = useState(false);
  const [imgPreview, setImgPreview] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const movedRef = useRef(false);

  // Render an inline thumbnail when the file is a small image.
  useEffect(() => {
    setImgPreview(file.mime.startsWith("image/") && file.size < 2_500_000);
  }, [file.mime, file.size]);

  const downloadUrl = `${RELAY_HTTP}/files/${file.id}`;

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, x, y };
    movedRef.current = false;
  };
  const onDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (!movedRef.current && Math.hypot(dx, dy) < 4) return;
    movedRef.current = true;
    onMove({ x: dragRef.current.x + dx, y: dragRef.current.y + dy });
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    dragRef.current = null;
  };

  return (
    <div
      onPointerDown={startDrag}
      onPointerMove={onDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => {
        if (!movedRef.current) window.open(downloadUrl, "_blank", "noopener");
      }}
      data-grab="true"
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: ICON_SIZE,
        zIndex,
        userSelect: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        cursor: "grab",
      }}
    >
      <div
        style={{
          width: ICON_SIZE - 16,
          height: ICON_SIZE - 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: hover ? "rgba(255,62,201,0.18)" : "rgba(255,255,255,0.04)",
          border: hover ? "1px solid var(--slop-magenta, #ff3ec9)" : "1px solid var(--slop-border, #2a1d4a)",
          borderRadius: 6,
          fontSize: imgPreview ? 0 : 38,
          lineHeight: 1,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {imgPreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={downloadUrl}
            alt={file.name}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={() => setImgPreview(false)}
            draggable={false}
          />
        ) : (
          glyphFor(file)
        )}
        {canDelete && hover ? (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              if (window.confirm(`Delete "${file.name}"?`)) onDelete();
            }}
            aria-label="delete file"
            style={{
              position: "absolute",
              top: -6,
              right: -6,
              width: 18,
              height: 18,
              fontSize: 11,
              lineHeight: 1,
              background: "var(--slop-magenta, #ff3ec9)",
              color: "#06030d",
              border: "none",
              borderRadius: "50%",
              cursor: "pointer",
              fontWeight: 800,
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      <div
        title={`${file.name} — ${formatBytes(file.size)} (${file.uploaderLabel})`}
        style={{
          width: ICON_SIZE,
          height: TEXT_LINES,
          fontSize: 10,
          lineHeight: "11px",
          textAlign: "center",
          color: "var(--slop-text)",
          fontFamily: "var(--slop-font-body)",
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          wordBreak: "break-word",
          textShadow: "0 1px 1px rgba(0,0,0,0.6)",
        }}
      >
        {file.name}
      </div>
    </div>
  );
};

export default DesktopFile;

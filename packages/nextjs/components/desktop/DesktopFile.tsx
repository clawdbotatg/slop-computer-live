"use client";

import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";

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
  /** Double-click handler — opens the preview window. */
  onPreview: () => void;
  /** Fires once on pointerup with the final position AND the position
   *  the drag started from, if the user actually moved the icon. Lets
   *  the parent intercept drops onto the trash can — and, when the
   *  dragger lacks delete permission, snap the icon back to startX/Y
   *  instead of leaving it parked on top of the trash. */
  onDragEnd?: (pos: { x: number; y: number; startX: number; startY: number }) => void;
  /** Predicate the icon polls during drag to know whether its current
   *  position overlaps the trash. When true, the icon visibly shrinks
   *  + fades to telegraph the impending delete. The icon's z is also
   *  bumped above the trash during ANY drag (not just over trash) so
   *  the file always appears on top of the can. */
  isOverTrash?: (x: number, y: number) => boolean;
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

export const DesktopFile = ({
  file,
  x,
  y,
  zIndex = 1,
  canDelete,
  onMove,
  onDelete,
  onPreview,
  onDragEnd,
  isOverTrash,
}: DesktopFileProps) => {
  const slug = useRoomSlug();
  const [hover, setHover] = useState(false);
  const [imgPreview, setImgPreview] = useState(false);
  // While the user is actively dragging this icon, lift it above the
  // trash (which lives at z=50). Without this the dragged file slips
  // BEHIND the trash on hover and the user can't see what they're
  // about to delete.
  const [isDragging, setIsDragging] = useState(false);
  const [overTrash, setOverTrash] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const movedRef = useRef(false);

  // Render an inline thumbnail when the file is a small image.
  useEffect(() => {
    setImgPreview(file.mime.startsWith("image/") && file.size < 2_500_000);
  }, [file.mime, file.size]);

  const downloadUrl = withSlug(`${RELAY_HTTP}/files/${file.id}`, slug);

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
    if (!isDragging) setIsDragging(true);
    const nextX = dragRef.current.x + dx;
    const nextY = dragRef.current.y + dy;
    onMove({ x: nextX, y: nextY });
    // Poll trash-overlap each move so the shrink-fade kicks in
    // exactly while the cursor lingers over the can. Cheap (one
    // getBoundingClientRect read inside the predicate).
    if (isOverTrash) {
      const over = isOverTrash(nextX, nextY);
      if (over !== overTrash) setOverTrash(over);
    }
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    // If the user actually moved (movedRef), fire onDragEnd with the
    // final position AND the start position. Parent uses this to
    // detect "dropped on trash" — onMove fires continuously during
    // drag so it can't be the trash-check trigger by itself. startX/Y
    // let the parent revert the slot to the pre-drag position when a
    // non-allowed dragger drops on the trash (slot would otherwise be
    // parked on top of the can after onMove's running updates).
    if (movedRef.current && onDragEnd) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      onDragEnd({
        x: dragRef.current.x + dx,
        y: dragRef.current.y + dy,
        startX: dragRef.current.x,
        startY: dragRef.current.y,
      });
    }
    dragRef.current = null;
    setIsDragging(false);
    setOverTrash(false);
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
        if (!movedRef.current) onPreview();
      }}
      data-grab="true"
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: ICON_SIZE,
        // While dragging, slot a high z so the icon paints above
        // every other desktop element (including the trash at z=50).
        // When the cursor enters the trash zone, the visual cue
        // depends on whether the dragger is allowed to delete:
        //   - allowed (owner / host / godMode): shrink + fade to
        //     telegraph the impending delete on release.
        //   - not allowed: keep full size but apply a red glow +
        //     no-drop cursor so the user can read "this isn't going
        //     to delete" before they release. Parent snaps the icon
        //     back on drop in that case.
        zIndex: isDragging ? 1000 : zIndex,
        userSelect: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        cursor: overTrash && !canDelete ? "not-allowed" : "grab",
        transform: overTrash && canDelete ? "scale(0.6)" : "scale(1)",
        transformOrigin: "center",
        opacity: overTrash && canDelete ? 0.5 : 1,
        filter: overTrash && !canDelete ? "drop-shadow(0 0 10px #ff3b6b) drop-shadow(0 0 4px #ff3b6b)" : undefined,
        transition: "transform 0.12s ease-out, opacity 0.12s ease-out, filter 0.12s ease-out",
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

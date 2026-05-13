"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

// Per-user QR generator. State is local: the window shell (open/close, drag,
// position) flows through SharedAppWindow like every other app, but the text
// input and optional center logo are private to each peer.
//
// On first open the input defaults to window.location.href so the QR is
// immediately scannable — point a phone at the screen and you're back on the
// same desktop.

const LOGO_MAX_DIM = 256;
const LOGO_JPEG_QUALITY = 0.9;

async function downscaleImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("invalid image"));
      i.src = url;
    });
    const ratio = Math.min(1, LOGO_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * ratio));
    const h = Math.max(1, Math.round(img.naturalHeight * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas-2d unavailable");
    ctx.drawImage(img, 0, 0, w, h);
    // PNG keeps transparency for logos with rounded corners; falls back to
    // JPEG-quality data URL when the image is opaque enough that PNG is just
    // wasted bytes — but in practice the data URL is only used as a render
    // source, so PNG is fine either way.
    return canvas.toDataURL("image/png", LOGO_JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const QrCodeWindow = () => {
  const [text, setText] = useState("");
  const [logo, setLogo] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Default to the current URL on first mount. Effect (not initial state)
  // because `window` isn't available during SSR.
  useEffect(() => {
    if (typeof window !== "undefined") {
      setText(window.location.href);
    }
  }, []);

  const handleFile = async (file: File | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const dataUrl = await downscaleImage(file);
      setLogo(dataUrl);
    } catch (err) {
      console.warn("QR logo decode failed", err);
    }
  };

  // stopPropagation on every drag event that handles a Files payload —
  // otherwise the event bubbles up to the desktop's drop-to-upload
  // handler in page.tsx and the file gets BOTH consumed by QR and
  // uploaded as a desktop file icon. stopPropagation on dragenter/over
  // suppresses the desktop's "drop to share" overlay too.
  const onDragEnter = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      setHover(true);
    }
  };
  const onDragOver = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDragLeave = (e: React.DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setHover(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHover(false);
    void handleFile(e.dataTransfer.files?.[0]);
  };

  // qrcode.react treats empty string as a valid (but ugly) value. Render a
  // single space when the input is empty so the canvas stays well-formed
  // and the user gets a visual hint that something will appear once they
  // type.
  const value = text.length > 0 ? text : " ";

  // Higher error correction lets us punch a logo hole through the middle
  // without breaking scannability. H = ~30% recovery.
  const imageSettings = logo
    ? {
        src: logo,
        height: 64,
        width: 64,
        excavate: true,
      }
    : undefined;

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        padding: 12,
        gap: 10,
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          borderRadius: 6,
          padding: 12,
        }}
      >
        <QRCodeSVG
          value={value}
          size={256}
          level="H"
          marginSize={1}
          imageSettings={imageSettings}
          style={{ width: "100%", height: "100%", maxWidth: 320, maxHeight: 320 }}
        />
      </div>

      <input
        type="text"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="type anything…"
        spellCheck={false}
        style={{
          padding: "8px 10px",
          fontSize: 13,
          fontFamily: "var(--slop-font-body)",
          background: "#0e0820",
          color: "var(--slop-text)",
          border: "1px solid var(--slop-border, #2a1d4a)",
          borderRadius: 4,
          outline: "none",
        }}
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11 }}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: "6px 10px",
            fontSize: 11,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            background: "transparent",
            color: "var(--slop-text)",
            border: "1px solid var(--slop-border, #2a1d4a)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {logo ? "Replace logo" : "Add logo"}
        </button>
        {logo ? (
          <button
            type="button"
            onClick={() => setLogo(null)}
            style={{
              padding: "6px 10px",
              fontSize: 11,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              background: "transparent",
              color: "var(--slop-text-muted)",
              border: "1px solid var(--slop-border, #2a1d4a)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        ) : null}
        <span style={{ color: "var(--slop-text-muted)", fontStyle: "italic", marginLeft: "auto" }}>
          drop image to center
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={e => {
            void handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

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

export default QrCodeWindow;

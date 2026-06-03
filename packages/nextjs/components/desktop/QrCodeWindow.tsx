"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";

// Multiplayer QR generator. The text input + center logo live on
// mesh.qrState — anyone in the room can edit, and every peer's QR
// re-renders in sync. Text edits are debounced before broadcast so
// keystrokes feel live to the typer but don't spam the relay; logo
// uploads broadcast once on each successful drop / file pick.
//
// On first open the input defaults to the current room's public URL —
// `live.` stripped off the host so a scanned QR lands on
// slop.computer/<slug> (e.g. slop.computer/binji-x), the shorter
// shareable form that redirects into the live desktop. The seed only
// fires when the shared state is still empty, so a re-open never
// overwrites someone else's custom text.

const LOGO_MAX_DIM = 256;
const LOGO_JPEG_QUALITY = 0.9;
// Debounce window for text broadcasts — long enough that a normal
// burst of typing collapses to one POST, short enough that the
// other peers feel the change live within a beat.
const TEXT_BROADCAST_DEBOUNCE_MS = 250;

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

export const QrCodeWindow = ({ mesh }: { mesh: PeerMeshState }) => {
  const sharedText = mesh.qrState.text;
  const sharedLogo = mesh.qrState.logoDataUrl;

  // Local draft of the input value. We type into this, then a
  // debounced effect mirrors changes into the shared state. While
  // the user is mid-burst, sharedText may still hold the old value;
  // we render `text` so the typer sees their own keystrokes live.
  // When the shared state changes from outside (another peer typed),
  // we adopt it as long as we're not currently mid-edit.
  const [text, setText] = useState(sharedText);
  const [hover, setHover] = useState(false);
  // Visible error banner for a failed logo upload. Cleared on the
  // next successful upload, on clear, or on reset. We track this
  // because the underlying fetch can fail (413 oversized payload,
  // network burp) and the user used to see nothing — the QR just
  // didn't update.
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const broadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBroadcastRef = useRef(sharedText);
  // Whether the local input has focus. While focused we ignore
  // foreign updates so the typer's caret position doesn't get
  // yanked around mid-burst.
  const editingRef = useRef(false);

  // The current room's public URL. Stripping `live.` off the host lands
  // a scanned QR on slop.computer/<slug>, the shorter shareable form that
  // redirects into the live desktop. `pathname` carries the room slug, so
  // in room `binji-x` this resolves to https://slop.computer/binji-x.
  // We drop `search`/`hash` deliberately: the room may have been entered
  // via a `?invite=<password>` link, and that must never be baked into a
  // QR that anyone in the audience can scan — keep it the clean public URL.
  const computeRoomUrl = (): string | null => {
    if (typeof window === "undefined") return null;
    const { host, pathname, protocol } = window.location;
    const publicHost = host.replace(/^live\./, "");
    return `${protocol}//${publicHost}${pathname}`;
  };

  // Mirror of `sharedText` for use inside async callbacks: lets the
  // seed effect re-check, after its fetch resolves, whether a peer has
  // already typed something — so we don't clobber their value.
  const latestSharedTextRef = useRef(sharedText);
  useEffect(() => {
    latestSharedTextRef.current = sharedText;
  }, [sharedText]);

  // Seed the QR URL the first time we encounter an empty shared text.
  // Done in an effect (not initial state) because `window` isn't
  // available during SSR. Multiple peers may race to seed — they all
  // compute the same current-room URL, so last-writer-wins is harmless.
  useEffect(() => {
    if (sharedText !== "") return;
    const seed = computeRoomUrl();
    if (!seed) return;
    // A peer may have typed something already; bail rather than
    // overwrite their custom text.
    if (latestSharedTextRef.current !== "") return;
    setText(seed);
    lastBroadcastRef.current = seed;
    void mesh.setQrPatch({ text: seed });
    // Run-once on the first empty-shared snapshot. We don't want to
    // re-seed if the host clears the text intentionally later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Adopt foreign shared-text updates when we're not actively typing.
  useEffect(() => {
    if (editingRef.current) return;
    if (sharedText === text) return;
    setText(sharedText);
    lastBroadcastRef.current = sharedText;
  }, [sharedText, text]);

  // Debounced broadcast of the local draft. Fires when the user
  // pauses typing for TEXT_BROADCAST_DEBOUNCE_MS. Re-armed on every
  // keystroke. Skip if the value matches what we last shipped.
  useEffect(() => {
    if (text === lastBroadcastRef.current) return;
    if (broadcastTimerRef.current != null) clearTimeout(broadcastTimerRef.current);
    broadcastTimerRef.current = setTimeout(() => {
      broadcastTimerRef.current = null;
      lastBroadcastRef.current = text;
      void mesh.setQrPatch({ text });
    }, TEXT_BROADCAST_DEBOUNCE_MS);
    return () => {
      if (broadcastTimerRef.current != null) {
        clearTimeout(broadcastTimerRef.current);
        broadcastTimerRef.current = null;
      }
    };
  }, [text, mesh]);

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setUploadError("drop an image file");
      return;
    }
    setUploadError(null);
    let dataUrl: string;
    try {
      dataUrl = await downscaleImage(file);
    } catch (err) {
      setUploadError(`couldn't decode image: ${(err as Error).message}`);
      return;
    }
    const result = await mesh.setQrPatch({ logoDataUrl: dataUrl });
    if (!result.ok) setUploadError(result.error);
  };

  const clearLogo = () => {
    setUploadError(null);
    void mesh.setQrPatch({ clearLogo: true });
  };

  // Reset the whole QR back to a fresh canonical-URL state — clears
  // the logo and rewrites the text to the current room's public URL
  // (slop.computer/<slug>). Anyone in the room can hit this; everyone's
  // QR snaps back together.
  const resetAll = () => {
    setUploadError(null);
    const seed = computeRoomUrl() ?? "";
    setText(seed);
    lastBroadcastRef.current = seed;
    void mesh.setQrPatch({ text: seed, clearLogo: true });
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
  const imageSettings = sharedLogo
    ? {
        src: sharedLogo,
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
        onFocus={() => {
          editingRef.current = true;
        }}
        onBlur={() => {
          editingRef.current = false;
        }}
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

      {uploadError ? (
        <div
          style={{
            padding: "6px 10px",
            border: "1px solid rgba(255,62,62,0.4)",
            background: "rgba(255,62,62,0.08)",
            borderRadius: 4,
            fontSize: 11,
            color: "#ff9a9a",
          }}
        >
          {uploadError}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, flexWrap: "wrap" }}>
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
          {sharedLogo ? "Replace logo" : "Add logo"}
        </button>
        {sharedLogo ? (
          <button
            type="button"
            onClick={clearLogo}
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
            Clear logo
          </button>
        ) : null}
        <button
          type="button"
          onClick={resetAll}
          title="reset text to the room URL and clear the logo"
          style={{
            padding: "6px 10px",
            fontSize: 11,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            background: "transparent",
            color: "var(--slop-magenta, #ff3ec9)",
            border: "1px solid rgba(255,62,201,0.45)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Reset
        </button>
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

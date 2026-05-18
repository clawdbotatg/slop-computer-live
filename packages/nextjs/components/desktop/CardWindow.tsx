"use client";

import { useEffect, useRef, useState } from "react";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const TEMPLATE_SRC = "/card-template.png";

// Title-card generator. The window's resting state is the
// slop.computer template — drop a guest PFP onto it, the relay calls
// gpt-image-2 to drop the face into the green-screen circle, and we
// swap the result in. DOWNLOAD saves the PNG; RESET goes back to the
// blank template for the next guest.
export const CardWindow = () => {
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  // Cycle through dot-dot-dot while the model is generating so it
  // doesn't feel frozen during the 20–30s call.
  const [dots, setDots] = useState(1);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setDots(d => (d % 3) + 1), 400);
    return () => clearInterval(t);
  }, [loading]);

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      abortRef.current?.abort();
    };
  }, [resultUrl]);

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("drop an image file");
      return;
    }
    setError(null);
    setLoading(true);
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`${RELAY_HTTP}/v1/card`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": file.type },
        body: file,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.detail) detail = String(j.detail);
        } catch {
          /* not json */
        }
        throw new Error(detail);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setResultUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message || "generation failed");
    } finally {
      setLoading(false);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    setHover(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };
  const handleDragLeave = (e: React.DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setHover(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHover(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const reset = () => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    setError(null);
  };

  const download = () => {
    if (!resultUrl) return;
    const a = document.createElement("a");
    a.href = resultUrl;
    a.download = `slop-card-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const imgSrc = resultUrl ?? TEMPLATE_SRC;

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#0b0420",
        overflow: "hidden",
      }}
    >
      <img
        src={imgSrc}
        alt="card"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          opacity: loading ? 0.45 : 1,
          transition: "opacity 120ms ease",
        }}
        draggable={false}
      />

      {!resultUrl && !loading ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            padding: "6px 10px",
            background: "rgba(0,0,0,0.55)",
            border: "1px solid var(--slop-magenta, #ff3ec9)",
            color: "#fff",
            fontFamily: "var(--slop-font-display)",
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            pointerEvents: "none",
          }}
        >
          drop a guest pfp →
        </div>
      ) : null}

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
            fontSize: 18,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          drop pfp
        </div>
      ) : null}

      {loading ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontFamily: "var(--slop-font-display)",
            fontSize: 20,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            textShadow: "0 0 12px rgba(255,62,201,0.7)",
            pointerEvents: "none",
            zIndex: 9,
          }}
        >
          generating{".".repeat(dots)}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          style={{
            position: "absolute",
            left: 12,
            top: 12,
            right: 12,
            padding: "8px 12px",
            background: "rgba(40,0,20,0.85)",
            border: "1px solid #ff3ec9",
            color: "#ff90d6",
            fontFamily: "var(--slop-font-display)",
            fontSize: 12,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            zIndex: 11,
          }}
        >
          {error}
        </div>
      ) : null}

      {resultUrl && !loading ? (
        <div
          style={{
            position: "absolute",
            right: 12,
            bottom: 12,
            display: "flex",
            gap: 8,
            zIndex: 12,
          }}
        >
          <button onClick={reset} style={buttonStyle}>
            reset
          </button>
          <button
            onClick={download}
            style={{ ...buttonStyle, background: "var(--slop-magenta, #ff3ec9)", color: "#0b0420" }}
          >
            download
          </button>
        </div>
      ) : null}
    </div>
  );
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "rgba(0,0,0,0.7)",
  border: "1px solid var(--slop-magenta, #ff3ec9)",
  color: "#fff",
  fontFamily: "var(--slop-font-display)",
  fontSize: 12,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  cursor: "pointer",
};

export default CardWindow;

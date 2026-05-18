"use client";

import { useEffect, useRef, useState } from "react";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const TEMPLATE_SRC = "/card-template.png";
const TITLE_COLOR = "#3fcfff"; // --slop-cyan

// Title-card generator. The window's resting state is the
// slop.computer template — drop a guest PFP onto it, the relay calls
// gpt-image-2 to drop the face into the green-screen circle, and we
// swap the result in. Once we have a result, an editable title overlay
// lets you type a guest name, drag to reposition, and wheel to resize.
// DOWNLOAD bakes the title text into the PNG via canvas before saving.
//
// Position + size are stored as fractions of the IMAGE content rect
// (not the window) so values stay correct across window resizes AND
// during the canvas bake at download time.

type Frac = { x: number; y: number };

export const CardWindow = () => {
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [progress, setProgress] = useState(0);

  // Title overlay state.
  const [titleText, setTitleText] = useState("GUEST NAME");
  const [titlePos, setTitlePos] = useState<Frac>({ x: 0.5, y: 0.93 }); // fraction of image rect
  const [titleSizeFrac, setTitleSizeFrac] = useState(0.055); // font-size as fraction of image width
  const [titleEditing, setTitleEditing] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<null | { startClientX: number; startClientY: number; startPos: Frac; moved: boolean }>(null);

  useEffect(() => {
    if (!loading) {
      setProgress(0);
      return;
    }
    const FAKE_DURATION_MS = 30_000;
    const CAP = 95;
    const start = Date.now();
    let raf = 0;
    const tick = () => {
      const elapsed = Date.now() - start;
      const pct = Math.min(elapsed / FAKE_DURATION_MS, 1) * CAP;
      setProgress(pct);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loading]);

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      abortRef.current?.abort();
    };
  }, [resultUrl]);

  // Compute where inside the wrapper the image is actually drawn
  // (object-fit: contain leaves letterbox bars). Returns null until
  // the image has loaded and the root has measured.
  const getImageRect = (): {
    left: number;
    top: number;
    width: number;
    height: number;
    naturalW: number;
    naturalH: number;
  } | null => {
    const root = rootRef.current;
    const img = imgRef.current;
    if (!root || !img || !img.naturalWidth || !img.naturalHeight) return null;
    const rootRect = root.getBoundingClientRect();
    const natAspect = img.naturalWidth / img.naturalHeight;
    const wrapAspect = rootRect.width / rootRect.height;
    let width: number;
    let height: number;
    let left: number;
    let top: number;
    if (wrapAspect > natAspect) {
      // letterbox on left/right
      height = rootRect.height;
      width = height * natAspect;
      left = (rootRect.width - width) / 2;
      top = 0;
    } else {
      width = rootRect.width;
      height = width / natAspect;
      left = 0;
      top = (rootRect.height - height) / 2;
    }
    return { left, top, width, height, naturalW: img.naturalWidth, naturalH: img.naturalHeight };
  };

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

  // Title drag — pointer-based so it works the same on mouse + touch.
  // Drag threshold: < 4px movement counts as a click (focus to edit),
  // otherwise we move the title.
  const onTitlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (titleEditing) return; // already editing → let normal text interactions happen
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPos: titlePos,
      moved: false,
    };
  };
  const onTitlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const rect = getImageRect();
    if (!rect) return;
    const dx = e.clientX - d.startClientX;
    const dy = e.clientY - d.startClientY;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setTitlePos({
      x: Math.max(0, Math.min(1, d.startPos.x + dx / rect.width)),
      y: Math.max(0, Math.min(1, d.startPos.y + dy / rect.height)),
    });
  };
  const onTitlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    // Treat as click → enter edit mode, focus + place caret at end.
    if (d && !d.moved) {
      setTitleEditing(true);
      // defer so the contentEditable is focusable after re-render
      requestAnimationFrame(() => {
        const el = titleRef.current;
        if (!el) return;
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
    }
  };

  // Wheel over the title resizes it. Cmd/Ctrl-wheel for finer steps.
  const onTitleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const fineStep = e.ctrlKey || e.metaKey;
    const step = fineStep ? 0.002 : 0.005;
    const delta = e.deltaY > 0 ? -step : step;
    setTitleSizeFrac(prev => Math.max(0.015, Math.min(0.25, prev + delta)));
  };

  const onTitleBlur = () => {
    setTitleEditing(false);
    const el = titleRef.current;
    if (el) setTitleText(el.innerText.replace(/\n/g, " ").trim() || " ");
  };
  const onTitleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleRef.current?.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Reset edits + blur.
      if (titleRef.current) titleRef.current.innerText = titleText;
      titleRef.current?.blur();
    }
  };

  const reset = () => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    setError(null);
  };

  // Bake the title text onto the result image at its NATURAL resolution
  // and trigger a PNG download. We use fractions-of-image-rect for
  // position and size so the on-screen layout maps 1:1 onto the
  // natural-size canvas (no display-px math).
  const download = async () => {
    if (!resultUrl) return;
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const loaded = new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("could not load result for bake"));
      });
      img.src = resultUrl;
      await loaded;

      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas-2d unavailable");
      ctx.drawImage(img, 0, 0);

      const text = (titleText || "").trim();
      if (text) {
        const sizePx = titleSizeFrac * img.naturalWidth;
        const x = titlePos.x * img.naturalWidth;
        const y = titlePos.y * img.naturalHeight;
        // Slop's display font (Silkscreen) is loaded via next/font; the
        // canvas can use it if the page already rendered it once. Fall
        // back to a monospace stack otherwise.
        ctx.font = `${sizePx}px var(--slop-font-display), "Silkscreen", "Courier New", monospace`;
        ctx.fillStyle = TITLE_COLOR;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = sizePx * 0.18;
        ctx.fillText(text, x, y);
      }

      const blob = await new Promise<Blob | null>(res => canvas.toBlob(b => res(b), "image/png"));
      if (!blob) throw new Error("canvas encode failed");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `slop-card-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Free the bake URL after the click has fired.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message || "download failed");
    }
  };

  const imgSrc = resultUrl ?? TEMPLATE_SRC;

  // Compute live screen-position for the title overlay based on the
  // current image rect. Falls back to off-screen until we have measured.
  const imgRect = getImageRect();
  const titleStyle: React.CSSProperties = imgRect
    ? {
        position: "absolute",
        left: imgRect.left + titlePos.x * imgRect.width,
        top: imgRect.top + titlePos.y * imgRect.height,
        transform: "translate(-50%, -50%)",
        fontSize: titleSizeFrac * imgRect.width,
        color: TITLE_COLOR,
        fontFamily: "var(--slop-font-display)",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        textShadow: "0 2px 6px rgba(0,0,0,0.7)",
        whiteSpace: "pre",
        userSelect: titleEditing ? "text" : "none",
        cursor: titleEditing ? "text" : "grab",
        padding: "4px 8px",
        outline: titleEditing ? `2px solid ${TITLE_COLOR}` : "1px dashed transparent",
        outlineOffset: 2,
        background: titleEditing ? "rgba(0,0,0,0.35)" : "transparent",
        zIndex: 8,
      }
    : { display: "none" };

  return (
    <div
      ref={rootRef}
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
        ref={imgRef}
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

      {/* Editable title — visible on the template too so you can prep
          the guest's name before dropping. Baked into the PNG only at
          download time. Drag to move, click to edit, wheel to resize. */}
      <div
        ref={titleRef}
        contentEditable={titleEditing}
        suppressContentEditableWarning
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
        onWheel={onTitleWheel}
        onBlur={onTitleBlur}
        onKeyDown={onTitleKeyDown}
        style={titleStyle}
        onMouseEnter={e => {
          if (!titleEditing) (e.currentTarget as HTMLDivElement).style.outline = `1px dashed ${TITLE_COLOR}`;
        }}
        onMouseLeave={e => {
          if (!titleEditing) (e.currentTarget as HTMLDivElement).style.outline = "1px dashed transparent";
        }}
      >
        {titleText}
      </div>

      {!loading ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            pointerEvents: "none",
            zIndex: 7,
          }}
        >
          {!resultUrl ? (
            <div
              style={{
                padding: "6px 10px",
                background: "rgba(0,0,0,0.55)",
                border: "1px solid var(--slop-magenta, #ff3ec9)",
                color: "#fff",
                fontFamily: "var(--slop-font-display)",
                fontSize: 11,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
            >
              drop a guest pfp →
            </div>
          ) : null}
          <div
            style={{
              padding: "6px 10px",
              background: "rgba(0,0,0,0.55)",
              border: "1px solid var(--slop-cyan, #3fcfff)",
              color: "var(--slop-cyan, #3fcfff)",
              fontFamily: "var(--slop-font-display)",
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            click title to edit · drag to move · wheel to resize
          </div>
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
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            color: "#fff",
            fontFamily: "var(--slop-font-display)",
            pointerEvents: "none",
            zIndex: 9,
          }}
        >
          <div
            style={{
              fontSize: 18,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              textShadow: "0 0 12px rgba(255,62,201,0.7)",
            }}
          >
            generating
          </div>
          <div
            style={{
              width: "min(340px, 60%)",
              height: 14,
              background: "rgba(0,0,0,0.65)",
              border: "1px solid var(--slop-magenta, #ff3ec9)",
              boxShadow: "0 0 12px rgba(255,62,201,0.5)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: "var(--slop-magenta, #ff3ec9)",
                boxShadow: "0 0 10px rgba(255,62,201,0.9) inset",
                transition: "width 80ms linear",
              }}
            />
          </div>
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              opacity: 0.7,
            }}
          >
            {Math.round(progress)}%
          </div>
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
            onClick={() => void download()}
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

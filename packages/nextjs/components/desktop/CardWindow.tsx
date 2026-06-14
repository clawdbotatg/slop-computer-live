"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LoadingBar } from "~~/components/ui";
import type { CardTitle, PeerMeshState } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const TEMPLATE_SRC = "/card-template.png";
const TITLE_COLOR = "#3fcfff"; // --slop-cyan

// Title-card generator. Multiplayer: a single shared card per room
// lives on the relay at /v1/cards/<slug>/card.png (under /v1/ so the
// prod Caddyfile's /v1/* proxy rule catches it). Any peer can drop a
// guest PFP, the relay kicks off gpt-image-2 as a background job,
// broadcasts `card_job` so every CardWindow in the room shows the
// shared progress bar — closing the window does NOT cancel — and on
// completion broadcasts `card_state` so everyone flips to the new
// card in lockstep. Reset broadcasts `card_state: null`, returning
// the room to the template.
//
// The title overlay (typed guest name, drag-to-position, wheel-to-
// resize) is ALSO shared — drags broadcast `card_title` at pointer-
// move cadence so every peer sees the move live; text is committed
// on blur. While a peer is actively editing the text via
// contentEditable, incoming text updates are skipped so we don't
// clobber their typing — position + size still update.
//
// Position + size are stored as fractions of the IMAGE content rect
// (not the window) so values stay correct across window resizes AND
// during the canvas bake at download time.

type Frac = { x: number; y: number };

// Default sits up-and-right of bottom-center — the spot hosts kept dragging
// the title to anyway. Fractions of the image content rect.
const DEFAULT_TITLE_POS: Frac = { x: 0.525, y: 0.838 };
const DEFAULT_TITLE_SIZE_FRAC = 0.055;

type Props = {
  mesh: PeerMeshState;
};

export const CardWindow = ({ mesh }: Props) => {
  const slug = useRoomSlug();
  const { cardState, cardJob, cardTitle, setCardTitle, resetCard } = mesh;
  const resultUrl = useMemo(() => {
    if (!cardState) return null;
    return `${RELAY_HTTP}/v1/cards/${encodeURIComponent(slug)}/card.png?v=${cardState.version}`;
  }, [cardState, slug]);
  // Generation is room-wide: any in-flight job (mine or someone else's)
  // shows the shared progress bar. Local upload-in-progress covers the
  // brief window between drop and the server's `card_job` broadcast.
  const [uploading, setUploading] = useState(false);
  const loading = !!cardJob || uploading;
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [progress, setProgress] = useState(0);

  // Resolve the title overlay state with slug-derived defaults when the
  // room has never edited it. Once any peer drags / types, mesh.cardTitle
  // becomes non-null and wins for everyone.
  const slugUpper = slug.toUpperCase();
  const titleText = cardTitle?.text ?? slugUpper;
  const titlePos: Frac = cardTitle ? { x: cardTitle.x, y: cardTitle.y } : DEFAULT_TITLE_POS;
  const titleSizeFrac = cardTitle?.sizeFrac ?? DEFAULT_TITLE_SIZE_FRAC;
  // Editing is purely local UX — entering edit mode reflects on this
  // peer only. Other peers keep seeing the last-committed text until
  // we blur and call setCardTitle.
  const [titleEditing, setTitleEditing] = useState(false);
  // contentEditable can't be controlled by React without fighting the
  // caret. We render `committedText` as its children — it tracks mesh
  // titleText whenever we're NOT editing, and freezes at the value
  // we started with as soon as `titleEditing` flips on. That way an
  // incoming `card_title` broadcast from another peer mid-edit can't
  // yank the text out from under whoever is typing.
  const [committedText, setCommittedText] = useState(titleText);
  useEffect(() => {
    if (!titleEditing) setCommittedText(titleText);
  }, [titleText, titleEditing]);

  // Resolve a full CardTitle from the current mesh state + any patched
  // fields. Used by every interaction that wants to broadcast a single
  // dimension (drag → x/y, wheel → sizeFrac, blur → text) without
  // dropping the others.
  const buildTitle = (patch: Partial<CardTitle>): CardTitle => ({
    text: titleText,
    x: titlePos.x,
    y: titlePos.y,
    sizeFrac: titleSizeFrac,
    ...patch,
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const titleBodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<null | {
    startClientX: number;
    startClientY: number;
    startPos: Frac;
    moved: boolean;
    startedOnBody: boolean;
    // Capture the full title at drag-start so concurrent text/size
    // edits from other peers don't get clobbered by the move broadcast.
    startTitle: CardTitle;
  }>(null);

  useEffect(() => {
    if (!loading) {
      setProgress(0);
      return;
    }
    const FAKE_DURATION_MS = 60_000;
    const CAP = 95;
    // Anchor the progress bar on the server-reported job start when
    // we have one — otherwise a peer who joins mid-generation would
    // see the bar restart at 0%. Falls back to "now" while the local
    // upload is still uploading and we haven't heard back from the
    // relay yet.
    const start = cardJob?.startedAt ?? Date.now();
    let raf = 0;
    const tick = () => {
      const elapsed = Date.now() - start;
      const pct = Math.min(elapsed / FAKE_DURATION_MS, 1) * CAP;
      setProgress(pct);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loading, cardJob?.startedAt]);

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
    if (cardJob) {
      // Someone else's drop is already cooking — no point queueing a
      // second job since the relay only tracks one per room.
      setError("already generating — wait for this one to finish");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      // Fire-and-forget: server responds 202 once the background job
      // is registered, then broadcasts `card_job` + `card_state` to
      // the whole room. The HTTP body here is just an ack. Closing
      // the window after this point does not cancel the job — the
      // server runs it to completion.
      const res = await fetch(withSlug(`${RELAY_HTTP}/v1/card`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": file.type },
        body: file,
      });
      if (!res.ok && res.status !== 409) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.detail) detail = String(j.detail);
        } catch {
          /* not json */
        }
        throw new Error(detail);
      }
    } catch (e) {
      setError((e as Error).message || "generation failed");
    } finally {
      setUploading(false);
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
  // Drag threshold: < 4px movement counts as a click; whether that
  // click enters edit mode depends on which zone was hit:
  // - body  → enter edit mode
  // - title bar → no-op (it's just a handle)
  const onTitlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (titleEditing) return; // already editing → let normal text interactions happen
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const body = titleBodyRef.current;
    const startedOnBody = !!body && (e.target === body || body.contains(e.target as Node));
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPos: titlePos,
      moved: false,
      startedOnBody,
      startTitle: buildTitle({}),
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
    const x = Math.max(0, Math.min(1, d.startPos.x + dx / rect.width));
    const y = Math.max(0, Math.min(1, d.startPos.y + dy / rect.height));
    // Broadcast through mesh — server fans the update out to other
    // peers (excluding us) and persists last-write-wins. Local mesh
    // state updates optimistically inside setCardTitle so this peer's
    // overlay tracks the cursor without WS round-trip lag.
    setCardTitle({ ...d.startTitle, x, y });
  };
  const onTitlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    // Treat as click on body → enter edit mode, focus + place caret at end.
    // Clicks on the title bar are no-ops (just used as a drag handle).
    if (d && !d.moved && d.startedOnBody) {
      setTitleEditing(true);
      requestAnimationFrame(() => {
        const el = titleBodyRef.current;
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
    const next = Math.max(0.015, Math.min(0.25, titleSizeFrac + delta));
    setCardTitle(buildTitle({ sizeFrac: next }));
  };

  const onTitleBlur = () => {
    setTitleEditing(false);
    const el = titleBodyRef.current;
    if (!el) return;
    const next = el.innerText.replace(/\n/g, " ").trim() || " ";
    if (next !== titleText) setCardTitle(buildTitle({ text: next }));
  };
  const onTitleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleBodyRef.current?.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Reset edits + blur. Use the snapshot we took on enter-edit so
      // a concurrent rename broadcast doesn't surprise the user with
      // someone else's new value as the "reverted" text.
      if (titleBodyRef.current) titleBodyRef.current.innerText = committedText;
      titleBodyRef.current?.blur();
    }
  };

  const reset = () => {
    setError(null);
    resetCard();
  };

  // Bake the title — including the magenta-bordered mini-window chrome
  // around it — onto the result image at its NATURAL resolution. We
  // measure the live DOM (window outer rect, title bar, body) and scale
  // each rect + computed style into canvas natural-pixel space so the
  // bake is WYSIWYG: whatever the host sees on screen is what lands in
  // the PNG. Backdrop-filter blur isn't reproducible on canvas but the
  // translucent fills still composite over the card image so the visual
  // result is close.
  //
  // Shared by both `download` (file save dialog) and `save` (POST to
  // relay as the unfurl image).
  const bakeBlob = async (): Promise<Blob | null> => {
    if (!resultUrl) return null;
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

    // Wait for any pending Silkscreen / next-font loads before we
    // measure-and-bake — first download after open used to render a
    // tiny default-font speck because the font wasn't ready yet.
    await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;

    const titleWindowEl = titleRef.current;
    const titleBarEl = titleWindowEl?.firstElementChild as HTMLElement | null;
    const bodyEl = titleBodyRef.current;
    const rootEl = rootRef.current;
    const imgRect = getImageRect();
    const rawText = ((bodyEl?.innerText ?? titleText) || "").replace(/\n/g, " ").trim();

    if (titleWindowEl && titleBarEl && bodyEl && rootEl && imgRect && rawText) {
      // Translate viewport-relative DOM rects into canvas (natural
      // image-pixel) coordinates. getImageRect is root-relative; rects
      // from getBoundingClientRect are viewport-relative — so anchor
      // off the root's viewport position.
      const rootViewport = rootEl.getBoundingClientRect();
      const imgVx = rootViewport.left + imgRect.left;
      const imgVy = rootViewport.top + imgRect.top;
      const scale = img.naturalWidth / imgRect.width;

      const wRect = titleWindowEl.getBoundingClientRect();
      const tbRect = titleBarEl.getBoundingClientRect();
      const bdRect = bodyEl.getBoundingClientRect();

      const wStyle = getComputedStyle(titleWindowEl);
      const tbStyle = getComputedStyle(titleBarEl);
      const bdStyle = getComputedStyle(bodyEl);

      const toCanvas = (r: DOMRect) => ({
        x: (r.left - imgVx) * scale,
        y: (r.top - imgVy) * scale,
        w: r.width * scale,
        h: r.height * scale,
      });
      const W = toCanvas(wRect);
      const TB = toCanvas(tbRect);
      const BD = toCanvas(bdRect);

      // Window outer drop shadow (matches inline boxShadow):
      // "0 4px 14px rgba(0,0,0,0.45), 0 0 8px rgba(255,62,201,0.25)"
      ctx.save();
      ctx.fillStyle = wStyle.backgroundColor || "rgba(10,4,30,0.32)";
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 14 * scale;
      ctx.shadowOffsetY = 4 * scale;
      ctx.fillRect(W.x, W.y, W.w, W.h);
      ctx.restore();
      // Magenta outer glow pass.
      ctx.save();
      ctx.shadowColor = "rgba(255,62,201,0.25)";
      ctx.shadowBlur = 8 * scale;
      ctx.strokeStyle = "rgba(255,62,201,0.001)";
      ctx.lineWidth = 1;
      ctx.strokeRect(W.x, W.y, W.w, W.h);
      ctx.restore();

      // Title bar fill + bottom border.
      ctx.fillStyle = tbStyle.backgroundColor || "var(--slop-titlebar-active)";
      ctx.fillRect(TB.x, TB.y, TB.w, TB.h);
      ctx.fillStyle = "rgba(255,62,201,0.6)";
      ctx.fillRect(TB.x, TB.y + TB.h - Math.max(1, scale), TB.w, Math.max(1, scale));

      // Title bar text — uppercase "TITLE" (CSS text-transform happens
      // visually; canvas needs the rendered glyphs).
      const tbFontPx = parseFloat(tbStyle.fontSize) * scale;
      ctx.font = `${tbFontPx}px ${tbStyle.fontFamily}`;
      ctx.fillStyle = tbStyle.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing =
        `${(parseFloat(tbStyle.letterSpacing) || 0) * scale}px`;
      ctx.fillText("TITLE", TB.x + TB.w / 2, TB.y + TB.h / 2);

      // Body fill (translucent black).
      ctx.fillStyle = bdStyle.backgroundColor || "rgba(0,0,0,0.28)";
      ctx.fillRect(BD.x, BD.y, BD.w, BD.h);

      // Body text — cyan title, drop shadow for legibility.
      const bdFontPx = parseFloat(bdStyle.fontSize) * scale;
      ctx.save();
      ctx.font = `${bdFontPx}px ${bdStyle.fontFamily}`;
      ctx.fillStyle = bdStyle.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing =
        `${(parseFloat(bdStyle.letterSpacing) || 0) * scale}px`;
      ctx.shadowColor = "rgba(0,0,0,0.7)";
      ctx.shadowBlur = bdFontPx * 0.18;
      ctx.shadowOffsetY = bdFontPx * 0.08;
      ctx.fillText(rawText.toUpperCase(), BD.x + BD.w / 2, BD.y + BD.h / 2);
      ctx.restore();

      // Window outer border last so it sits on top of all fills.
      ctx.strokeStyle = wStyle.borderColor || "#ff3ec9";
      ctx.lineWidth = Math.max(1, scale);
      ctx.strokeRect(W.x, W.y, W.w, W.h);
    }

    const blob = await new Promise<Blob | null>(res => canvas.toBlob(b => res(b), "image/png"));
    if (!blob) throw new Error("canvas encode failed");
    return blob;
  };

  const download = async () => {
    if (!resultUrl) return;
    try {
      const blob = await bakeBlob();
      if (!blob) return;
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

  // Publish the baked card (with title overlay) to the relay as the
  // room's unfurl image — `generateMetadata()` in app/[slug]/page.tsx
  // points og:image at this file. Anyone in the room can re-publish;
  // mirrors the permissive reset pattern. The relay rate is itself a
  // small file write, so we don't bother with a "publishing" spinner —
  // the icon flashes saved on success.
  const [saved, setSaved] = useState(false);
  const save = async () => {
    if (!resultUrl) return;
    setError(null);
    try {
      const blob = await bakeBlob();
      if (!blob) return;
      const res = await fetch(withSlug(`${RELAY_HTTP}/v1/card/published`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "image/png" },
        body: blob,
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) detail = String(j.error);
        } catch {
          /* not json */
        }
        throw new Error(detail);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message || "save failed");
    }
  };

  const imgSrc = resultUrl ?? TEMPLATE_SRC;

  // Compute live screen-position for the title overlay based on the
  // current image rect. Falls back to hidden until we have measured.
  const imgRect = getImageRect();
  const titleFontPx = imgRect ? titleSizeFrac * imgRect.width : 0;
  // Title-bar height scales with the body font but stays in a comfy
  // range so a tiny title still has a touchable handle.
  const titleBarHeight = Math.max(14, Math.min(28, titleFontPx * 0.42));
  const titleWindowStyle: React.CSSProperties = imgRect
    ? {
        position: "absolute",
        left: imgRect.left + titlePos.x * imgRect.width,
        top: imgRect.top + titlePos.y * imgRect.height,
        transform: "translate(-50%, -50%)",
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--slop-magenta, #ff3ec9)",
        boxShadow: "0 4px 14px rgba(0,0,0,0.45), 0 0 8px rgba(255,62,201,0.25)",
        background: "rgba(10, 4, 30, 0.32)",
        backdropFilter: "blur(2px)",
        cursor: titleEditing ? "auto" : "grab",
        userSelect: titleEditing ? "text" : "none",
        zIndex: 8,
        // Just enough min-width so even an empty title is a clickable
        // window, not a sliver.
        minWidth: Math.max(80, titleFontPx * 3),
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

      {/* Editable title — a tiny faux window with a magenta title bar
          and a translucent body holding cyan editable text. Visible on
          the template too so the host can prep the guest's name before
          drop. The window decoration is UI only; the canvas bake at
          download time renders just the text. Drag from the title bar
          (or unfocused body) to move; click body to edit; wheel to
          resize. */}
      <div
        ref={titleRef}
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
        onWheel={onTitleWheel}
        style={titleWindowStyle}
      >
        <div
          aria-hidden
          style={{
            height: titleBarHeight,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 8px",
            background: "var(--slop-titlebar-active)",
            borderBottom: "1px solid rgba(255,62,201,0.6)",
            color: "#fff",
            fontFamily: "var(--slop-font-display)",
            fontSize: Math.max(8, titleBarHeight * 0.55),
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            cursor: titleEditing ? "default" : "grab",
            userSelect: "none",
          }}
        >
          title
        </div>
        <div
          ref={titleBodyRef}
          contentEditable={titleEditing}
          suppressContentEditableWarning
          onBlur={onTitleBlur}
          onKeyDown={onTitleKeyDown}
          style={{
            padding: `${Math.max(4, titleFontPx * 0.18)}px ${Math.max(10, titleFontPx * 0.32)}px`,
            background: titleEditing ? "rgba(0,0,0,0.42)" : "rgba(0,0,0,0.28)",
            color: TITLE_COLOR,
            fontFamily: "var(--slop-font-display)",
            fontSize: titleFontPx,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            outline: "none",
            cursor: titleEditing ? "text" : "grab",
            textAlign: "center",
            textShadow: "0 2px 6px rgba(0,0,0,0.7)",
          }}
        >
          {committedText}
        </div>
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
            pointerEvents: "none",
            zIndex: 9,
          }}
        >
          <LoadingBar cells={20} progress={progress} caption="generating" />
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
            top: 8,
            right: 8,
            display: "flex",
            gap: 6,
            zIndex: 12,
          }}
        >
          <button
            type="button"
            onClick={() => void save()}
            aria-label="save as unfurl"
            title={saved ? "saved!" : "save as unfurl"}
            style={overlayBtnStyle(saved)}
          >
            <SaveIcon />
          </button>
          <button
            type="button"
            onClick={reset}
            aria-label="reset card"
            title="reset card"
            style={overlayBtnStyle(false)}
          >
            <ResetIcon />
          </button>
          <button
            type="button"
            onClick={() => void download()}
            aria-label="download PNG"
            title="download PNG"
            style={overlayBtnStyle(false)}
          >
            <DownloadIcon />
          </button>
        </div>
      ) : null}
    </div>
  );
};

// Matches the VideoView / AudioVisualizer overlay button — translucent
// dark bg, backdrop blur, magenta border on active.
const overlayBtnStyle = (active: boolean): React.CSSProperties => ({
  width: 32,
  height: 32,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: active ? "var(--slop-magenta, #ff3ec9)" : "rgba(6,3,13,0.7)",
  border: `1px solid ${active ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-bevel-light, #4a4a4a)"}`,
  color: "#fff",
  cursor: "pointer",
  backdropFilter: "blur(4px)",
});

// Mac OS 9-flavored monochrome icons. ~16px viewBox, currentColor.
const ResetIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {/* Circular arrow — start of the loop near top-right, sweeping
        counter-clockwise to a downward arrowhead on the left. */}
    <path d="M13 8 A 5 5 0 1 1 8 3" />
    <polyline points="8 1 8 3 10 3" />
  </svg>
);

// Floppy disk — classic save icon. Outer rectangle = disk body,
// top notch = label area, small inner rectangle = metal shutter.
const SaveIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="2" y="2" width="12" height="12" rx="1" />
    <polyline points="4 2 4 7 11 7 11 2" />
    <rect x="5" y="9.5" width="6" height="3.5" />
  </svg>
);

const DownloadIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {/* Down arrow into a tray. */}
    <line x1="8" y1="2" x2="8" y2="10" />
    <polyline points="4.5 7 8 10.5 11.5 7" />
    <polyline points="2.5 12 2.5 14 13.5 14 13.5 12" />
  </svg>
);

export default CardWindow;

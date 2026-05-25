"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioBusElement } from "~~/hooks/useAudioBus";
import type { FileEntry, PeerMeshState, PreviewMediaSnapshot } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";

// Inline file preview. Dispatches on mime type → image / video / audio /
// pdf / text. Falls back to a metadata-only card with a Download button
// for binary types we can't natively render. Used for double-click on
// any DesktopFile.
//
// The preview *window* (open/close/position/size) is multiplayer via
// the slot + window-id system in Desktop.tsx — opening `preview-<id>`
// broadcasts to the whole room. The *content state* is mostly per-peer
// (each viewer scrolls text or paginates PDF independently), with one
// exception: audio + video playback is synced via mesh.previewMedia[id]
// so when the host scrubs a clip every peer's element follows. The
// SyncedMedia subcomponent below owns that bidirectional bridge.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const MAX_INLINE_TEXT_BYTES = 1_000_000; // 1 MB cap for text fetch

export type FilePreviewWindowProps = {
  file: FileEntry;
  mesh: PeerMeshState;
  /** God-mode only: route preview audio/video through the shared
   *  AudioBus so the EQ popup can mix it with peer voices + music. */
  audioBusEnabled?: boolean;
};

// Drift tolerance: only force a seek when the local element has
// strayed more than this from the shared playhead. Loose enough that
// natural buffering / network burps don't cause visible re-seeks.
const SYNC_TOLERANCE_SEC = 1.5;
// Cap forward extrapolation in case a stale snapshot says "playing"
// from hours ago — don't try to seek to position-1h.
const MAX_FORWARD_EXTRAPOLATION_SEC = 600;

function livePosition(s: PreviewMediaSnapshot | undefined | null): number {
  if (!s) return 0;
  if (!s.playing) return s.position;
  const elapsed = Math.max(0, (Date.now() - s.at) / 1000);
  if (elapsed > MAX_FORWARD_EXTRAPOLATION_SEC) return s.position;
  return s.position + elapsed;
}

// Render an <audio> or <video> element whose playhead is bound to
// mesh.previewMedia[fileId]. Foreign updates are pushed into the
// element (seek + play/pause); local user gestures (clicking play,
// dragging the scrubber, hitting end) broadcast a new snapshot.
//
// The "applyingServer" ref blocks the echo: when we programmatically
// seek/play/pause to apply a foreign snapshot, the element fires the
// same events as if the user did it. We set the flag for one tick
// before mutating so the event handlers know to skip.
const SyncedMedia = ({
  fileId,
  src,
  kind,
  mesh,
  audioBusEnabled = false,
  audioBusLabel = "file preview",
}: {
  fileId: string;
  src: string;
  kind: "audio" | "video";
  mesh: PeerMeshState;
  /** God-mode only: route this clip's audio through the bus. */
  audioBusEnabled?: boolean;
  audioBusLabel?: string;
}) => {
  const elRef = useRef<HTMLMediaElement | null>(null);
  const applyingServerRef = useRef(false);
  const shared = mesh.previewMedia[fileId] ?? null;

  // God-mode only — route this clip's playback through the shared
  // AudioBus so the EQ popup can mix it. Applies to both <audio> and
  // <video> elements (movies have audio too).
  useAudioBusElement(elRef, `preview-${fileId}`, audioBusLabel, audioBusEnabled);

  // Push shared state → local element.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const target = livePosition(shared);
    applyingServerRef.current = true;
    try {
      if (Number.isFinite(target) && Math.abs(el.currentTime - target) > SYNC_TOLERANCE_SEC) {
        try {
          el.currentTime = target;
        } catch {
          /* readyState too low — the 'loadeddata' listener below will retry */
        }
      }
      const shouldPlay = !!shared?.playing;
      if (shouldPlay && el.paused) {
        el.play().catch(() => {
          /* Autoplay can be blocked when the foreign snapshot tells us
             to play before the user has gestured. They'll start playback
             themselves with a click — the broadcast happens then. */
        });
      } else if (!shouldPlay && !el.paused) {
        el.pause();
      }
    } finally {
      // queueMicrotask so any synthetic events fired by the play()/
      // pause()/currentTime= calls above land while the flag is true.
      queueMicrotask(() => {
        applyingServerRef.current = false;
      });
    }
  }, [shared]);

  // Once metadata is ready, retry the sync — the initial seek above
  // may have been rejected for readyState reasons.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const onLoaded = () => {
      const target = livePosition(shared);
      if (Number.isFinite(target) && Math.abs(el.currentTime - target) > SYNC_TOLERANCE_SEC) {
        applyingServerRef.current = true;
        try {
          el.currentTime = target;
        } catch {
          /* still not seekable */
        }
        queueMicrotask(() => {
          applyingServerRef.current = false;
        });
      }
    };
    el.addEventListener("loadeddata", onLoaded);
    return () => el.removeEventListener("loadeddata", onLoaded);
  }, [shared]);

  // Local user gestures → broadcast.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const broadcast = () => {
      if (applyingServerRef.current) return;
      mesh.setPreviewMedia(fileId, {
        position: el.currentTime,
        playing: !el.paused && !el.ended,
        at: Date.now(),
      });
    };
    el.addEventListener("play", broadcast);
    el.addEventListener("pause", broadcast);
    el.addEventListener("seeked", broadcast);
    el.addEventListener("ended", broadcast);
    return () => {
      el.removeEventListener("play", broadcast);
      el.removeEventListener("pause", broadcast);
      el.removeEventListener("seeked", broadcast);
      el.removeEventListener("ended", broadcast);
    };
  }, [fileId, mesh]);

  // Web Audio's createMediaElementSource silently outputs zero for
  // tainted (cross-origin without crossOrigin) elements, so we have to
  // opt the element into CORS when routing through the bus. Only set
  // it when we actually need it — non-god-mode sessions stick with the
  // current no-crossOrigin path (works even if a gateway lacks CORS).
  const crossOriginAttr = audioBusEnabled ? "anonymous" : undefined;
  if (kind === "video") {
    return (
      <video
        ref={el => {
          elRef.current = el;
        }}
        src={src}
        controls
        crossOrigin={crossOriginAttr}
        style={{ maxWidth: "100%", maxHeight: "100%", display: "block", margin: "auto" }}
      />
    );
  }
  return (
    <audio
      ref={el => {
        elRef.current = el;
      }}
      src={src}
      controls
      crossOrigin={crossOriginAttr}
      style={{ width: "100%", maxWidth: 360 }}
    />
  );
};

type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "html" | "none";

function previewKindFor(file: FileEntry): PreviewKind {
  const mime = (file.mime ?? "").toLowerCase();
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  // Textual mime types + common code/config file extensions. We never
  // sniff binary text; if the mime says text/* we trust it. For ext-
  // based detection we still fetch with a size cap and check the body
  // for null bytes before rendering.
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/json" || mime === "application/xml") return "text";
  if (
    [
      "txt",
      "md",
      "markdown",
      "json",
      "yaml",
      "yml",
      "toml",
      "xml",
      "csv",
      "log",
      "ini",
      "conf",
      "js",
      "mjs",
      "cjs",
      "ts",
      "tsx",
      "jsx",
      "py",
      "rs",
      "go",
      "rb",
      "sh",
      "bash",
      "zsh",
      "html",
      "htm",
      "css",
      "scss",
      "less",
      "sol",
      "java",
      "c",
      "cpp",
      "h",
      "hpp",
      "swift",
      "kt",
      "php",
      "lua",
    ].includes(ext)
  ) {
    return "text";
  }
  // Iframe-able HTML pages — same as text but renders the markup.
  if (mime === "text/html") return "html";
  return "none";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// How long after a local scroll we stay "detached" — ignoring foreign
// scroll updates so a peer reading at their own pace isn't yanked. The
// next foreign update after this window re-syncs them to the room.
const SCROLL_DETACH_MS = 2500;
// Min spacing between our own scroll broadcasts. Scroll fires a lot;
// this keeps the relay traffic sane while still feeling live.
const SCROLL_BROADCAST_THROTTLE_MS = 150;
// Frac equality slop — used to recognize our own follow-scroll so it
// doesn't echo back out as if the user had scrolled.
const SCROLL_FRAC_EPSILON = 0.002;

const TextPreview = ({
  url,
  name,
  fileId,
  mesh,
}: {
  url: string;
  name: string;
  fileId: string;
  mesh: PeerMeshState;
}) => {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  // The scroll fraction we most recently applied from a foreign
  // update — lets the scroll handler tell our own follow-scroll apart
  // from a genuine user scroll (which it then broadcasts).
  const lastAppliedFracRef = useRef<number | null>(null);
  // Timestamp of the last genuine user scroll. While recent we stay
  // detached and don't let foreign updates move us.
  const lastUserScrollRef = useRef(0);
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBroadcastAtRef = useRef(0);

  const sharedFrac = mesh.previewMedia[fileId]?.scrollFrac;

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setError(null);
    fetch(url, { headers: { range: `bytes=0-${MAX_INLINE_TEXT_BYTES - 1}` } })
      .then(async r => {
        if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        if (cancelled) return;
        // Guard against accidentally-text mime types that are actually
        // binary — show "no preview" rather than a wall of mojibake.
        if (text.includes("\x00")) {
          setError("binary content (looks non-text)");
          return;
        }
        setBody(text);
      })
      .catch(err => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Gentle follow: when the shared scroll position changes, snap the
  // local <pre> to it — UNLESS the local user has scrolled within the
  // last SCROLL_DETACH_MS, in which case we leave them be (they get
  // re-synced by the next foreign update after the grace window). The
  // `body` dep re-runs this once the text actually lands so a window
  // opened mid-room jumps straight to the room's scroll position.
  useEffect(() => {
    const el = preRef.current;
    if (el == null || sharedFrac == null) return;
    if (Date.now() - lastUserScrollRef.current < SCROLL_DETACH_MS) return;
    const range = el.scrollHeight - el.clientHeight;
    if (range <= 0) return;
    const target = sharedFrac * range;
    if (Math.abs(el.scrollTop - target) < 4) return;
    // Record what we're applying so the resulting scroll event is
    // recognized as ours and not re-broadcast.
    lastAppliedFracRef.current = sharedFrac;
    el.scrollTop = target;
  }, [sharedFrac, body]);

  const onScroll = useCallback(() => {
    const el = preRef.current;
    if (el == null) return;
    const range = el.scrollHeight - el.clientHeight;
    const frac = range > 0 ? el.scrollTop / range : 0;
    // Our own follow-scroll? If the position matches what we last
    // applied from a foreign update, swallow it — no echo.
    if (lastAppliedFracRef.current != null && Math.abs(frac - lastAppliedFracRef.current) < SCROLL_FRAC_EPSILON) {
      return;
    }
    // Genuine user scroll → detach + broadcast (throttled).
    lastUserScrollRef.current = Date.now();
    const fire = () => {
      lastBroadcastAtRef.current = Date.now();
      mesh.setPreviewMedia(fileId, { position: 0, playing: false, at: Date.now(), scrollFrac: frac });
    };
    if (throttleRef.current != null) clearTimeout(throttleRef.current);
    const sinceLast = Date.now() - lastBroadcastAtRef.current;
    if (sinceLast >= SCROLL_BROADCAST_THROTTLE_MS) {
      fire();
    } else {
      throttleRef.current = setTimeout(fire, SCROLL_BROADCAST_THROTTLE_MS - sinceLast);
    }
  }, [fileId, mesh]);

  useEffect(() => {
    return () => {
      if (throttleRef.current != null) clearTimeout(throttleRef.current);
    };
  }, []);

  if (error) {
    return (
      <div style={{ padding: 16, color: "var(--slop-text-muted)", fontFamily: "var(--slop-font-body)", fontSize: 12 }}>
        Can&apos;t render <code>{name}</code> as text: {error}
      </div>
    );
  }
  if (body === null) {
    return (
      <div style={{ padding: 16, color: "var(--slop-text-muted)", fontFamily: "var(--slop-font-body)", fontSize: 12 }}>
        Loading…
      </div>
    );
  }
  return (
    <pre
      ref={preRef}
      onScroll={onScroll}
      style={{
        margin: 0,
        padding: 12,
        flex: 1,
        overflow: "auto",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {body}
    </pre>
  );
};

export const FilePreviewWindow = ({ file, mesh, audioBusEnabled = false }: FilePreviewWindowProps) => {
  const slug = useRoomSlug();
  const downloadUrl = withSlug(`${RELAY_HTTP}/files/${file.id}`, slug);
  const kind = previewKindFor(file);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
      }}
    >
      {/* Header — always present. Filename, size, uploader, mime tag,
          and a Download button that's just a normal <a> so the
          browser handles the response (Content-Disposition: attachment). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          borderBottom: "1px solid var(--slop-border, #2a1d4a)",
          background: "#0a061a",
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={file.name}
          >
            {file.name}
          </div>
          <div style={{ fontSize: 10, color: "var(--slop-text-muted)", marginTop: 2 }}>
            {formatBytes(file.size)} · {file.mime || "unknown"} · uploaded by {file.uploaderLabel}
          </div>
        </div>
        <a
          href={downloadUrl}
          download={file.name}
          style={{
            flexShrink: 0,
            padding: "6px 12px",
            fontSize: 11,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            background: "var(--slop-magenta, #ff3ec9)",
            color: "#06030d",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            textDecoration: "none",
            fontWeight: 700,
          }}
        >
          Download
        </a>
      </div>

      {/* Body — preview content. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: "#06030d",
          alignItems: "stretch",
          justifyContent:
            kind === "image" || kind === "video" || kind === "audio" || kind === "none" ? "center" : "stretch",
        }}
      >
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={downloadUrl}
            alt={file.name}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              display: "block",
              margin: "auto",
            }}
          />
        ) : kind === "video" ? (
          <SyncedMedia
            fileId={file.id}
            src={downloadUrl}
            kind="video"
            mesh={mesh}
            audioBusEnabled={audioBusEnabled}
            audioBusLabel={`video · ${file.name}`}
          />
        ) : kind === "audio" ? (
          <div
            style={{
              padding: 24,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              fontSize: 60,
            }}
          >
            <div>🎵</div>
            <SyncedMedia
              fileId={file.id}
              src={downloadUrl}
              kind="audio"
              mesh={mesh}
              audioBusEnabled={audioBusEnabled}
              audioBusLabel={`audio · ${file.name}`}
            />
          </div>
        ) : kind === "pdf" ? (
          <iframe
            src={downloadUrl}
            title={file.name}
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
          />
        ) : kind === "html" ? (
          // Sandbox the iframe so an HTML upload can't run scripts in
          // our origin — preview is a viewer, not a runtime.
          <iframe
            src={downloadUrl}
            title={file.name}
            sandbox=""
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
          />
        ) : kind === "text" ? (
          <TextPreview url={downloadUrl} name={file.name} fileId={file.id} mesh={mesh} />
        ) : (
          // No native preview — show a friendly fallback. The user can
          // still hit the Download button up top.
          <div
            style={{
              padding: 24,
              textAlign: "center",
              color: "var(--slop-text-muted)",
              fontSize: 13,
              fontFamily: "var(--slop-font-body)",
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 10 }}>📁</div>
            <div>No preview available for this file type.</div>
            <div style={{ marginTop: 6, fontSize: 11 }}>
              Use the <strong>Download</strong> button above to grab it.
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FilePreviewWindow;

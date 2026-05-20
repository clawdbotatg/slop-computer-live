"use client";

import { useEffect, useState } from "react";
import type { FileEntry } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";

// Inline file preview. Dispatches on mime type → image / video / audio /
// pdf / text. Falls back to a metadata-only card with a Download button
// for binary types we can't natively render. Used for double-click on
// any DesktopFile.
//
// State is per-peer, not mesh-synced (each viewer can have their own
// preview window open). Lives in page.tsx's local state, not the slot
// system — position is just whatever we choose at open time.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const MAX_INLINE_TEXT_BYTES = 1_000_000; // 1 MB cap for text fetch

export type FilePreviewWindowProps = {
  file: FileEntry;
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

const TextPreview = ({ url, name }: { url: string; name: string }) => {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

export const FilePreviewWindow = ({ file }: FilePreviewWindowProps) => {
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
          <video
            src={downloadUrl}
            controls
            style={{ maxWidth: "100%", maxHeight: "100%", display: "block", margin: "auto" }}
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
            <audio src={downloadUrl} controls style={{ width: "100%", maxWidth: 360 }} />
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
          <TextPreview url={downloadUrl} name={file.name} />
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

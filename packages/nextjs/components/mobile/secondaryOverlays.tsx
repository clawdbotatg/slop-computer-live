"use client";

import type { PeerMeshState } from "~~/hooks/usePeerMesh";

// Small overlays that ride on top of the main layout when the operator
// cycles to a non-default variant. None of them take a video slot —
// they're "lower-third" furniture that says "this room also has a
// music player / wallet / etc going on" without stealing space from
// the talking heads. Wired into MobileStage's variant dispatcher.

// --- music ticker ---------------------------------------------------------
//
// Thin strip at the bottom of the video area showing what's playing.
// Track title gets parsed out of the src URL (last path segment, no
// extension) since the playlist itself doesn't live on mesh.musicState
// — only the playback snapshot does. Hidden when nothing is playing.

function trackTitleFromSrc(src: string): string {
  try {
    const last = src.split(/[?#]/)[0].split("/").pop() ?? "";
    const noExt = last.replace(/\.[a-z0-9]+$/i, "");
    const decoded = decodeURIComponent(noExt);
    return decoded.replace(/[_-]+/g, " ").trim() || "track";
  } catch {
    return "track";
  }
}

export type MusicTickerProps = {
  mesh: PeerMeshState;
};

export const MusicTicker = ({ mesh }: MusicTickerProps) => {
  const music = mesh.musicState;
  const playing = !!music?.playing && !!music?.src;
  const title = music?.src ? trackTitleFromSrc(music.src) : "—";
  return (
    <div
      style={{
        height: 32,
        width: "100%",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 14px",
        background: "linear-gradient(180deg, rgba(255,62,201,0.18) 0%, rgba(6,8,24,0.78) 100%)",
        borderTop: "1px solid rgba(255,62,201,0.40)",
        borderBottom: "1px solid rgba(63,207,255,0.20)",
        fontFamily: "var(--slop-font-display)",
        fontSize: 11,
        letterSpacing: "0.10em",
        textTransform: "uppercase",
        color: "var(--slop-text)",
      }}
    >
      <span
        style={{
          color: playing ? "var(--slop-magenta, #ff3ec9)" : "var(--slop-text-muted)",
          fontSize: 14,
        }}
      >
        ♪
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: playing ? "var(--slop-text)" : "var(--slop-text-muted)",
        }}
      >
        {playing ? title : "music idle"}
      </span>
    </div>
  );
};

// --- wallet pill ----------------------------------------------------------
//
// Top-right corner pill showing the active room wallet. Renders the
// label (defaults to "wallet" if unset) + a short address. Punted on
// live balance — that's a separate hook and we don't want to invite a
// 10s loading state into a clip recording.

export type WalletPillProps = {
  mesh: PeerMeshState;
};

export const WalletPill = ({ mesh }: WalletPillProps) => {
  const wallet = mesh.wallet;
  if (!wallet) {
    return (
      <div style={pillStyle} title="no wallet on this room yet">
        <span style={{ color: "var(--slop-text-muted)" }}>no wallet</span>
      </div>
    );
  }
  const addr = wallet.address;
  const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  return (
    <div style={pillStyle}>
      <span style={{ color: "var(--slop-cyan, #3fcfff)" }}>{wallet.label || "wallet"}</span>
      <span style={{ color: "var(--slop-text-muted)", fontSize: 9 }}>{short}</span>
    </div>
  );
};

// Top-left, mirroring the title bar's centered SLOP.COMPUTER on the
// right — leaves the top-right corner free for the variant HUD.
const pillStyle: React.CSSProperties = {
  position: "absolute",
  top: 56,
  left: 10,
  padding: "4px 10px",
  borderRadius: 999,
  background: "rgba(6,8,24,0.85)",
  border: "1px solid rgba(63,207,255,0.55)",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 0,
  fontFamily: "var(--slop-font-display)",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  zIndex: 9000,
  pointerEvents: "none",
};

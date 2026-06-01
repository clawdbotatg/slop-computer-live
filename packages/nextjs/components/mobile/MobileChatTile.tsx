"use client";

import { useEffect, useRef } from "react";
import { SlopAddress } from "~~/components/ui";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";

// View-only chat preview for the mobile clip stage. Shows the last N
// messages auto-scrolled to the bottom. Read-only — no input affordance
// (mobile is a spectator session). Each message is one line: sender +
// text, with system/emote variants matching the desktop ChatWindow's
// rendering rules.

const MAX_MESSAGES = 30;

export type MobileChatTileProps = {
  mesh: PeerMeshState;
};

export const MobileChatTile = ({ mesh }: MobileChatTileProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = mesh.chatMessages.slice(-MAX_MESSAGES);

  // Pin to bottom whenever the message list changes — new chat lands
  // at the bottom and the operator should see it without scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "linear-gradient(180deg, rgba(6,8,24,0.92) 0%, rgba(12,4,28,0.92) 100%)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: "4px 10px",
          background: "rgba(63,207,255,0.10)",
          borderBottom: "1px solid rgba(63,207,255,0.30)",
          fontFamily: "var(--slop-font-display)",
          fontSize: 9,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--slop-cyan, #3fcfff)",
        }}
      >
        chat
      </div>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 13,
          lineHeight: 1.3,
          color: "var(--slop-text)",
        }}
      >
        {messages.length === 0 ? (
          <span
            style={{
              color: "var(--slop-text-muted)",
              fontFamily: "var(--slop-font-display)",
              fontSize: 10,
              letterSpacing: "0.10em",
              textTransform: "uppercase",
              textAlign: "center",
              margin: "auto",
            }}
          >
            no chat yet
          </span>
        ) : (
          messages.map(m => <MessageRow key={m.id} msg={m} customNames={mesh.customNames} />)
        )}
      </div>
    </div>
  );
};

type MessageRowProps = {
  msg: import("~~/hooks/usePeerMesh").ChatMessage;
  customNames: Record<string, string>;
};

const MessageRow = ({ msg, customNames }: MessageRowProps) => {
  // System lines: unattributed centered notice. Same shape ChatWindow
  // uses for slash-command output that's about the room, not a sender.
  if (msg.kind === "system") {
    return (
      <span
        style={{
          textAlign: "center",
          color: "var(--slop-text-muted)",
          fontStyle: "italic",
          fontSize: 12,
        }}
      >
        {msg.text}
      </span>
    );
  }
  // Emote: italicized, sender first. Renders like "* foo waves".
  if (msg.kind === "emote") {
    return (
      <span style={{ fontStyle: "italic" }}>
        <span style={{ color: "var(--slop-magenta, #ff3ec9)", marginRight: 4 }}>*</span>
        <SlopAddress
          address={msg.address ?? undefined}
          handle={msg.handle ?? undefined}
          anonId={msg.anonId ?? undefined}
          fallback={msg.id}
          customNames={customNames}
        />{" "}
        {msg.text}
      </span>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <SlopAddress
        address={msg.address ?? undefined}
        handle={msg.handle ?? undefined}
        anonId={msg.anonId ?? undefined}
        fallback={msg.id}
        customNames={customNames}
      />
      <span style={{ wordBreak: "break-word" }}>{msg.text}</span>
    </div>
  );
};

export default MobileChatTile;

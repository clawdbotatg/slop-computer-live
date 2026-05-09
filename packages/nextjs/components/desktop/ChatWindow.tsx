"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import { Button } from "~~/components/ui";
import type { ChatMessage } from "~~/hooks/usePeerMesh";
import { type Bands, bandsFromIdentity } from "~~/utils/blockieBands";

export type ChatWindowProps = {
  messages: ChatMessage[];
  sendChat: (text: string) => void;
  myAddress: string | null;
  myHandle: string | null;
};

// The chat panel body. The parent <Window> already supplies the title bar,
// drag/resize, and shell — this just paints the scrollback + composer.
export const ChatWindow = ({ messages, sendChat, myAddress, myHandle }: ChatWindowProps) => {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Pin to bottom on new messages — but only if the user is already near
  // the bottom. Mid-scroll users shouldn't get yanked back when a new
  // message lands; that's a respectful chat default.
  const wasAtBottomRef = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    sendChat(text);
    setDraft("");
  };

  const myKey = (myAddress ?? myHandle ?? "").toLowerCase();

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
      <div
        ref={listRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              color: "var(--slop-text-muted)",
              fontSize: 12,
              fontStyle: "italic",
              padding: 12,
              textAlign: "center",
            }}
          >
            no messages yet — say hi
          </div>
        ) : (
          messages.map(m => {
            const isMine = (m.address ?? m.handle ?? "").toLowerCase() === myKey && myKey !== "";
            return <ChatRow key={m.id} msg={m} isMine={isMine} />;
          })
        )}
      </div>
      <div
        style={{
          padding: 8,
          borderTop: "1px solid var(--slop-bevel-light, #4a4a4a)",
          background: "rgba(6,3,13,0.85)",
          display: "flex",
          gap: 6,
        }}
      >
        <input
          type="text"
          value={draft}
          maxLength={500}
          placeholder="message…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          style={{
            flex: 1,
            padding: "6px 8px",
            background: "#06030d",
            border: "1px solid var(--slop-bevel-light, #4a4a4a)",
            color: "var(--slop-text)",
            fontFamily: "var(--slop-font-body)",
            fontSize: 13,
            outline: "none",
          }}
        />
        <Button onClick={submit} disabled={!draft.trim()} variant="primary">
          Send
        </Button>
      </div>
    </div>
  );
};

const ChatRow = ({ msg, isMine }: { msg: ChatMessage; isMine: boolean }) => {
  const bands = useMemo<Bands>(
    () =>
      bandsFromIdentity({
        address: msg.address,
        handle: msg.handle,
        fallback: msg.id,
      }),
    [msg.address, msg.handle, msg.id],
  );
  const sourceTag = msg.source === "agent" ? "AGENT" : msg.source === "spectator" ? "SPECTATOR" : null;
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        opacity: msg.source === "spectator" ? 0.85 : 1,
      }}
    >
      {/* left stripe in the sender's band1 — instant identity at a glance */}
      <div
        aria-hidden
        style={{
          width: 3,
          minWidth: 3,
          alignSelf: "stretch",
          background: bands.band1,
          boxShadow: `0 0 6px ${bands.band1}`,
          borderRadius: 1,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: bands.band1,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {msg.address ? (
            <Address address={msg.address as AddressType} size="xs" onlyEnsOrAddress disableAddressLink />
          ) : (
            <span>{msg.handle ?? "anon"}</span>
          )}
          {isMine ? <span style={{ opacity: 0.7 }}>(you)</span> : null}
          {sourceTag ? (
            <span
              style={{
                fontSize: 9,
                padding: "0 4px",
                color: "var(--slop-text-muted)",
                border: "1px solid var(--slop-bevel-light, #4a4a4a)",
                letterSpacing: "0.06em",
              }}
            >
              {sourceTag}
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.4,
            color: "var(--slop-text)",
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
          }}
        >
          {msg.text}
        </div>
      </div>
    </div>
  );
};

export default ChatWindow;

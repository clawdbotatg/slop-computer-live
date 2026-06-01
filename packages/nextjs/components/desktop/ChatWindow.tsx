"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import { Button, SlopAddress } from "~~/components/ui";
import type { ChatMessage, PeerMeshState } from "~~/hooks/usePeerMesh";
import { useSyncedScroll } from "~~/hooks/useSyncedScroll";
import { useTip } from "~~/hooks/useTip";
import { type Bands, bandsFromIdentity } from "~~/utils/blockieBands";

export type ChatWindowProps = {
  messages: ChatMessage[];
  sendChat: (text: string) => void;
  myAddress: string | null;
  myHandle: string | null;
  customNames: Record<string, string>;
  mesh: PeerMeshState;
};

// Local-only notices (e.g. /help output, /block confirmations). Never sent
// to the relay or seen by other peers — merged into the scrollback by ts.
type Notice = { id: string; ts: number; text: string };

const CLIENT_HELP = [
  "slop chat commands —",
  "/me <action> · /slap <name> · /roll [NdM] · /flip",
  "/tip 0.001 base eth · /who · /music",
  "/url · /link · /address (/ca) · /tldr",
  "/code · /twitter · /help",
  "/block <name> · /unblock <name>",
  "(/block hides someone for you only)",
].join("\n");

// Per-viewer block list. Address/handle entries carry across rooms (you
// blocked that wallet); they're just lowercased tokens we match a sender
// against. Persisted so a refresh keeps your mutes.
const BLOCK_KEY = "slop.chat.blocked";

const loadBlocked = (): string[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(BLOCK_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const saveBlocked = (list: string[]): void => {
  try {
    window.localStorage.setItem(BLOCK_KEY, JSON.stringify(list));
  } catch {
    /* private mode / quota — mute just won't survive reload */
  }
};

// Stable identity token for a sender, lowercased. Address > anonId > handle.
const senderKey = (m: ChatMessage): string => (m.address ?? m.anonId ?? m.handle ?? "").toLowerCase();

const displayName = (m: ChatMessage, customNames: Record<string, string>): string => {
  const custom = customNames[(m.address ?? "").toLowerCase()] ?? customNames[m.anonId ?? ""];
  if (custom) return custom;
  if (m.handle) return m.handle;
  if (m.address) return `${m.address.slice(0, 6)}…${m.address.slice(-4)}`;
  return "anon";
};

// The chat panel body. The parent <Window> already supplies the title bar,
// drag/resize, and shell — this just paints the scrollback + composer.
export const ChatWindow = ({ messages, sendChat, myAddress, myHandle, customNames, mesh }: ChatWindowProps) => {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Per-viewer mutes — seeded straight from localStorage in the initializer
  // so a refresh never flashes blocked messages before a mount effect runs.
  const [blocked, setBlocked] = useState<string[]>(() => loadBlocked());
  useEffect(() => {
    saveBlocked(blocked);
  }, [blocked]);

  // Local-only command output (/help, /block, /tip progress, …).
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeSeq = useRef(0);
  const addNotice = (text: string) =>
    setNotices(prev => [...prev, { id: `n${noticeSeq.current++}`, ts: Date.now(), text }].slice(-50));

  // /tip: parse → pop wallet → send to multisig → announce. Progress shows
  // as local notices; the wallet popup + signing is all client-side.
  const requestTip = useTip(mesh);

  // Resolve a typed /block target to every stable key it should mute: the
  // raw token (matches by name even for senders not currently visible) plus
  // the senderKey of anyone in scrollback whose name/handle/address matches.
  const deriveBlockKeys = (target: string): string[] => {
    const t = target.toLowerCase();
    const keys = new Set<string>([t]);
    for (const m of messages) {
      if (
        displayName(m, customNames).toLowerCase() === t ||
        m.handle?.toLowerCase() === t ||
        m.address?.toLowerCase() === t
      ) {
        keys.add(senderKey(m));
      }
    }
    return [...keys];
  };

  const isBlocked = (m: ChatMessage, set: Set<string>): boolean =>
    set.has(senderKey(m)) ||
    (m.address ? set.has(m.address.toLowerCase()) : false) ||
    (m.handle ? set.has(m.handle.toLowerCase()) : false) ||
    set.has(displayName(m, customNames).toLowerCase());

  // Client-side commands: handled locally, never sent. Returns true if the
  // command was consumed (so it isn't forwarded to the relay).
  const handleLocalCommand = (text: string): boolean => {
    const parts = text.slice(1).split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase();
    const arg = parts.slice(1).join(" ").trim();
    switch (cmd) {
      case "help":
        addNotice(CLIENT_HELP);
        return true;
      case "block": {
        if (!arg) {
          addNotice(blocked.length ? `blocked: ${blocked.join(", ")}` : "nobody blocked. use /block <name>");
          return true;
        }
        setBlocked(prev => [...new Set([...prev, ...deriveBlockKeys(arg)])]);
        addNotice(`🚫 blocked ${arg} — /unblock ${arg} to undo`);
        return true;
      }
      case "unblock": {
        if (!arg) {
          addNotice("use /unblock <name>");
          return true;
        }
        const rm = new Set(deriveBlockKeys(arg));
        setBlocked(prev => prev.filter(b => !rm.has(b)));
        addNotice(`unblocked ${arg}`);
        return true;
      }
      case "tip": {
        if (!arg) {
          addNotice("usage: /tip 0.001 base eth");
          return true;
        }
        void requestTip(arg, addNotice);
        return true;
      }
      case "clear":
        setNotices([]);
        return true;
      default:
        return false;
    }
  };

  // Pin to bottom on new messages — but only if the user is already near
  // the bottom. Mid-scroll users shouldn't get yanked back when a new
  // message lands; that's a respectful chat default.
  const wasAtBottomRef = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Multiplayer scroll sync: peers follow whoever scrolled most
  // recently. Composes with the stick-to-bottom check above so both
  // behaviors coexist on every scroll event.
  const syncedOnScroll = useSyncedScroll(mesh, "chat", listRef);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    syncedOnScroll();
  };

  // When *you* send anything — chat, command, or local notice — force the
  // scrollback to the bottom so you see your own message land, even if you'd
  // scrolled up. Distinct from the respectful stick-to-bottom default above,
  // which only applies to *incoming* messages. Setting wasAtBottomRef also
  // keeps the relay's round-tripped echo pinned when it arrives.
  const forceScrollToBottom = () => {
    wasAtBottomRef.current = true;
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    // /help, /block, /unblock, /clear are viewer-local — handle without a
    // round-trip. Everything else (incl. server commands like /me, /roll)
    // goes to the relay.
    if (text.startsWith("/") && handleLocalCommand(text)) {
      setDraft("");
      forceScrollToBottom();
      return;
    }
    sendChat(text);
    setDraft("");
    forceScrollToBottom();
  };

  const myKey = (myAddress ?? myHandle ?? "").toLowerCase();

  // Filter mutes, fold in local notices, order everything by ts so commands
  // and chat interleave naturally.
  const rows = useMemo(() => {
    const set = new Set(blocked);
    const visible: ({ ts: number } & ({ msg: ChatMessage } | { notice: Notice }))[] = [
      ...messages.filter(m => !isBlocked(m, set)).map(m => ({ ts: m.ts, msg: m })),
      ...notices.map(n => ({ ts: n.ts, notice: n })),
    ];
    visible.sort((a, b) => a.ts - b.ts);
    return visible;
    // isBlocked closes over customNames/messages; listing the primitives we
    // actually read keeps the memo honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, notices, blocked, customNames]);

  return (
    <div
      id="slop-chat-window"
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
        {rows.length === 0 ? (
          <div
            style={{
              color: "var(--slop-text-muted)",
              fontSize: 12,
              fontStyle: "italic",
              padding: 12,
              textAlign: "center",
            }}
          >
            no messages yet — say hi · /help for commands
          </div>
        ) : (
          rows.map(row => {
            if ("notice" in row) return <SystemLine key={row.notice.id} text={row.notice.text} />;
            const m = row.msg;
            if (m.kind === "system") return <SystemLine key={m.id} text={m.text} />;
            const isMine = (m.address ?? m.handle ?? "").toLowerCase() === myKey && myKey !== "";
            return <ChatRow key={m.id} msg={m} isMine={isMine} customNames={customNames} />;
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

// Any full Ethereum address embedded in a system line (e.g. /address, /ca,
// /who). 40 hex chars — narrower than a 64-hex tx/keccak hash, so no false
// positives on those.
const ETH_ADDR_RE = /0x[a-fA-F0-9]{40}/g;

// Render a system line, swapping every 0x…address token for a proper
// <Address/> chip (ENS / blockie / copy) and linkifying the rest.
const renderSystemText = (text: string) => {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  ETH_ADDR_RE.lastIndex = 0;
  while ((m = ETH_ADDR_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={`s${i}`}>{linkify(text.slice(last, m.index))}</span>);
    parts.push(
      <span key={`a${i}`} style={{ display: "inline-flex", verticalAlign: "middle" }}>
        <Address address={m[0] as AddressType} size="xs" onlyEnsOrAddress disableAddressLink />
      </span>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (parts.length === 0) return linkify(text);
  if (last < text.length) parts.push(<span key={`s${i}`}>{linkify(text.slice(last))}</span>);
  return parts;
};

// Centered, dim italic line for /who, /music, /help, … and local notices.
const SystemLine = ({ text }: { text: string }) => (
  <div
    style={{
      textAlign: "center",
      color: "var(--slop-text-muted)",
      fontStyle: "italic",
      fontSize: 12,
      lineHeight: 1.4,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      padding: "2px 8px",
    }}
  >
    {renderSystemText(text)}
  </div>
);

const ChatRow = ({
  msg,
  isMine,
  customNames,
}: {
  msg: ChatMessage;
  isMine: boolean;
  customNames: Record<string, string>;
}) => {
  const isEmote = msg.kind === "emote";
  const bands = useMemo<Bands>(
    () =>
      bandsFromIdentity({
        address: msg.address,
        anonId: msg.anonId,
        handle: msg.handle,
        fallback: msg.id,
      }),
    [msg.address, msg.anonId, msg.handle, msg.id],
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
          <SlopAddress
            address={msg.address}
            handle={msg.handle}
            anonId={msg.anonId}
            fallback={msg.id}
            customNames={customNames}
          />
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
            color: isEmote ? "var(--slop-text-muted)" : "var(--slop-text)",
            fontStyle: isEmote ? "italic" : "normal",
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
          }}
        >
          {isEmote ? `✻ ${msg.text}` : linkify(msg.text)}
        </div>
      </div>
    </div>
  );
};

// Matches bare http(s)://… and www.… URLs. Trailing punctuation that's
// almost certainly sentence-terminal (.,!?;:) gets trimmed back so we
// don't eat the period at the end of "check out https://foo.com."
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

const linkify = (text: string) => {
  const parts: (string | { url: string; key: string })[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    let url = match[1];
    let tail = "";
    while (url.length > 0 && /[.,!?;:)\]}]/.test(url[url.length - 1])) {
      tail = url[url.length - 1] + tail;
      url = url.slice(0, -1);
    }
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push({ url, key: `u${i++}` });
    if (tail) parts.push(tail);
    lastIndex = match.index + match[1].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  if (parts.length === 0) return text;
  return parts.map((p, idx) => {
    if (typeof p === "string") return <span key={`s${idx}`}>{p}</span>;
    const href = p.url.startsWith("http") ? p.url : `https://${p.url}`;
    return (
      <a
        key={p.key}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "var(--slop-cyan, #00e5ff)", textDecoration: "underline" }}
      >
        {p.url}
      </a>
    );
  });
};

export default ChatWindow;

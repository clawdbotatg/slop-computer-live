"use client";

import { MobileChatTile } from "~~/components/mobile/MobileChatTile";
import { SlopAddress } from "~~/components/ui";
import type { GlossaryTerm, Note, PeerMeshState, TodoItem } from "~~/hooks/usePeerMesh";

// Dispatcher for open-app tiles on the mobile stage. Each app id maps
// to a mobile-friendly read-only renderer; apps without a renderer
// fall back to a placeholder block so the operator at least sees
// "yes, the window is open in the room." Per-app renderers are
// intentionally lightweight — mobile clips are a spectator view, no
// input affordances.
//
// Mapping mirrors DEFAULT_APPS in packages/relay/src/index.ts. If you
// add an app there with a useful mobile preview, add a case here.

export type MobileAppTileProps = {
  appId: string;
  mesh: PeerMeshState;
};

// AppIds that have a real, content-bearing mobile renderer below.
// MobileStage filters openWindowIds against this set so apps that
// would only render as a bare icon (research, card, etc.) are skipped
// entirely — an icon floating in a clip reads as broken, not "open."
// Keep in sync with the switch in MobileAppTile.
export const MOBILE_APP_RENDERERS = new Set(["chat", "todo", "notes", "glossary"]);

export const MobileAppTile = ({ appId, mesh }: MobileAppTileProps) => {
  switch (appId) {
    case "chat":
      return <MobileChatTile mesh={mesh} />;
    case "todo":
      return <MobileTodoTile mesh={mesh} />;
    case "notes":
      return <MobileNotesTile mesh={mesh} />;
    case "glossary":
      return <MobileGlossaryTile mesh={mesh} />;
    default:
      return <AppPlaceholder appId={appId} />;
  }
};

// --- Shared tile chrome --------------------------------------------------

type TileFrameProps = {
  label: string;
  children: React.ReactNode;
};

// Common chrome for every text-list tile so they read as a family:
// dark glass background, cyan small-caps header, scroll container.
const TileFrame = ({ label, children }: TileFrameProps) => (
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
      {label}
    </div>
    <div
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
      {children}
    </div>
  </div>
);

const EmptyHint = ({ text }: { text: string }) => (
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
    {text}
  </span>
);

// --- Todo ----------------------------------------------------------------

const MobileTodoTile = ({ mesh }: { mesh: PeerMeshState }) => {
  const items = mesh.todos.slice(0, 50);
  return (
    <TileFrame label={`todo · ${items.filter(t => !t.done).length} open`}>
      {items.length === 0 ? (
        <EmptyHint text="no todos yet" />
      ) : (
        items.map(t => <TodoRow key={t.id} item={t} customNames={mesh.customNames} />)
      )}
    </TileFrame>
  );
};

const TodoRow = ({ item, customNames }: { item: TodoItem; customNames: Record<string, string> }) => (
  <div style={{ display: "flex", alignItems: "flex-start", gap: 8, opacity: item.done ? 0.55 : 1 }}>
    <span
      aria-hidden
      style={{
        flexShrink: 0,
        width: 14,
        height: 14,
        borderRadius: 3,
        border: "1px solid rgba(63,207,255,0.55)",
        background: item.done ? "var(--slop-cyan, #3fcfff)" : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginTop: 2,
        color: "#000",
        fontSize: 10,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {item.done ? "✓" : ""}
    </span>
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
      <SlopAddress
        address={item.address ?? undefined}
        handle={item.handle ?? undefined}
        anonId={item.anonId ?? undefined}
        fallback={item.id}
        customNames={customNames}
      />
      <span
        style={{
          textDecoration: item.done ? "line-through" : undefined,
          wordBreak: "break-word",
        }}
      >
        {item.text}
      </span>
    </div>
  </div>
);

// --- Notes ---------------------------------------------------------------

const MobileNotesTile = ({ mesh }: { mesh: PeerMeshState }) => {
  // Show most recently updated first so the active conversation is
  // at the top, the same priority a desktop note-taker would scan.
  const items = [...mesh.notes].sort((a, b) => b.updatedTs - a.updatedTs).slice(0, 30);
  return (
    <TileFrame label={`notes · ${mesh.notes.length}`}>
      {items.length === 0 ? (
        <EmptyHint text="no notes yet" />
      ) : (
        items.map(n => <NoteRow key={n.id} note={n} customNames={mesh.customNames} />)
      )}
    </TileFrame>
  );
};

const NoteRow = ({ note, customNames }: { note: Note; customNames: Record<string, string> }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
    <SlopAddress
      address={note.address ?? undefined}
      handle={note.handle ?? undefined}
      anonId={note.anonId ?? undefined}
      fallback={note.id}
      customNames={customNames}
    />
    <span
      style={{
        wordBreak: "break-word",
        // Long notes truncate to 4 lines so one verbose entry can't
        // hog the whole tile.
        display: "-webkit-box",
        WebkitLineClamp: 4,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "pre-wrap",
      }}
    >
      {note.text}
    </span>
  </div>
);

// --- Glossary ------------------------------------------------------------

const MobileGlossaryTile = ({ mesh }: { mesh: PeerMeshState }) => {
  // Newest first — the AI definitions are useful in the moment a term
  // came up, less so for old ones, so reverse-chronological matches
  // the desktop sort order.
  const items = [...mesh.glossary].sort((a, b) => b.createdTs - a.createdTs).slice(0, 30);
  return (
    <TileFrame label={`glossary · ${mesh.glossary.length}`}>
      {items.length === 0 ? <EmptyHint text="no terms yet" /> : items.map(g => <GlossaryRow key={g.id} term={g} />)}
    </TileFrame>
  );
};

const GlossaryRow = ({ term }: { term: GlossaryTerm }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
    <span
      style={{
        fontFamily: "var(--slop-font-display)",
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--slop-magenta, #ff3ec9)",
      }}
    >
      {term.term}
      {term.status === "pending" ? (
        <span style={{ color: "var(--slop-text-muted)", marginLeft: 6 }}>· loading…</span>
      ) : term.status === "error" ? (
        <span style={{ color: "var(--slop-text-muted)", marginLeft: 6 }}>· failed</span>
      ) : null}
    </span>
    {term.status === "ready" ? (
      <span
        style={{
          wordBreak: "break-word",
          display: "-webkit-box",
          WebkitLineClamp: 4,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {term.tldr}
      </span>
    ) : null}
  </div>
);

// --- Placeholder ---------------------------------------------------------

type AppPlaceholderProps = { appId: string };

// Generic stand-in for apps that don't have a dedicated mobile
// renderer yet. Shows the icon + label so the operator can see what's
// open in the room without us having to ship 20+ bespoke views.
const AppPlaceholder = ({ appId }: AppPlaceholderProps) => (
  <div
    style={{
      width: "100%",
      height: "100%",
      background: "linear-gradient(180deg, rgba(6,8,24,0.92) 0%, rgba(12,4,28,0.92) 100%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      color: "var(--slop-text)",
    }}
  >
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img
      src={iconPathFor(appId)}
      alt=""
      width={56}
      height={56}
      style={{ imageRendering: "pixelated", filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.65))" }}
    />
    <span
      style={{
        fontFamily: "var(--slop-font-display)",
        fontSize: 12,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--slop-text)",
      }}
    >
      {appId}
    </span>
    <span
      style={{
        fontFamily: "var(--slop-font-display)",
        fontSize: 8,
        letterSpacing: "0.10em",
        textTransform: "uppercase",
        color: "var(--slop-text-muted)",
      }}
    >
      window open
    </span>
  </div>
);

// AppId → public icon path, mirroring DEFAULT_APPS in the relay. Falls
// back to a generic icon for ids we don't recognize so an unknown
// window still renders something.
function iconPathFor(appId: string): string {
  const map: Record<string, string> = {
    chat: "/icons/chat.png",
    video: "/icons/video.png",
    audio: "/icons/mic.png",
    screen: "/icons/screen-sharing.png",
    music: "/icons/music.png",
    chess: "/icons/chess.png",
    pong: "/icons/pong.png",
    worm: "/icons/worm.png",
    browser: "/icons/browser.png",
    "abi-ninja": "/icons/ninja.png",
    "nifty-ink": "/icons/paint.png",
    qr: "/icons/qr.png",
    todo: "/icons/todo.png",
    notes: "/icons/notes.png",
    glossary: "/icons/glossary.png",
    gas: "/icons/gas.png",
    clock: "/icons/clock.png",
    wallet: "/icons/wallet.png",
    ens: "/icons/ens.png",
    research: "/icons/research.png",
    news: "/icons/news.png",
    transcript: "/icons/transcript.png",
    card: "/icons/card.png",
  };
  return map[appId] ?? "/icons/browser.png";
}

export default MobileAppTile;

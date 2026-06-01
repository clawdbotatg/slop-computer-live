"use client";

import { MobileChatTile } from "~~/components/mobile/MobileChatTile";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";

// Dispatcher for open-app tiles on the mobile stage. Each app id maps
// to a mobile-friendly read-only renderer; apps without a renderer
// fall back to a placeholder block so the operator at least sees
// "yes, the wallet window is open in the room." Per-app renderers
// are intentionally lightweight — mobile clips are a spectator view,
// no input affordances.
//
// Mapping mirrors DEFAULT_APPS in packages/relay/src/index.ts. If you
// add an app there with a useful mobile preview, add a case here.

export type MobileAppTileProps = {
  appId: string;
  mesh: PeerMeshState;
};

export const MobileAppTile = ({ appId, mesh }: MobileAppTileProps) => {
  if (appId === "chat") return <MobileChatTile mesh={mesh} />;
  return <AppPlaceholder appId={appId} />;
};

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

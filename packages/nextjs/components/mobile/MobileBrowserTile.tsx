"use client";

import { useEffect, useRef, useState } from "react";
import { useRoomSlug } from "~~/lib/room-slug";

// View-only browser preview for the mobile clip stage. Subscribes to
// the same browser-host /stream/:id WebSocket the desktop's
// SharedBrowser uses and renders the latest JPEG frame as an <img>.
//
// Why not just iframe the URL? Most popular sites (x.com, Uniswap,
// anything with `X-Frame-Options: deny` or a strict CSP) refuse to
// load in an iframe. The screenshot stream sidesteps that entirely
// AND pixel-matches what the room is seeing — same Puppeteer tab,
// same impersonator, same chain.
//
// Connect rules from the browser-host WS handler:
//   * First subscriber for a brand-new tab picks the initial
//     impersonator + chainId from query params.
//   * SUBSEQUENT subscribers (us) inherit the existing tab's state —
//     our query params are ignored. So passing 0x0…0 / chainId 1 is
//     safe even if the room is on Base with a real impersonator.
// `hello` arrives on connect with the actual current state; we
// surface it for the badge but otherwise ignore it.

const BROWSER_HOST_URL = process.env.NEXT_PUBLIC_BROWSER_HOST_URL ?? "ws://localhost:8090";
const NEUTRAL_IMPERSONATOR = "0x0000000000000000000000000000000000000000";

export type MobileBrowserTileProps = {
  /** Browser id from `mesh.browsers` — keys the host tab. */
  id: string;
  url: string;
  /** Bottom-right corner gets a small host tag so a clip viewer can
   *  tell the tile is a webpage (and which one). */
  showBadge?: boolean;
};

export const MobileBrowserTile = ({ id, url, showBadge = true }: MobileBrowserTileProps) => {
  const slug = useRoomSlug();
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  const wsRef = useRef<WebSocket | null>(null);

  // (Re)open the stream whenever id or url changes. URL changes flow
  // through mesh.browsers; we send a `navigate` to keep the host on
  // the right URL since our connect param is only used on first-tab.
  useEffect(() => {
    const params = new URLSearchParams({
      url,
      impersonated: NEUTRAL_IMPERSONATOR,
      chainId: "1",
      slug,
    });
    const wsUrl = `${BROWSER_HOST_URL}/stream/${encodeURIComponent(id)}?${params.toString()}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setConnState("connecting");

    ws.onopen = () => setConnState("open");
    ws.onclose = () => {
      setConnState("closed");
      if (wsRef.current === ws) wsRef.current = null;
    };
    ws.onerror = () => setConnState("closed");
    ws.onmessage = ev => {
      let msg: { type?: string; data?: unknown };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.type === "frame" && typeof msg.data === "string") {
        setFrameSrc(`data:image/jpeg;base64,${msg.data}`);
      }
    };

    return () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [id, url, slug]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
      {frameSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={frameSrc}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            // The browser-host renders at 1280×800. `contain` preserves
            // that aspect inside whatever tile we get — letterbox bars
            // on the sides for portrait clips, on top/bottom for
            // landscape. Avoids the awful aspect-stretch.
            objectFit: "contain",
            background: "#000",
            pointerEvents: "none",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--slop-text-muted)",
            fontFamily: "var(--slop-font-display)",
            fontSize: 11,
            letterSpacing: "0.10em",
            textTransform: "uppercase",
          }}
        >
          {connState === "open" ? "waiting for frame…" : connState === "closed" ? "stream closed" : "connecting…"}
        </div>
      )}
      {showBadge ? (
        <div
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            padding: "2px 6px",
            background: "rgba(6,8,24,0.78)",
            border: "1px solid rgba(63,207,255,0.40)",
            borderRadius: 3,
            fontFamily: "var(--slop-font-display)",
            fontSize: 9,
            letterSpacing: "0.10em",
            textTransform: "uppercase",
            color: "var(--slop-cyan, #3fcfff)",
            pointerEvents: "none",
            maxWidth: "60%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            zIndex: 3,
          }}
          title={url}
        >
          {hostFromUrl(url)}
        </div>
      ) : null}
    </div>
  );
};

function hostFromUrl(input: string): string {
  try {
    return new URL(input).host;
  } catch {
    return "browser";
  }
}

export default MobileBrowserTile;

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import { Button, TextField } from "~~/components/ui";
import type { Browser, TxRequest } from "~~/hooks/usePeerMesh";

// Hardcoded for v1. Eventually this is the slop-computer smart-contract
// wallet address; for now we impersonate vitalik so the UI has someone real
// to point at on chain.
export const IMPERSONATED_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as AddressType;

const BROWSER_HOST_URL = process.env.NEXT_PUBLIC_BROWSER_HOST_URL ?? "ws://localhost:8090";

// Server viewport — must match VIEWPORT_WIDTH / VIEWPORT_HEIGHT on the host.
// Inputs are sent in *server* coordinates so we scale client → server before
// emitting them.
const SERVER_W = 1280;
const SERVER_H = 800;

const isHttpUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const normaliseUrl = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return "about:blank";
  if (isHttpUrl(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+/.test(trimmed)) return `https://${trimmed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
};

export type SharedBrowserProps = {
  browser: Browser;
  txRequests: TxRequest[];
  onNavigate: (url: string) => void;
  canControl: boolean;
};

export const SharedBrowser = ({ browser, txRequests, onNavigate, canControl }: SharedBrowserProps) => {
  const [draft, setDraft] = useState(browser.url);
  const lastSeenUrlRef = useRef(browser.url);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [showTxPanel, setShowTxPanel] = useState(false);
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  // Tx requests captured directly from the browser-host WS — distinct from
  // the cross-peer txRequests prop which arrives via the relay. We merge
  // both for display so peers without a host subscription still see them.
  const [hostTxRequests, setHostTxRequests] = useState<TxRequest[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Keep the URL bar in sync with shared state, but don't clobber what the
  // user is in the middle of typing.
  useEffect(() => {
    if (browser.url !== lastSeenUrlRef.current) {
      lastSeenUrlRef.current = browser.url;
      setDraft(browser.url);
    }
  }, [browser.url]);

  // Connect to the browser-host's stream for this browser id. On every
  // shared-state URL change we send a "navigate" message so the headless
  // tab follows the URL bar.
  useEffect(() => {
    const url = `${BROWSER_HOST_URL}/stream/${encodeURIComponent(browser.id)}?url=${encodeURIComponent(browser.url)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => setConnState("open");
    ws.onclose = () => {
      setConnState("closed");
      if (wsRef.current === ws) wsRef.current = null;
    };
    ws.onerror = () => setConnState("closed");
    ws.onmessage = ev => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.type === "frame" && typeof msg.data === "string") {
        setFrameSrc(`data:image/jpeg;base64,${msg.data}`);
        return;
      }
      if (msg.type === "tx_request") {
        const method = typeof msg.method === "string" ? msg.method : "";
        const params = Array.isArray(msg.params) ? msg.params : [];
        let to: string | null = null;
        let value: string | null = null;
        let calldata = "";
        if (method === "eth_sendTransaction" && params[0] && typeof params[0] === "object") {
          const tx = params[0] as { to?: unknown; value?: unknown; data?: unknown };
          to = typeof tx.to === "string" ? tx.to : null;
          value = typeof tx.value === "string" ? tx.value : null;
          calldata = typeof tx.data === "string" ? tx.data : JSON.stringify(tx);
        } else {
          calldata = JSON.stringify({ method, params });
        }
        const next: TxRequest = {
          from: "browser-host",
          browserId: browser.id,
          calldata,
          to,
          value,
          chainId: null,
          receivedAt: Date.now(),
        };
        setHostTxRequests(prev => [next, ...prev].slice(0, 50));
        return;
      }
    };
    return () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
    // We intentionally only re-subscribe on browser.id, not browser.url —
    // URL changes are sent as navigate messages over the existing WS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser.id]);

  // Reflect URL changes from the shared mesh state to the headless tab.
  useEffect(() => {
    if (connState !== "open") return;
    const ws = wsRef.current;
    if (!ws) return;
    ws.send(JSON.stringify({ type: "navigate", url: browser.url }));
  }, [browser.url, connState]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canControl) return;
    const next = normaliseUrl(draft);
    onNavigate(next);
  };

  const reload = () => {
    if (!canControl) return;
    onNavigate(browser.url);
  };

  // ---- Input forwarding ----------------------------------------------------
  // The frame is rendered with object-fit: contain so it preserves the
  // server viewport's aspect ratio (1280:800) regardless of how the user has
  // resized the surrounding Window. Clicks in the letterbox bars map to no
  // valid server coordinate and are dropped; clicks within the image area
  // are scaled into server space.
  const computeImageRect = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    const targetAspect = SERVER_W / SERVER_H;
    const stageAspect = rect.width / rect.height;
    let imgW: number;
    let imgH: number;
    if (stageAspect > targetAspect) {
      // Stage is wider than the image — bars on left/right.
      imgH = rect.height;
      imgW = imgH * targetAspect;
    } else {
      // Stage is taller — bars on top/bottom.
      imgW = rect.width;
      imgH = imgW / targetAspect;
    }
    const offsetX = rect.left + (rect.width - imgW) / 2;
    const offsetY = rect.top + (rect.height - imgH) / 2;
    return { offsetX, offsetY, imgW, imgH };
  }, []);

  const toServerCoords = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const r = computeImageRect();
      if (!r) return null;
      const localX = e.clientX - r.offsetX;
      const localY = e.clientY - r.offsetY;
      if (localX < 0 || localX > r.imgW || localY < 0 || localY > r.imgH) return null;
      return {
        x: (localX / r.imgW) * SERVER_W,
        y: (localY / r.imgH) * SERVER_H,
      };
    },
    [computeImageRect],
  );

  const sendInput = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    if (!canControl) return;
    const c = toServerCoords(e);
    if (!c) return;
    sendInput({
      type: "mouse",
      event: "down",
      x: c.x,
      y: c.y,
      button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
    });
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if (!canControl) return;
    const c = toServerCoords(e);
    if (!c) return;
    sendInput({
      type: "mouse",
      event: "up",
      x: c.x,
      y: c.y,
      button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
    });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!canControl) return;
    const c = toServerCoords(e);
    if (!c) return;
    sendInput({ type: "mouse", event: "move", x: c.x, y: c.y, button: "none" });
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!canControl) return;
    const c = toServerCoords(e);
    if (!c) return;
    sendInput({ type: "wheel", x: c.x, y: c.y, deltaX: e.deltaX, deltaY: e.deltaY });
  };
  // Capture key events on the stage when it has focus. Key events are
  // captured at the element level rather than window so typing in our URL
  // bar doesn't get swallowed by the iframe stand-in.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!canControl) return;
    sendInput({
      type: "key",
      event: "down",
      key: e.key,
      code: e.code,
      modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0),
    });
    if (e.key.length === 1) {
      sendInput({ type: "key", event: "char", key: e.key, code: e.code, text: e.key });
    }
    e.preventDefault();
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (!canControl) return;
    sendInput({
      type: "key",
      event: "up",
      key: e.key,
      code: e.code,
      modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0),
    });
    e.preventDefault();
  };

  const txList = useMemo(() => {
    // Merge mesh-broadcast and host-direct streams. De-dupe on (calldata, to)
    // since the same tx comes via both paths once relay forwarding is on.
    const seen = new Set<string>();
    const out: TxRequest[] = [];
    for (const tx of [...hostTxRequests, ...txRequests]) {
      const key = `${tx.calldata}|${tx.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tx);
      if (out.length >= 10) break;
    }
    return out;
  }, [txRequests, hostTxRequests]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0a0612" }}>
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          gap: 6,
          padding: 6,
          background: "var(--slop-panel)",
          borderBottom: "1px solid rgba(255,62,201,0.2)",
        }}
      >
        <Button onClick={reload} aria-label="Reload">
          ↻
        </Button>
        <TextField
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="https://example.com"
          spellCheck={false}
          style={{ flex: 1 }}
          disabled={!canControl}
        />
        <Button variant="primary" type="submit" disabled={!canControl}>
          Go
        </Button>
      </form>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          fontSize: 11,
          color: "var(--slop-text-muted)",
          background: "rgba(255,62,201,0.06)",
          borderBottom: "1px solid rgba(255,62,201,0.15)",
        }}
        title="Wallet calls are intercepted server-side and impersonated as this address. Calldata appears below — nothing is signed."
      >
        <span style={{ color: connState === "open" ? "var(--slop-magenta, #ff3ec9)" : "#888" }}>◉</span>
        <span>Impersonating</span>
        <Address address={IMPERSONATED_ADDRESS} size="xs" onlyEnsOrAddress />
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--slop-text-muted)" }}>{connState}</span>
        <button
          type="button"
          onClick={() => setShowTxPanel(v => !v)}
          style={{
            background: "transparent",
            border: 0,
            color: "inherit",
            cursor: "pointer",
            font: "inherit",
            padding: 0,
            marginLeft: 8,
          }}
        >
          {txList.length} tx {showTxPanel ? "▾" : "▸"}
        </button>
      </div>

      {showTxPanel ? (
        <div
          style={{
            maxHeight: 160,
            overflow: "auto",
            background: "#06030d",
            borderBottom: "1px solid rgba(255,62,201,0.15)",
            fontFamily: "monospace",
            fontSize: 10,
            color: "var(--slop-text)",
          }}
        >
          {txList.length === 0 ? (
            <div style={{ padding: 8, color: "var(--slop-text-muted)" }}>
              no tx captured yet — interact with the dapp to see calldata here
            </div>
          ) : (
            txList.map((tx, i) => (
              <div
                key={i}
                style={{
                  padding: 8,
                  borderBottom: i === txList.length - 1 ? "none" : "1px dashed rgba(255,62,201,0.15)",
                }}
              >
                <div style={{ color: "var(--slop-text-muted)", marginBottom: 2 }}>
                  to {tx.to ? `${tx.to.slice(0, 10)}…${tx.to.slice(-4)}` : "—"}
                  {tx.value && tx.value !== "0x0" ? ` · value ${tx.value}` : ""}
                  {tx.chainId !== null ? ` · chain ${tx.chainId}` : ""}
                </div>
                <div style={{ wordBreak: "break-all" }}>{tx.calldata}</div>
              </div>
            ))
          )}
        </div>
      ) : null}

      <div
        ref={stageRef}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onContextMenu={e => e.preventDefault()}
        tabIndex={0}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          // Letterbox bars when the window aspect doesn't match 1280:800.
          background: "#06030d",
          outline: "none",
          cursor: canControl ? "default" : "not-allowed",
        }}
      >
        {frameSrc ? (
          <img
            src={frameSrc}
            alt=""
            draggable={false}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              // contain preserves the server's 1280:800 aspect ratio; the
              // input handlers compute the active image rect and drop clicks
              // landing in the letterbox bars.
              objectFit: "contain",
              userSelect: "none",
              pointerEvents: "none",
            }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--slop-text-muted)",
              fontFamily: "monospace",
              fontSize: 12,
            }}
          >
            {connState === "open" ? "loading…" : connState === "connecting" ? "connecting…" : "browser-host offline"}
          </div>
        )}
      </div>
    </div>
  );
};

export default SharedBrowser;

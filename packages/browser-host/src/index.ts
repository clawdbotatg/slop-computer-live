// Browser host: a single headless Chrome that any number of clients can
// watch and drive over a WebSocket. Not a generic remote-Chrome service —
// the only goal is "shared dapp window with vitalik.eth as the wallet."
//
// One tab per browser-id. Frontends connect to /stream/:id; the first
// connection that includes a `url` query string starts a tab. Subsequent
// clients on the same id share the same tab. When the last client leaves,
// the tab is kept warm for 30s so quick reconnects don't lose state.

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { Browser, CDPSession, Page } from "puppeteer";
import puppeteerVanilla from "puppeteer";
// puppeteer-extra wraps the same Chromium puppeteer downloads, then layers
// the stealth plugin which patches ~20 fingerprint vectors (navigator.webdriver,
// chrome.runtime, plugin array, permissions API, languages, etc.) that
// Cloudflare/Turnstile/Datadome use to flag headless Chrome.
//
// Both packages are CommonJS — we await dynamic imports at top level to
// pull `.default` cleanly and apply the plugin once.
const puppeteerExtraMod = (await import("puppeteer-extra")) as unknown as {
  default: { use: (p: unknown) => void } & typeof puppeteerVanilla;
};
const StealthPluginMod = (await import("puppeteer-extra-plugin-stealth")) as unknown as {
  default: () => unknown;
};
const puppeteer = puppeteerExtraMod.default;
puppeteer.use(StealthPluginMod.default());
import type { WebSocket } from "ws";
import { config, upstreamRpcUrl } from "./config.js";
import { PROVIDER_INJECT_SCRIPT } from "./inject.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 256 * 1024,
});

await app.register(cors, {
  origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
  credentials: true,
});
await app.register(websocket);

let browser: Browser | null = null;
let browserBootPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
  if (browserBootPromise) return browserBootPromise;
  browserBootPromise = (async () => {
    const b = await puppeteer.launch({
      // headless: true is "new headless" in puppeteer >=22 — a full Chrome
      // with no UI rather than the old chrome-headless-shell binary that
      // Cloudflare can fingerprint trivially.
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--mute-audio",
        "--disable-blink-features=AutomationControlled",
        // Realistic locale; avoids the "C" locale that headless defaults to.
        "--lang=en-US,en",
        // Keep background tabs/windows actively rendering. Without these
        // Chromium pauses non-foreground pages and Page.startScreencast
        // stops emitting frames the moment a second tab is opened.
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=CalculateNativeWinOcclusion,IsolateOrigins,site-per-process",
        `--window-size=${config.viewport.width},${config.viewport.height}`,
      ],
      defaultViewport: {
        width: config.viewport.width,
        height: config.viewport.height,
        deviceScaleFactor: 1,
      },
      ignoreDefaultArgs: ["--enable-automation"],
    });
    app.log.info(`puppeteer launched`);
    browser = b;
    browserBootPromise = null;
    return b;
  })();
  return browserBootPromise;
}

type Tab = {
  id: string;
  page: Page;
  cdp: CDPSession;
  url: string;
  subscribers: Set<WebSocket>;
  shutdownTimer: NodeJS.Timeout | null;
};

const tabs = new Map<string, Tab>();
const tabBoots = new Map<string, Promise<Tab>>();

// Map a KeyboardEvent.key value to the legacy "windows virtual key code"
// CDP expects. Without it, Chrome treats special keys (Backspace, Delete,
// Tab, Enter, arrows) as keyCode=0 and the input element ignores them.
const SPECIAL_VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

function virtualKeyCode(key: string): number {
  if (SPECIAL_VK[key] !== undefined) return SPECIAL_VK[key]!;
  // Letters and digits: keyCode is the uppercase ASCII code. e.key for the
  // 'a' key is 'a' (or 'A' with shift); both map to keyCode 65.
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

const send = (ws: WebSocket, msg: unknown) => {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }
};

const broadcastTab = (tab: Tab, msg: unknown) => {
  for (const ws of tab.subscribers) send(ws, msg);
};

async function forwardTxToRelay(tab: Tab, payload: unknown): Promise<void> {
  if (!config.relayTxBroadcastUrl) return;
  try {
    await fetch(config.relayTxBroadcastUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.relayTxBroadcastSecret ? { authorization: `Bearer ${config.relayTxBroadcastSecret}` } : {}),
      },
      body: JSON.stringify({ browserId: tab.id, payload }),
    });
  } catch (err) {
    app.log.warn({ err }, "failed to forward tx to relay");
  }
}

async function createTab(id: string, url: string): Promise<Tab> {
  const b = await getBrowser();
  const page = await b.newPage();

  await page.setViewport({
    width: config.viewport.width,
    height: config.viewport.height,
    deviceScaleFactor: 1,
  });

  // Inject window.ethereum *before* any of the dapp's scripts. This is the
  // whole point of the browser-host — same-origin code runs against our
  // fake provider before MetaMask, EIP-6963 listeners, etc. ever fire.
  await page.evaluateOnNewDocument(PROVIDER_INJECT_SCRIPT(config.impersonatedAddress, config.chainId));

  page.on("console", msg => {
    const t = msg.type();
    if (t === "error" || t === "warn") app.log.info({ id, t, text: msg.text().slice(0, 300) }, "page-console");
  });
  page.on("pageerror", err => {
    const message = err instanceof Error ? err.message : String(err);
    app.log.warn({ id, err: message }, "page-error");
  });

  // The injected provider's `fetch("/__slop_rpc", ...)` call is intercepted
  // here and proxied to Alchemy. By doing this on the request side we
  // never expose the upstream URL or API key to the page.
  await page.setRequestInterception(true);
  page.on("request", req => {
    const reqUrl = req.url();
    if (reqUrl.endsWith("/__slop_rpc")) {
      const post = req.postData() ?? "{}";
      void (async () => {
        try {
          const upstream = await fetch(upstreamRpcUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: post,
          });
          const text = await upstream.text();
          await req.respond({
            status: upstream.status,
            contentType: "application/json",
            body: text,
          });
        } catch (err) {
          app.log.warn({ err }, "rpc proxy failed");
          await req.respond({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "rpc proxy failed" } }),
          });
        }
      })();
      return;
    }
    void req.continue();
  });

  const cdp = await page.target().createCDPSession();

  // CDP binding — calls to `__slopTxRequest(json)` from the page surface as
  // Runtime.bindingCalled events here. We rebroadcast to subscribers and
  // optionally POST to the relay so peers in other tabs see the calldata.
  await cdp.send("Runtime.enable");
  await cdp.send("Runtime.addBinding", { name: "__slopTxRequest" });
  cdp.on("Runtime.bindingCalled", evt => {
    if (evt.name !== "__slopTxRequest") return;
    let parsed: { method?: string; params?: unknown } = {};
    try {
      parsed = JSON.parse(evt.payload);
    } catch {
      return;
    }
    const tab = tabs.get(id);
    if (!tab) return;
    app.log.info({ id, method: parsed.method }, "tx_request captured");
    broadcastTab(tab, { type: "tx_request", method: parsed.method, params: parsed.params });
    void forwardTxToRelay(tab, parsed);
  });

  await cdp.send("Page.enable");

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: config.screencast.quality,
    maxWidth: config.screencast.maxWidth,
    maxHeight: config.screencast.maxHeight,
    everyNthFrame: config.screencast.everyNthFrame,
  });

  cdp.on("Page.screencastFrame", async evt => {
    const tab = tabs.get(id);
    if (!tab) return;
    broadcastTab(tab, { type: "frame", data: evt.data, sessionId: evt.sessionId });
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: evt.sessionId });
    } catch {
      /* tab closed */
    }
  });

  // Surface URL changes (in-page nav) so the URL bar across all peers
  // updates. We don't echo this back to the relay yet — the URL bar
  // updates are local-only for v1.
  page.on("framenavigated", frame => {
    if (frame !== page.mainFrame()) return;
    const next = page.url();
    const tab = tabs.get(id);
    if (!tab) return;
    if (next === tab.url) return;
    tab.url = next;
    broadcastTab(tab, { type: "url", url: next });
  });

  const tab: Tab = { id, page, cdp, url, subscribers: new Set(), shutdownTimer: null };
  tabs.set(id, tab);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    app.log.warn({ err, url }, "initial navigation failed");
  }
  tab.url = page.url();

  return tab;
}

async function destroyTab(id: string): Promise<void> {
  const tab = tabs.get(id);
  if (!tab) return;
  tabs.delete(id);
  try {
    await tab.cdp.send("Page.stopScreencast").catch(() => undefined);
  } catch {
    /* ignore */
  }
  try {
    await tab.page.close({ runBeforeUnload: false });
  } catch {
    /* ignore */
  }
  for (const ws of tab.subscribers) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  app.log.info({ id }, "tab destroyed");
}

const TAB_LINGER_MS = 30_000;

function scheduleShutdown(tab: Tab) {
  if (tab.shutdownTimer) clearTimeout(tab.shutdownTimer);
  tab.shutdownTimer = setTimeout(() => {
    if (tab.subscribers.size === 0) void destroyTab(tab.id);
  }, TAB_LINGER_MS);
}

function cancelShutdown(tab: Tab) {
  if (tab.shutdownTimer) {
    clearTimeout(tab.shutdownTimer);
    tab.shutdownTimer = null;
  }
}

// ---- HTTP -----------------------------------------------------------------

app.get("/health", async () => ({
  ok: true,
  service: "slop-browser-host",
  tabs: tabs.size,
  impersonating: config.impersonatedAddress,
}));

// ---- WS /stream/:id -------------------------------------------------------

app.register(async function (fastify) {
  fastify.get<{ Params: { id: string }; Querystring: { url?: string } }>(
    "/stream/:id",
    { websocket: true },
    async (socket, req) => {
      const id = req.params.id;
      const initialUrl = req.query.url ?? "about:blank";
      let tab = tabs.get(id);
      if (!tab) {
        // Coalesce concurrent subscribers so we don't launch N tabs for the
        // same browser id. The first subscriber wins; everyone else awaits.
        let boot = tabBoots.get(id);
        if (!boot) {
          boot = createTab(id, initialUrl).finally(() => tabBoots.delete(id));
          tabBoots.set(id, boot);
        }
        try {
          tab = await boot;
        } catch (err) {
          app.log.error({ err }, "createTab failed");
          send(socket, { type: "error", error: "tab_create_failed" });
          socket.close(1011);
          return;
        }
      }
      cancelShutdown(tab);
      tab.subscribers.add(socket);
      send(socket, { type: "hello", id, url: tab.url });

      socket.on("message", (raw: Buffer | string) => {
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!tab) return;
        switch (msg.type) {
          case "navigate": {
            if (typeof msg.url !== "string") return;
            void tab.page.goto(msg.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(err => {
              app.log.warn({ err, url: msg.url }, "navigate failed");
            });
            return;
          }
          case "mouse": {
            const x = Number(msg.x);
            const y = Number(msg.y);
            const buttonRaw = (msg.button as string) ?? "left";
            const button: "left" | "right" | "middle" | "none" =
              buttonRaw === "right" ? "right" : buttonRaw === "middle" ? "middle" : buttonRaw === "none" ? "none" : "left";
            const event = (msg.event as string) ?? "click";
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            const cdpType: "mousePressed" | "mouseReleased" | "mouseMoved" =
              event === "down"
                ? "mousePressed"
                : event === "up"
                  ? "mouseReleased"
                  : event === "move"
                    ? "mouseMoved"
                    : "mousePressed";
            void tab.cdp
              .send("Input.dispatchMouseEvent", {
                type: cdpType,
                x,
                y,
                button,
                buttons: button === "left" ? 1 : button === "right" ? 2 : button === "middle" ? 4 : 0,
                clickCount: event === "down" || event === "up" ? 1 : 0,
              })
              .catch(() => undefined);
            return;
          }
          case "wheel": {
            const x = Number(msg.x);
            const y = Number(msg.y);
            const dx = Number(msg.deltaX ?? 0);
            const dy = Number(msg.deltaY ?? 0);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            void tab.cdp
              .send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x,
                y,
                deltaX: dx,
                deltaY: dy,
                button: "none" as const,
                buttons: 0,
              })
              .catch(() => undefined);
            return;
          }
          case "key": {
            const event = (msg.event as string) ?? "down";
            const key = String(msg.key ?? "");
            const code = String(msg.code ?? "");
            const text = typeof msg.text === "string" ? msg.text : undefined;
            const cdpType: "keyDown" | "keyUp" | "char" =
              event === "down" ? "keyDown" : event === "up" ? "keyUp" : "char";
            // CDP's Input.dispatchKeyEvent ignores special keys (Backspace,
            // Delete, arrows, etc.) unless we also send the legacy
            // windowsVirtualKeyCode. Without it Chrome sees keyCode=0 and
            // the input element's default handler (delete-char-left/right,
            // move caret, submit, etc.) never fires.
            const vk = cdpType === "char" ? 0 : virtualKeyCode(key);
            void tab.cdp
              .send("Input.dispatchKeyEvent", {
                type: cdpType,
                key,
                code,
                text,
                modifiers: Number(msg.modifiers ?? 0),
                windowsVirtualKeyCode: vk,
                nativeVirtualKeyCode: vk,
              })
              .catch(() => undefined);
            return;
          }
          case "ping":
            send(socket, { type: "pong" });
            return;
        }
      });

      socket.on("close", () => {
        if (!tab) return;
        tab.subscribers.delete(socket);
        if (tab.subscribers.size === 0) scheduleShutdown(tab);
      });
    },
  );
});

// ---- Boot -----------------------------------------------------------------

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    app.log.info(
      `slop-browser-host listening on http://${config.host}:${config.port} — impersonating ${config.impersonatedAddress} on chain ${config.chainId}`,
    );
  })
  .catch(err => {
    app.log.error(err);
    process.exit(1);
  });

const shutdown = async (signal: NodeJS.Signals) => {
  app.log.info(`received ${signal} — shutting down`);
  for (const id of [...tabs.keys()]) await destroyTab(id);
  if (browser && browser.connected) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

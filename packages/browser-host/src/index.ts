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
import { config, isSupportedChain, SUPPORTED_CHAINS, upstreamRpcUrl } from "./config.js";
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
  /** Address the injected provider claims to be. Per-tab so each browser
   *  window can impersonate something different (deployed wallet, peer
   *  address, custom). Changed by the `set_impersonator` WS message,
   *  which destroys + recreates the tab with a new value. */
  impersonatedAddress: string;
  /** Chain the injected provider reports + RPC proxy targets. Per-tab so
   *  each window can sit on a different network. Changed by the
   *  `set_chain` WS message (user-initiated from the selector) or by
   *  the dapp calling `wallet_switchEthereumChain` (EIP-3326), both of
   *  which destroy + recreate the tab. */
  chainId: number;
  subscribers: Set<WebSocket>;
  shutdownTimer: NodeJS.Timeout | null;
  /** Wall-clock ms when the most recent frame was emitted. Used by
   *  /diag/:id to spot frozen tabs. */
  lastFrameAt: number;
  /** Wall-clock ms of the most recent input event (key / mouse / wheel).
   *  Watchdog only restarts the screencast when input came AFTER the
   *  last frame — otherwise a static page would keep getting kicked. */
  lastInputAt: number;
  /** True once we've seen a renderer crash / process death on this tab.
   *  Reload requests on a crashed tab go straight to "destroy + recreate". */
  crashed: boolean;
};

// EIP-55 / checksum-agnostic 0x40 hex check. Anything that doesn't match
// falls back to the configured default — we never reflect untrusted
// strings into the injected provider verbatim.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
function sanitizeImpersonator(raw: unknown): string {
  if (typeof raw !== "string") return config.impersonatedAddress;
  return ADDRESS_RE.test(raw) ? raw : config.impersonatedAddress;
}

const tabs = new Map<string, Tab>();
const tabBoots = new Map<string, Promise<Tab>>();

// Map a KeyboardEvent.code value (the physical key, unambiguous regardless
// of Shift state or layout) to the legacy "windows virtual key code" that
// Chrome's input handler expects. Without it, Chrome's input element
// ignores the keystroke (special keys), or — worse — interprets it as the
// wrong key (e.g. punctuation whose ASCII value collides with a special
// key's VK: '.' is ASCII 46, which is also VK_DELETE).
const CODE_VK: Record<string, number> = {
  // Letters
  KeyA: 65, KeyB: 66, KeyC: 67, KeyD: 68, KeyE: 69, KeyF: 70,
  KeyG: 71, KeyH: 72, KeyI: 73, KeyJ: 74, KeyK: 75, KeyL: 76,
  KeyM: 77, KeyN: 78, KeyO: 79, KeyP: 80, KeyQ: 81, KeyR: 82,
  KeyS: 83, KeyT: 84, KeyU: 85, KeyV: 86, KeyW: 87, KeyX: 88,
  KeyY: 89, KeyZ: 90,
  // Top-row digits
  Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52,
  Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
  // Numpad
  Numpad0: 96, Numpad1: 97, Numpad2: 98, Numpad3: 99, Numpad4: 100,
  Numpad5: 101, Numpad6: 102, Numpad7: 103, Numpad8: 104, Numpad9: 105,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109,
  NumpadDecimal: 110, NumpadDivide: 111, NumpadEnter: 13,
  // OEM punctuation — these are why '.' was breaking
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190,
  Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220,
  BracketRight: 221, Quote: 222, IntlBackslash: 226,
  // Whitespace + line editing
  Space: 32, Backspace: 8, Tab: 9, Enter: 13,
  // Navigation
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45, Delete: 46,
  // System
  Escape: 27, CapsLock: 20, Pause: 19, ScrollLock: 145, PrintScreen: 44,
  // Modifiers (left/right discriminated)
  ShiftLeft: 16, ShiftRight: 16,
  ControlLeft: 17, ControlRight: 17,
  AltLeft: 18, AltRight: 18,
  MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
  // Function row
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

// Last-resort key-name lookup for keys we somehow get without a code (older
// browsers, synthetic events). Keep this small — code is the source of truth.
const KEY_VK: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, " ": 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45,
  Shift: 16, Control: 17, Alt: 18, Meta: 91, CapsLock: 20,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

function virtualKeyCode(key: string, code: string): number {
  if (code && CODE_VK[code] !== undefined) return CODE_VK[code]!;
  if (key && KEY_VK[key] !== undefined) return KEY_VK[key]!;
  // Final fallback: if we got a single printable char and no code,
  // assume it's a letter/digit where ASCII == VK. Punctuation will be
  // wrong here, but this path only triggers for synthetic events.
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

async function createTab(id: string, url: string, impersonatedAddress: string, chainId: number): Promise<Tab> {
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
  await page.evaluateOnNewDocument(
    PROVIDER_INJECT_SCRIPT(impersonatedAddress, chainId, Object.keys(SUPPORTED_CHAINS).map(Number)),
  );

  // Pin all navigations to this same tab. Without this:
  //   - window.open(url) creates a new puppeteer Page we're not streaming →
  //     user sees nothing happen, looks frozen.
  //   - <a target="_blank"> does the same.
  // We rewrite window.open to a same-window navigation, and intercept any
  // _blank link click in the capture phase before the dapp's own handlers
  // see it.
  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(window, "open", {
        value: (url?: string | URL) => {
          if (url) window.location.href = String(url);
          return null;
        },
        writable: false,
        configurable: false,
      });
    } catch {
      /* ignore */
    }
    document.addEventListener(
      "click",
      ev => {
        const t = ev.target;
        if (!(t instanceof Element)) return;
        const a = t.closest("a");
        if (!a) return;
        const target = a.getAttribute("target");
        if (target !== "_blank") return;
        const href = a.href;
        if (!href) return;
        ev.preventDefault();
        ev.stopPropagation();
        window.location.href = href;
      },
      true,
    );
  });

  page.on("console", msg => {
    const t = msg.type();
    if (t === "error" || t === "warn") app.log.info({ id, t, text: msg.text().slice(0, 300) }, "page-console");
  });
  page.on("pageerror", err => {
    const message = err instanceof Error ? err.message : String(err);
    app.log.warn({ id, err: message }, "page-error");
  });

  // If a popup slips past the JS interception above (middle-click, CSP
  // weirdness, programmatic <a>.click() pre-script, etc.) puppeteer fires
  // 'popup' with the new Page. Capture its target URL and redirect the
  // ORIGINAL page to it, then close the popup so we keep streaming the
  // tab the user is actually watching.
  page.on("popup", async popup => {
    if (!popup) return;
    try {
      let url = popup.url();
      // The popup may not have settled on a real URL yet.
      if (!url || url === "about:blank") {
        await new Promise(r => setTimeout(r, 80));
        url = popup.url();
      }
      app.log.info({ id, popupUrl: url }, "popup intercepted — redirecting main tab");
      await popup.close().catch(() => undefined);
      if (url && url !== "about:blank") {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(err => {
          app.log.warn({ id, err: err.message, url }, "popup goto failed");
        });
      }
    } catch (err) {
      app.log.warn({ id, err: (err as Error).message }, "popup handler errored");
    }
  });

  // The injected provider's `fetch("/__slop_rpc", ...)` call is intercepted
  // here and proxied to Alchemy. By doing this on the request side we
  // never expose the upstream URL or API key to the page.
  await page.setRequestInterception(true);
  page.on("request", req => {
    const reqUrl = req.url();
    if (reqUrl.endsWith("/__slop_rpc")) {
      const post = req.postData() ?? "{}";
      // Tab may have switched chains since this listener captured `id` —
      // look up the current chainId so the proxy follows the switch.
      const t = tabs.get(id);
      const tabChain = t?.chainId ?? chainId;
      void (async () => {
        try {
          const upstream = await fetch(upstreamRpcUrl(tabChain), {
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
  // Sibling binding for EIP-3326 — the dapp calls
  // wallet_switchEthereumChain, our injected provider relays the target
  // chainId here, we validate + destroy+recreate the tab with the new
  // chain (same dance as the user-driven `set_chain` WS message).
  await cdp.send("Runtime.addBinding", { name: "__slopChainSwitch" });
  cdp.on("Runtime.bindingCalled", evt => {
    if (evt.name === "__slopTxRequest") {
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
      return;
    }
    if (evt.name === "__slopChainSwitch") {
      const targetChain = Number(evt.payload);
      if (!Number.isFinite(targetChain) || !isSupportedChain(targetChain)) {
        app.log.warn({ id, payload: evt.payload }, "chain switch rejected — unsupported");
        return;
      }
      const t = tabs.get(id);
      if (!t || targetChain === t.chainId) return;
      const url = t.url;
      const impersonator = t.impersonatedAddress;
      app.log.info({ id: t.id, from: t.chainId, to: targetChain }, "wallet_switchEthereumChain");
      void (async () => {
        const oldSubs = [...t.subscribers];
        await destroyTab(t.id, { keepSubscribers: true });
        try {
          const created = await createTab(t.id, url, impersonator, targetChain);
          for (const ws of oldSubs) {
            created.subscribers.add(ws);
            send(ws, { type: "chain_changed", chainId: targetChain });
          }
        } catch (err) {
          app.log.error({ id: t.id, err: (err as Error).message }, "chain switch recreate failed");
        }
      })();
      return;
    }
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
    tab.lastFrameAt = Date.now();
    broadcastTab(tab, { type: "frame", data: evt.data, sessionId: evt.sessionId });
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: evt.sessionId });
    } catch {
      /* tab closed */
    }
  });

  // Renderer crash signals — both flavors. page.on('error') fires when the
  // renderer process itself dies (Chrome's "Aw, snap!" page); pageerror is
  // for uncaught JS exceptions from the dapp (less serious). The CDP
  // Inspector.targetCrashed event is the lowest-level signal from Chrome
  // itself. Mark the tab crashed so a reload request takes the destroy+
  // recreate path.
  page.on("error", err => {
    const tab = tabs.get(id);
    if (tab) tab.crashed = true;
    app.log.error({ id, err: err instanceof Error ? err.message : String(err) }, "renderer-crashed");
  });
  cdp.on("Inspector.targetCrashed", () => {
    const tab = tabs.get(id);
    if (tab) tab.crashed = true;
    app.log.error({ id }, "target-crashed");
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

  const tab: Tab = {
    id,
    page,
    cdp,
    url,
    impersonatedAddress,
    chainId,
    subscribers: new Set(),
    shutdownTimer: null,
    lastFrameAt: Date.now(),
    lastInputAt: 0,
    crashed: false,
  };
  tabs.set(id, tab);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    app.log.warn({ err, url }, "initial navigation failed");
  }
  tab.url = page.url();

  return tab;
}

/**
 * Tear down a tab's Chromium page + screencast.
 *
 * `keepSubscribers` controls whether subscriber WebSockets are closed
 * along with the tab. Default false (close) is right for terminal
 * teardown — page crash, server shutdown, idle linger. The recreate
 * flow (reload, set_impersonator, set_chain, EIP-3326 chain switch)
 * passes true: it captures the subscriber list BEFORE the destroy,
 * keeps the sockets open through the gap, and re-attaches them to the
 * freshly-created tab on the other side. Closing the sockets here
 * would silently break every recreate path — frames from the new
 * page go to `send()` which skips non-OPEN sockets, so users would
 * see a frozen frame forever.
 */
async function destroyTab(id: string, opts: { keepSubscribers?: boolean } = {}): Promise<void> {
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
  if (!opts.keepSubscribers) {
    for (const ws of tab.subscribers) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
  app.log.info({ id, kept: !!opts.keepSubscribers }, "tab destroyed");
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

// ---- Watchdog ------------------------------------------------------------
// CDP screencast occasionally wedges after input on certain pages — frames
// stop emitting even though the renderer is alive. Empirically, neither
// page.reload() nor stop+restart Page.startScreencast brings it back. The
// only reliable cure is destroying the tab and creating a fresh one. The
// watchdog does that automatically when it sees a wedged tab so the user
// doesn't have to manually click reload.
//
// Gate: only fires when the user has given input after the last frame and
// the screencast has been silent for 6s+. Static-page idle states (no
// input, no expected redraw) are left alone. Cooldown of 12s after a
// recreate so we don't loop.

const WATCHDOG_INTERVAL_MS = 4000;
const WATCHDOG_FRAME_STALENESS_MS = 6000;
const WATCHDOG_COOLDOWN_MS = 12_000;

const lastWatchdogRecreateAt = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const tab of tabs.values()) {
    if (tab.subscribers.size === 0) continue;
    if (tab.crashed) continue;
    const stale = now - tab.lastFrameAt;
    if (stale < WATCHDOG_FRAME_STALENESS_MS) continue;
    if (tab.lastInputAt <= tab.lastFrameAt) continue; // no input → no expected redraw
    const lastRecreate = lastWatchdogRecreateAt.get(tab.id) ?? 0;
    if (now - lastRecreate < WATCHDOG_COOLDOWN_MS) continue;
    lastWatchdogRecreateAt.set(tab.id, now);
    app.log.warn(
      { id: tab.id, msSinceFrame: stale, msSinceInput: now - tab.lastInputAt },
      "watchdog: wedged tab — destroy+recreate",
    );
    const t = tab;
    void (async () => {
      const url = t.url;
      const impersonator = t.impersonatedAddress;
      const tabChain = t.chainId;
      const oldSubs = [...t.subscribers];
      await destroyTab(t.id, { keepSubscribers: true });
      try {
        const next = await createTab(t.id, url, impersonator, tabChain);
        for (const ws of oldSubs) next.subscribers.add(ws);
      } catch (err) {
        app.log.error({ id: t.id, err: (err as Error).message }, "watchdog recreate failed");
      }
    })();
  }
}, WATCHDOG_INTERVAL_MS);

// ---- HTTP -----------------------------------------------------------------

app.get("/health", async () => ({
  ok: true,
  service: "slop-browser-host",
  tabs: tabs.size,
  // Default impersonator for tabs created without an explicit address.
  // Per-tab values appear in /diag.
  defaultImpersonator: config.impersonatedAddress,
}));

// Diagnostics. Lists tab metadata so a wedged tab can be inspected from the
// outside (subscribers count, frame staleness, crash flag). Unauthenticated
// — info only, no actions.
app.get("/diag", async () => {
  const now = Date.now();
  return {
    tabs: [...tabs.values()].map(t => ({
      id: t.id,
      url: t.url,
      impersonatedAddress: t.impersonatedAddress,
      subscribers: t.subscribers.size,
      lastFrameAt: t.lastFrameAt,
      msSinceLastFrame: now - t.lastFrameAt,
      crashed: t.crashed,
      pageClosed: t.page.isClosed(),
    })),
  };
});

app.get<{ Params: { id: string } }>("/diag/:id", async (req, reply) => {
  const t = tabs.get(req.params.id);
  if (!t) return reply.code(404).send({ error: "no such tab" });
  const now = Date.now();
  return {
    id: t.id,
    url: t.url,
    impersonatedAddress: t.impersonatedAddress,
    subscribers: t.subscribers.size,
    lastFrameAt: t.lastFrameAt,
    msSinceLastFrame: now - t.lastFrameAt,
    crashed: t.crashed,
    pageClosed: t.page.isClosed(),
  };
});

// ---- WS /stream/:id -------------------------------------------------------

app.register(async function (fastify) {
  fastify.get<{ Params: { id: string }; Querystring: { url?: string; impersonated?: string; chainId?: string } }>(
    "/stream/:id",
    { websocket: true },
    async (socket, req) => {
      const id = req.params.id;
      const initialUrl = req.query.url ?? "about:blank";
      // First subscriber for a brand-new tab picks the impersonator from
      // their query. Subsequent subscribers join the existing tab and
      // inherit whatever it's currently impersonating — they can
      // change it later via `set_impersonator`.
      const initialImpersonator = sanitizeImpersonator(req.query.impersonated);
      // Same first-subscriber-wins semantics as impersonator. Querystring
      // is always strings; coerce + validate against the supported chain
      // set, otherwise fall back to the host's configured default.
      const requestedChain = Number(req.query.chainId);
      const initialChain = Number.isFinite(requestedChain) && isSupportedChain(requestedChain) ? requestedChain : config.chainId;
      let tab = tabs.get(id);
      if (!tab) {
        // Coalesce concurrent subscribers so we don't launch N tabs for the
        // same browser id. The first subscriber wins; everyone else awaits.
        let boot = tabBoots.get(id);
        if (!boot) {
          boot = createTab(id, initialUrl, initialImpersonator, initialChain).finally(() => tabBoots.delete(id));
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
      send(socket, { type: "hello", id, url: tab.url, impersonated: tab.impersonatedAddress, chainId: tab.chainId });

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
          case "reload": {
            // Always destroy + recreate. page.reload() with screencast
            // stop/start doesn't actually unwedge a frozen screencast;
            // making the user click reload twice is worse than just
            // giving them a fresh tab on click one.
            const url = tab.url;
            const impersonator = tab.impersonatedAddress;
            const tabChain = tab.chainId;
            const t = tab;
            app.log.info({ id: t.id, url }, "reload — destroy+recreate");
            void (async () => {
              const oldSubs = [...t.subscribers];
              await destroyTab(t.id, { keepSubscribers: true });
              try {
                const next = await createTab(t.id, url, impersonator, tabChain);
                for (const ws of oldSubs) next.subscribers.add(ws);
              } catch (err) {
                app.log.error({ id: t.id, err: (err as Error).message }, "recreate failed");
              }
            })();
            return;
          }
          case "set_impersonator": {
            // Swapping the injected provider's address requires a page-
            // level destroy+recreate: `evaluateOnNewDocument` only fires
            // on the next navigation, and existing pages still hold a
            // reference to the old non-writable window.ethereum. Same
            // mechanics as `reload`, but with a new impersonator.
            const next = sanitizeImpersonator(msg.address);
            if (next.toLowerCase() === tab.impersonatedAddress.toLowerCase()) return;
            const url = tab.url;
            const tabChain = tab.chainId;
            const t = tab;
            app.log.info({ id: t.id, from: t.impersonatedAddress, to: next }, "set_impersonator");
            void (async () => {
              const oldSubs = [...t.subscribers];
              await destroyTab(t.id, { keepSubscribers: true });
              try {
                const created = await createTab(t.id, url, next, tabChain);
                for (const ws of oldSubs) {
                  created.subscribers.add(ws);
                  // Each subscribed peer's UI tracks the current
                  // impersonator separately from its local dropdown
                  // selection, so broadcast the new value.
                  send(ws, { type: "impersonator_changed", impersonated: next });
                }
              } catch (err) {
                app.log.error({ id: t.id, err: (err as Error).message }, "impersonator recreate failed");
              }
            })();
            return;
          }
          case "set_chain": {
            // Same destroy+recreate dance as set_impersonator. The chain
            // is baked into the injected provider, so the only way to
            // change it is to re-inject on a fresh page. Triggered by
            // the user picking from the SharedBrowser selector, or by
            // the dapp calling wallet_switchEthereumChain via the
            // __slopChainSwitch CDP binding (see Runtime.bindingCalled
            // handler below).
            const targetChain = Number(msg.chainId);
            if (!Number.isFinite(targetChain) || !isSupportedChain(targetChain)) {
              return send(socket, { type: "error", error: "unsupported_chain" });
            }
            if (targetChain === tab.chainId) return;
            const url = tab.url;
            const impersonator = tab.impersonatedAddress;
            const t = tab;
            app.log.info({ id: t.id, from: t.chainId, to: targetChain }, "set_chain");
            void (async () => {
              const oldSubs = [...t.subscribers];
              await destroyTab(t.id, { keepSubscribers: true });
              try {
                const created = await createTab(t.id, url, impersonator, targetChain);
                for (const ws of oldSubs) {
                  created.subscribers.add(ws);
                  send(ws, { type: "chain_changed", chainId: targetChain });
                }
              } catch (err) {
                app.log.error({ id: t.id, err: (err as Error).message }, "chain recreate failed");
              }
            })();
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
            tab.lastInputAt = Date.now();
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
            tab.lastInputAt = Date.now();
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
            tab.lastInputAt = Date.now();
            const cdpType: "keyDown" | "keyUp" | "char" =
              event === "down" ? "keyDown" : event === "up" ? "keyUp" : "char";
            // CDP's Input.dispatchKeyEvent ignores special keys (Backspace,
            // Delete, arrows, etc.) unless we also send the legacy
            // windowsVirtualKeyCode. Without it Chrome sees keyCode=0 and
            // the input element's default handler (delete-char-left/right,
            // move caret, submit, etc.) never fires.
            const vk = cdpType === "char" ? 0 : virtualKeyCode(key, code);
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
      `slop-browser-host listening on http://${config.host}:${config.port} — default impersonator ${config.impersonatedAddress} on chain ${config.chainId}`,
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

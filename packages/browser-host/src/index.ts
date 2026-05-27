// Browser host: a single headless Chrome that any number of clients can
// watch and drive over a WebSocket. Not a generic remote-Chrome service —
// the only goal is "shared dapp window with vitalik.eth as the wallet."
//
// Phase 2: tabs are partitioned by room (slug). One Chromium process,
// one BrowserContext per room — same Chromium, isolated cookies /
// localStorage / IndexedDB. WS path is /stream/:id?slug=<slug>; missing
// slug falls back to "debug" (the always-on dev sandbox) so pre-
// Phase-3 frontends keep working.
//
// Per-room tab cap + process-wide cap stop one busy room from starving
// every other room (or OOM-ing the prod box). Idle timer destroys tabs
// that the user interacted with but then walked away from.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { Browser, BrowserContext, CDPSession, CookieData, Page } from "puppeteer";
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

// ---- Per-room organization -----------------------------------------------

// Mirrors the relay's slug rule (`^[a-z0-9-]{1,64}$`). browser-host never
// reads the on-chain contract — the frontend hands us slugs and we
// validate locally.
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const DEFAULT_SLUG = "debug";

function parseSlug(raw: string | undefined): string {
  if (!raw) return DEFAULT_SLUG;
  return SLUG_RE.test(raw) ? raw : DEFAULT_SLUG;
}

// Reject any URL that would let an attacker turn this headless browser
// into a local-disk reader or internal-network scanner. Allowed: plain
// http(s) to public hosts, plus the literal "about:blank" empty tab.
// Everything else — file://, data:, javascript:, chrome://, gopher:,
// etc. — and every loopback/link-local/RFC1918/CGNAT/multicast IP
// literal gets denied.
//
// Hostname matching is literal-only: an attacker can still DNS-rebind
// `evil.com` to 127.0.0.1 mid-session and bypass this. The prod box
// should also iptables-block outbound traffic to RFC1918 from the
// browser-host process. Treat this function as defense in depth, not
// the sole gate.
export function isSafeBrowsableUrl(raw: string): boolean {
  if (!raw) return false;
  if (raw === "about:blank") return true;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback") return false;
  if (host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".lan")) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local incl. 169.254.169.254 cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
    if (a >= 224) return false; // multicast + reserved
    return true;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return false;
    if (/^fe[89ab]/.test(host)) return false;          // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return false; // fc00::/7 unique-local
    if (host.startsWith("::ffff:")) return false;      // IPv4-mapped — refuse wholesale
    return true;
  }
  return true;
}

// Google search is unusable from datacenter IPs — captcha never resolves,
// no amount of cookie warmup or fingerprint stealth fixes it. Rewrite
// every main-frame navigation that lands on a google.com search page (or
// the bare homepage) to DuckDuckGo. Maps/Gmail/Calendar live on different
// subdomains and are left alone. Returns the rewrite target, or null if
// the URL should pass through untouched.
export function maybeRewriteSearch(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  // Match google.com, google.co.uk, www.google.fr, etc., but not
  // maps.google.com / mail.google.com / news.google.com.
  if (!/^(www\.)?google(\.[a-z]{2,3}){1,2}$/.test(host)) return null;
  if (u.pathname === "/search") {
    const q = u.searchParams.get("q") ?? "";
    return q ? `https://duckduckgo.com/?q=${encodeURIComponent(q)}` : "https://duckduckgo.com/";
  }
  if (u.pathname === "/" || u.pathname === "") return "https://duckduckgo.com/";
  return null;
}

const MAX_TABS_PER_ROOM = 5;
const MAX_TABS_TOTAL = 30;

// Cookies loaded once at boot from config.cookiesPath. Injected into every
// new BrowserContext (per-room) so Google etc. see a "returning visitor"
// with real bot-detection cookies (NID/SOCS/CONSENT) instead of a fresh
// fingerprint on each room. Operator generates the file via `yarn warmup`.
let warmupCookies: CookieData[] = [];
async function loadWarmupCookies(): Promise<void> {
  const abs = resolve(process.cwd(), config.cookiesPath);
  try {
    const raw = await readFile(abs, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      app.log.warn({ path: abs }, "cookies file is not a JSON array — ignoring");
      return;
    }
    warmupCookies = parsed as CookieData[];
    app.log.info({ path: abs, count: warmupCookies.length }, "warmup cookies loaded");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      app.log.info({ path: abs }, "no cookies file — skipping warmup injection (run `yarn warmup` to create one)");
    } else {
      app.log.warn({ path: abs, err: (err as Error).message }, "failed to load cookies file");
    }
  }
}

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
  slug: string;
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
   *  last frame — otherwise a static page would keep getting kicked.
   *  Idle policy: a tab that received input then went quiet for
   *  IDLE_DESTROY_MS gets torn down. */
  lastInputAt: number;
  /** True once we've seen a renderer crash / process death on this tab.
   *  Reload requests on a crashed tab go straight to "destroy + recreate". */
  crashed: boolean;
  /** Soft-paused: screencast stopped because the user hasn't interacted
   *  in a while. Next input resumes the screencast. */
  paused: boolean;
  /** EIP-5792 batch status map. Keyed by the batchId we returned from
   *  wallet_sendCalls; value is the v2-shaped response wallet_getCallsStatus
   *  should return when the dapp polls. Initialized PENDING on the
   *  wallet_sendCalls capture; flipped to SUCCESS / FAILED when
   *  SharedBrowser sends a `batch_status` WS message after the
   *  multisig executed the batch on-chain.
   *  Capped at MAX_BATCH_STATUSES per tab — oldest evicted first. */
  batchStatuses: Map<string, BatchStatusV2>;
};

// EIP-5792 v2 wallet_getCallsStatus response shape. status codes:
//   100 = pending, 200 = confirmed, 400 = chain reverted, 500 = error.
type BatchStatusV2 = {
  version: "2.0.0";
  id: string;
  chainId: string;       // hex, e.g. "0x2105"
  atomic: boolean;
  status: number;
  receipts: Array<{
    transactionHash: string;
    status: string;      // "0x1" success, "0x0" reverted
    blockHash?: string;
    blockNumber?: string;
    gasUsed?: string;
    logs?: unknown[];
  }>;
};

const MAX_BATCH_STATUSES = 32;

type RoomBrowser = {
  slug: string;
  /** Puppeteer BrowserContext — incognito-style isolated cookies /
   *  localStorage / IndexedDB. All tabs in this room share one context;
   *  closing it closes every tab in the room atomically (used by the
   *  relay's hibernation flow in Phase 7). */
  context: BrowserContext;
  tabs: Map<string, Tab>;
};

const roomBrowsers = new Map<string, RoomBrowser>();
// Coalesce concurrent first-tab boots so two subscribers connecting at
// the same time don't race to create the same tab.
const tabBoots = new Map<string, Promise<Tab>>();
// Coalesce context creation similarly — first connect for a room
// creates the BrowserContext; concurrent connects wait.
const roomBoots = new Map<string, Promise<RoomBrowser>>();

async function getOrCreateRoomBrowser(slug: string): Promise<RoomBrowser> {
  const existing = roomBrowsers.get(slug);
  if (existing) return existing;
  const inFlight = roomBoots.get(slug);
  if (inFlight) return inFlight;
  const boot = (async () => {
    const b = await getBrowser();
    const ctx = await b.createBrowserContext();
    if (warmupCookies.length > 0) {
      try {
        await ctx.setCookie(...warmupCookies);
      } catch (err) {
        app.log.warn({ slug, err: (err as Error).message }, "warmup cookie injection failed");
      }
    }
    const rb: RoomBrowser = { slug, context: ctx, tabs: new Map() };
    roomBrowsers.set(slug, rb);
    app.log.info({ slug, cookies: warmupCookies.length }, "room context created");
    return rb;
  })().finally(() => roomBoots.delete(slug));
  roomBoots.set(slug, boot);
  return boot;
}

function getTab(slug: string, id: string): Tab | undefined {
  return roomBrowsers.get(slug)?.tabs.get(id);
}

function tabBootKey(slug: string, id: string): string {
  return `${slug}:${id}`;
}

function totalTabCount(): number {
  let n = 0;
  for (const rb of roomBrowsers.values()) n += rb.tabs.size;
  return n;
}

// EIP-55 / checksum-agnostic 0x40 hex check. Anything that doesn't match
// falls back to the configured default — we never reflect untrusted
// strings into the injected provider verbatim.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
function sanitizeImpersonator(raw: unknown): string {
  if (typeof raw !== "string") return config.impersonatedAddress;
  return ADDRESS_RE.test(raw) ? raw : config.impersonatedAddress;
}

// Map a KeyboardEvent.code value (the physical key, unambiguous regardless
// of Shift state or layout) to the legacy "windows virtual key code" that
// Chrome's input handler expects. Without it, Chrome's input element
// ignores the keystroke (special keys), or — worse — interprets it as the
// wrong key (e.g. punctuation whose ASCII value collides with a special
// key's VK: '.' is ASCII 46, which is also VK_DELETE).
const CODE_VK: Record<string, number> = {
  KeyA: 65, KeyB: 66, KeyC: 67, KeyD: 68, KeyE: 69, KeyF: 70,
  KeyG: 71, KeyH: 72, KeyI: 73, KeyJ: 74, KeyK: 75, KeyL: 76,
  KeyM: 77, KeyN: 78, KeyO: 79, KeyP: 80, KeyQ: 81, KeyR: 82,
  KeyS: 83, KeyT: 84, KeyU: 85, KeyV: 86, KeyW: 87, KeyX: 88,
  KeyY: 89, KeyZ: 90,
  Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52,
  Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
  Numpad0: 96, Numpad1: 97, Numpad2: 98, Numpad3: 99, Numpad4: 100,
  Numpad5: 101, Numpad6: 102, Numpad7: 103, Numpad8: 104, Numpad9: 105,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109,
  NumpadDecimal: 110, NumpadDivide: 111, NumpadEnter: 13,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190,
  Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220,
  BracketRight: 221, Quote: 222, IntlBackslash: 226,
  Space: 32, Backspace: 8, Tab: 9, Enter: 13,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45, Delete: 46,
  Escape: 27, CapsLock: 20, Pause: 19, ScrollLock: 145, PrintScreen: 44,
  ShiftLeft: 16, ShiftRight: 16,
  ControlLeft: 17, ControlRight: 17,
  AltLeft: 18, AltRight: 18,
  MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

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
      body: JSON.stringify({ slug: tab.slug, browserId: tab.id, payload }),
    });
  } catch (err) {
    app.log.warn({ err }, "failed to forward tx to relay");
  }
}

async function createTab(
  slug: string,
  id: string,
  url: string,
  impersonatedAddress: string,
  chainId: number,
): Promise<Tab> {
  if (totalTabCount() >= MAX_TABS_TOTAL) {
    throw new Error(`tab cap reached (process ${MAX_TABS_TOTAL})`);
  }
  const rb = await getOrCreateRoomBrowser(slug);
  if (rb.tabs.size >= MAX_TABS_PER_ROOM) {
    // Room is full → evict the staleest tab (lowest `max(lastFrameAt,
    // lastInputAt)`) to make room. Without this we'd throw, the WS would
    // close with code 4290, and the client would show "HOST OFFLINE" —
    // even though the host is fine. Eviction sends `evicted` to existing
    // subscribers first so the kicked client can render a meaningful UI.
    const lastActive = (t: Tab) => Math.max(t.lastFrameAt, t.lastInputAt);
    const victim = [...rb.tabs.values()].reduce((a, b) => (lastActive(a) <= lastActive(b) ? a : b));
    app.log.warn(
      { slug, evictedId: victim.id, newId: id, lastFrameAt: victim.lastFrameAt, lastInputAt: victim.lastInputAt },
      "room cap reached — evicting LRU tab",
    );
    for (const ws of victim.subscribers) {
      send(ws, { type: "evicted", reason: "room_cap_lru", evictedBy: id });
    }
    await destroyTab(slug, victim.id);
  }
  const page = await rb.context.newPage();

  // Pin UA explicitly so the page never advertises "HeadlessChrome" — the
  // stealth plugin patches navigator.userAgent in JS-land, but the HTTP
  // request header sent by the network stack can still leak depending on
  // the puppeteer/Chromium versions. setUserAgent overrides both.
  await page.setUserAgent(config.userAgent);

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
    if (t === "error" || t === "warn") app.log.info({ slug, id, t, text: msg.text().slice(0, 300) }, "page-console");
  });
  page.on("pageerror", err => {
    const message = err instanceof Error ? err.message : String(err);
    app.log.warn({ slug, id, err: message }, "page-error");
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
      if (!url || url === "about:blank") {
        await new Promise(r => setTimeout(r, 80));
        url = popup.url();
      }
      app.log.info({ slug, id, popupUrl: url }, "popup intercepted — redirecting main tab");
      await popup.close().catch(() => undefined);
      if (url && url !== "about:blank") {
        if (!isSafeBrowsableUrl(url)) {
          app.log.warn({ slug, id, popupUrl: url }, "popup blocked — unsafe url");
          return;
        }
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(err => {
          app.log.warn({ slug, id, err: err.message, url }, "popup goto failed");
        });
      }
    } catch (err) {
      app.log.warn({ slug, id, err: (err as Error).message }, "popup handler errored");
    }
  });

  // The injected provider's `fetch("/__slop_rpc", ...)` call is intercepted
  // here and proxied to Alchemy. By doing this on the request side we
  // never expose the upstream URL or API key to the page.
  await page.setRequestInterception(true);
  page.on("request", req => {
    const reqUrl = req.url();
    // EIP-5792 batch-status poll. inject's wallet_getCallsStatus
    // fetches this with ?id=<batchId>; we look the id up in the
    // tab's batchStatuses map and return the current v2 status.
    // Unknown ids → generic PENDING so polling doesn't error.
    if (reqUrl.includes("/__slop_batch_status")) {
      let batchId = "";
      try {
        const u = new URL(reqUrl);
        batchId = u.searchParams.get("id") ?? "";
      } catch {
        /* keep empty — falls through to PENDING below */
      }
      const t = getTab(slug, id);
      const tabChain = t?.chainId ?? chainId;
      const known = t?.batchStatuses.get(batchId);
      const body: BatchStatusV2 = known ?? {
        version: "2.0.0",
        id: batchId,
        chainId: "0x" + tabChain.toString(16),
        atomic: true,
        status: 100,
        receipts: [],
      };
      void req.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
    if (reqUrl.endsWith("/__slop_rpc")) {
      const post = req.postData() ?? "{}";
      // Tab may have switched chains since this listener captured `id` —
      // look up the current chainId so the proxy follows the switch.
      const t = getTab(slug, id);
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
    // Backstop for everything goto can't catch — subresource fetches,
    // HTTP→HTTP redirects to private IPs, in-page beacons, iframes.
    // Same allowlist as the goto sites. The __slop_rpc proxy above is
    // already handled (req.respond + return); anything else gets the
    // safety check before req.continue.
    if (!isSafeBrowsableUrl(reqUrl)) {
      app.log.warn({ slug, id, reqUrl }, "blocked unsafe subresource");
      void req.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    // Search-engine rewrite: only fire on main-frame top-level navigations,
    // never on subresource fetches (a page that embeds google.com analytics
    // or fonts shouldn't get redirected to ddg). Subframe iframes are also
    // left alone — only the real navigation to a Google search page is
    // intercepted, because that's the surface that captchas the user.
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      const rewrite = maybeRewriteSearch(reqUrl);
      if (rewrite) {
        app.log.info({ slug, id, from: reqUrl, to: rewrite }, "search rewrite → ddg");
        void req.respond({
          status: 302,
          headers: { Location: rewrite },
        });
        return;
      }
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
      let parsed: { method?: string; params?: unknown; batchId?: unknown } = {};
      try {
        parsed = JSON.parse(evt.payload);
      } catch {
        return;
      }
      const tab = getTab(slug, id);
      if (!tab) return;
      app.log.info(
        { slug, id, method: parsed.method, subscribers: tab.subscribers.size, impersonator: tab.impersonatedAddress, chainId: tab.chainId, batchId: parsed.batchId },
        "[SLOP-TX-DEBUG] tx_request captured",
      );
      // Seed PENDING for wallet_sendCalls so subsequent
      // wallet_getCallsStatus polls (which can race the SharedBrowser
      // route) get a coherent response immediately. Eviction is FIFO
      // by insertion order once we exceed the cap.
      if (parsed.method === "wallet_sendCalls" && typeof parsed.batchId === "string") {
        if (tab.batchStatuses.size >= MAX_BATCH_STATUSES) {
          const oldest = tab.batchStatuses.keys().next().value;
          if (oldest !== undefined) tab.batchStatuses.delete(oldest);
        }
        tab.batchStatuses.set(parsed.batchId, {
          version: "2.0.0",
          id: parsed.batchId,
          chainId: "0x" + tab.chainId.toString(16),
          atomic: true,
          status: 100,
          receipts: [],
        });
      }
      // Stable per-capture id. Every client watching this shared tab
      // independently forwards the captured tx to the impersonated peer;
      // without a shared id the relay tags each forward with a fresh
      // `${peerId}-${Date.now()}` and the receiver surfaces one modal per
      // watcher (2 watchers → 2 modals; approve+swap → 4). Generated once
      // here at the single capture point so the receiver can dedup them.
      const requestId = globalThis.crypto.randomUUID();
      broadcastTab(tab, {
        type: "tx_request",
        requestId,
        method: parsed.method,
        params: parsed.params,
        batchId: parsed.batchId,
      });
      void forwardTxToRelay(tab, parsed);
      return;
    }
    if (evt.name === "__slopChainSwitch") {
      const targetChain = Number(evt.payload);
      if (!Number.isFinite(targetChain) || !isSupportedChain(targetChain)) {
        app.log.warn({ slug, id, payload: evt.payload }, "chain switch rejected — unsupported");
        return;
      }
      const t = getTab(slug, id);
      if (!t || targetChain === t.chainId) return;
      const url = t.url;
      const impersonator = t.impersonatedAddress;
      app.log.info({ slug, id: t.id, from: t.chainId, to: targetChain }, "wallet_switchEthereumChain");
      void (async () => {
        const oldSubs = [...t.subscribers];
        await destroyTab(slug, t.id, { keepSubscribers: true });
        try {
          const created = await createTab(slug, t.id, url, impersonator, targetChain);
          for (const ws of oldSubs) {
            created.subscribers.add(ws);
            send(ws, { type: "chain_changed", chainId: targetChain });
          }
        } catch (err) {
          app.log.error({ slug, id: t.id, err: (err as Error).message }, "chain switch recreate failed");
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
    const tab = getTab(slug, id);
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
    const tab = getTab(slug, id);
    if (tab) tab.crashed = true;
    app.log.error({ slug, id, err: err instanceof Error ? err.message : String(err) }, "renderer-crashed");
  });
  cdp.on("Inspector.targetCrashed", () => {
    const tab = getTab(slug, id);
    if (tab) tab.crashed = true;
    app.log.error({ slug, id }, "target-crashed");
  });

  // Surface URL changes (in-page nav) so the URL bar across all peers
  // updates. We don't echo this back to the relay yet — the URL bar
  // updates are local-only for v1.
  page.on("framenavigated", frame => {
    if (frame !== page.mainFrame()) return;
    const next = page.url();
    const tab = getTab(slug, id);
    if (!tab) return;
    if (next === tab.url) return;
    tab.url = next;
    broadcastTab(tab, { type: "url", url: next });
  });

  const tab: Tab = {
    id,
    slug,
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
    paused: false,
    batchStatuses: new Map(),
  };
  rb.tabs.set(id, tab);

  try {
    if (!isSafeBrowsableUrl(url)) throw new Error(`unsafe url: ${url.slice(0, 80)}`);
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
async function destroyTab(slug: string, id: string, opts: { keepSubscribers?: boolean } = {}): Promise<void> {
  const rb = roomBrowsers.get(slug);
  if (!rb) return;
  const tab = rb.tabs.get(id);
  if (!tab) return;
  rb.tabs.delete(id);
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
  app.log.info({ slug, id, kept: !!opts.keepSubscribers }, "tab destroyed");
}

/**
 * Close a room's BrowserContext — Phase 7 hibernation path. Closes every
 * tab in the room atomically and removes the room entry. The relay calls
 * this via POST /admin/rooms/:slug/close when it hibernates the room.
 */
async function closeRoomContext(slug: string): Promise<void> {
  const rb = roomBrowsers.get(slug);
  if (!rb) return;
  roomBrowsers.delete(slug);
  // Close subscribers first so frontends know to back off.
  for (const tab of rb.tabs.values()) {
    for (const ws of tab.subscribers) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
  try {
    await rb.context.close();
  } catch (err) {
    app.log.warn({ slug, err: (err as Error).message }, "context close failed");
  }
  app.log.info({ slug, tabs: rb.tabs.size }, "room context closed");
}

const TAB_LINGER_MS = 30_000;

function scheduleShutdown(tab: Tab) {
  if (tab.shutdownTimer) clearTimeout(tab.shutdownTimer);
  tab.shutdownTimer = setTimeout(() => {
    if (tab.subscribers.size === 0) void destroyTab(tab.slug, tab.id);
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
  for (const rb of roomBrowsers.values()) {
    for (const tab of rb.tabs.values()) {
      if (tab.subscribers.size === 0) continue;
      if (tab.crashed) continue;
      if (tab.paused) continue;
      const stale = now - tab.lastFrameAt;
      if (stale < WATCHDOG_FRAME_STALENESS_MS) continue;
      if (tab.lastInputAt <= tab.lastFrameAt) continue; // no input → no expected redraw
      const key = `${tab.slug}:${tab.id}`;
      const lastRecreate = lastWatchdogRecreateAt.get(key) ?? 0;
      if (now - lastRecreate < WATCHDOG_COOLDOWN_MS) continue;
      lastWatchdogRecreateAt.set(key, now);
      app.log.warn(
        { slug: tab.slug, id: tab.id, msSinceFrame: stale, msSinceInput: now - tab.lastInputAt },
        "watchdog: wedged tab — destroy+recreate",
      );
      const t = tab;
      void (async () => {
        const url = t.url;
        const impersonator = t.impersonatedAddress;
        const tabChain = t.chainId;
        const oldSubs = [...t.subscribers];
        await destroyTab(t.slug, t.id, { keepSubscribers: true });
        try {
          const next = await createTab(t.slug, t.id, url, impersonator, tabChain);
          for (const ws of oldSubs) next.subscribers.add(ws);
        } catch (err) {
          app.log.error({ slug: t.slug, id: t.id, err: (err as Error).message }, "watchdog recreate failed");
        }
      })();
    }
  }
}, WATCHDOG_INTERVAL_MS);

// ---- Idle policy ---------------------------------------------------------
// Tabs the user actually used (lastInputAt > 0) but then walked away from
// get soft-paused at 30 min and destroyed at 2 h. Tabs that never received
// input are left alone — they might be a livestream / clock / ticker the
// peer is watching, where "no input" is the normal mode of use.
//
// Soft pause: stop the screencast (no more frame work in Chromium), tell
// subscribers via `{ type: "idle_paused" }`. Next input wakes the tab by
// restarting the screencast + emitting `{ type: "idle_resumed" }`.

const IDLE_CHECK_INTERVAL_MS = 60_000;
const IDLE_SOFT_PAUSE_MS = 30 * 60 * 1000;
const IDLE_DESTROY_MS = 2 * 60 * 60 * 1000;

async function pauseTab(tab: Tab): Promise<void> {
  if (tab.paused) return;
  tab.paused = true;
  try {
    await tab.cdp.send("Page.stopScreencast").catch(() => undefined);
  } catch {
    /* ignore */
  }
  broadcastTab(tab, { type: "idle_paused" });
  app.log.info({ slug: tab.slug, id: tab.id }, "tab soft-paused (idle)");
}

async function resumeTab(tab: Tab): Promise<void> {
  if (!tab.paused) return;
  tab.paused = false;
  try {
    await tab.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: config.screencast.quality,
      maxWidth: config.screencast.maxWidth,
      maxHeight: config.screencast.maxHeight,
      everyNthFrame: config.screencast.everyNthFrame,
    });
  } catch (err) {
    app.log.warn({ slug: tab.slug, id: tab.id, err: (err as Error).message }, "resume screencast failed");
  }
  broadcastTab(tab, { type: "idle_resumed" });
  app.log.info({ slug: tab.slug, id: tab.id }, "tab resumed");
}

setInterval(() => {
  const now = Date.now();
  for (const rb of roomBrowsers.values()) {
    for (const tab of rb.tabs.values()) {
      if (tab.lastInputAt === 0) continue;
      const idleMs = now - tab.lastInputAt;
      if (idleMs >= IDLE_DESTROY_MS) {
        app.log.info({ slug: tab.slug, id: tab.id, idleMs }, "idle destroy");
        void destroyTab(tab.slug, tab.id);
        continue;
      }
      if (idleMs >= IDLE_SOFT_PAUSE_MS && !tab.paused) {
        void pauseTab(tab);
      }
    }
  }
}, IDLE_CHECK_INTERVAL_MS);

// ---- HTTP -----------------------------------------------------------------

app.get("/health", async () => ({
  ok: true,
  service: "slop-browser-host",
  tabs: totalTabCount(),
  rooms: roomBrowsers.size,
  defaultImpersonator: config.impersonatedAddress,
}));

// Diagnostics. Lists tab metadata grouped by room so a wedged tab can be
// inspected from the outside (subscribers count, frame staleness, crash
// flag). Unauthenticated — info only, no actions.
app.get("/diag", async () => {
  const now = Date.now();
  const rooms: Record<string, unknown> = {};
  for (const rb of roomBrowsers.values()) {
    rooms[rb.slug] = {
      tabCount: rb.tabs.size,
      tabs: [...rb.tabs.values()].map(t => ({
        id: t.id,
        url: t.url,
        impersonatedAddress: t.impersonatedAddress,
        chainId: t.chainId,
        subscribers: t.subscribers.size,
        lastFrameAt: t.lastFrameAt,
        msSinceLastFrame: now - t.lastFrameAt,
        lastInputAt: t.lastInputAt,
        msSinceLastInput: t.lastInputAt ? now - t.lastInputAt : null,
        crashed: t.crashed,
        paused: t.paused,
        pageClosed: t.page.isClosed(),
      })),
    };
  }
  return {
    totalTabs: totalTabCount(),
    caps: { perRoom: MAX_TABS_PER_ROOM, total: MAX_TABS_TOTAL },
    rooms,
  };
});

app.get<{ Params: { slug?: string; id: string } }>("/diag/:id", async (req, reply) => {
  // Backwards-compat: pre-Phase-3 diag URLs only carry an id. Search every
  // room until we find it. Phase 3+ frontends should hit /diag/:slug/:id
  // directly (added below).
  const id = req.params.id;
  for (const rb of roomBrowsers.values()) {
    const t = rb.tabs.get(id);
    if (!t) continue;
    const now = Date.now();
    return {
      slug: t.slug,
      id: t.id,
      url: t.url,
      impersonatedAddress: t.impersonatedAddress,
      chainId: t.chainId,
      subscribers: t.subscribers.size,
      lastFrameAt: t.lastFrameAt,
      msSinceLastFrame: now - t.lastFrameAt,
      crashed: t.crashed,
      paused: t.paused,
      pageClosed: t.page.isClosed(),
    };
  }
  return reply.code(404).send({ error: "no such tab" });
});

// Admin: close a whole room's BrowserContext. Called by the relay's
// hibernation path (Phase 7). Idempotent — closing an unknown room is a
// no-op. Auth gate is bearer-shared-secret if the relay is configured
// with one; otherwise local-only.
app.post<{ Params: { slug: string } }>("/admin/rooms/:slug/close", async (req, reply) => {
  if (config.relayTxBroadcastSecret) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${config.relayTxBroadcastSecret}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  }
  const slug = parseSlug(req.params.slug);
  await closeRoomContext(slug);
  return { ok: true, slug };
});

// Per-tab destroy — called by the relay on `browser_close` so closing a
// browser window in the UI also tears down the host tab. Without this we
// rely on every subscriber WS closing within TAB_LINGER_MS, which can
// leave zombies when a peer's socket lingers (TCP keepalive, dropped
// peer, etc.) and fills the per-room cap.
app.post<{ Params: { slug: string; id: string } }>("/admin/rooms/:slug/tabs/:id/close", async (req, reply) => {
  if (config.relayTxBroadcastSecret) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${config.relayTxBroadcastSecret}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  }
  const slug = parseSlug(req.params.slug);
  const id = req.params.id;
  const tab = getTab(slug, id);
  if (!tab) return { ok: true, slug, id, existed: false };
  await destroyTab(slug, id);
  return { ok: true, slug, id, existed: true };
});

// ---- WS /stream/:id?slug=<slug> ------------------------------------------

app.register(async function (fastify) {
  fastify.get<{
    Params: { id: string };
    Querystring: { url?: string; impersonated?: string; chainId?: string; slug?: string };
  }>(
    "/stream/:id",
    { websocket: true },
    async (socket, req) => {
      const id = req.params.id;
      const slug = parseSlug(req.query.slug);
      // Origin gate. /stream/:id has no cookie or bearer credential —
      // Caddy strips them — so wide-open would let any browser tab or
      // CLI client point this Puppeteer at internal targets. Browsers
      // send a real Origin on WS upgrade and get rejected here; non-
      // browser clients (curl, wscat) can forge it, so the URL allow-
      // list below is the real backstop. Wildcard ("*") in corsOrigins
      // disables the check, matching the HTTP CORS plugin's behavior.
      const origin = (req.headers.origin as string | undefined) ?? "";
      if (!config.corsOrigins.includes("*") && !config.corsOrigins.includes(origin)) {
        send(socket, { type: "error", error: "bad-origin", origin });
        socket.close(4403, "bad-origin");
        return;
      }
      const initialUrl = req.query.url ?? "about:blank";
      if (!isSafeBrowsableUrl(initialUrl)) {
        send(socket, { type: "error", error: "unsafe-url", url: initialUrl });
        socket.close(4400, "unsafe-url");
        return;
      }
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
      let tab = getTab(slug, id);
      if (!tab) {
        // Coalesce concurrent subscribers so we don't launch N tabs for the
        // same (slug, id). The first subscriber wins; everyone else awaits.
        const bootKey = tabBootKey(slug, id);
        let boot = tabBoots.get(bootKey);
        if (!boot) {
          boot = createTab(slug, id, initialUrl, initialImpersonator, initialChain).finally(() => tabBoots.delete(bootKey));
          tabBoots.set(bootKey, boot);
        }
        try {
          tab = await boot;
        } catch (err) {
          const msg = (err as Error).message;
          app.log.error({ slug, id, err: msg }, "createTab failed");
          // Cap-reached → 4290 close code so the client can distinguish
          // from generic failure. Anything else → 1011 (internal error).
          const isCap = /tab cap reached/.test(msg);
          send(socket, { type: "error", error: isCap ? "tab_cap_reached" : "tab_create_failed", message: msg });
          socket.close(isCap ? 4290 : 1011);
          return;
        }
      }
      cancelShutdown(tab);
      tab.subscribers.add(socket);
      send(socket, { type: "hello", id, slug, url: tab.url, impersonated: tab.impersonatedAddress, chainId: tab.chainId });
      // Subscribing counts as "intent to use" — resume from idle pause
      // immediately so the joining peer doesn't see a frozen frame.
      if (tab.paused) void resumeTab(tab);

      socket.on("message", (raw: Buffer | string) => {
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        // Re-read the current tab on every message instead of using the
        // closure-captured one. The outer `tab` is whatever was alive at
        // WS-open time; every destroyTab+createTab cycle (set_chain,
        // set_impersonator, reload, EIP-3326 chain switch, watchdog)
        // swaps the entry in the room's Map but can't update this closure.
        const tab = getTab(slug, id);
        if (!tab) return;
        // Any input wakes a paused tab.
        if (tab.paused && (msg.type === "mouse" || msg.type === "wheel" || msg.type === "key" || msg.type === "insertText")) {
          void resumeTab(tab);
        }
        switch (msg.type) {
          case "navigate": {
            if (typeof msg.url !== "string") return;
            if (!isSafeBrowsableUrl(msg.url)) {
              app.log.warn({ slug, id, url: msg.url }, "navigate blocked — unsafe url");
              send(socket, { type: "error", error: "unsafe-url", url: msg.url });
              return;
            }
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
            app.log.info({ slug: t.slug, id: t.id, url }, "reload — destroy+recreate");
            void (async () => {
              const oldSubs = [...t.subscribers];
              await destroyTab(t.slug, t.id, { keepSubscribers: true });
              try {
                const next = await createTab(t.slug, t.id, url, impersonator, tabChain);
                for (const ws of oldSubs) next.subscribers.add(ws);
              } catch (err) {
                app.log.error({ slug: t.slug, id: t.id, err: (err as Error).message }, "recreate failed");
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
            app.log.info({ slug: t.slug, id: t.id, from: t.impersonatedAddress, to: next }, "set_impersonator");
            void (async () => {
              const oldSubs = [...t.subscribers];
              await destroyTab(t.slug, t.id, { keepSubscribers: true });
              try {
                const created = await createTab(t.slug, t.id, url, next, tabChain);
                for (const ws of oldSubs) {
                  created.subscribers.add(ws);
                  send(ws, { type: "impersonator_changed", impersonated: next });
                }
              } catch (err) {
                app.log.error({ slug: t.slug, id: t.id, err: (err as Error).message }, "impersonator recreate failed");
              }
            })();
            return;
          }
          case "set_chain": {
            const targetChain = Number(msg.chainId);
            if (!Number.isFinite(targetChain) || !isSupportedChain(targetChain)) {
              return send(socket, { type: "error", error: "unsupported_chain" });
            }
            if (targetChain === tab.chainId) return;
            const url = tab.url;
            const impersonator = tab.impersonatedAddress;
            const t = tab;
            app.log.info({ slug: t.slug, id: t.id, from: t.chainId, to: targetChain }, "set_chain");
            void (async () => {
              const oldSubs = [...t.subscribers];
              await destroyTab(t.slug, t.id, { keepSubscribers: true });
              try {
                const created = await createTab(t.slug, t.id, url, impersonator, targetChain);
                for (const ws of oldSubs) {
                  created.subscribers.add(ws);
                  send(ws, { type: "chain_changed", chainId: targetChain });
                }
              } catch (err) {
                app.log.error({ slug: t.slug, id: t.id, err: (err as Error).message }, "chain recreate failed");
              }
            })();
            return;
          }
          case "batch_status": {
            // SharedBrowser tells us the on-chain outcome of a
            // wallet_sendCalls batch (the multisig executed it /
            // it reverted / it expired). Cache it so the next
            // /__slop_batch_status poll the dapp makes returns
            // the real status + receipt.
            if (typeof msg.batchId !== "string") return;
            const batchId = msg.batchId;
            const prior = tab.batchStatuses.get(batchId);
            const status =
              typeof msg.status === "number" ? msg.status : prior?.status ?? 100;
            const txHash = typeof msg.txHash === "string" ? msg.txHash : null;
            const receiptStatus = status === 200 ? "0x1" : status >= 400 ? "0x0" : "0x1";
            tab.batchStatuses.set(batchId, {
              version: "2.0.0",
              id: batchId,
              chainId: prior?.chainId ?? "0x" + tab.chainId.toString(16),
              atomic: true,
              status,
              receipts: txHash ? [{ transactionHash: txHash, status: receiptStatus }] : [],
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
            tab.lastInputAt = Date.now();
            const cdpType: "mousePressed" | "mouseReleased" | "mouseMoved" =
              event === "down"
                ? "mousePressed"
                : event === "up"
                  ? "mouseReleased"
                  : event === "move"
                    ? "mouseMoved"
                    : "mousePressed";
            const buttonBit = button === "left" ? 1 : button === "right" ? 2 : button === "middle" ? 4 : 0;
            const buttonsAfter = cdpType === "mouseReleased" ? 0 : buttonBit;
            void tab.cdp
              .send("Input.dispatchMouseEvent", {
                type: cdpType,
                x,
                y,
                button,
                buttons: buttonsAfter,
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
          case "insertText": {
            const text = typeof msg.text === "string" ? msg.text : "";
            if (!text) return;
            tab.lastInputAt = Date.now();
            void tab.cdp.send("Input.insertText", { text }).catch(() => undefined);
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
        // Same fresh-lookup pattern as the message handler — after any
        // recreate the WS is in the new tab's subscriber set, not the
        // closure-captured one.
        const tab = getTab(slug, id);
        if (!tab) return;
        tab.subscribers.delete(socket);
        if (tab.subscribers.size === 0) scheduleShutdown(tab);
      });
    },
  );
});

// ---- Boot -----------------------------------------------------------------

await loadWarmupCookies();

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    app.log.info(
      `slop-browser-host listening on http://${config.host}:${config.port} — default impersonator ${config.impersonatedAddress} on chain ${config.chainId}, tab caps perRoom=${MAX_TABS_PER_ROOM} total=${MAX_TABS_TOTAL}`,
    );
  })
  .catch(err => {
    app.log.error(err);
    process.exit(1);
  });

const shutdown = async (_signal: NodeJS.Signals) => {
  app.log.info(`received ${_signal} — shutting down`);
  // Force-exit safety net: if any of destroyTab / browser.close /
  // app.close hangs (puppeteer or a stuck WS), we still exit well
  // inside systemd's 90s TimeoutStopSec instead of getting SIGKILLed.
  // `.unref()` so the timeout itself doesn't pin the event loop on a
  // clean shutdown.
  setTimeout(() => {
    app.log.warn("graceful shutdown exceeded 3s — force-exiting");
    process.exit(0);
  }, 3000).unref();
  for (const rb of [...roomBrowsers.values()]) {
    for (const id of [...rb.tabs.keys()]) await destroyTab(rb.slug, id);
  }
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

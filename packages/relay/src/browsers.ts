// Shared browser windows.
//
// A "browser" is a desktop window backed by an iframe whose URL is synced
// across every connected peer. Anyone can open one, change its URL, or close
// it. Like slot positions, browser state is host-authoritative-ish: persisted
// per primary host so a relay restart doesn't wipe what's open.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Browser = {
  id: string;
  url: string;
  openedBy: string; // peerId who opened it
  openedAt: number;
};

const BROWSERS_PATH = process.env.BROWSERS_PATH ?? "/var/lib/slop-relay/browsers.json";

const browsersByHost: Map<string, Map<string, Browser>> = loadBrowsers();

function loadBrowsers(): Map<string, Map<string, Browser>> {
  try {
    const raw = readFileSync(BROWSERS_PATH, "utf8");
    const obj = JSON.parse(raw) as Record<string, Record<string, Browser>>;
    const out = new Map<string, Map<string, Browser>>();
    for (const [host, list] of Object.entries(obj)) {
      out.set(host, new Map(Object.entries(list)));
    }
    return out;
  } catch {
    return new Map();
  }
}

let saveQueued = false;
function scheduleSave(): void {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    try {
      mkdirSync(dirname(BROWSERS_PATH), { recursive: true });
      const obj: Record<string, Record<string, Browser>> = {};
      for (const [host, list] of browsersByHost) obj[host] = Object.fromEntries(list);
      writeFileSync(BROWSERS_PATH, JSON.stringify(obj));
    } catch (err) {
      console.error("[browsers] failed to persist:", err);
    }
  });
}

const norm = (addr: string | null | undefined) => (addr ? addr.toLowerCase() : null);

function bucket(hostAddress: string | null): Map<string, Browser> {
  const host = norm(hostAddress) ?? "_global";
  let b = browsersByHost.get(host);
  if (!b) {
    b = new Map();
    browsersByHost.set(host, b);
  }
  return b;
}

export function listBrowsers(hostAddress: string | null): Browser[] {
  const host = norm(hostAddress) ?? "_global";
  return [...(browsersByHost.get(host)?.values() ?? [])];
}

export function openBrowser(
  hostAddress: string | null,
  id: string,
  url: string,
  openedBy: string,
): Browser {
  const b = bucket(hostAddress);
  const browser: Browser = { id, url, openedBy, openedAt: Date.now() };
  b.set(id, browser);
  scheduleSave();
  return browser;
}

export function navigateBrowser(
  hostAddress: string | null,
  id: string,
  url: string,
): Browser | null {
  const b = bucket(hostAddress);
  const cur = b.get(id);
  if (!cur) return null;
  const next: Browser = { ...cur, url };
  b.set(id, next);
  scheduleSave();
  return next;
}

export function closeBrowser(hostAddress: string | null, id: string): boolean {
  const b = bucket(hostAddress);
  if (!b.has(id)) return false;
  b.delete(id);
  scheduleSave();
  return true;
}

// Per-room shared browser windows.
//
// A "browser" is a desktop window backed by an iframe whose URL is synced
// across every connected peer in a room. Anyone can open one, change its
// URL, or close it. State persists across relay restarts so a refresh
// doesn't wipe what's open.

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

export type Browser = {
  id: string;
  url: string;
  openedBy: string; // peerId who opened it
  openedAt: number;
  // App that spawned this browser (matches a DEFAULT_APPS / hot-apps id).
  // Lets the frontend lock chrome to that app — e.g. abi-ninja hides the
  // URL bar so the window is permanently pinned to abi.ninja.
  appId?: string;
};

export class BrowserRegistry {
  private browsers = new Map<string, Browser>();
  private loaded = false;
  private saveQueued = false;

  constructor(
    private readonly filePath: string,
    /** Legacy by-host map: `{ [hostAddress]: { [browserId]: Browser } }`.
     *  Only the main room reads this and only for the slop-computer
     *  primary host bucket — see `legacyHostKey`. */
    private readonly legacyPath: string | null = null,
    private readonly legacyHostKey: string | null = null,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.readFrom(this.filePath)) return;
    if (this.legacyPath && this.legacyHostKey) this.readLegacy();
  }

  private readFrom(path: string): boolean {
    try {
      const raw = readFileSync(path, "utf8");
      const obj = JSON.parse(raw) as Record<string, Browser>;
      for (const [id, b] of Object.entries(obj)) {
        this.browsers.set(id, b);
      }
      return true;
    } catch {
      return false;
    }
  }

  private readLegacy(): void {
    try {
      const raw = readFileSync(this.legacyPath!, "utf8");
      const obj = JSON.parse(raw) as Record<string, Record<string, Browser>>;
      const bucket = obj[this.legacyHostKey!];
      if (bucket) {
        for (const [id, b] of Object.entries(bucket)) {
          this.browsers.set(id, b);
        }
      }
    } catch {
      /* fresh start */
    }
  }

  private scheduleSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      try {
        writeFileAtomic(this.filePath, JSON.stringify(Object.fromEntries(this.browsers)));
      } catch (err) {
        console.error("[browsers] failed to persist:", err);
      }
    });
  }

  list(): Browser[] {
    this.load();
    return [...this.browsers.values()];
  }

  open(id: string, url: string, openedBy: string, appId?: string): Browser {
    this.load();
    const browser: Browser = { id, url, openedBy, openedAt: Date.now() };
    if (appId) browser.appId = appId;
    this.browsers.set(id, browser);
    this.scheduleSave();
    return browser;
  }

  navigate(id: string, url: string): Browser | null {
    this.load();
    const cur = this.browsers.get(id);
    if (!cur) return null;
    const next: Browser = { ...cur, url };
    this.browsers.set(id, next);
    this.scheduleSave();
    return next;
  }

  close(id: string): boolean {
    this.load();
    if (!this.browsers.has(id)) return false;
    this.browsers.delete(id);
    this.scheduleSave();
    return true;
  }
}

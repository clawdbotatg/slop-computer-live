// Per-room singleton windows.
//
// A "window" here is a desktop app whose visibility is one-shared-bit
// (open or closed) within a single room, NOT per user. Compare:
//
//   - publications  → one entity per peer (each user's own camera, mic)
//   - browsers      → many shared entities (multiple iframes, by id)
//   - chat          → per-user open/close (your panel, your call)
//   - SINGLETONS    → one shared entity per room (music player, future
//                     calculator, weather widget, etc.) — anyone can
//                     open, all see; anyone can close, all lose it
//
// Position is still tracked via the slot system (keyed by `app-${id}`),
// so the window comes up where it last sat across reloads/peers.

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

export class WindowSet {
  private openIds = new Set<string>();
  private loaded = false;
  private saveQueued = false;

  constructor(
    private readonly filePath: string,
    private readonly legacyPath: string | null = null,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.readFrom(this.filePath)) return;
    if (this.legacyPath) this.readFrom(this.legacyPath);
  }

  private readFrom(path: string): boolean {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { open?: unknown };
      if (Array.isArray(parsed.open)) {
        this.openIds = new Set(parsed.open.filter((s): s is string => typeof s === "string"));
        return true;
      }
    } catch {
      /* missing or unparseable */
    }
    return false;
  }

  private scheduleSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      try {
        writeFileAtomic(this.filePath, JSON.stringify({ open: [...this.openIds] }));
      } catch (err) {
        console.error("[windows] failed to persist:", err);
      }
    });
  }

  list(): string[] {
    this.load();
    return [...this.openIds];
  }

  /** @returns true if the set actually changed. */
  open(id: string): boolean {
    this.load();
    if (this.openIds.has(id)) return false;
    this.openIds.add(id);
    this.scheduleSave();
    return true;
  }

  /** @returns true if the set actually changed. */
  close(id: string): boolean {
    this.load();
    if (!this.openIds.has(id)) return false;
    this.openIds.delete(id);
    this.scheduleSave();
    return true;
  }
}

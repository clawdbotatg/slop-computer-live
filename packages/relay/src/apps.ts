import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room app catalog — the ephemeral / third-party desktop icons that
// only exist in one room. This is the scoped sibling of the two global
// layers (DEFAULT_APPS in code + the hot-apps.json overlay), both of
// which show in every room. An app added via POST /v1/apps lands here,
// in the caller's room, until a host `promote`s it into the global
// overlay. Same on-disk pattern as NoteList: a JSON snapshot at
// .slop-data/rooms/<slug>/apps.json, lazily loaded, atomically written.

export type RoomApp = {
  id: string;
  label: string;
  icon: string;
  url?: string;
  chrome?: "app" | "browser";
};

const MAX_ITEMS = 100;

export class RoomApps {
  private items: RoomApp[] = [];
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { apps?: unknown };
      if (Array.isArray(parsed.apps)) this.items = (parsed.apps as RoomApp[]).slice(0, MAX_ITEMS);
    } catch {
      /* missing or unparseable — empty catalog */
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify({ apps: this.items }, null, 2));
    } catch {
      /* disk write failure — in-memory state still served */
    }
  }

  list(): RoomApp[] {
    this.load();
    return [...this.items];
  }

  get(id: string): RoomApp | undefined {
    this.load();
    return this.items.find(a => a.id === id);
  }

  /** Insert or replace by id. Returns the stored entry. */
  upsert(app: RoomApp): RoomApp {
    this.load();
    const idx = this.items.findIndex(a => a.id === app.id);
    if (idx >= 0) this.items[idx] = app;
    else this.items.push(app);
    this.persist();
    return app;
  }

  remove(id: string): boolean {
    this.load();
    const idx = this.items.findIndex(a => a.id === id);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    this.persist();
    return true;
  }
}

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room shared todo list. Same no-DB pattern as chat: JSON snapshot on
// disk, in-memory cache, change subscribers fan out over the WS mesh.
// Unlike chat (append-only) todos support mutate/delete, so we rewrite
// the snapshot on each change.

const MAX_ITEMS = 200;
const MAX_TEXT_LEN = 500;

export type TodoItem = {
  id: string;
  ts: number;
  /** Lower-cased wallet address of the creator, when authed via SIWE. */
  address: string | null;
  /** Free-form display name. */
  handle: string | null;
  text: string;
  done: boolean;
};

type Subscriber = (items: TodoItem[]) => void;

export class TodoList {
  private items: TodoItem[] = [];
  private subscribers = new Set<Subscriber>();
  private loaded = false;

  /**
   * @param filePath Canonical per-room path (e.g. `.slop-data/rooms/main/todos.json`).
   * @param legacyPath Optional pre-room-aware path to migrate from on first load.
   *   Used by the "main" room to inherit the pre-Phase-1d global `todos.json`.
   *   Read-only — once we persist to `filePath` the legacy file is ignored.
   */
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
      const parsed = JSON.parse(raw) as { items?: unknown };
      if (Array.isArray(parsed.items)) {
        this.items = (parsed.items as TodoItem[]).slice(-MAX_ITEMS);
        return true;
      }
    } catch {
      /* missing or unparseable — caller decides what to fall back to */
    }
    return false;
  }

  private persist(): void {
    try {
      writeFileAtomic(this.filePath, JSON.stringify({ items: this.items }));
    } catch {
      /* disk write failure — in-memory state still served */
    }
  }

  private emit(): void {
    for (const fn of this.subscribers) {
      try {
        fn(this.items);
      } catch {
        /* one bad subscriber shouldn't kill the rest */
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  list(): TodoItem[] {
    this.load();
    return [...this.items];
  }

  add(input: {
    address: string | null;
    handle: string | null;
    text: string;
  }): TodoItem | null {
    this.load();
    const text = input.text.trim().slice(0, MAX_TEXT_LEN);
    if (!text) return null;
    const item: TodoItem = {
      id: randomBytes(8).toString("hex"),
      ts: Date.now(),
      address: input.address ? input.address.toLowerCase() : null,
      handle: input.handle ?? null,
      text,
      done: false,
    };
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS);
    this.persist();
    this.emit();
    return item;
  }

  toggle(id: string): boolean {
    this.load();
    const it = this.items.find(i => i.id === id);
    if (!it) return false;
    it.done = !it.done;
    this.persist();
    this.emit();
    return true;
  }

  update(id: string, text: string): boolean {
    this.load();
    const it = this.items.find(i => i.id === id);
    if (!it) return false;
    const trimmed = text.trim().slice(0, MAX_TEXT_LEN);
    if (!trimmed) return false;
    it.text = trimmed;
    this.persist();
    this.emit();
    return true;
  }

  remove(id: string): boolean {
    this.load();
    const idx = this.items.findIndex(i => i.id === id);
    if (idx < 0) return false;
    this.items.splice(idx, 1);
    this.persist();
    this.emit();
    return true;
  }

  clearDone(): void {
    this.load();
    const before = this.items.length;
    this.items = this.items.filter(i => !i.done);
    if (this.items.length !== before) {
      this.persist();
      this.emit();
    }
  }

  // Reorder the list to match the order in `ids`. Any items present in
  // `items` but missing from `ids` are kept and appended at the end
  // (defensive: a race where one peer reorders while another adds shouldn't
  // nuke the new item). Unknown ids in `ids` are ignored.
  reorder(ids: string[]): void {
    this.load();
    const byId = new Map(this.items.map(i => [i.id, i]));
    const ordered: TodoItem[] = [];
    const used = new Set<string>();
    for (const id of ids) {
      const it = byId.get(id);
      if (it && !used.has(id)) {
        ordered.push(it);
        used.add(id);
      }
    }
    for (const it of this.items) {
      if (!used.has(it.id)) ordered.push(it);
    }
    const sameOrder = ordered.length === this.items.length && ordered.every((it, i) => it.id === this.items[i]?.id);
    if (sameOrder) return;
    this.items = ordered;
    this.persist();
    this.emit();
  }
}

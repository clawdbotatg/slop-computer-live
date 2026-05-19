import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room shared notes — same pattern as todos: JSON snapshot on disk,
// in-memory cache, broadcast subscribers. Each note has a single text
// body; the client uses the first line as a title in the list view.
// Anyone can create / edit / delete.

const MAX_ITEMS = 200;
const MAX_TEXT_LEN = 10_000;

export type Note = {
  id: string;
  createdTs: number;
  updatedTs: number;
  address: string | null;
  handle: string | null;
  text: string;
};

type Subscriber = (items: Note[]) => void;

export class NoteList {
  private items: Note[] = [];
  private subscribers = new Set<Subscriber>();
  private loaded = false;

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
        this.items = (parsed.items as Note[]).slice(-MAX_ITEMS);
        return true;
      }
    } catch {
      /* missing or unparseable */
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

  list(): Note[] {
    this.load();
    return [...this.items];
  }

  create(input: {
    address: string | null;
    handle: string | null;
    text: string;
  }): Note | null {
    this.load();
    const text = input.text.slice(0, MAX_TEXT_LEN);
    const now = Date.now();
    const note: Note = {
      id: randomBytes(8).toString("hex"),
      createdTs: now,
      updatedTs: now,
      address: input.address ? input.address.toLowerCase() : null,
      handle: input.handle ?? null,
      text,
    };
    this.items.push(note);
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS);
    this.persist();
    this.emit();
    return note;
  }

  update(id: string, text: string): boolean {
    this.load();
    const it = this.items.find(i => i.id === id);
    if (!it) return false;
    it.text = text.slice(0, MAX_TEXT_LEN);
    it.updatedTs = Date.now();
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
}

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";

// Per-room research corpus — host-curated source documents for the
// guest-research AI. Same shape as notes (JSON snapshot on disk,
// in-memory cache, broadcast subscribers) but each doc has an explicit
// `name` separate from its body: the body is pasted material (tweet
// threads, article text, bios) and routinely starts with junk that
// would make a terrible first-line title.
//
// Lifecycle is tied to the research flow, not the room: every doc is
// about the CURRENT guest, so the research "Start over" (DELETE
// /v1/research) clears the corpus along with the dossier. Anyone in
// the room can create / edit / delete — same permissive model as notes.
//
// When a lookup or research job starts, the relay tiles every doc's
// text into the AI prompt as host-provided context (guest-research.ts).

const MAX_ITEMS = 50;
const MAX_NAME_LEN = 80;
const MAX_TEXT_LEN = 20_000;

export type CorpusDoc = {
  id: string;
  createdTs: number;
  updatedTs: number;
  address: string | null;
  handle: string | null;
  /** Stable anon id of the author, for anon users — same role as on Note. */
  anonId?: string | null;
  name: string;
  text: string;
};

type Subscriber = (items: CorpusDoc[]) => void;

export class ResearchCorpus {
  private items: CorpusDoc[] = [];
  private subscribers = new Set<Subscriber>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { items?: unknown };
      if (Array.isArray(parsed.items)) this.items = (parsed.items as CorpusDoc[]).slice(-MAX_ITEMS);
    } catch {
      /* missing or unparseable */
    }
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

  list(): CorpusDoc[] {
    this.load();
    return [...this.items];
  }

  create(input: {
    address: string | null;
    handle: string | null;
    anonId?: string | null;
    name: string;
    text?: string;
  }): CorpusDoc | null {
    this.load();
    if (this.items.length >= MAX_ITEMS) return null;
    const now = Date.now();
    const doc: CorpusDoc = {
      id: randomBytes(8).toString("hex"),
      createdTs: now,
      updatedTs: now,
      address: input.address ? input.address.toLowerCase() : null,
      handle: input.handle ?? null,
      anonId: input.anonId ?? null,
      name: input.name.slice(0, MAX_NAME_LEN),
      text: (input.text ?? "").slice(0, MAX_TEXT_LEN),
    };
    this.items.push(doc);
    this.persist();
    this.emit();
    return doc;
  }

  /** Patch-style update: only the provided fields change. Name and text
   *  edit independently (rename field vs. body textarea in the UI). */
  update(id: string, patch: { name?: string; text?: string }): boolean {
    this.load();
    const it = this.items.find(i => i.id === id);
    if (!it) return false;
    if (typeof patch.name === "string") it.name = patch.name.slice(0, MAX_NAME_LEN);
    if (typeof patch.text === "string") it.text = patch.text.slice(0, MAX_TEXT_LEN);
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

  /** Wipe every doc — called by the research "Start over" so a new
   *  guest begins with an empty corpus. */
  clear(): void {
    this.load();
    if (this.items.length === 0) return;
    this.items = [];
    this.persist();
    this.emit();
  }
}

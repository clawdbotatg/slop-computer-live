import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Shared notes — same pattern as todos: JSON snapshot on disk, in-memory
// cache, broadcast subscribers. Each note has a single text body; the
// client uses the first line as a title in the list view. Anyone can
// create / edit / delete.

const NOTES_FILE = process.env.NOTES_FILE ?? "./.slop-data/notes.json";
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

let items: Note[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(NOTES_FILE, "utf8");
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (Array.isArray(parsed.items)) {
      items = (parsed.items as Note[]).slice(-MAX_ITEMS);
    }
  } catch {
    /* fresh */
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(NOTES_FILE), { recursive: true });
    writeFileSync(NOTES_FILE, JSON.stringify({ items }), "utf8");
  } catch {
    /* disk write failure — in-memory state still served */
  }
}

type Subscriber = (items: Note[]) => void;
const subscribers = new Set<Subscriber>();

function emit(): void {
  for (const fn of subscribers) {
    try {
      fn(items);
    } catch {
      /* ignore */
    }
  }
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function list(): Note[] {
  load();
  return [...items];
}

export function create(input: {
  address: string | null;
  handle: string | null;
  text: string;
}): Note | null {
  load();
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
  items.push(note);
  if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
  persist();
  emit();
  return note;
}

export function update(id: string, text: string): boolean {
  load();
  const it = items.find(i => i.id === id);
  if (!it) return false;
  it.text = text.slice(0, MAX_TEXT_LEN);
  it.updatedTs = Date.now();
  persist();
  emit();
  return true;
}

export function remove(id: string): boolean {
  load();
  const idx = items.findIndex(i => i.id === id);
  if (idx < 0) return false;
  items.splice(idx, 1);
  persist();
  emit();
  return true;
}

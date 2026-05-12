import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Shared todo list — single global list visible to every peer. Same
// no-DB pattern as chat: JSON snapshot on disk, in-memory cache, change
// subscribers fan out over the WS mesh. Unlike chat (append-only), todos
// support mutate/delete, so we rewrite the snapshot on each change.

const TODOS_FILE = process.env.TODOS_FILE ?? "./.slop-data/todos.json";
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

let items: TodoItem[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(TODOS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (Array.isArray(parsed.items)) {
      items = (parsed.items as TodoItem[]).slice(-MAX_ITEMS);
    }
  } catch {
    /* fresh */
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(TODOS_FILE), { recursive: true });
    writeFileSync(TODOS_FILE, JSON.stringify({ items }), "utf8");
  } catch {
    /* disk write failure — in-memory state still served */
  }
}

type Subscriber = (items: TodoItem[]) => void;
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

export function list(): TodoItem[] {
  load();
  return [...items];
}

export function add(input: {
  address: string | null;
  handle: string | null;
  text: string;
}): TodoItem | null {
  load();
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
  items.push(item);
  if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
  persist();
  emit();
  return item;
}

export function toggle(id: string): boolean {
  load();
  const it = items.find(i => i.id === id);
  if (!it) return false;
  it.done = !it.done;
  persist();
  emit();
  return true;
}

export function update(id: string, text: string): boolean {
  load();
  const it = items.find(i => i.id === id);
  if (!it) return false;
  const trimmed = text.trim().slice(0, MAX_TEXT_LEN);
  if (!trimmed) return false;
  it.text = trimmed;
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

export function clearDone(): void {
  load();
  const before = items.length;
  items = items.filter(i => !i.done);
  if (items.length !== before) {
    persist();
    emit();
  }
}

// Reorder the list to match the order in `ids`. Any items present in
// `items` but missing from `ids` are kept and appended at the end
// (defensive: a race where one peer reorders while another adds shouldn't
// nuke the new item). Unknown ids in `ids` are ignored.
export function reorder(ids: string[]): void {
  load();
  const byId = new Map(items.map(i => [i.id, i]));
  const ordered: TodoItem[] = [];
  const used = new Set<string>();
  for (const id of ids) {
    const it = byId.get(id);
    if (it && !used.has(id)) {
      ordered.push(it);
      used.add(id);
    }
  }
  for (const it of items) {
    if (!used.has(it.id)) ordered.push(it);
  }
  // Skip the broadcast when the order hasn't actually changed (e.g.
  // a drop that landed back at the same index).
  const sameOrder = ordered.length === items.length && ordered.every((it, i) => it.id === items[i]?.id);
  if (sameOrder) return;
  items = ordered;
  persist();
  emit();
}

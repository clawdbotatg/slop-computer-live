import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineTerm } from "./glossary-ai.js";

// Shared glossary — terms added by any peer get an AI-generated TLDR
// attached asynchronously. Same persistence + broadcast pattern as
// notes/todos: JSON snapshot on disk, in-memory cache, full-list
// rebroadcast on every change. Term creation returns immediately with
// status="pending"; the AI call lands later and bumps status to "ready"
// (or "error") with the TLDR text.

const GLOSSARY_FILE = process.env.GLOSSARY_FILE ?? "./.slop-data/glossary.json";
const MAX_ITEMS = 200;
const MAX_TERM_LEN = 120;

export type GlossaryStatus = "pending" | "ready" | "error";

export type GlossaryTerm = {
  id: string;
  term: string;
  tldr: string; // empty until the AI call resolves
  status: GlossaryStatus;
  createdTs: number;
  updatedTs: number;
  address: string | null;
  handle: string | null;
};

let items: GlossaryTerm[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(GLOSSARY_FILE, "utf8");
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (Array.isArray(parsed.items)) {
      items = (parsed.items as GlossaryTerm[]).slice(-MAX_ITEMS);
    }
  } catch {
    /* fresh */
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(GLOSSARY_FILE), { recursive: true });
    writeFileSync(GLOSSARY_FILE, JSON.stringify({ items }), "utf8");
  } catch {
    /* disk write failure — in-memory state still served */
  }
}

type Subscriber = (items: GlossaryTerm[]) => void;
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

export function list(): GlossaryTerm[] {
  load();
  return [...items];
}

// Kick off the AI call in the background; when it returns, update the
// stored term in place and re-emit so subscribers see the new TLDR.
// We re-find the entry by id at completion time because the term could
// have been removed (or recreated with a fresh id) while the request
// was in flight. Pass other entries as priming so the AI infers the
// domain from existing glossary terms.
function generateTldrAsync(id: string, term: string): void {
  // Snapshot peer terms BEFORE the async call so we don't capture the
  // pending entry itself (it was just pushed onto `items`).
  const existingTerms = items.filter(i => i.id !== id).map(i => i.term);
  void (async () => {
    try {
      const tldr = await defineTerm(term, { existingTerms });
      load();
      const it = items.find(i => i.id === id);
      if (!it) return;
      it.tldr = tldr;
      it.status = tldr.startsWith("(AI ") ? "error" : "ready";
      it.updatedTs = Date.now();
      persist();
      emit();
    } catch (err) {
      load();
      const it = items.find(i => i.id === id);
      if (!it) return;
      it.tldr = `(unexpected error: ${String(err).slice(0, 100)})`;
      it.status = "error";
      it.updatedTs = Date.now();
      persist();
      emit();
    }
  })();
}

export function create(input: {
  term: string;
  address: string | null;
  handle: string | null;
}): GlossaryTerm | null {
  load();
  const term = input.term.trim().slice(0, MAX_TERM_LEN);
  if (!term) return null;
  // Soft-dedupe: case-insensitive match returns the existing entry
  // instead of stacking duplicates. Anyone wanting a fresh TLDR can
  // hit the regenerate endpoint.
  const existing = items.find(i => i.term.toLowerCase() === term.toLowerCase());
  if (existing) return existing;

  const now = Date.now();
  const entry: GlossaryTerm = {
    id: randomBytes(8).toString("hex"),
    term,
    tldr: "",
    status: "pending",
    createdTs: now,
    updatedTs: now,
    address: input.address ? input.address.toLowerCase() : null,
    handle: input.handle ?? null,
  };
  items.push(entry);
  if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
  persist();
  emit();
  generateTldrAsync(entry.id, entry.term);
  return entry;
}

export function regenerate(id: string): boolean {
  load();
  const it = items.find(i => i.id === id);
  if (!it) return false;
  it.status = "pending";
  it.tldr = "";
  it.updatedTs = Date.now();
  persist();
  emit();
  generateTldrAsync(it.id, it.term);
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

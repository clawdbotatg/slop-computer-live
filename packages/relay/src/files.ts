import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Shared desktop file system. Every authenticated user can drop a file
// onto the desktop; it uploads, lands at a position (slot id `file-<id>`),
// and every peer sees the icon. Click → download via the relay.
//
// Storage layout:
//   $FILES_DIR/<id>.<ext>     — the actual bytes (random id)
//   $FILES_DIR/files.json     — metadata array (this module's source of truth)
//
// We persist the file LIST on every mutation; the binary content lives
// alongside in the same directory. The systemd box maps $FILES_DIR to
// /var/lib/slop-relay/files so a relay restart keeps everything.

const FILES_DIR = process.env.FILES_DIR ?? "./.slop-data/files";
const METADATA_FILE = `${FILES_DIR}/files.json`;
const MAX_ITEMS = 500;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file
export const FILES_DIR_PATH = FILES_DIR;
export const FILES_MAX_BYTES = MAX_FILE_BYTES;

export type FileEntry = {
  id: string;
  /** Original filename as uploaded — what the user dragged in. */
  name: string;
  size: number;
  mime: string;
  /** Uploader's stable owner key (lowercased address ?? handle). */
  ownerKey: string;
  /** Display label for the uploader (handle preferred, else address). */
  uploaderLabel: string;
  /** Server-stamped ms epoch when the upload landed. */
  ts: number;
  /** On-disk filename (id + the safest extension we could infer). */
  storedAs: string;
};

let items: FileEntry[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(METADATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (Array.isArray(parsed.items)) {
      items = (parsed.items as FileEntry[]).slice(-MAX_ITEMS);
    }
  } catch {
    /* fresh */
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(METADATA_FILE), { recursive: true });
    writeFileSync(METADATA_FILE, JSON.stringify({ items }), "utf8");
  } catch {
    /* disk write failure — in-memory state still served */
  }
}

type Subscriber = (event: FileEvent) => void;
type FileEvent =
  | { type: "added"; item: FileEntry }
  | { type: "removed"; id: string }
  | { type: "list"; items: FileEntry[] };
const subscribers = new Set<Subscriber>();

function emit(event: FileEvent): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      /* ignore */
    }
  }
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function list(): FileEntry[] {
  load();
  return [...items];
}

// Pick a safe-ish extension from a filename. Falls back to "bin" so the
// stored path always has SOMETHING after the dot.
function extFor(name: string): string {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name);
  const ext = m?.[1];
  return ext ? ext.toLowerCase() : "bin";
}

export type AddInput = {
  name: string;
  mime: string;
  buffer: Buffer;
  ownerKey: string;
  uploaderLabel: string;
};

export function add(input: AddInput): FileEntry | { error: string } {
  load();
  if (input.buffer.length === 0) return { error: "empty" };
  if (input.buffer.length > MAX_FILE_BYTES) return { error: "too-large" };
  const safeName = (input.name || "untitled").slice(0, 200).replace(/[\r\n\t]/g, " ").trim() || "untitled";
  const id = randomBytes(8).toString("hex");
  const storedAs = `${id}.${extFor(safeName)}`;
  mkdirSync(FILES_DIR, { recursive: true });
  try {
    writeFileSync(`${FILES_DIR}/${storedAs}`, input.buffer);
  } catch (err) {
    return { error: `write-failed:${(err as Error).message}` };
  }
  const item: FileEntry = {
    id,
    name: safeName,
    size: input.buffer.length,
    mime: input.mime || "application/octet-stream",
    ownerKey: input.ownerKey.toLowerCase(),
    uploaderLabel: input.uploaderLabel || "anon",
    ts: Date.now(),
    storedAs,
  };
  items.push(item);
  if (items.length > MAX_ITEMS) {
    const evicted = items.slice(0, items.length - MAX_ITEMS);
    items = items.slice(-MAX_ITEMS);
    for (const e of evicted) {
      try {
        unlinkSync(`${FILES_DIR}/${e.storedAs}`);
      } catch {
        /* file already gone is fine */
      }
    }
  }
  persist();
  emit({ type: "added", item });
  return item;
}

export function get(id: string): FileEntry | null {
  load();
  return items.find(i => i.id === id) ?? null;
}

export type RemoveResult = "ok" | "not-found" | "forbidden";

export function remove(id: string, callerOwnerKey: string, callerIsHost: boolean): RemoveResult {
  load();
  const idx = items.findIndex(i => i.id === id);
  if (idx < 0) return "not-found";
  const item = items[idx]!;
  // Uploaders can delete their own files; host can delete anyone's.
  if (!callerIsHost && item.ownerKey !== callerOwnerKey.toLowerCase()) return "forbidden";
  items.splice(idx, 1);
  try {
    unlinkSync(`${FILES_DIR}/${item.storedAs}`);
  } catch {
    /* already gone */
  }
  persist();
  emit({ type: "removed", id });
  return "ok";
}

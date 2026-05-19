import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";
import { pinBlob } from "./ipfs.js";

// Per-room desktop file system. Every authenticated user in a room can
// drop a file onto the desktop; it uploads, lands at a position
// (slot id `file-<id>`), and every peer in that room sees the icon.
// Click → download via the relay.
//
// Storage layout (per-room):
//   <dir>/<id>.<ext>      — the actual bytes (random id)
//   <dir>/files.json      — metadata array (this module's source of truth)
//
// Phase 4 moves blobs to BGIPFS and stores `cid` instead of `storedAs`
// — until that lands the on-box layout above remains. Per-room dirs
// give each room its own blob namespace today.

const MAX_ITEMS = 500;
export const FILES_MAX_BYTES = 50 * 1024 * 1024; // 50 MB per file

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
  /** On-disk filename (id + the safest extension we could infer).
   *  Legacy entries from before BGIPFS pinning still rely on this for
   *  serving; new entries also keep it as a fallback when the IPFS
   *  gateway is down. */
  storedAs: string;
  /** BGIPFS content id, set once the background pin completes. Download
   *  prefers the gateway URL over local storage when present — keeps the
   *  prod box's outbound bandwidth off the hot path. */
  cid?: string;
};

export type FileEvent =
  | { type: "added"; item: FileEntry }
  | { type: "removed"; id: string }
  | { type: "list"; items: FileEntry[] };

type Subscriber = (event: FileEvent) => void;

export type AddInput = {
  name: string;
  mime: string;
  buffer: Buffer;
  ownerKey: string;
  uploaderLabel: string;
};

export type RemoveResult = "ok" | "not-found" | "forbidden";

// Pick a safe-ish extension from a filename. Falls back to "bin" so the
// stored path always has SOMETHING after the dot.
function extFor(name: string): string {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name);
  const ext = m?.[1];
  return ext ? ext.toLowerCase() : "bin";
}

export class FileIndex {
  private items: FileEntry[] = [];
  private loaded = false;
  private subscribers = new Set<Subscriber>();

  /**
   * @param blobsDir Where uploaded bytes land (one file per upload).
   * @param metadataFile JSON catalog of FileEntry rows.
   * @param legacyBlobsDir Legacy dir to migrate read-only from on first load
   *   (used so the main room inherits files uploaded before the per-room split).
   * @param legacyMetadataFile Legacy JSON to read from if the canonical one is missing.
   * @param ipfsApiUrl kubo daemon URL. When set, every upload pins to BGIPFS
   *   in the background and stamps `cid` once the pin returns. The local
   *   copy in `blobsDir` is still written first so a failed/slow pin
   *   doesn't block the upload response.
   */
  constructor(
    public readonly blobsDir: string,
    private readonly metadataFile: string,
    private readonly legacyBlobsDir: string | null = null,
    private readonly legacyMetadataFile: string | null = null,
    private readonly ipfsApiUrl: string | null = null,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.readFrom(this.metadataFile)) return;
    if (this.legacyMetadataFile) this.readFrom(this.legacyMetadataFile);
  }

  private readFrom(path: string): boolean {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { items?: unknown };
      if (Array.isArray(parsed.items)) {
        this.items = (parsed.items as FileEntry[]).slice(-MAX_ITEMS);
        return true;
      }
    } catch {
      /* missing or unparseable */
    }
    return false;
  }

  private persist(): void {
    try {
      writeFileAtomic(this.metadataFile, JSON.stringify({ items: this.items }));
    } catch {
      /* disk write failure — in-memory state still served */
    }
  }

  private emit(event: FileEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* one bad subscriber shouldn't kill the rest */
      }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  list(): FileEntry[] {
    this.load();
    return [...this.items];
  }

  /** Resolve a file id to its absolute on-disk path, honoring legacy
   *  storage for entries inherited from the pre-per-room dir. */
  pathOf(entry: FileEntry): string {
    // If the canonical blobs dir has the file, prefer it. Otherwise fall
    // back to the legacy dir (read-only). On first load after the split,
    // legacy entries still live in legacyBlobsDir; new uploads land in
    // blobsDir.
    if (this.legacyBlobsDir) {
      // Try canonical first by stat-ing — but a missing file isn't always
      // an error path here (Node returns ENOENT on readFile in get() if
      // it's gone). We don't actually fopen here; caller does. Just
      // return canonical and let the caller fall back if needed.
    }
    return `${this.blobsDir}/${entry.storedAs}`;
  }

  /** Try the canonical path first, then the legacy path. Caller uses this
   *  when reading bytes off disk so legacy uploads still serve. */
  resolveReadPath(entry: FileEntry): string {
    const canonical = `${this.blobsDir}/${entry.storedAs}`;
    if (!this.legacyBlobsDir) return canonical;
    try {
      readFileSync(canonical);
      return canonical;
    } catch {
      return `${this.legacyBlobsDir}/${entry.storedAs}`;
    }
  }

  add(input: AddInput): FileEntry | { error: string } {
    this.load();
    if (input.buffer.length === 0) return { error: "empty" };
    if (input.buffer.length > FILES_MAX_BYTES) return { error: "too-large" };
    const safeName = (input.name || "untitled").slice(0, 200).replace(/[\r\n\t]/g, " ").trim() || "untitled";
    const id = randomBytes(8).toString("hex");
    const storedAs = `${id}.${extFor(safeName)}`;
    mkdirSync(this.blobsDir, { recursive: true });
    try {
      writeFileSync(`${this.blobsDir}/${storedAs}`, input.buffer);
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
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) {
      const evicted = this.items.slice(0, this.items.length - MAX_ITEMS);
      this.items = this.items.slice(-MAX_ITEMS);
      for (const e of evicted) {
        try {
          unlinkSync(`${this.blobsDir}/${e.storedAs}`);
        } catch {
          /* file already gone is fine */
        }
      }
    }
    this.persist();
    this.emit({ type: "added", item });
    // Background BGIPFS pin. We return the entry immediately so the
    // uploader's HTTP response isn't blocked on the gateway. The pin
    // result is recorded by the callback below; a failed pin leaves
    // `cid` unset and the file is served from local storage forever.
    if (this.ipfsApiUrl) {
      void this.pinInBackground(item.id, input.buffer, safeName);
    }
    return item;
  }

  private async pinInBackground(id: string, bytes: Buffer, filename: string): Promise<void> {
    if (!this.ipfsApiUrl) return;
    try {
      const cid = await pinBlob({ apiUrl: this.ipfsApiUrl, bytes, filename });
      this.setCid(id, cid);
    } catch (err) {
      // Pin failure is non-fatal — the file is still served locally.
      // Log at warn so prod has signal but a flaky kubo doesn't spam.
      console.warn(`[files] ipfs pin failed for ${id}:`, (err as Error).message);
    }
  }

  /** Record the BGIPFS CID after a background pin completes (or for the
   *  legacy backfill flow). No-op if the entry has gone away since. */
  setCid(id: string, cid: string): void {
    this.load();
    const it = this.items.find(i => i.id === id);
    if (!it) return;
    if (it.cid === cid) return;
    it.cid = cid;
    this.persist();
    this.emit({ type: "added", item: it });
  }

  get(id: string): FileEntry | null {
    this.load();
    return this.items.find(i => i.id === id) ?? null;
  }

  remove(id: string, callerOwnerKey: string, callerIsHost: boolean): RemoveResult {
    this.load();
    const idx = this.items.findIndex(i => i.id === id);
    if (idx < 0) return "not-found";
    const item = this.items[idx]!;
    // Uploaders can delete their own files; host can delete anyone's.
    if (!callerIsHost && item.ownerKey !== callerOwnerKey.toLowerCase()) return "forbidden";
    this.items.splice(idx, 1);
    try {
      unlinkSync(`${this.blobsDir}/${item.storedAs}`);
    } catch {
      /* already gone */
    }
    this.persist();
    this.emit({ type: "removed", id });
    return "ok";
  }
}

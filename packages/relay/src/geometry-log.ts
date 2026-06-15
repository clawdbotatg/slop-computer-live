// Append-only, time-ordered log of window geometry over an episode.
//
// Why this exists: the relay knows every shared-desktop window's exact
// `{x, y, width, height, z}` because it renders the layout. The episode
// recording, however, is a flat OBS-captured MP4 — that truth never reaches
// the artifact. Downstream tools (the clipper's 9:16 mobile crop) otherwise
// have to recover window rects with computer vision from the pixels. By
// logging the geometry during the session and pinning it next to the video
// (referenced from the manifest, same pattern as transcript / chat / card),
// the clipper can read rects deterministically and fall back to CV only when
// the log is absent (older episodes, a dropped log).
//
// Format — newline-delimited JSON, one event per line, time-ordered. The
// consumer replays events with `ts <= T` to reconstruct the live window set
// at any time T (last write per `id` wins; `removed` drops it). A `header`
// line is prepended at finalize (it carries `videoStartMs`, which is only
// known once the recording filename is parsed). Lines:
//
//   { "ts": 1736900012345, "id": "owner-0xab12…-camera", "shown": true,
//     "x": 520, "y": 88, "w": 480, "h": 360, "z": 6 }   // window appeared
//   { "ts": …, "id": "owner-0xab12…-camera", "x": …, "y": …, "w": …, "h": …, "z": … }  // moved/resized
//   { "ts": …, "id": "owner-0xab12…-camera", "removed": true }  // window closed
//
// The `id` is the stable slot id (`owner-<ownerKey>-<kind>[-<streamId>]`), so
// the consumer can parse owner + kind from it and join owner → display name
// via `manifest.participants` — no fuzzy matching, no roster duplicated here.
//
// Scope: only media slots (`owner-…` ids — camera / audio / screen) are
// logged. Browser/app windows aren't speakers, so they're skipped to keep the
// log small and focused on the speaker→tile mapping the clipper needs.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SlotPosition } from "./desktop.js";

// A drag fires many slot updates; coalesce to ≤1 line per slot per window so
// the log stays tiny next to chat/transcript. The trailing flush guarantees
// the final resting position lands.
const FLUSH_MS = 150;

// Only speaker windows carry this prefix (see slotIdFor in desktop.ts).
const isMediaSlot = (id: string): boolean => id.startsWith("owner-");

/** One window's actual rendered rect in the OBS-capture (god-mode) browser, in
 *  that browser's CSS px (viewport-relative). `vw`/`vh` (the viewport) travel
 *  with each line so the consumer maps to the recorded frame as x/vw, y/vh. */
export type GodWindow = { id: string; x: number; y: number; w: number; h: number; z: number };

export class GeometryLog {
  private pending = new Map<string, SlotPosition>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingGod: { vw: number; vh: number; windows: GodWindow[] } | null = null;
  private godTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly filePath: string) {}

  /** A slot moved/resized. Throttled — coalesced into ≤1 line per slot per
   *  FLUSH_MS, with a trailing flush so the final position is always written. */
  recordMove(slot: SlotPosition): void {
    if (!isMediaSlot(slot.id)) return;
    this.pending.set(slot.id, slot);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPending();
    }, FLUSH_MS);
  }

  /** A window appeared (a publication mapped to this slot went live). Emitted
   *  immediately. Carries the slot geometry if already known so the consumer
   *  has a position even for a window that never moves during the session. */
  recordShow(id: string, slot: SlotPosition | null): void {
    if (!isMediaSlot(id)) return;
    this.flushPending(); // preserve ordering vs. any queued moves
    if (slot) {
      this.write({ id, shown: true, x: slot.x, y: slot.y, w: slot.width, h: slot.height, z: slot.z });
    } else {
      this.write({ id, shown: true });
    }
  }

  /** A window closed (publication unpublished or peer disconnected). */
  recordHide(id: string): void {
    if (!isMediaSlot(id)) return;
    this.flushPending();
    this.write({ id, removed: true });
  }

  /** GOD-FRAME geometry: the god-mode/OBS browser's snapshot of every media
   *  window's ACTUAL rendered rect + that browser's viewport (vw/vh). This is
   *  the recorded-frame truth — it maps to the captured pixels with no
   *  calibration guess, unlike the slot rects recordMove logs (a different
   *  composition). Coalesced like recordMove (the client already debounces).
   *  Lines carry `shown:true` so they're self-sufficient; window REMOVAL still
   *  comes from recordHide (a closed window simply drops out of the snapshot).
   *  Consumers prefer god lines (vw/vh present) over slot lines per id. */
  recordGod(vw: number, vh: number, windows: GodWindow[]): void {
    const media = windows.filter(w => isMediaSlot(w.id));
    if (!media.length) return;
    this.pendingGod = { vw, vh, windows: media };
    if (this.godTimer) return;
    this.godTimer = setTimeout(() => {
      this.godTimer = null;
      this.flushGod();
    }, FLUSH_MS);
  }

  private flushGod(): void {
    if (this.godTimer) {
      clearTimeout(this.godTimer);
      this.godTimer = null;
    }
    if (!this.pendingGod) return;
    const { vw, vh, windows } = this.pendingGod;
    this.pendingGod = null;
    for (const w of windows) {
      this.write({ id: w.id, shown: true, x: w.x, y: w.y, w: w.w, h: w.h, z: w.z, vw, vh, src: "god" });
    }
  }

  private flushPending(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.size === 0) return;
    for (const slot of this.pending.values()) {
      this.write({ id: slot.id, x: slot.x, y: slot.y, w: slot.width, h: slot.height, z: slot.z });
    }
    this.pending.clear();
  }

  private write(fields: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: Date.now(), ...fields });
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, line + "\n", "utf8");
    } catch {
      // Disk write failed — a dropped geometry line just means the clipper
      // falls back to its CV pixel pipeline for that frame. Never fatal.
    }
  }

  /** Snapshot the log for finalize. Flushes any pending move first so the
   *  snapshot is complete, then reads the file as-is. `sampleCount` is the
   *  number of event lines (used to skip pinning an empty log). */
  readArchive(): { content: string; sampleCount: number } | null {
    this.flushPending();
    this.flushGod();
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return null;
    }
    let sampleCount = 0;
    for (const line of raw.split("\n")) if (line.trim()) sampleCount++;
    return { content: raw, sampleCount };
  }

  /** Wipe the log to a clean slate. The file is append-only and keyed per
   *  slug, so without this it accumulates ACROSS sessions on the same slug —
   *  a replay-by-timestamp consumer then sees stale rects from prior shows.
   *  Called from the host's "reset STT" path so a new session starts fresh.
   *  Drops any queued move and truncates the file; the caller (DesktopState)
   *  re-emits currently-visible windows so the fresh log still has a baseline. */
  reset(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.godTimer) {
      clearTimeout(this.godTimer);
      this.godTimer = null;
    }
    this.pending.clear();
    this.pendingGod = null;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, "", "utf8");
    } catch {
      // Truncate failed — non-fatal; worst case the old lines linger and the
      // clipper's CV fallback covers any misalignment.
    }
  }
}

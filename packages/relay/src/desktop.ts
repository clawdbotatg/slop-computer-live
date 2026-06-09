// Per-room desktop state.
//
// Two distinct concepts:
//
// 1. Publications — ephemeral, per-peer announcements of "I'm publishing
//    streamId X of kind Y with label Z". Lives in memory only; cleared on
//    disconnect. Drives whether a window exists at all.
//
// 2. Slot positions — persistent record of where a stable "slot" should
//    live (x, y, width, height, z). Only stores the layout; the slot only
//    renders if there's an active publication that maps to it. Mirrored
//    to disk so a relay restart preserves positions.
//
// Slot IDs are stable strings:
//   "host-camera", "host-screen"     — host's own streams, keyed by kind
//   "peer-<peerId>-<streamId>"        — each guest stream gets its own slot
//                                       (peer streams are ephemeral so position
//                                       isn't kept across reconnects, but the
//                                       slot id is deterministic for the
//                                       current session).

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";
import type { GeometryLog } from "./geometry-log.js";

export type SlotKind = "camera" | "screen" | "audio";

// Stable slot id for a media publication. MUST match the frontend's
// `slotIdFor` (Desktop.tsx) — the id is the join key the geometry log and the
// clipper use to map a window rect back to its owner + kind. Screens include
// the streamId so one user sharing two screens gets two windows.
export function slotIdFor(pub: Pick<Publication, "ownerKey" | "kind" | "streamId">): string {
  if (pub.kind === "screen") return `owner-${pub.ownerKey}-screen-${pub.streamId}`;
  return `owner-${pub.ownerKey}-${pub.kind}`;
}

export type Publication = {
  streamId: string;
  peerId: string;     // ephemeral; changes every WS reconnect
  ownerKey: string;   // stable across reconnects (wallet address or handle)
  kind: SlotKind;
  label: string;
  /** Camera publications only. When the publisher flips to audio-only,
   *  they stop sending video but keep the mic; this flag tells every
   *  peer (and the late-joiner snapshot) to render the avatar in place
   *  of the now-black video. Undefined === false. */
  cameraOff?: boolean;
};

export type SlotPosition = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
};

export class DesktopState {
  private slots = new Map<string, SlotPosition>();
  private publicationsByPeer = new Map<string, Publication[]>();
  private loaded = false;
  private saveQueued = false;

  constructor(
    private readonly slotsFile: string,
    /** Legacy global slots file `{ [hostAddress]: { [slotId]: SlotPos } }`.
     *  Only the main room reads this and only for the configured primary
     *  host bucket. */
    private readonly legacySlotsFile: string | null = null,
    private readonly legacyHostKey: string | null = null,
    /** Append-only geometry log. Every slot move / window show / window hide
     *  funnels through this class's methods, so wiring the log here captures
     *  both the WS `slot_update` path and the HTTP `/v1/slots` path with no
     *  call-site duplication. Null disables logging (e.g. in tests). */
    private readonly geometry: GeometryLog | null = null,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.readFrom(this.slotsFile)) return;
    if (this.legacySlotsFile && this.legacyHostKey) this.readLegacy();
  }

  private readFrom(path: string): boolean {
    try {
      const raw = readFileSync(path, "utf8");
      const obj = JSON.parse(raw) as Record<string, SlotPosition>;
      for (const [id, slot] of Object.entries(obj)) {
        this.slots.set(id, slot);
      }
      return true;
    } catch {
      return false;
    }
  }

  private readLegacy(): void {
    try {
      const raw = readFileSync(this.legacySlotsFile!, "utf8");
      const obj = JSON.parse(raw) as Record<string, Record<string, SlotPosition>>;
      const bucket = obj[this.legacyHostKey!];
      if (bucket) {
        for (const [id, slot] of Object.entries(bucket)) this.slots.set(id, slot);
      }
    } catch {
      /* fresh start */
    }
  }

  private scheduleSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      try {
        writeFileAtomic(this.slotsFile, JSON.stringify(Object.fromEntries(this.slots)));
      } catch (err) {
        console.error("[desktop] failed to persist slots:", err);
      }
    });
  }

  // ---- slot positions ------------------------------------------------------

  getSlots(): SlotPosition[] {
    this.load();
    return [...this.slots.values()];
  }

  applySlotUpdate(patch: Partial<SlotPosition> & { id: string }): SlotPosition | null {
    this.load();
    const prev = this.slots.get(patch.id);
    const merged: SlotPosition = {
      id: patch.id,
      x: patch.x ?? prev?.x ?? 80,
      y: patch.y ?? prev?.y ?? 280,
      width: patch.width ?? prev?.width ?? 360,
      height: patch.height ?? prev?.height ?? 260,
      z: patch.z ?? prev?.z ?? 1,
    };
    this.slots.set(patch.id, merged);
    this.scheduleSave();
    this.geometry?.recordMove(merged);
    return merged;
  }

  // ---- publications --------------------------------------------------------

  listPublications(): Publication[] {
    const out: Publication[] = [];
    for (const list of this.publicationsByPeer.values()) out.push(...list);
    return out;
  }

  publish(p: Publication): void {
    const list = this.publicationsByPeer.get(p.peerId) ?? [];
    // De-dupe: if same streamId already exists, replace it.
    const next = list.filter(x => x.streamId !== p.streamId);
    next.push(p);
    this.publicationsByPeer.set(p.peerId, next);
    // Window became live — log it with its current position (if a slot is
    // already remembered) so the geometry log carries even never-moved windows.
    const slotId = slotIdFor(p);
    this.geometry?.recordShow(slotId, this.getSlot(slotId));
  }

  getSlot(id: string): SlotPosition | null {
    this.load();
    return this.slots.get(id) ?? null;
  }

  unpublish(peerId: string, streamId: string): boolean {
    const list = this.publicationsByPeer.get(peerId);
    if (!list) return false;
    const removed = list.find(x => x.streamId === streamId);
    const next = list.filter(x => x.streamId !== streamId);
    if (next.length === list.length) return false;
    if (next.length === 0) this.publicationsByPeer.delete(peerId);
    else this.publicationsByPeer.set(peerId, next);
    if (removed) this.geometry?.recordHide(slotIdFor(removed));
    return true;
  }

  /** Flip a camera publication's audio-only flag. Returns the mutated
   *  publication (so the caller can rebroadcast it via `published`) or
   *  null if this peer owns no such stream. Mutated in place so the
   *  hello snapshot's `listPublications()` carries it for late joiners. */
  setCameraOff(peerId: string, streamId: string, off: boolean): Publication | null {
    const list = this.publicationsByPeer.get(peerId);
    if (!list) return null;
    const pub = list.find(p => p.streamId === streamId);
    if (!pub) return null;
    pub.cameraOff = off;
    return pub;
  }

  /** Find which peer owns this publication. Used by close-anyone — any
   *  authenticated peer can ask the relay to drop someone else's window. */
  findPublicationOwner(streamId: string): string | null {
    for (const [peerId, list] of this.publicationsByPeer) {
      if (list.some(p => p.streamId === streamId)) return peerId;
    }
    return null;
  }

  /** Wipe the geometry log to a clean slate (new session), then re-seed it
   *  with every currently-live window's position so a reset that happens with
   *  windows already on screen still has a baseline. Wired to the host's
   *  "reset STT" action — the natural new-session boundary. */
  resetGeometry(): void {
    if (!this.geometry) return;
    this.geometry.reset();
    for (const p of this.listPublications()) {
      const slotId = slotIdFor(p);
      this.geometry.recordShow(slotId, this.getSlot(slotId));
    }
  }

  clearPeerPublications(peerId: string): Publication[] {
    const list = this.publicationsByPeer.get(peerId) ?? [];
    this.publicationsByPeer.delete(peerId);
    // Peer disconnected — every one of their windows closed.
    for (const p of list) this.geometry?.recordHide(slotIdFor(p));
    return list;
  }
}

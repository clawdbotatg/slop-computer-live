// Host-authoritative desktop state.
//
// Two distinct concepts:
//
// 1. Publications — ephemeral, per-peer announcements of "I'm publishing
//    streamId X of kind Y with label Z". Lives in memory only; cleared on
//    disconnect. Drives whether a window exists at all.
//
// 2. Slot positions — persistent, per-host (admin wallet) record of where a
//    stable "slot" should live (x, y, width, height, z). Only stores the
//    layout; the slot only renders if there's an active publication that
//    maps to it. Mirrored to disk so a relay restart preserves positions.
//
// Slot IDs are stable strings:
//   "host-camera", "host-screen"     — host's own streams, keyed by kind
//   "peer-<peerId>-<streamId>"        — each guest stream gets its own slot
//                                       (peer streams are ephemeral so position
//                                       isn't kept across reconnects, but the
//                                       slot id is deterministic for the
//                                       current session).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SlotKind = "camera" | "screen" | "audio";

export type Publication = {
  streamId: string;
  peerId: string;     // ephemeral; changes every WS reconnect
  ownerKey: string;   // stable across reconnects (wallet address or handle)
  kind: SlotKind;
  label: string;
};

export type SlotPosition = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
};

const SLOT_PATH = process.env.SLOT_PATH ?? "/var/lib/slop-relay/slots.json";

const slotsByHost: Map<string, Map<string, SlotPosition>> = loadSlots();
const publicationsByPeer = new Map<string, Publication[]>();

function loadSlots(): Map<string, Map<string, SlotPosition>> {
  try {
    const raw = readFileSync(SLOT_PATH, "utf8");
    const obj = JSON.parse(raw) as Record<string, Record<string, SlotPosition>>;
    const out = new Map<string, Map<string, SlotPosition>>();
    for (const [host, slots] of Object.entries(obj)) {
      out.set(host, new Map(Object.entries(slots)));
    }
    return out;
  } catch {
    return new Map();
  }
}

let saveQueued = false;
function scheduleSave(): void {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    try {
      mkdirSync(dirname(SLOT_PATH), { recursive: true });
      const obj: Record<string, Record<string, SlotPosition>> = {};
      for (const [host, slots] of slotsByHost) {
        obj[host] = Object.fromEntries(slots);
      }
      writeFileSync(SLOT_PATH, JSON.stringify(obj));
    } catch (err) {
      console.error("[desktop] failed to persist slots:", err);
    }
  });
}

const norm = (addr: string | null | undefined) => (addr ? addr.toLowerCase() : null);

// ---- slot positions --------------------------------------------------------

export function getSlots(hostAddress: string | null): SlotPosition[] {
  const host = norm(hostAddress);
  if (!host) return [];
  return [...(slotsByHost.get(host)?.values() ?? [])];
}

export function applySlotUpdate(
  hostAddress: string | null,
  patch: Partial<SlotPosition> & { id: string },
): SlotPosition | null {
  const host = norm(hostAddress);
  if (!host) return null;
  let slots = slotsByHost.get(host);
  if (!slots) {
    slots = new Map();
    slotsByHost.set(host, slots);
  }
  const prev = slots.get(patch.id);
  const merged: SlotPosition = {
    id: patch.id,
    x: patch.x ?? prev?.x ?? 80,
    y: patch.y ?? prev?.y ?? 280,
    width: patch.width ?? prev?.width ?? 360,
    height: patch.height ?? prev?.height ?? 260,
    z: patch.z ?? prev?.z ?? 1,
  };
  slots.set(patch.id, merged);
  scheduleSave();
  return merged;
}

// ---- publications ----------------------------------------------------------

export function listPublications(): Publication[] {
  const out: Publication[] = [];
  for (const list of publicationsByPeer.values()) out.push(...list);
  return out;
}

export function publish(p: Publication): void {
  const list = publicationsByPeer.get(p.peerId) ?? [];
  // De-dupe: if same streamId already exists, replace it.
  const next = list.filter(x => x.streamId !== p.streamId);
  next.push(p);
  publicationsByPeer.set(p.peerId, next);
}

export function unpublish(peerId: string, streamId: string): boolean {
  const list = publicationsByPeer.get(peerId);
  if (!list) return false;
  const next = list.filter(x => x.streamId !== streamId);
  if (next.length === list.length) return false;
  if (next.length === 0) publicationsByPeer.delete(peerId);
  else publicationsByPeer.set(peerId, next);
  return true;
}

export function clearPeerPublications(peerId: string): Publication[] {
  const list = publicationsByPeer.get(peerId) ?? [];
  publicationsByPeer.delete(peerId);
  return list;
}

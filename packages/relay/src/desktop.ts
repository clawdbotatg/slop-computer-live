// Host-authoritative desktop window state.
//
// The host owns the canonical desktop layout: which windows exist, their
// positions, sizes, z-order, and open/closed state. Guests render whatever
// the host says. Anyone can read; only the host can write.
//
// State is keyed by host wallet address (lowercase) so a host reload restores
// their last layout. The map is mirrored to disk (LAYOUT_PATH) so a relay
// process restart also survives.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type WindowState = {
  id: string;
  kind: "camera" | "screen" | "remote" | "panel";
  ownerPeerId: string | null; // peer that owns the underlying media (null for panels)
  ownerLabel: string | null;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  open: boolean;
};

const LAYOUT_PATH = process.env.LAYOUT_PATH ?? "/var/lib/slop-relay/layouts.json";

const layoutsByHost: Map<string, Map<string, WindowState>> = loadLayouts();

function loadLayouts(): Map<string, Map<string, WindowState>> {
  try {
    const raw = readFileSync(LAYOUT_PATH, "utf8");
    const obj = JSON.parse(raw) as Record<string, Record<string, WindowState>>;
    const out = new Map<string, Map<string, WindowState>>();
    for (const [host, windows] of Object.entries(obj)) {
      out.set(host, new Map(Object.entries(windows)));
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
  // Microtask: collapse multiple updates in one tick into a single write.
  queueMicrotask(() => {
    saveQueued = false;
    try {
      mkdirSync(dirname(LAYOUT_PATH), { recursive: true });
      const obj: Record<string, Record<string, WindowState>> = {};
      for (const [host, windows] of layoutsByHost) {
        obj[host] = Object.fromEntries(windows);
      }
      writeFileSync(LAYOUT_PATH, JSON.stringify(obj));
    } catch (err) {
      console.error("[desktop] failed to persist layout:", err);
    }
  });
}

const normaliseHost = (addr: string | null | undefined): string | null =>
  addr ? addr.toLowerCase() : null;

export function getLayout(hostAddress: string | null): WindowState[] {
  const host = normaliseHost(hostAddress);
  if (!host) return [];
  return [...(layoutsByHost.get(host)?.values() ?? [])];
}

export function applyWindowUpdate(
  hostAddress: string | null,
  patch: Partial<WindowState> & { id: string },
): WindowState | null {
  const host = normaliseHost(hostAddress);
  if (!host) return null;
  let layout = layoutsByHost.get(host);
  if (!layout) {
    layout = new Map();
    layoutsByHost.set(host, layout);
  }
  const prev = layout.get(patch.id);
  const merged: WindowState = {
    id: patch.id,
    kind: patch.kind ?? prev?.kind ?? "panel",
    ownerPeerId: patch.ownerPeerId ?? prev?.ownerPeerId ?? null,
    ownerLabel: patch.ownerLabel ?? prev?.ownerLabel ?? null,
    title: patch.title ?? prev?.title ?? patch.id,
    x: patch.x ?? prev?.x ?? 80,
    y: patch.y ?? prev?.y ?? 80,
    width: patch.width ?? prev?.width ?? 320,
    height: patch.height ?? prev?.height ?? 240,
    z: patch.z ?? prev?.z ?? 1,
    open: patch.open ?? prev?.open ?? true,
  };
  layout.set(patch.id, merged);
  scheduleSave();
  return merged;
}

export function removeWindow(hostAddress: string | null, id: string): boolean {
  const host = normaliseHost(hostAddress);
  if (!host) return false;
  const layout = layoutsByHost.get(host);
  if (!layout) return false;
  const ok = layout.delete(id);
  if (ok) scheduleSave();
  return ok;
}

export function clearLayout(hostAddress: string | null): void {
  const host = normaliseHost(hostAddress);
  if (!host) return;
  const ok = layoutsByHost.delete(host);
  if (ok) scheduleSave();
}

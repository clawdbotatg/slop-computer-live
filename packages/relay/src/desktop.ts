// Host-authoritative desktop window state.
//
// The host owns the canonical desktop layout: which windows exist, their
// positions, sizes, z-order, and open/closed state. Guests render whatever
// the host says. Anyone can read; only the host can write.
//
// State is keyed by host wallet address (lowercase) so a host reload restores
// their last layout. In-memory only — fine for single-box v1.

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

const layoutsByHost = new Map<string, Map<string, WindowState>>();

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
  return merged;
}

export function removeWindow(hostAddress: string | null, id: string): boolean {
  const host = normaliseHost(hostAddress);
  if (!host) return false;
  const layout = layoutsByHost.get(host);
  if (!layout) return false;
  return layout.delete(id);
}

export function clearLayout(hostAddress: string | null): void {
  const host = normaliseHost(hostAddress);
  if (!host) return;
  layoutsByHost.delete(host);
}

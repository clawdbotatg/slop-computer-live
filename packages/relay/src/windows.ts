// Shared singleton windows.
//
// A "window" here is a desktop app whose visibility is one-shared-bit
// (open or closed) across the entire mesh, NOT per user. Compare:
//
//   - publications  → one entity per peer (each user's own camera, mic)
//   - browsers      → many shared entities (multiple iframes, by id)
//   - chat          → per-user open/close (your panel, your call)
//   - SINGLETONS    → one shared entity (music player, future calculator,
//                     weather widget, etc.) — anyone can open, all see;
//                     anyone can close, all lose it
//
// Position is still tracked via the slot system (keyed by `app-${id}`),
// so the window comes up where it last sat across reloads/peers.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const WINDOWS_PATH = process.env.WINDOWS_PATH ?? "/var/lib/slop-relay/windows.json";

const openIds: Set<string> = loadOpen();

function loadOpen(): Set<string> {
  try {
    const raw = readFileSync(WINDOWS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { open?: unknown };
    if (Array.isArray(parsed.open)) return new Set(parsed.open.filter((s): s is string => typeof s === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

let saveQueued = false;
function scheduleSave(): void {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    try {
      mkdirSync(dirname(WINDOWS_PATH), { recursive: true });
      writeFileSync(WINDOWS_PATH, JSON.stringify({ open: [...openIds] }));
    } catch (err) {
      console.error("[windows] failed to persist:", err);
    }
  });
}

export function listOpenWindows(): string[] {
  return [...openIds];
}

/** @returns true if the set actually changed. */
export function openWindow(id: string): boolean {
  if (openIds.has(id)) return false;
  openIds.add(id);
  scheduleSave();
  return true;
}

/** @returns true if the set actually changed. */
export function closeWindow(id: string): boolean {
  if (!openIds.has(id)) return false;
  openIds.delete(id);
  scheduleSave();
  return true;
}

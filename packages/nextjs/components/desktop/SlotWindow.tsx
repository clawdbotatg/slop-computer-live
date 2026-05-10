"use client";

import { type CSSProperties, type ReactNode } from "react";
import { Window } from "~~/components/ui";
import type { PeerMeshState, SlotPosition } from "~~/hooks/usePeerMesh";

// Single source of truth for a desktop window: the mesh slot system.
// All windows on the desktop (browsers, cameras, audio, chat) share the
// same persistence path:
//   - position + size + z live in mesh.slots[slotId]
//   - onMove / onResize / onFocus go through mesh.updateSlot, which is
//     optimistic locally and broadcast to all peers + persisted to disk
//     by the relay (slots.json)
//   - on reload, the WS hello payload restores everything
//   - the menubar inset is enforced once in <Window>
//
// New window kinds = `<SlotWindow slotId="..." defaultSlot={...}>`. Don't
// hand-roll localStorage / position state — every time we have, we've
// re-introduced a bug the slot system already solved.
//
// Whether the window APPEARS for a given user is the caller's concern
// (per-user open/close vs. publication-driven vs. host-controlled). This
// component only handles the geometry.

export type SlotWindowProps = {
  mesh: PeerMeshState;
  slotId: string;
  /** Used the first time this slot is rendered (no entry in mesh.slots yet). */
  defaultSlot: SlotPosition;
  title: string;
  onClose?: () => void;
  minWidth?: number;
  minHeight?: number;
  bodyClassName?: string;
  bodyStyle?: CSSProperties;
  /** Default 38 — height of the menubar. Window clamps drag/resize so
   *  the titlebar can never slip behind it. Override for windows that
   *  share space with other chrome. */
  menubarInset?: number;
  children?: ReactNode;
};

export const SlotWindow = ({
  mesh,
  slotId,
  defaultSlot,
  title,
  onClose,
  minWidth,
  minHeight,
  bodyClassName,
  bodyStyle,
  menubarInset = 38,
  children,
}: SlotWindowProps) => {
  const slot = mesh.slots[slotId] ?? defaultSlot;
  return (
    <Window
      title={title}
      x={slot.x}
      y={slot.y}
      width={slot.width}
      height={slot.height}
      zIndex={slot.z}
      minWidth={minWidth}
      minHeight={minHeight}
      bodyClassName={bodyClassName}
      bodyStyle={bodyStyle}
      onClose={onClose}
      onFocus={() => {
        // Promote this window above all others. Bump 1 above the current
        // max so we don't have to know what the next slot will pick.
        const maxZ = Math.max(0, ...Object.values(mesh.slots).map(s => s.z), 5);
        if (slot.z >= maxZ) return;
        mesh.updateSlot({ id: slotId, z: maxZ + 1 });
      }}
      // Pass the full geometry on every move, not just x/y. Otherwise
      // mesh.updateSlot's optimistic merge falls back to its generic
      // 360×260 defaults when a slot is being created for the first
      // time (i.e. user opens a window and immediately drags it before
      // the slot has been persisted) — making the window snap-shrink
      // mid-drag.
      onMove={({ x, y }) => mesh.updateSlot({ id: slotId, x, y, width: slot.width, height: slot.height })}
      onResize={({ x, y, width, height }) => mesh.updateSlot({ id: slotId, x, y, width, height })}
      containerInset={{ top: menubarInset }}
    >
      {children}
    </Window>
  );
};

export default SlotWindow;

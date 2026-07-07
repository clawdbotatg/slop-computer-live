"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { BOTTOM_BAR_Z, DOCKED_PILL_BOTTOM_INSET } from "~~/components/desktop/bottomBarLayout";
import { Window } from "~~/components/ui";
import type { LocalWindowsState } from "~~/hooks/useLocalWindows";
import type { SlotPosition } from "~~/hooks/usePeerMesh";

// The single-player analog of SharedAppWindow. A real, draggable, resizable,
// minimize-able, position-remembered window — but LOCAL: its geometry and
// open/close bit live in useLocalWindows (localStorage), never the mesh, so
// only the viewer who opened it ever sees it. The grey titlebar
// (`slop-titlebar--private`) is the at-a-glance cue that this window is yours
// alone; the traffic lights stay full color.
//
// This is the one path for any private/personal app window — don't hand-roll
// local open state or a bespoke modal. Usage mirrors SharedAppWindow exactly,
// swapping `mesh` for `local`:
//
//   <PrivateAppWindow
//     local={local}
//     id="mywallet"
//     title="WALLET"
//     defaultSlot={{ x: 120, y: 120, width: 480, height: 640 }}
//   >
//     <WalletAppWindow ... />
//   </PrivateAppWindow>

const PRIVATE_TITLEBAR_CLASS = "slop-titlebar--private";

// Geometry half — the local twin of SlotWindow. Reads/writes position, size,
// and z through `local` instead of `mesh`.
const LocalWindow = ({
  local,
  slotId,
  defaultSlot,
  title,
  onClose,
  minWidth,
  minHeight,
  bodyClassName,
  bodyStyle,
  menubarInset = 38,
  keepMountedWhenDocked,
  sharedMaxZ,
  children,
}: {
  local: LocalWindowsState;
  slotId: string;
  defaultSlot: SlotPosition;
  title: string;
  onClose?: () => void;
  minWidth?: number;
  minHeight?: number;
  bodyClassName?: string;
  bodyStyle?: CSSProperties;
  menubarInset?: number;
  keepMountedWhenDocked?: boolean;
  sharedMaxZ?: () => number;
  children?: ReactNode;
}) => {
  const slot = local.slots[slotId] ?? defaultSlot;

  // Eager-persist the default slot on first mount (same reasoning as
  // SlotWindow: without it the first focus/drag goes through updateSlot's
  // partial-merge fallbacks and snap-shrinks the window). Refs so the
  // effect fires once per missing slot, not on every slots/prop churn.
  const updateSlot = local.updateSlot;
  const defaultSlotRef = useRef(defaultSlot);
  const localSlotsRef = useRef(local.slots);
  localSlotsRef.current = local.slots;
  const sharedMaxZRef = useRef(sharedMaxZ);
  sharedMaxZRef.current = sharedMaxZ;
  const hasSlot = local.slots[slotId] !== undefined;
  useEffect(() => {
    if (hasSlot) return;
    // Same "every brand-new window comes to the front" rule as
    // usePeerMesh.updateSlot, but across BOTH z spaces: spawn above the
    // highest shared and private window, not at the static default z.
    const localMax = Math.max(0, ...Object.values(localSlotsRef.current).map(s => s.z));
    const sharedMax = sharedMaxZRef.current ? sharedMaxZRef.current() : 0;
    const z = Math.max(defaultSlotRef.current.z, localMax, sharedMax) + 1;
    updateSlot({ ...defaultSlotRef.current, id: slotId, z });
  }, [hasSlot, slotId, updateSlot]);

  return (
    <Window
      title={title}
      titleBarClassName={PRIVATE_TITLEBAR_CLASS}
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
        // Float above ALL windows on focus, not just other private ones:
        // shared (mesh) z grows unbounded over a session, so comparing only
        // against local.slots would let a BANK window stay pinned on top of
        // the wallet. We READ the shared max z (never write the mesh — the
        // bump stays a local number) so clicking the wallet always brings it
        // forward, exactly like clicking any other window.
        const localMax = Math.max(0, ...Object.values(local.slots).map(s => s.z), 5);
        const maxZ = Math.max(localMax, sharedMaxZ ? sharedMaxZ() : 0);
        if (slot.z > maxZ) return;
        local.updateSlot({ id: slotId, z: maxZ + 1 });
      }}
      onMove={({ x, y }) => local.updateSlot({ id: slotId, x, y, width: slot.width, height: slot.height })}
      onResize={({ x, y, width, height }) => local.updateSlot({ id: slotId, x, y, width, height })}
      containerInset={{ top: menubarInset }}
      dockBottomInset={DOCKED_PILL_BOTTOM_INSET}
      dockUnderZ={BOTTOM_BAR_Z}
      keepMountedWhenDocked={keepMountedWhenDocked}
    >
      {children}
    </Window>
  );
};

export type PrivateAppWindowProps = {
  local: LocalWindowsState;
  /** Stable id used for both `local.openWindow(id)` and the slot key
   *  `app-${id}`. Keep it short, lowercase, hyphenless. */
  id: string;
  title: string;
  /** Initial geometry the first time this viewer opens the app. After that
   *  the local slot store remembers position/size across reloads. */
  defaultSlot: { x: number; y: number; width: number; height: number; z?: number };
  minWidth?: number;
  minHeight?: number;
  bodyClassName?: string;
  bodyStyle?: CSSProperties;
  keepMountedWhenDocked?: boolean;
  /** Returns the current max z among SHARED (mesh) windows. Passed so focus
   *  floats the private window above everything, not just other private
   *  windows. Read-only — the private window never writes the mesh. */
  sharedMaxZ?: () => number;
  /** Override the close action. Defaults to `local.closeWindow(id)`. */
  onClose?: () => void;
  children: ReactNode;
};

export const PrivateAppWindow = ({
  local,
  id,
  title,
  defaultSlot,
  minWidth,
  minHeight,
  bodyClassName,
  bodyStyle = { padding: 0, overflow: "hidden" },
  keepMountedWhenDocked,
  sharedMaxZ,
  onClose,
  children,
}: PrivateAppWindowProps) => {
  if (!local.openWindowIds.has(id)) return null;
  const slotId = `app-${id}`;
  return (
    <LocalWindow
      local={local}
      slotId={slotId}
      defaultSlot={{
        id: slotId,
        x: defaultSlot.x,
        y: defaultSlot.y,
        width: defaultSlot.width,
        height: defaultSlot.height,
        z: defaultSlot.z ?? 50,
      }}
      title={title}
      minWidth={minWidth}
      minHeight={minHeight}
      bodyClassName={bodyClassName}
      bodyStyle={bodyStyle}
      keepMountedWhenDocked={keepMountedWhenDocked}
      sharedMaxZ={sharedMaxZ}
      onClose={onClose ?? (() => local.closeWindow(id))}
    >
      {children}
    </LocalWindow>
  );
};

export default PrivateAppWindow;

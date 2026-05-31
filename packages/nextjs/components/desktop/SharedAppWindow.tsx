"use client";

import type { CSSProperties, ReactNode } from "react";
import { SlotWindow } from "~~/components/desktop/SlotWindow";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";

// One wrapper, every singleton app window.
//
// Visibility, position, and the close button are all shared across the
// mesh — when one peer opens "calc", every peer sees a calc window appear
// at the same spot; when any peer drags it or closes it, the change
// propagates to everyone. This is the only path you should reach for
// when adding a new desktop app: don't hand-roll local open state, don't
// pick your own slot id, don't wire `mesh.closeWindow` in two places.
//
// Usage:
//
//   <SharedAppWindow
//     mesh={mesh}
//     id="calc"
//     title="CALCULATOR"
//     defaultSlot={{ x: 120, y: 120, width: 220, height: 280, z: 50 }}
//   >
//     <Calculator />
//   </SharedAppWindow>
//
// The component returns null when the app isn't open; the parent can
// render it unconditionally and let visibility flow through the mesh.

export type SharedAppWindowProps = {
  mesh: PeerMeshState;
  /** Stable id used for both `mesh.openWindow(id)` and the slot key
   *  `app-${id}`. Keep it short, lowercase, hyphenless. */
  id: string;
  title: string;
  /** Initial geometry the first time anyone opens this app. After that,
   *  the slot system takes over and remembers position/size across
   *  reloads + peers. */
  defaultSlot: { x: number; y: number; width: number; height: number; z?: number };
  minWidth?: number;
  minHeight?: number;
  bodyClassName?: string;
  bodyStyle?: CSSProperties;
  /** Keep the body mounted (hidden) while minimized instead of unmounting
   *  it. Opt in for apps with live state that must survive minimize —
   *  e.g. SLOPAMP, whose <audio> element keeps playing only while in the
   *  DOM. Off by default: most apps are fine to tear down + rebuild. */
  keepMountedWhenDocked?: boolean;
  children: ReactNode;
};

export const SharedAppWindow = ({
  mesh,
  id,
  title,
  defaultSlot,
  minWidth,
  minHeight,
  bodyClassName,
  // Most app windows want their full body (no padding, no scroll bars
  // on the chrome) — they paint their own UI edge to edge. Callers can
  // still override.
  bodyStyle = { padding: 0, overflow: "hidden" },
  keepMountedWhenDocked,
  children,
}: SharedAppWindowProps) => {
  if (!mesh.openWindowIds.has(id)) return null;
  const slotId = `app-${id}`;
  return (
    <SlotWindow
      mesh={mesh}
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
      onClose={() => mesh.closeWindow(id)}
    >
      {children}
    </SlotWindow>
  );
};

export default SharedAppWindow;

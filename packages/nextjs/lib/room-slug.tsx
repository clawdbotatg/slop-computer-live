"use client";

import { type ReactNode, createContext, useContext } from "react";
import { DEFAULT_SLUG } from "./slug";

// Carries the current room's slug down to whatever hook / component
// needs it (usePeerMesh, SharedBrowser, etc.) without prop-drilling
// through the Desktop component tree. The dynamic `[slug]` route sets
// the value; everything else reads via `useRoomSlug()`.

const RoomSlugContext = createContext<string>(DEFAULT_SLUG);

export function RoomSlugProvider({ slug, children }: { slug: string; children: ReactNode }) {
  return <RoomSlugContext.Provider value={slug}>{children}</RoomSlugContext.Provider>;
}

export function useRoomSlug(): string {
  return useContext(RoomSlugContext);
}

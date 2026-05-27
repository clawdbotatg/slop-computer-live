// Single home for the room-password localStorage convention. Both
// PasswordGate (which writes the value when a user clears the gate) and
// MenuBar (which bakes it into a shareable `?invite=` link) read from here,
// so the key format + legacy fallback live in one leaf module — no UI
// imports, no import cycle through the components barrel.

export const slugStorageKey = (slug: string) => `slop-room-password-${slug}`;
export const LEGACY_STORAGE_KEY = "slop-invite-password";

/** The per-room password cached for `slug`, or "" if none/unavailable. */
export const readStoredPassword = (slug: string): string => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(slugStorageKey(slug)) ?? "";
  } catch {
    return "";
  }
};

/** The room password this browser has cached for `slug` — the per-room
 *  value if present, else the legacy global invite password. This is the
 *  exact credential the gate replays on mount, so it's also what an invite
 *  link needs to carry to clear the gate for someone else. */
export const readStoredRoomPassword = (slug: string): string => {
  if (typeof window === "undefined") return "";
  try {
    return readStoredPassword(slug) || window.localStorage.getItem(LEGACY_STORAGE_KEY) || "";
  } catch {
    return "";
  }
};

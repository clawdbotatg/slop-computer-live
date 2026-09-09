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

// The admin panel keeps its own slug→password map (rooms created or rotated
// from /admin land here, not in the per-slug gate key). Read-only mirror of
// the key in app/admin/page.tsx so a host who set the room up from the admin
// panel gets a working private link from the menubar without retyping.
export const ADMIN_STORAGE_KEY = "slop-admin-room-passwords";
const readAdminPassword = (slug: string): string => {
  try {
    const raw = window.localStorage.getItem(ADMIN_STORAGE_KEY);
    if (!raw) return "";
    const map = JSON.parse(raw) as Record<string, unknown>;
    const v = map?.[slug];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
};

/** Cache a password under the per-slug gate key (what the gate replays). */
export const rememberStoredPassword = (slug: string, password: string): void => {
  try {
    window.localStorage.setItem(slugStorageKey(slug), password);
  } catch {
    /* cookie-only is fine */
  }
};

/** Best-effort room password for building a `?invite=` link: every local
 *  cache first, then the relay's host-only `/v1/rooms/:slug/invite` (the
 *  relay stores the plaintext precisely so a host on a device that never
 *  typed the password — cookie session, admin-created room — can still hand
 *  out the link). A relay hit is cached so the next copy is instant.
 *  Returns "" when nothing is on file anywhere (non-host, unclaimed room). */
export const resolveRoomPassword = async (slug: string, relayHttp: string): Promise<string> => {
  if (typeof window === "undefined") return "";
  const local = readStoredRoomPassword(slug) || readAdminPassword(slug);
  if (local) return local;
  try {
    const res = await fetch(`${relayHttp}/v1/rooms/${encodeURIComponent(slug)}/invite`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return "";
    const j = (await res.json()) as { password?: string | null };
    if (!j.password) return "";
    rememberStoredPassword(slug, j.password);
    return j.password;
  } catch {
    return "";
  }
};

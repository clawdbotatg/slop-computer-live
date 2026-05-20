// Mirrors the on-chain SlopComputer contract's slug rule
// (`^[a-z0-9-]{1,64}$`) and the relay's local validator. Kept in this
// package as its own file so client + server components + hooks can
// share the regex without dragging in a workspace dep.

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

// Sandbox room used for debugging — always-on, no password. Unknown
// slugs do NOT land here; they bounce to slop.computer (see the
// dynamic [slug] route).
export const DEFAULT_SLUG = "debug";

// Where to send users when they hit an unknown / unclaimed / invalid
// slug. The live.slop.computer subdomain is for actual claimed
// episodes; anything else belongs on the parent site.
export const ROOM_NOT_FOUND_URL = "https://slop.computer";

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && SLUG_RE.test(slug);
}

/**
 * Coerce a free-form string into a valid slug or return `DEFAULT_SLUG`.
 * Used by the dynamic `[slug]` route to bounce bad URLs back to the
 * canonical fallback rather than 404.
 */
export function normalizeSlug(raw: unknown): string {
  return isValidSlug(raw) ? raw : DEFAULT_SLUG;
}

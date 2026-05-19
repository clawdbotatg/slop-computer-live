// Mirrors the on-chain SlopComputer contract's slug rule
// (`^[a-z0-9-]{1,64}$`) and the relay's local validator. Kept in this
// package as its own file so client + server components + hooks can
// share the regex without dragging in a workspace dep.

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

export const DEFAULT_SLUG = "main";

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

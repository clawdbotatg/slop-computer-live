import { redirect } from "next/navigation";
import { Desktop } from "~~/components/Desktop";
import { DEFAULT_SLUG, isValidSlug } from "~~/lib/slug";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
// Cap the existence check at 2s so a slow / unreachable relay doesn't
// freeze every page load. On timeout we render the page anyway — the
// WS handshake will reject with `room-not-found` if appropriate, which
// the frontend handles via its own error flow.
const EXIST_CHECK_TIMEOUT_MS = 2000;

// Dynamic per-room route. Validates the slug here so the Desktop
// component (which only reads from the context) can trust it.
// Invalid slugs bounce to DEFAULT_SLUG rather than 404 — the user
// presumably mistyped a URL; quietly recover.
//
// Pre-claim gate: a non-main slug must have been claimed by a host
// (POST /v1/rooms creates `.slop-data/rooms/<slug>/auth.json`) before
// the page renders. Unclaimed non-main slugs redirect to main so a
// typo can't silently spin up a sandbox room. The relay's WS
// handshake enforces the same rule defense-in-depth.
export default async function RoomPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidSlug(slug)) redirect(`/${DEFAULT_SLUG}`);

  if (slug !== DEFAULT_SLUG) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), EXIST_CHECK_TIMEOUT_MS);
    try {
      const res = await fetch(`${RELAY_BASE}/v1/rooms/${encodeURIComponent(slug)}/auth`, {
        cache: "no-store",
        signal: ctl.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as { exists?: boolean };
        if (!data.exists) redirect(`/${DEFAULT_SLUG}`);
      }
    } catch (err) {
      // Next.js's `redirect()` throws internally — propagate that.
      // Anything else (network blip, timeout) → render anyway and let
      // the WS layer handle the rejection.
      if ((err as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return <Desktop slug={slug} />;
}

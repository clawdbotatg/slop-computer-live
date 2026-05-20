import { redirect } from "next/navigation";
import { Desktop } from "~~/components/Desktop";
import { DEFAULT_SLUG, ROOM_NOT_FOUND_URL, isValidSlug } from "~~/lib/slug";

const RELAY_BASE = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
// Cap the existence check at 2s so a slow / unreachable relay doesn't
// freeze every page load. On timeout we render the page anyway — the
// WS handshake will reject with `room-not-found` if appropriate, which
// the frontend handles via its own error flow.
const EXIST_CHECK_TIMEOUT_MS = 2000;

// Dynamic per-room route. Validates the slug, then checks with the
// relay that a host has claimed it. Misses bounce to slop.computer —
// live.slop.computer is for actual episodes, not a generic fallback.
//
// The `debug` slug (DEFAULT_SLUG) is special-cased: always-on, no
// password required, used by ops + dev for poking at the relay. It
// skips the existence check.
export default async function RoomPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidSlug(slug)) redirect(ROOM_NOT_FOUND_URL);

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
        if (!data.exists) redirect(ROOM_NOT_FOUND_URL);
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

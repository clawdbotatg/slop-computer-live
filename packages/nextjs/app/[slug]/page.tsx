import { redirect } from "next/navigation";
import { Desktop } from "~~/components/Desktop";
import { DEFAULT_SLUG, isValidSlug } from "~~/lib/slug";

// Dynamic per-room route. Validates the slug here so the Desktop
// component (which only reads from the context) can trust it.
// Invalid slugs bounce to DEFAULT_SLUG rather than 404 — the user
// presumably mistyped a URL; quietly recover.
export default async function RoomPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidSlug(slug)) redirect(`/${DEFAULT_SLUG}`);
  return <Desktop slug={slug} />;
}

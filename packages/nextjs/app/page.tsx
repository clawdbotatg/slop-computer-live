import { redirect } from "next/navigation";
import { DEFAULT_SLUG } from "~~/lib/slug";

// Root `/` always lands on the canonical fallback room. Phase 8-ish:
// once the SlopComputer contract is wired in, this redirects to
// `liveEpisode.slug` when one exists, falling back to DEFAULT_SLUG
// when there's no live episode.
export default function RootPage(): never {
  redirect(`/${DEFAULT_SLUG}`);
}

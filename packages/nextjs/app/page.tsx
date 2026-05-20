import { redirect } from "next/navigation";
import { ROOM_NOT_FOUND_URL } from "~~/lib/slug";

// live.slop.computer is for specific claimed rooms (e.g. /ep0). Bare
// visits with no slug get bounced to slop.computer where the catalog
// of episodes lives. Phase 8-ish: once the SlopComputer contract is
// wired in, this could redirect to `liveEpisode.slug` when a live
// episode exists instead of leaving the live subdomain entirely.
export default function RootPage(): never {
  redirect(ROOM_NOT_FOUND_URL);
}

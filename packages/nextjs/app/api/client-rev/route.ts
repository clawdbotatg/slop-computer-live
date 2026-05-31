import { NextResponse } from "next/server";

// Returns the client-bundle source fingerprint baked into THIS deployment
// at build time (see clientRev() in next.config.ts). The UpgradeModal
// fetches this after a relay restart and compares it to the rev baked into
// the running client: differ → client code changed, hard-reload to pick it
// up; equal → relay-only deploy, skip the reload so live camera/mic shares
// survive.
//
// force-static so the IPFS `output: export` build (which forbids dynamic
// route handlers) still builds — the value is a build-time constant, so a
// static render is correct. We send Cache-Control: no-store anyway and the
// client fetches with cache:"no-store", so a stale cached copy can never
// cause a NEEDED reload to be skipped (the one failure mode we refuse).
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(
    { rev: process.env.NEXT_PUBLIC_CLIENT_REV ?? "unknown" },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}

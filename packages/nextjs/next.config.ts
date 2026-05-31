import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import path from "node:path";

// Fingerprint of the CLIENT bundle's source, baked into the build. It's
// the git tree hash of packages/nextjs (changes on any client edit) plus
// the lockfile blob (catches dependency bumps) — deliberately NOT Next's
// build id, which is random on every `next build` (and deploy.sh rebuilds
// on every deploy), so a relay-only deploy would otherwise look "changed".
// The UpgradeModal compares this (baked into the running client) against
// /api/client-rev (baked into the freshly-deployed server): differ → the
// client code changed, hard-reload; equal → relay-only deploy, skip the
// reload so live camera/mic shares aren't torn down. Falls back to "dev"
// when git is unavailable — "dev" never compares equal, so the safe
// default (always reload) holds.
function clientRev(): string {
  try {
    const sha = (p: string) => execSync(`git rev-parse HEAD:${p}`, { encoding: "utf8" }).trim();
    return `${sha("packages/nextjs")}-${sha("yarn.lock")}`;
  } catch {
    return "dev";
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  outputFileTracingRoot: path.join(__dirname),
  env: {
    NEXT_PUBLIC_CLIENT_REV: clientRev(),
  },
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  // Backwards-compat: /desktop used to be the participant view; now / is.
  // /join used to redirect to slop.computer/join — now auth lives inline on /,
  // so /join just redirects to /.
  async redirects() {
    return [
      { source: "/desktop", destination: "/", permanent: true },
      { source: "/desktop/:path*", destination: "/:path*", permanent: true },
      { source: "/join", destination: "/", permanent: true },
      { source: "/join/:path*", destination: "/", permanent: true },
    ];
  },
  webpack: config => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

const isIpfs = process.env.NEXT_PUBLIC_IPFS_BUILD === "true";

if (isIpfs) {
  nextConfig.output = "export";
  nextConfig.trailingSlash = true;
  nextConfig.images = {
    unoptimized: true,
  };
}

module.exports = nextConfig;

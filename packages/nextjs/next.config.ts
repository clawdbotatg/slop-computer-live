import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  outputFileTracingRoot: path.join(__dirname),
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  // Backwards-compat:
  //  - /desktop used to be the participant view; now / is.
  //  - /admin and /join moved to slop.computer (the audience domain) so the
  //    cookie set there on .slop.computer is then visible to live.slop.computer.
  async redirects() {
    return [
      { source: "/desktop", destination: "/", permanent: true },
      { source: "/desktop/:path*", destination: "/:path*", permanent: true },
      { source: "/admin", destination: "https://slop.computer/admin", permanent: false },
      { source: "/admin/:path*", destination: "https://slop.computer/admin/:path*", permanent: false },
      { source: "/join", destination: "https://slop.computer/join", permanent: false },
      { source: "/join/:path*", destination: "https://slop.computer/join/:path*", permanent: false },
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

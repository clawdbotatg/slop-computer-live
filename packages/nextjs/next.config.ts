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

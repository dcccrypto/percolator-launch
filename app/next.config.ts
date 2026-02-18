import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://percolator-api1-production.up.railway.app";

const nextConfig: NextConfig = {
  transpilePackages: ["@percolator/core"],
  turbopack: {
    resolveAlias: {
      buffer: "buffer",
    },
  },
  async rewrites() {
    // Use afterFiles so that local Next.js API routes (e.g. /api/funding/[slab]/route.ts,
    // /api/markets/[slab]/prices/route.ts) take priority over these proxy rewrites.
    // This lets simulator routes serve from Next.js while production data routes
    // still proxy to the Railway API service.
    return {
      beforeFiles: [],
      afterFiles: [
        // Data routes → API service (only if no local route.ts exists)
        { source: "/api/markets/:slab/trades", destination: `${API_URL}/markets/:slab/trades` },
        { source: "/api/markets/:slab/prices", destination: `${API_URL}/markets/:slab/prices` },
        { source: "/api/markets/:slab/stats", destination: `${API_URL}/markets/:slab/stats` },
        { source: "/api/markets/:slab/volume", destination: `${API_URL}/markets/:slab/volume` },
        // NOTE: Do NOT rewrite /api/markets/:slab/logo — that stays in Next.js (file upload)
        // NOTE: Do NOT rewrite /api/markets/:slab (single market) — keep in Next.js for now
        { source: "/api/funding/:slab/history", destination: `${API_URL}/funding/:slab/history` },
        { source: "/api/funding/:slab", destination: `${API_URL}/funding/:slab` },
        { source: "/api/insurance/:slab", destination: `${API_URL}/insurance/:slab` },
        { source: "/api/open-interest/:slab", destination: `${API_URL}/open-interest/:slab` },
        { source: "/api/prices/:path*", destination: `${API_URL}/prices/:path*` },
        { source: "/api/crank/status", destination: `${API_URL}/crank/status` },
        { source: "/api/trades/recent", destination: `${API_URL}/trades/recent` },
        { source: "/api/oracle/:path*", destination: `${API_URL}/oracle/:path*` },
      ],
      fallback: [],
    };
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        stream: false,
        fs: false,
        path: false,
        os: false,
      };
    }
    return config;
  },
};

export default withSentryConfig(nextConfig, {
  // Sentry webpack plugin options
  silent: true, // Suppresses all logs
  
  // Disable automatic source map upload (we'll enable later with auth token)
  sourcemaps: {
    disable: true,
  },
});

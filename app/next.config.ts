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
      afterFiles: [],
      // fallback: checked AFTER local Next.js dynamic routes (e.g. [slab]/route.ts).
      // This ensures local API stubs and sim routes serve first;
      // only unmatched paths proxy to the Railway API service.
      fallback: [
        { source: "/api/markets/:slab/trades", destination: `${API_URL}/markets/:slab/trades` },
        { source: "/api/markets/:slab/prices", destination: `${API_URL}/markets/:slab/prices` },
        { source: "/api/markets/:slab/stats", destination: `${API_URL}/markets/:slab/stats` },
        { source: "/api/markets/:slab/volume", destination: `${API_URL}/markets/:slab/volume` },
        { source: "/api/funding/:slab/history", destination: `${API_URL}/funding/:slab/history` },
        { source: "/api/funding/:slab", destination: `${API_URL}/funding/:slab` },
        { source: "/api/insurance/:slab", destination: `${API_URL}/insurance/:slab` },
        { source: "/api/open-interest/:slab", destination: `${API_URL}/open-interest/:slab` },
        { source: "/api/prices/:path*", destination: `${API_URL}/prices/:path*` },
        { source: "/api/crank/status", destination: `${API_URL}/crank/status` },
        { source: "/api/trades/recent", destination: `${API_URL}/trades/recent` },
        { source: "/api/oracle/:path*", destination: `${API_URL}/oracle/:path*` },
      ],
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

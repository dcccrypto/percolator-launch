import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://percolator-api1-production.up.railway.app";

const nextConfig: NextConfig = {
  // @solana/kit must be transpiled: its browser export resolves to an ESM .mjs file
  // that webpack includes verbatim, causing "Unexpected token 'export'" in production bundles.
  transpilePackages: ["@percolator/sdk", "@solana/kit"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Clickjacking protection — SAMEORIGIN allows Privy embedded wallet iframes
          // (middleware also sets this; must agree to avoid double-header conflicts)
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // MIME sniffing protection
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Referrer control
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Disable browser features not used by a DApp
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), usb=(), bluetooth=()",
          },
          // Content Security Policy — permissive enough for wallet adapters + Solana
          // frame-ancestors 'none' is the CSP equivalent of X-Frame-Options: DENY
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next.js requires unsafe-inline and unsafe-eval; wallet adapters add more
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' data: https://fonts.gstatic.com",
              // Images from various sources (explorer, token logos, CDNs)
              "img-src 'self' data: blob: https:",
              // RPC calls, Supabase, Helius, Railway API, Pyth, Sentry, Phantom/Solflare
              "connect-src 'self' https: wss: ws://localhost:* ws://127.0.0.1:*",
              // Privy auth + embedded wallet iframe + wallet adapter popups/iframes
              "frame-src 'self' https://auth.privy.io https://embedded-wallets.privy.io https://phantom.app https://solflare.com",
              "worker-src 'self' blob:",
              "frame-ancestors 'self' https://percolatorlaunch.com https://*.percolatorlaunch.com https://percolator-launch.vercel.app https://*.vercel.app",
            ].join("; "),
          },
        ],
      },
    ];
  },
  turbopack: {
    resolveAlias: {
      buffer: "buffer",
    },
  },
  async rewrites() {
    return [
      // Data routes → API service
      { source: "/api/markets/:slab/trades", destination: `${API_URL}/markets/:slab/trades` },
      { source: "/api/markets/:slab/prices", destination: `${API_URL}/markets/:slab/prices` },
      { source: "/api/markets/:slab/stats", destination: `${API_URL}/markets/:slab/stats` },
      { source: "/api/markets/:slab/volume", destination: `${API_URL}/markets/:slab/volume` },
      // NOTE: Do NOT rewrite /api/markets/:slab/logo — that stays in Next.js (file upload)
      // NOTE: Do NOT rewrite /api/markets/:slab (single market) — keep in Next.js for now (uses markets_with_stats view)
      { source: "/api/funding/:slab/history", destination: `${API_URL}/funding/:slab/history` },
      { source: "/api/funding/:slab", destination: `${API_URL}/funding/:slab` },
      { source: "/api/insurance/:slab", destination: `${API_URL}/insurance/:slab` },
      { source: "/api/open-interest/:slab", destination: `${API_URL}/open-interest/:slab` },
      { source: "/api/prices/:path*", destination: `${API_URL}/prices/:path*` },
      { source: "/api/crank/status", destination: `${API_URL}/crank/status` },
      { source: "/api/trades/recent", destination: `${API_URL}/trades/recent` },
      { source: "/api/oracle/:path*", destination: `${API_URL}/oracle/:path*` },
    ];
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
  
  // Source maps: enabled when SENTRY_AUTH_TOKEN is set (CI/CD only)
  // Set SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT in your CI environment
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },

  // Upload source maps during build when auth token is available
  org: process.env.SENTRY_ORG || "percolator",
  project: process.env.SENTRY_PROJECT || "percolator-app",
  authToken: process.env.SENTRY_AUTH_TOKEN,
});

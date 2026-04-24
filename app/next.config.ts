import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// NEXT_PUBLIC_API_URL must be explicitly set — no hardcoded fallback
// This ensures misconfigured deployments fail loudly, not silently to production
const API_URL = process.env.NEXT_PUBLIC_API_URL;
if (!API_URL && process.env.NODE_ENV === "production") {
  throw new Error(
    "NEXT_PUBLIC_API_URL environment variable is required in production. " +
    "Please configure this before deploying."
  );
}

const nextConfig: NextConfig = {
  // @solana/kit must be transpiled: its browser export resolves to an ESM .mjs file
  // that webpack includes verbatim, causing "Unexpected token 'export'" in production bundles.
  transpilePackages: ["@percolator/sdk", "@solana/kit"],
  async headers() {
    // Security headers are set here as a baseline. CSP is NOT set here because
    // middleware.ts handles it with per-request nonce generation. When both
    // next.config and middleware set CSP, browsers intersect them (most
    // restrictive wins), which can cause unexpected blocking.
    return [
      {
        source: "/(.*)",
        headers: [
          // Clickjacking protection — SAMEORIGIN allows Privy embedded wallet iframes
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // MIME sniffing protection
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Referrer control
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // HSTS: enforce HTTPS for 2 years (defense-in-depth alongside middleware)
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          // Disable browser features not used by a DApp
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), usb=(), bluetooth=()",
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
  async redirects() {
    return [
      // GH#1552: /markets/[slab] only works client-side (intercepting route).
      // Direct navigation / refresh hits the server where no page exists → 404.
      // Permanent redirect to the canonical /trade/[slab] route.
      {
        source: "/markets/:slab",
        destination: "/trade/:slab",
        permanent: true,
      },
    ];
  },
  async rewrites() {
    return [
      // Data routes → API service
      { source: "/api/markets/:slab/trades", destination: `${API_URL}/markets/:slab/trades` },
      // NOTE: Do NOT rewrite /api/markets/:slab/prices — route.ts handles it (proxies to /prices/:slab).
      // A rewrite here would bypass route.ts and hit the wrong Railway path (/markets/:slab/prices → 404→500).
      // GH#1936 / PERC-8302 root cause fix.
      { source: "/api/markets/:slab/stats", destination: `${API_URL}/markets/:slab/stats` },
      { source: "/api/markets/:slab/volume", destination: `${API_URL}/markets/:slab/volume` },
      // NOTE: Do NOT rewrite /api/markets/:slab/logo — that stays in Next.js (file upload)
      // NOTE: Do NOT rewrite /api/markets/:slab (single market) — keep in Next.js for now (uses markets_with_stats view)
      { source: "/api/funding/:slab/history", destination: `${API_URL}/funding/:slab/history` },
      { source: "/api/funding/:slab", destination: `${API_URL}/funding/:slab` },
      { source: "/api/insurance/:slab", destination: `${API_URL}/insurance/:slab` },
      // GH#1462: Moved to app/api/open-interest/[slab]/route.ts for defense-in-depth phantom OI filtering.
      // { source: "/api/open-interest/:slab", destination: `${API_URL}/open-interest/:slab` },
      // NOTE: Do NOT rewrite /api/prices/:slab — app/api/prices/[slab]/route.ts
      // transforms backend { prices } into { stats: { change24h, high24h, low24h } }
      // that MarketInfoBar + useLivePrice consume. A rewrite here silently bypasses
      // that transform, leaving 24H HIGH / 24H LOW as dashes in the UI.
      { source: "/api/crank/status", destination: `${API_URL}/crank/status` },
      { source: "/api/trades/recent", destination: `${API_URL}/trades/recent` },
      // PERC-470: /api/oracle/resolve is handled by Next.js route.ts (returns oracleMode + dexPoolAddress).
      // Railway also has /oracle/resolve but returns a different format ({ bestSource }).
      // We only need the Railway proxy for non-resolve oracle routes now.
      // Using a negative lookahead isn't possible in Next.js rewrites, so list explicitly:
      { source: "/api/oracle/publishers", destination: `${API_URL}/oracle/publishers` },
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
      // Next.js aliases browser `require('buffer')` to its own compiled
      // polyfill at node_modules/next/dist/compiled/buffer/index.js,
      // which is missing Node 12+ BigInt methods (writeBigUInt64LE etc.).
      // That breaks spl-token's createExecuteInstruction on the transfer-
      // hook path. We DON'T try to override that alias here anymore —
      // earlier attempts (plain resolve.alias, NormalModuleReplacement-
      // Plugin) proved ineffective against Next's internal fallback.
      // Instead, app/hooks/useTransferPositionNft.ts builds the Execute
      // ix by hand via DataView, avoiding Buffer.writeBigUInt64LE
      // altogether. No bundler hack required.
    }
    return config;
  },
};

export default withSentryConfig(nextConfig, {
  // Sentry webpack plugin options
  silent: true, // Suppress verbose upload logs in CI

  // Source maps: enabled when SENTRY_AUTH_TOKEN is set (CI/Vercel only).
  // To enable: add SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT to Vercel env vars.
  //   SENTRY_ORG=dcc-pz
  //   SENTRY_PROJECT=percolator-frontend
  //   SENTRY_AUTH_TOKEN=<token from https://sentry.io/settings/auth-tokens/>
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true, // do not ship source maps to browsers
  },

  // Sentry org/project — must match your Sentry workspace.
  // Defaults are the production values; override via env vars if needed.
  org: process.env.SENTRY_ORG || "dcc-pz",
  project: process.env.SENTRY_PROJECT || "percolator-frontend",
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Automatically instrument server components and route handlers
  autoInstrumentServerFunctions: true,

  // Disable the Sentry telemetry/privacy popup in the Next.js dev overlay
  disableLogger: true,
});

import type { NextConfig } from "next";
// withSentryConfig disabled — its build-time instrumentation is not Turbopack-
// compatible (Next 16 builds with Turbopack) and injects Node-only code into the
// Edge middleware bundle, which Vercel rejects at deploy ("referencing unsupported
// modules"). See the export at the bottom of this file.
// import { withSentryConfig } from "@sentry/nextjs";

// NEXT_PUBLIC_API_URL must be explicitly set — no hardcoded fallback
// This ensures misconfigured deployments fail loudly, not silently to production
const API_URL = process.env.NEXT_PUBLIC_API_URL;
if (!API_URL && process.env.NODE_ENV === "production") {
  throw new Error(
    "NEXT_PUBLIC_API_URL environment variable is required in production. " +
    "Please configure this before deploying."
  );
}

// `eslint`/`typescript` are valid next.config runtime keys, but this @types/next
// version omits them from the NextConfig type — hence the `as NextConfig` cast below.
const nextConfig = {
  // Playground is a fast-moving devnet contributor app: don't let a lint warning or a
  // stray type error in an unrelated file block `next build` (Vercel already builds this
  // way). Type-safety is still enforced separately by the `tsc --noEmit` CI gate.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  // Allow loading the dev server from the LAN IP (e.g. phone on the same WiFi).
  // Next 16 blocks /_next/* dev resources from non-localhost origins by default,
  // which makes the page render blank when accessed via an IP. Dev-only setting.
  // Dev-only. Next blocks cross-origin requests to /_next/* dev resources, so a
  // dev server reached over anything other than localhost serves the HTML but no
  // JS chunks — i.e. a blank page. "100.*" covers Tailscale's CGNAT range
  // (100.64.0.0/10), which is how the dev server is reachable from a phone or a
  // second machine when the LAN interface is firewalled.
  allowedDevOrigins: [
    "192.168.1.42",
    "192.168.1.*",
    "100.98.227.2", // Tailscale (tailnet) address of the dev machine
    "100.64.*",
    "localhost",
    "127.0.0.1",
  ],
  // @solana/kit must be transpiled: its browser export resolves to an ESM .mjs file
  // that webpack includes verbatim, causing "Unexpected token 'export'" in production bundles.
  transpilePackages: ["@percolator/sdk", "@solana/kit"],
  // Tree-shake named imports out of large barrel packages so only the used
  // members land in the bundle. @solana/wallet-adapter-wallets re-exports ~36
  // adapters but we use one (Solflare); spl-token / wallet-adapter-react are
  // wide barrels too. Behavior-identical — pure build-time import rewriting.
  experimental: {
    optimizePackageImports: [
      "@solana/wallet-adapter-wallets",
      "@solana/wallet-adapter-react",
      "@solana/spl-token",
    ],
    // Client Router Cache lifetime for prefetched routes. Next 15+ defaults
    // `dynamic` to 0, which silently defeats <Link prefetch={true}> on dynamic
    // routes: the full /trade/[slab] RSC payload IS prefetched when a market
    // row enters the viewport, then discarded as instantly-stale, so the
    // click pays the whole server round-trip again behind the loading.tsx
    // skeleton (~0.6-1.3s measured). 300s matches fetchMarketMeta's own
    // `revalidate: 300` — the payload is a static shell + metadata; all live
    // trading data is fetched client-side after mount, so a minutes-old
    // router-cache entry costs nothing in freshness.
    staleTimes: { dynamic: 300, static: 300 },
  },
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
    // When INDEXER_DATABASE_URL is set (playground / local devnet), skip rewrites for the
    // indexer-backed routes so their route.ts handlers (which check hasIndexerDb()) can run.
    // These routes proxy to Railway only when the local indexer DB is NOT configured.
    const useLocalIndexer = !!process.env.INDEXER_DATABASE_URL;
    return [
      // Data routes → API service
      // NOTE: skipped when INDEXER_DATABASE_URL is set — route.ts handles them via local DB
      ...(useLocalIndexer ? [] : [
        { source: "/api/markets/:slab/trades", destination: `${API_URL}/markets/:slab/trades` },
        { source: "/api/funding/:slab/history", destination: `${API_URL}/funding/:slab/history` },
        // NOTE: /api/funding/global has its own route.ts with local-indexer fallback;
        // skip the generic /api/funding/:slab rewrite that would shadow it.
      ]),
      // NOTE: Do NOT rewrite /api/markets/:slab/prices — route.ts handles it (proxies to /prices/:slab).
      // A rewrite here would bypass route.ts and hit the wrong Railway path (/markets/:slab/prices → 404→500).
      // GH#1936 / PERC-8302 root cause fix.
      { source: "/api/markets/:slab/stats", destination: `${API_URL}/markets/:slab/stats` },
      { source: "/api/markets/:slab/volume", destination: `${API_URL}/markets/:slab/volume` },
      // NOTE: Do NOT rewrite /api/markets/:slab/logo — that stays in Next.js (file upload)
      // NOTE: Do NOT rewrite /api/markets/:slab (single market) — keep in Next.js for now (uses markets_with_stats view)
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
} as NextConfig;

// Export the config directly, WITHOUT Sentry's build wrapper. withSentryConfig
// auto-instruments the middleware/edge bundle, but under Turbopack (Next 16's
// default builder) that instrumentation injects Node-only code into middleware.js
// → Vercel deploy fails with 'Edge Function "middleware" referencing unsupported
// modules'. Sentry was already non-functional under Turbopack (see the build-log
// deprecation warnings) and is optional telemetry for this devnet playground.
// Runtime Sentry.init in sentry.*.config.* is unaffected. Re-wrap with
// withSentryConfig only once Sentry supports Turbopack (or the build returns to webpack).
export default nextConfig;

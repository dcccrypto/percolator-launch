import type { NextConfig } from "next";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://percolator-api-production.up.railway.app";

const nextConfig: NextConfig = {
  transpilePackages: ["@percolator/core"],
  turbopack: {
    resolveAlias: {
      buffer: "buffer",
    },
  },
  async rewrites() {
    return [
      {
        source: "/api/markets/:path*",
        destination: `${API_URL}/markets/:path*`,
      },
      {
        source: "/api/prices/:path*",
        destination: `${API_URL}/prices/:path*`,
      },
    ];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Polyfill bn.js and buffer for @solana/web3.js in browser
      // Without this, some users see "can't access property BN, t is undefined"
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

export default nextConfig;

/**
 * RPC Configuration — uses server-side proxy by default, falls back to direct Helius for SSR.
 * Client-side code should use /api/rpc proxy to avoid exposing API keys.
 */
export type Network = "mainnet" | "devnet";

function getNetwork(): Network {
  if (typeof window !== "undefined") {
    try {
      const override = localStorage.getItem("percolator-network") as Network | null;
      if (override === "mainnet" || override === "devnet") return override;
    } catch {
      // localStorage may be unavailable (SSR, iframes, or test environments)
    }
  }
  // Trim env var to handle trailing whitespace/newlines (Vercel env var copy-paste issue)
  const envNet = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim();
  if (envNet === "mainnet" || envNet === "devnet") return envNet;
  return "devnet";
}

/** Get RPC endpoint — absolute /api/rpc on client, direct RPC on server */
export function getRpcEndpoint(): string {
  if (typeof window !== "undefined") {
    return new URL("/api/rpc", window.location.origin).toString();
  }

  const explicit = process.env.NEXT_PUBLIC_HELIUS_RPC_URL?.trim();
  if (explicit) return explicit;

  const apiKey = process.env.HELIUS_API_KEY ?? process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? "";
  if (apiKey) {
    const net = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim();
    const network = net === "mainnet" ? "mainnet" : "devnet";
    return network === "mainnet"
      ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
      : `https://devnet.helius-rpc.com/?api-key=${apiKey}`;
  }

  return process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
}

/**
 * Get WebSocket endpoint for Solana Connection subscriptions.
 * The HTTP proxy at /api/rpc doesn't support WebSocket upgrades,
 * so we connect directly to Helius WSS for real-time subscriptions.
 * Returns undefined if no Helius key is configured (disables WS subscriptions).
 */
export function getWsEndpoint(): string | undefined {
  const apiKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? "";
  if (!apiKey) return undefined;

  const net = getNetwork();
  return net === "mainnet"
    ? `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`
    : `wss://devnet.helius-rpc.com/?api-key=${apiKey}`;
}

const CONFIGS = {
  mainnet: {
    get rpcUrl() { return getRpcEndpoint(); },
    programId: "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24",
    matcherProgramId: "DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX",
    crankWallet: "",  // TODO: set mainnet crank wallet
    explorerUrl: "https://solscan.io",
  },
  devnet: {
    get rpcUrl() { return getRpcEndpoint(); },
    programId: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    matcherProgramId: "4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy",
    crankWallet: "2JaSzRYrf44fPpQBtRJfnCEgThwCmvpFd3FCXi45VXxm",
    explorerUrl: "https://explorer.solana.com",
    // Multiple program deployments for different slab sizes
    programsBySlabTier: {
      small: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",   // 256 slots
      medium: "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",  // 1024 slots
      large: "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in",   // 4096 slots
    } as Record<string, string>,
  },
} as const;

export function getConfig() {
  const network = getNetwork();
  return {
    ...CONFIGS[network],
    network,
    // Default slab size — variable sizes now supported via SLAB_TIERS
    slabSize: 992_560,
    matcherCtxSize: 320,
    priorityFee: 50_000,
  };
}

export function setNetwork(network: Network) {
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem("percolator-network", network);
    } catch {
      // localStorage may be unavailable (iframes with restrictive policies)
    }
    window.location.reload();
  }
}

// For backward compat — consumers should call getConfig() directly
// Removed eager eval: `export const config = getConfig()` broke SSG/SSR
// when localStorage or env vars weren't available at module load time.

/** Backend API URL — reads NEXT_PUBLIC_API_URL with Railway production as fallback.
 * This is the single source of truth for the backend URL across the entire frontend.
 * Previously: NEXT_PUBLIC_BACKEND_URL, NEXT_PUBLIC_API_URL were used inconsistently.
 */
export function getBackendUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? "https://percolator-api-production.up.railway.app";
}

/** Build an explorer URL for a transaction */
export function explorerTxUrl(sig: string): string {
  const c = getConfig();
  const cluster = c.network === "devnet" ? "?cluster=devnet" : "";
  return `${c.explorerUrl}/tx/${sig}${cluster}`;
}

/** Build an explorer URL for an account */
export function explorerAccountUrl(address: string): string {
  const c = getConfig();
  const cluster = c.network === "devnet" ? "?cluster=devnet" : "";
  return `${c.explorerUrl}/account/${address}${cluster}`;
}

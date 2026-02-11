/**
 * ⚠️  SECURITY WARNING — NEXT_PUBLIC_HELIUS_API_KEY
 * The Helius RPC API key is exposed in the client bundle via the NEXT_PUBLIC_ prefix.
 * This is acceptable for devnet but MUST be replaced with a server-side RPC proxy
 * (e.g. /api/rpc) before mainnet launch. See SECURITY.md for details.
 */
export type Network = "mainnet" | "devnet";

function getNetwork(): Network {
  if (typeof window !== "undefined") {
    const override = localStorage.getItem("percolator-network") as Network | null;
    if (override === "mainnet" || override === "devnet") return override;
  }
  return (process.env.NEXT_PUBLIC_DEFAULT_NETWORK as Network) ?? "devnet";
}

const CONFIGS = {
  mainnet: {
    rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? ""}`,
    programId: "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24",
    matcherProgramId: "DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX",
    crankWallet: "",  // TODO: set mainnet crank wallet
    explorerUrl: "https://solscan.io",
  },
  devnet: {
    // Use public devnet RPC as primary (Helius key is rate-limited on devnet)
    // Helius will be used for mainnet where rate limits are higher
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com",
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
    localStorage.setItem("percolator-network", network);
    window.location.reload();
  }
}

// For backward compat — consumers should call getConfig() directly
// Removed eager eval: `export const config = getConfig()` broke SSG/SSR
// when localStorage or env vars weren't available at module load time.

/** Backend API URL — reads NEXT_PUBLIC_BACKEND_URL with Railway production as fallback */
export function getBackendUrl(): string {
  return process.env.NEXT_PUBLIC_BACKEND_URL ?? "https://percolator-api-production.up.railway.app";
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

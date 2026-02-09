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
    rpcUrl: `https://devnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? ""}`,
    programId: "8n1YAoHzZAAz2JkgASr7Yk9dokptDa9VzjbsRadu3MhL",
    matcherProgramId: "4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy",
    crankWallet: "2JaSzRYrf44fPpQBtRJfnCEgThwCmvpFd3FCXi45VXxm",
    explorerUrl: "https://explorer.solana.com",
    // Multiple program deployments for different slab sizes
    programsBySlabTier: {
      small: "8n1YAoHzZAAz2JkgASr7Yk9dokptDa9VzjbsRadu3MhL",   // 256 slots
      medium: "9RKMpUGWemamrMg75zLgjYPmjWGzfah7wf9rgVrTddnT",  // 1024 slots
      large: "58XqjfaeBVcJBrK6mdY51SaeEW1UFmFX9sVimxpryFEu",   // 4096 slots
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

// For backward compat
export const config = getConfig();

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

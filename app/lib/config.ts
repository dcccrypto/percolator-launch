export type Network = "mainnet" | "devnet";

function getNetwork(): Network {
  if (typeof window !== "undefined") {
    const stored = localStorage.getItem("percolator_network");
    if (stored === "devnet" || stored === "mainnet") return stored;
  }
  return (process.env.NEXT_PUBLIC_DEFAULT_NETWORK as Network) ?? "mainnet";
}

const CONFIGS = {
  mainnet: {
    rpcUrl: "https://mainnet.helius-rpc.com/?api-key=e568033d-06d6-49d1-ba90-b3564c91851b",
    programId: "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24",
    matcherProgramId: "DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX",
    explorerUrl: "https://solscan.io",
  },
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
    programId: "2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp",
    matcherProgramId: "4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy",
    explorerUrl: "https://explorer.solana.com",
  },
} as const;

export function getConfig() {
  const network = getNetwork();
  return {
    ...CONFIGS[network],
    network,
    // Smaller slab = cheaper rent. 128 accounts = ~0.22 SOL, plenty for early markets
    slabSize: 31_296,  // 128 max accounts
    matcherCtxSize: 320,
    priorityFee: 50_000,
  };
}

export function setNetwork(network: Network) {
  if (typeof window !== "undefined") {
    localStorage.setItem("percolator_network", network);
    window.location.reload();
  }
}

// For backward compat
export const config = getConfig();

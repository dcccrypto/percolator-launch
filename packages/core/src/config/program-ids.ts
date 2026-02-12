import { PublicKey } from "@solana/web3.js";

/**
 * Centralized PROGRAM_ID configuration
 * 
 * Default to environment variable, then fall back to network-specific defaults.
 * This prevents hard-coded program IDs scattered across the codebase.
 */

export const PROGRAM_IDS = {
  devnet: {
    percolator: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    matcher: "4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy",
  },
  mainnet: {
    percolator: "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24",
    matcher: "", // TODO: Deploy matcher to mainnet
  },
} as const;

export type Network = "devnet" | "mainnet";

/**
 * Get the Percolator program ID for the current network
 * 
 * Priority:
 * 1. PROGRAM_ID env var (explicit override)
 * 2. Network-specific default (NETWORK env var)
 * 3. Devnet default (safest fallback)
 */
export function getProgramId(network?: Network): PublicKey {
  // Explicit override takes precedence
  if (process.env.PROGRAM_ID) {
    return new PublicKey(process.env.PROGRAM_ID);
  }

  // Use provided network or detect from env
  const targetNetwork = network ?? (process.env.NETWORK as Network) ?? "devnet";
  const programId = PROGRAM_IDS[targetNetwork].percolator;

  return new PublicKey(programId);
}

/**
 * Get the Matcher program ID for the current network
 */
export function getMatcherProgramId(network?: Network): PublicKey {
  // Explicit override takes precedence
  if (process.env.MATCHER_PROGRAM_ID) {
    return new PublicKey(process.env.MATCHER_PROGRAM_ID);
  }

  // Use provided network or detect from env
  const targetNetwork = network ?? (process.env.NETWORK as Network) ?? "devnet";
  const programId = PROGRAM_IDS[targetNetwork].matcher;

  if (!programId) {
    throw new Error(`Matcher program not deployed on ${targetNetwork}`);
  }

  return new PublicKey(programId);
}

/**
 * Get the current network from environment
 * Defaults to devnet for safety
 */
export function getCurrentNetwork(): Network {
  const network = process.env.NETWORK?.toLowerCase();
  if (network === "mainnet" || network === "mainnet-beta") {
    return "mainnet";
  }
  return "devnet";
}

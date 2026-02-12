import "dotenv/config";

// Validate RPC_URL in production
if (process.env.NODE_ENV === "production" && !process.env.RPC_URL) {
  throw new Error("RPC_URL must be explicitly set in production environment. Cannot fall back to devnet.");
}

export const config = {
  rpcUrl: process.env.RPC_URL ?? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ""}`,
  programId: process.env.PROGRAM_ID ?? "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
  /** Comma-separated list of all program IDs to scan for markets */
  allProgramIds: (process.env.ALL_PROGRAM_IDS ?? [
    "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",
    "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in",
  ].join(",")).split(",").filter(Boolean),
  crankKeypair: process.env.CRANK_KEYPAIR ?? "",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseKey: process.env.SUPABASE_KEY ?? "",
  heliusApiKey: process.env.HELIUS_API_KEY ?? "",
  fallbackRpcUrl: process.env.FALLBACK_RPC_URL ?? "https://api.devnet.solana.com",
  port: Number(process.env.PORT ?? 3001),
  crankIntervalMs: Number(process.env.CRANK_INTERVAL_MS ?? 10_000),
  crankInactiveIntervalMs: Number(process.env.CRANK_INACTIVE_INTERVAL_MS ?? 60_000),
  /** BH4: Reduced to 60s to catch markets created/deleted within smaller window */
  discoveryIntervalMs: Number(process.env.DISCOVERY_INTERVAL_MS ?? 60_000),
} as const;

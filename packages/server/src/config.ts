import "dotenv/config";

export const config = {
  rpcUrl: process.env.RPC_URL ?? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ""}`,
  programId: process.env.PROGRAM_ID ?? "8n1YAoHzZAAz2JkgASr7Yk9dokptDa9VzjbsRadu3MhL",
  /** Comma-separated list of all program IDs to scan for markets */
  allProgramIds: (process.env.ALL_PROGRAM_IDS ?? [
    "8n1YAoHzZAAz2JkgASr7Yk9dokptDa9VzjbsRadu3MhL",
    "9RKMpUGWemamrMg75zLgjYPmjWGzfah7wf9rgVrTddnT",
    "58XqjfaeBVcJBrK6mdY51SaeEW1UFmFX9sVimxpryFEu",
  ].join(",")).split(",").filter(Boolean),
  crankKeypair: process.env.CRANK_KEYPAIR ?? "",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseKey: process.env.SUPABASE_KEY ?? "",
  heliusApiKey: process.env.HELIUS_API_KEY ?? "",
  fallbackRpcUrl: process.env.FALLBACK_RPC_URL ?? "https://api.devnet.solana.com",
  port: Number(process.env.PORT ?? 3001),
  crankIntervalMs: Number(process.env.CRANK_INTERVAL_MS ?? 10_000),
  crankInactiveIntervalMs: Number(process.env.CRANK_INACTIVE_INTERVAL_MS ?? 60_000),
} as const;

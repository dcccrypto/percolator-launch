import "dotenv/config";
import { validateEnv } from "./validation.js";

// Validate environment variables at startup
const env = validateEnv();

export const config = {
  rpcUrl: env.RPC_URL ?? `https://devnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY ?? ""}`,
  programId: env.PROGRAM_ID ?? "4dvCZrrPHmimQLDUBLme5CRqa81nGVLzGMwKUAPfXKih",
  /** Comma-separated list of all program IDs to scan for markets */
  allProgramIds: (env.ALL_PROGRAM_IDS ?? [
    "4dvCZrrPHmimQLDUBLme5CRqa81nGVLzGMwKUAPfXKih",
    "p9F84kJm39fQP3AwZSta2tB7oudUKPQd7zFuNHR7vas",
    "6oLLu8wLe6tmEkcGhHfNXNEBZFgKBzcZFheNtgJvZQaS",
  ].join(",")).split(",").filter(Boolean),
  crankKeypair: env.CRANK_KEYPAIR ?? "",
  supabaseUrl: env.SUPABASE_URL ?? "",
  supabaseKey: env.SUPABASE_KEY ?? "",
  supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  heliusApiKey: env.HELIUS_API_KEY ?? "",
  fallbackRpcUrl: env.FALLBACK_RPC_URL ?? "https://api.devnet.solana.com",
  port: env.PORT ?? 3001,
  crankIntervalMs: env.CRANK_INTERVAL_MS ?? 30_000,
  crankInactiveIntervalMs: env.CRANK_INACTIVE_INTERVAL_MS ?? 60_000,
  /** BH4: Reduced to 60s to catch markets created/deleted within smaller window */
  discoveryIntervalMs: env.DISCOVERY_INTERVAL_MS ?? 300_000,
  /** Helius webhook secret for auth validation */
  webhookSecret: env.HELIUS_WEBHOOK_SECRET ?? "",
  /** Public URL for webhook registration (e.g. Railway URL) */
  webhookUrl: env.WEBHOOK_URL ?? "",
} as const;

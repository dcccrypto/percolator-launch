import "dotenv/config";
import { validateEnv } from "./validation.js";
import { validateNetworkConfig, ensureNetworkConfigValid } from "./networkValidation.js";

// Validate network configuration at startup (prevents mainnet accidents)
ensureNetworkConfigValid(process.env);

// Validate environment variables
const env = validateEnv();
const networkConfig = validateNetworkConfig(process.env as Record<string, string | undefined>);

export const config = {
  // Network is validated above; use the validated RPC URL
  rpcUrl: networkConfig.rpcUrl,
  // PROGRAM_ID is required and validated above
  programId: networkConfig.programIds[0],
  /** Comma-separated list of all program IDs to scan for markets */
  allProgramIds: (env.ALL_PROGRAM_IDS ?? [
    "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",
    "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in",
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

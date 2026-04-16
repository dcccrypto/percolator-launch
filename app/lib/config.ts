/**
 * RPC Configuration — uses server-side proxy by default, falls back to direct Helius for SSR.
 * Client-side code should use /api/rpc proxy to avoid exposing API keys.
 */
export type Network = "mainnet" | "devnet";

export function getNetwork(): Network {
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
  // Default fail-closed to mainnet; prevents devnet-only features (pre-fund, faucet)
  // from activating on misconfigured production deployments.
  // Set NEXT_PUBLIC_DEFAULT_NETWORK=devnet explicitly for devnet environments.
  return "mainnet";
}

/** Solana public fallback RPC (rate-limited, for development/build only) */
const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";

/**
 * Validate an RPC URL is non-empty and has a valid scheme.
 * Returns the URL if valid, or null if invalid/empty.
 */
function validateRpcUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Must be http(s) — catch misconfigured values like "null", "undefined", empty-ish strings
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    console.warn(`[getRpcEndpoint] Invalid RPC URL (bad scheme): "${trimmed}"`);
    return null;
  }
  return trimmed;
}

/** Get RPC endpoint — absolute /api/rpc on client, direct RPC on server */
export function getRpcEndpoint(): string {
  if (typeof window !== "undefined") {
    return new URL("/api/rpc", window.location.origin).toString();
  }

  // 1. Explicit full URL override (highest priority)
  const explicit = validateRpcUrl(process.env.NEXT_PUBLIC_HELIUS_RPC_URL);
  if (explicit) return explicit;

  // 2. Build from Helius API key (PERC-469: prefer network-specific keys, fall back to generic)
  const net = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim();
  const network = net === "mainnet" ? "mainnet" : "devnet";
  const apiKey = (
    network === "mainnet"
      ? (process.env.HELIUS_MAINNET_API_KEY ?? process.env.HELIUS_API_KEY ?? "")
      : (process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY ?? "")
  ).trim();
  if (apiKey) {
    return network === "mainnet"
      ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
      : `https://devnet.helius-rpc.com/?api-key=${apiKey}`;
  }

  // 3. Generic Solana RPC URL (supports both env var names)
  const solanaRpc =
    validateRpcUrl(process.env.NEXT_PUBLIC_SOLANA_RPC_URL) ||
    validateRpcUrl(process.env.SOLANA_RPC_URL);
  if (solanaRpc) return solanaRpc;

  // 4. Public fallback (rate-limited but prevents build failures)
  return PUBLIC_DEVNET_RPC;
}

/**
 * Get WebSocket endpoint for Solana Connection subscriptions.
 * The HTTP proxy at /api/rpc doesn't support WebSocket upgrades,
 * so we connect directly to Helius WSS for real-time subscriptions.
 * Always returns a valid WSS URL — Helius if configured, public Solana RPC otherwise.
 */
export function getWsEndpoint(): string {
  // PERC-469: Use only the dedicated WS key (safe to expose: WS-only, rate-limited).
  // NEXT_PUBLIC_HELIUS_API_KEY has been removed; HELIUS_API_KEY is server-only and
  // unavailable on the client, so we cannot use it here.
  const apiKey = (process.env.NEXT_PUBLIC_HELIUS_WS_API_KEY ?? "").trim();
  const net = getNetwork();

  if (apiKey) {
    return net === "mainnet"
      ? `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`
      : `wss://devnet.helius-rpc.com/?api-key=${apiKey}`;
  }

  // No dedicated WS key — fall back to public Solana WS endpoints.
  // Rate-limited but functional for real-time subscriptions.
  // We MUST return a valid WSS URL (not undefined) because @solana/web3.js
  // auto-derives wss:// from the HTTP endpoint when wsEndpoint is falsy,
  // and on the client the HTTP endpoint is /api/rpc (a proxy that doesn't
  // support WS upgrades), causing reconnect storms on Vercel (#869).
  return net === "mainnet"
    ? "wss://api.mainnet-beta.solana.com"
    : "wss://api.devnet.solana.com";
}

const CONFIGS = {
  mainnet: {
    get rpcUrl() { return getRpcEndpoint(); },
    programId: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
    matcherProgramId: "GDK8wx38kpiSVSfGTVNiSdptX3Z5R4kQyqh6Q3QX6wmi",
    crankWallet: "8y7sXswvGo6fWa4daCnxaE3znaFoBs6QJXLTzCLYXotV",  // mainnet keeper crank wallet
    explorerUrl: "https://solscan.io",
  },
  devnet: {
    get rpcUrl() { return getRpcEndpoint(); },
    programId: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
    matcherProgramId: "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k",
    crankWallet: "FF7KFfU5Bb3Mze2AasDHCCZuyhdaSLjUZy2K3JvjdB7x",
    explorerUrl: "https://explorer.solana.com",
    // Multiple program deployments for different slab sizes (PERC-286).
    // Each tier has its own on-chain program compiled with the appropriate --features flag.
    // small:  256 slots  (~0.44 SOL rent) — --features small
    // medium: 1024 slots (~1.8 SOL rent)  — --features medium
    // large:  4096 slots (~7 SOL rent)    — default build (no features)
    // v12.17: micro tier removed — only small/medium/large
    programsBySlabTier: {
      small:  "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",  // 256 slots
      medium: "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in",   // 1024 slots
      large:  "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",  // 4096 slots (confirmed working)
    } satisfies Record<string, string>,
    // PERC-356: Test USDC mint for auto-fund on wallet connect
    testUsdcMint:
      process.env.NEXT_PUBLIC_TEST_USDC_MINT?.trim() ||
      "EqDqqRzRwA5xnZYu7oJ6LfJbcFuwkTKs7KBSTu2xaG66",
  },
} as const;

/**
 * Validate mainnet configuration safety.
 * Throws descriptive error if mainnet is selected but not fully configured.
 * Issue #244: Mainnet keeper bot and address setup required before production launch.
 */
function validateMainnetConfig(
  config: (typeof CONFIGS)[keyof typeof CONFIGS],
  network: Network
): void {
  if (network !== "mainnet") return;

  const crankWallet = config.crankWallet as string;
  if (!crankWallet || crankWallet.trim() === "") {
    console.warn("[getConfig] Mainnet crankWallet not set — keeper bot not deployed (Issue #244).");
  }

  const matcherProgramId = config.matcherProgramId as string;
  if (!matcherProgramId || matcherProgramId.trim() === "") {
    throw new Error(
      "Mainnet Configuration Error: matcherProgramId not set. " +
      "Matcher program must be deployed to mainnet before production use."
    );
  }

  const programId = config.programId as string;
  if (!programId || programId.trim() === "") {
    throw new Error(
      "Mainnet Configuration Error: programId not set. " +
      "Core program must be deployed to mainnet before production use."
    );
  }
}

export function getConfig() {
  const network = getNetwork();
  const baseConfig = CONFIGS[network];

  // Fail fast on unsafe mainnet configuration (Issue #244)
  validateMainnetConfig(baseConfig, network);

  return {
    ...baseConfig,
    network,
    // Default slab size — variable sizes now supported via SLAB_TIERS
    slabSize: 992_560,
    matcherCtxSize: 320,
    priorityFee: 50_000,
    // Expose programsBySlabTier with proper typing (devnet has it, mainnet doesn't yet)
    programsBySlabTier: "programsBySlabTier" in baseConfig
      ? (baseConfig as typeof CONFIGS.devnet).programsBySlabTier
      : undefined,
  };
}

/**
 * Get all unique program ID strings from config (default + all slab tier programs).
 * Shared utility — avoids duplicating this logic across hooks.
 */
export function getAllProgramIds(): string[] {
  const cfg = getConfig();
  const ids = new Set<string>();
  if (cfg.programId) ids.add(cfg.programId);
  const byTier = cfg.programsBySlabTier;
  if (byTier) {
    Object.values(byTier).forEach((id) => { if (id) ids.add(id); });
  }
  return [...ids];
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
  const url = process.env.NEXT_PUBLIC_API_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL;
  if (!url) {
    // Backend URL is required in all environments — no hardcoded fallback
    // This prevents misconfigured deployments from silently routing to production
    throw new Error(
      "NEXT_PUBLIC_API_URL or NEXT_PUBLIC_BACKEND_URL must be explicitly set. " +
      "No hardcoded fallback is provided — ensure your environment configuration is correct."
    );
  }
  return url.trim();
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

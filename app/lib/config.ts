/**
 * RPC Configuration — uses server-side proxy by default, falls back to direct Helius for SSR.
 * Client-side code should use /api/rpc proxy to avoid exposing API keys.
 */
import { MAINNET_PROGRAM_IDS, resolveDevnetProgramIds } from "@/lib/program-ids";

export type Network = "mainnet" | "devnet";

export function getNetwork(): Network {
  // NEXT_PUBLIC_DEFAULT_NETWORK is baked into the client bundle at build time.
  // On mainnet deployments this check is enforced before localStorage is read,
  // so an XSS payload calling localStorage.setItem("percolator-network","devnet")
  // cannot redirect a mainnet frontend to devnet config or devnet program IDs.
  // GH#2704: the same holds the other way. A devnet build can't serve mainnet
  // (the RPC proxy refuses mainnet routing there, GH#1945), so a stored
  // "mainnet" would only swap in program IDs no devnet market uses. The
  // override applies only when the deployment network is unset (local dev).
  const deploymentNet = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim();
  if (deploymentNet === "mainnet") return "mainnet";
  if (deploymentNet === "devnet") return "devnet";

  if (typeof window !== "undefined") {
    try {
      const override = localStorage.getItem("percolator-network") as Network | null;
      if (override === "mainnet" || override === "devnet") return override;
    } catch {
      // localStorage may be unavailable (SSR, iframes, or test environments)
    }
  }
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
  // Local fork / E2E: an explicit ws(s) URL wins (devnet builds only). Pairs with
  // the server-side DEVNET_RPC_URL that /api/rpc and getServerConnection use.
  const wsOverride = process.env.NEXT_PUBLIC_SOLANA_WS_URL?.trim();
  if (wsOverride && /^wss?:\/\//.test(wsOverride) && getNetwork() === "devnet") return wsOverride;

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

// Program ids: lib/program-ids.ts is the single source (one-line repoint + env overrides).
const DEVNET_IDS = resolveDevnetProgramIds();

const CONFIGS = {
  mainnet: {
    get rpcUrl() { return getRpcEndpoint(); },
    programId: MAINNET_PROGRAM_IDS.wrapper,
    matcherProgramId: MAINNET_PROGRAM_IDS.matcher,
    crankWallet: "8y7sXswvGo6fWa4daCnxaE3znaFoBs6QJXLTzCLYXotV",  // mainnet keeper crank wallet
    explorerUrl: "https://solscan.io",
  },
  devnet: {
    get rpcUrl() { return getRpcEndpoint(); },
    // Wrapper / matcher / nft / stake: lib/program-ids.ts (DEVNET_PROGRAM_IDS, env-overridable).
    programId: DEVNET_IDS.wrapper,
    matcherProgramId: DEVNET_IDS.matcher,
    nftProgramId: DEVNET_IDS.nft,
    vaultProgramId: DEVNET_IDS.stake,
    crankWallet: "FF7KFfU5Bb3Mze2AasDHCCZuyhdaSLjUZy2K3JvjdB7x",
    explorerUrl: "https://explorer.solana.com",
    // v17+ uses a single unified wrapper — every slab tier is the same program.
    programsBySlabTier: {
      small: DEVNET_IDS.wrapper,
      medium: DEVNET_IDS.wrapper,
      large: DEVNET_IDS.wrapper,
    } satisfies Record<string, string>,
    // Playground: canonical Sim-USDC mint (6 decimals).
    // Overridable via NEXT_PUBLIC_TEST_USDC_MINT env var.
    // Default: DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC (mint authority: GRMMNsNP...)
    testUsdcMint:
      process.env.NEXT_PUBLIC_TEST_USDC_MINT?.trim() ||
      "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC",
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

// Known-program allowlist: the devnet set from lib/program-ids.ts (after env
// overrides). A repoint there moves the allowlist with it — the old wrapper
// drops out, so its markets are treated as untrusted after the cutover.
const DEVNET_KNOWN_PROGRAM_IDS: readonly string[] = [
  DEVNET_IDS.wrapper,
  DEVNET_IDS.matcher,
  DEVNET_IDS.nft,
  DEVNET_IDS.stake,
];

/**
 * Get all unique program ID strings from config (default + all slab tier programs).
 * Shared utility — avoids duplicating this logic across hooks.
 */
export function getAllProgramIds(): string[] {
  const cfg = getConfig();
  const ids = new Set<string>();
  if (cfg.programId) ids.add(cfg.programId);
  // Slabs are owned by the matcher program, not the engine. Mainnet has no
  // programsBySlabTier yet (single matcher), so without this entry the
  // mainnet allowlist excludes the canonical matcher and parseSlab rejects
  // every legitimate market — trade UI dies on deploy.
  if (cfg.matcherProgramId) ids.add(cfg.matcherProgramId);
  const byTier = cfg.programsBySlabTier;
  if (byTier) {
    Object.values(byTier).forEach((id) => { if (id) ids.add(id); });
  }
  if (cfg.network === "devnet") DEVNET_KNOWN_PROGRAM_IDS.forEach((id) => ids.add(id));
  return [...ids];
}

/**
 * Program IDs that can actually own/discover market slabs.
 *
 * This is intentionally narrower than getAllProgramIds(), which is the
 * security/known-program allowlist and also contains matcher, NFT and stake
 * programs on devnet.
 *
 * v17+ devnet markets are owned by the wrapper program exposed through
 * programsBySlabTier. Mainnet currently has no tier map, so preserve the
 * existing wrapper + matcher discovery scope there for backward compatibility.
 */
export function getMarketDiscoveryProgramIds(): string[] {
  const cfg = getConfig();
  const ids = new Set<string>();

  if (cfg.programId) ids.add(cfg.programId);

  const byTier = cfg.programsBySlabTier;
  if (byTier) {
    Object.values(byTier).forEach((id) => {
      if (id) ids.add(id);
    });
  } else if (cfg.matcherProgramId) {
    // Preserve the existing mainnet/legacy discovery scope when no explicit
    // market-program tier map exists.
    ids.add(cfg.matcherProgramId);
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

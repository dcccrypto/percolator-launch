/**
 * PERC-377: Bot Configuration
 *
 * All configuration is loaded from environment variables with sensible defaults.
 * Supports three modes: filler, maker, or both (default).
 */

import { PublicKey } from "@solana/web3.js";

export type BotMode = "filler" | "maker" | "both" | "trader" | "all";

const VALID_BOT_MODES: BotMode[] = ["filler", "maker", "both", "trader", "all"];

function parseNum(val: string | undefined, fallback: number): number {
  if (val === undefined) return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export interface BotConfig {
  // ── Core ──────────────────────────────────────
  mode: BotMode;
  rpcUrl: string;
  programId: PublicKey;
  matcherProgramId: PublicKey;
  dryRun: boolean;
  healthPort: number;
  healthHost: string;

  // ── Wallets ───────────────────────────────────
  /** Path to filler/crank wallet keypair */
  fillerKeypairPath: string;
  /** Path to maker/quoter wallet keypair */
  makerKeypairPath: string;

  // ── Filler Config ─────────────────────────────
  /** Crank interval in ms (how often to process orders) */
  crankIntervalMs: number;
  /** Max slots a crank can be stale before alerting */
  maxCrankStalenessSlots: number;
  /** Batch size for parallel market cranking */
  crankBatchSize: number;
  /** Enable proactive order filling (watch for pending orders) */
  proactiveFill: boolean;

  // ── Maker Config ──────────────────────────────
  /** Half-spread in basis points */
  spreadBps: number;
  /** Max quote size per side in USDC */
  maxQuoteSizeUsdc: number;
  /** Max position as % of collateral */
  maxPositionPct: number;
  /** Re-quote interval in ms */
  quoteIntervalMs: number;
  /** Collateral to deposit per market (USDC, 6 decimals) */
  initialCollateralUsdc: bigint;
  /** Spread skew multiplier at max exposure */
  skewMaxMultiplier: number;
  /** Random spread noise in bps (for organic orderbook appearance) */
  spreadNoiseBps: number;
  /** Size jitter factor (0–1) */
  sizeJitter: number;
  /** Filter to specific market symbols (null = all) */
  marketsFilter: string[] | null;

  // ── Oracle ────────────────────────────────────
  /** Whether to push oracle prices for Hyperp-mode markets */
  pushOraclePrices: boolean;
  /** Max price staleness before force-push in ms */
  maxPriceStalenessMs: number;
}

export function loadConfig(): BotConfig {
  const heliusKey = process.env.HELIUS_API_KEY ?? "";
  const defaultRpc = heliusKey
    ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}`
    : "https://api.devnet.solana.com";

  const rawMode = process.env.BOT_MODE ?? "both";
  const mode: BotMode = VALID_BOT_MODES.includes(rawMode as BotMode)
    ? (rawMode as BotMode)
    : "both";

  return {
    mode,
    rpcUrl: process.env.RPC_URL ?? defaultRpc,
    programId: new PublicKey(
      process.env.PROGRAM_ID ?? "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn",
    ),
    matcherProgramId: new PublicKey(
      process.env.MATCHER_PROGRAM_ID ?? "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k",
    ),
    dryRun: process.env.DRY_RUN === "true",
    healthPort: parseNum(process.env.HEALTH_PORT, 18820),
    healthHost: process.env.HEALTH_HOST ?? "127.0.0.1",

    fillerKeypairPath:
      process.env.FILLER_KEYPAIR ??
      process.env.BOOTSTRAP_KEYPAIR ??
      "/tmp/percolator-bots/filler.json",
    makerKeypairPath:
      process.env.MAKER_KEYPAIR ??
      process.env.BOOTSTRAP_KEYPAIR ??
      "/tmp/percolator-bots/maker.json",

    crankIntervalMs: parseNum(process.env.CRANK_INTERVAL_MS, 5000),
    maxCrankStalenessSlots: parseNum(process.env.MAX_CRANK_STALENESS, 200),
    crankBatchSize: parseNum(process.env.CRANK_BATCH_SIZE, 3),
    proactiveFill: process.env.PROACTIVE_FILL !== "false",

    spreadBps: parseNum(process.env.SPREAD_BPS, 25),
    maxQuoteSizeUsdc: parseNum(process.env.MAX_QUOTE_SIZE_USDC, 500),
    maxPositionPct: parseNum(process.env.MAX_POSITION_PCT, 10),
    quoteIntervalMs: parseNum(process.env.QUOTE_INTERVAL_MS, 5000),
    initialCollateralUsdc: BigInt(process.env.INITIAL_COLLATERAL ?? "10000000000"), // $10k
    skewMaxMultiplier: parseNum(process.env.SKEW_MAX_MULTIPLIER, 3.0),
    spreadNoiseBps: parseNum(process.env.SPREAD_NOISE_BPS, 4),
    sizeJitter: parseNum(process.env.SIZE_JITTER, 0.25),
    marketsFilter: process.env.MARKETS_FILTER
      ? process.env.MARKETS_FILTER.split(",").map((s) => s.trim().toUpperCase())
      : null,

    pushOraclePrices: process.env.PUSH_ORACLE !== "false",
    maxPriceStalenessMs: parseNum(process.env.MAX_PRICE_STALENESS_MS, 10000),
  };
}

/**
 * PERC-366: Market Maker Profile Definitions
 *
 * Three profiles per market create realistic-looking orderbook depth:
 *   - WIDE:    Conservative MM — wide spread, large size, slow re-quote
 *   - TIGHT_A: Aggressive MM A — tight spread, small size, fast re-quote
 *   - TIGHT_B: Aggressive MM B — tight spread, small size, fast re-quote (offset)
 *
 * Each profile runs as an independent quote loop with its own subaccount,
 * so positions are isolated and risk limits apply per-profile.
 */

export interface MakerProfile {
  /** Human-readable profile name */
  name: string;
  /** Half-spread in basis points */
  spreadBps: number;
  /** Max quote size per side in USDC (6 decimal units) */
  maxQuoteSizeUsdc: bigint;
  /** Max position as % of collateral before one-siding */
  maxPositionPct: number;
  /** Re-quote interval in ms */
  quoteIntervalMs: number;
  /** Spread multiplier at max exposure (skew aggressiveness) */
  skewMaxMultiplier: number;
  /** Collateral to deposit per market (6 decimals) */
  initialCollateralUsdc: bigint;
  /** Random jitter range added to quote interval (ms) — prevents lockstep */
  jitterMs: number;
  /** Offset from oracle in bps — TIGHT_B uses this to stagger with TIGHT_A */
  oracleOffsetBps: number;
  /** Whether to add small random walk noise to spread (makes orderbook look organic) */
  spreadNoise: boolean;
  /** Max random spread noise in bps (applied ± each cycle) */
  spreadNoiseBps: number;
  /** Size randomization factor (0–1). 0 = fixed size, 0.3 = ±30% variation */
  sizeJitter: number;
}

/**
 * WIDE profile — the "bedrock" liquidity layer.
 * Wide spread captures large moves, big size makes the book look deep.
 */
export const PROFILE_WIDE: MakerProfile = {
  name: "WIDE",
  spreadBps: 40, // 0.40% half-spread — PERC-372: tightened from 60 to stay within 1%
  maxQuoteSizeUsdc: 2_000_000_000n, // $2,000 per side
  maxPositionPct: 15,
  quoteIntervalMs: 8_000,
  skewMaxMultiplier: 2.5,
  initialCollateralUsdc: 25_000_000_000n, // $25,000
  jitterMs: 2_000,
  oracleOffsetBps: 0,
  spreadNoise: true,
  spreadNoiseBps: 5,
  sizeJitter: 0.2,
};

/**
 * TIGHT_A — aggressive MM #1.
 * Tight spread, small size, fast re-quote. Creates top-of-book action.
 */
export const PROFILE_TIGHT_A: MakerProfile = {
  name: "TIGHT_A",
  spreadBps: 12, // 0.12% half-spread — PERC-372: tightened from 15 for tighter top-of-book
  maxQuoteSizeUsdc: 300_000_000n, // $300 per side
  maxPositionPct: 8,
  quoteIntervalMs: 3_000,
  skewMaxMultiplier: 4.0,
  initialCollateralUsdc: 10_000_000_000n, // $10,000
  jitterMs: 1_000,
  oracleOffsetBps: 0,
  spreadNoise: true,
  spreadNoiseBps: 3,
  sizeJitter: 0.3,
};

/**
 * TIGHT_B — aggressive MM #2.
 * Similar to TIGHT_A but with a small oracle offset so they don't stack
 * on the exact same price. Slight timing offset via different jitter seed.
 */
export const PROFILE_TIGHT_B: MakerProfile = {
  name: "TIGHT_B",
  spreadBps: 18, // 0.18% half-spread — PERC-372: tightened from 20 for tighter quotes
  maxQuoteSizeUsdc: 250_000_000n, // $250 per side
  maxPositionPct: 8,
  quoteIntervalMs: 4_000,
  skewMaxMultiplier: 3.5,
  initialCollateralUsdc: 10_000_000_000n, // $10,000
  jitterMs: 1_500,
  oracleOffsetBps: 2, // +0.02% oracle offset — slightly different reference price
  spreadNoise: true,
  spreadNoiseBps: 4,
  sizeJitter: 0.25,
};

/** All default profiles for the fleet */
export const DEFAULT_PROFILES: MakerProfile[] = [
  PROFILE_WIDE,
  PROFILE_TIGHT_A,
  PROFILE_TIGHT_B,
];

/**
 * Calculate bid/ask quotes for a given profile.
 *
 * @param profile - The maker profile parameters
 * @param oraclePrice - Current oracle price in USD
 * @param positionSize - Current position in 6-decimal units (signed)
 * @param collateral - Collateral deposited in 6-decimal units
 * @returns Quote prices and sizes with skew info
 */
export function calculateProfileQuotes(
  profile: MakerProfile,
  oraclePrice: number,
  positionSize: bigint,
  collateral: bigint,
): {
  bidPrice: number;
  askPrice: number;
  bidSize: bigint;
  askSize: bigint;
  skewFactor: number;
  effectiveSpreadBps: number;
} {
  // Apply oracle offset
  const offsetFrac = profile.oracleOffsetBps / 10_000;
  const refPrice = oraclePrice * (1 + offsetFrac);

  // Base spread
  let spreadBps = profile.spreadBps;

  // Apply spread noise if enabled
  if (profile.spreadNoise) {
    const noise =
      (Math.random() * 2 - 1) * profile.spreadNoiseBps;
    spreadBps = Math.max(1, spreadBps + noise);
  }

  const spreadFrac = spreadBps / 10_000;
  const collateralUsd = Number(collateral) / 1_000_000;
  const positionUsd = Number(positionSize) / 1_000_000;

  // Exposure: position / (collateral × maxPositionPct%)
  const maxPosUsd = collateralUsd * (profile.maxPositionPct / 100);
  const exposure =
    maxPosUsd > 0
      ? Math.max(-1, Math.min(1, positionUsd / maxPosUsd))
      : 0;

  const skewFactor = exposure;

  // Skew spread multipliers
  const bidSpreadMul =
    1 + Math.max(0, skewFactor) * (profile.skewMaxMultiplier - 1);
  const askSpreadMul =
    1 + Math.max(0, -skewFactor) * (profile.skewMaxMultiplier - 1);

  const bidPrice = refPrice * (1 - spreadFrac * bidSpreadMul);
  const askPrice = refPrice * (1 + spreadFrac * askSpreadMul);

  // Size scaling
  const absExposure = Math.abs(exposure);
  const sizeFactor = Math.max(0.1, 1 - absExposure * 0.8);

  let bidSize = profile.maxQuoteSizeUsdc;
  let askSize = profile.maxQuoteSizeUsdc;

  if (absExposure >= 0.95) {
    // At max exposure, only quote on the reducing side
    if (exposure > 0) {
      bidSize = 0n;
    } else {
      askSize = 0n;
    }
  } else {
    const baseSize = BigInt(
      Math.floor(Number(profile.maxQuoteSizeUsdc) * sizeFactor),
    );

    // Apply size jitter
    if (profile.sizeJitter > 0) {
      const jitterFactor =
        1 + (Math.random() * 2 - 1) * profile.sizeJitter;
      const jitteredSize = BigInt(
        Math.floor(Number(baseSize) * Math.max(0.1, jitterFactor)),
      );
      bidSize = jitteredSize;
      askSize = jitteredSize;
    } else {
      bidSize = baseSize;
      askSize = baseSize;
    }
  }

  return {
    bidPrice,
    askPrice,
    bidSize,
    askSize,
    skewFactor,
    effectiveSpreadBps: spreadBps,
  };
}

/**
 * Parse profile overrides from environment variables.
 * Format: MM_WIDE_SPREAD_BPS=80, MM_TIGHT_A_MAX_QUOTE_SIZE_USDC=200, etc.
 */
export function applyEnvOverrides(profiles: MakerProfile[]): MakerProfile[] {
  return profiles.map((p) => {
    const prefix = `MM_${p.name}_`;
    const clone = { ...p };

    const envSpread = process.env[`${prefix}SPREAD_BPS`];
    if (envSpread) clone.spreadBps = Number(envSpread);

    const envSize = process.env[`${prefix}MAX_QUOTE_SIZE_USDC`];
    if (envSize) clone.maxQuoteSizeUsdc = BigInt(envSize) * 1_000_000n;

    const envPos = process.env[`${prefix}MAX_POSITION_PCT`];
    if (envPos) clone.maxPositionPct = Number(envPos);

    const envInterval = process.env[`${prefix}QUOTE_INTERVAL_MS`];
    if (envInterval) clone.quoteIntervalMs = Number(envInterval);

    const envCollateral = process.env[`${prefix}INITIAL_COLLATERAL`];
    if (envCollateral) clone.initialCollateralUsdc = BigInt(envCollateral);

    return clone;
  });
}

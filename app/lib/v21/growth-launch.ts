/**
 * Devnet v2.1: the create-market wizard's growth-v19 block (pure; no wallet, no RPC).
 *
 * A growth market is a P3 single-asset market (vault-owned LP + the creator's junior tranche) whose
 * leverage and capacity follow the capital that backs it. The wrapper (percolator-prog #524 @
 * 9cc6d281) validates, at InitMarket, with the optional 4-byte trailer `(r_gap_bps, l_launch_x100)`:
 *   - `r_gap > 0`, `r_gap >= max_price_move_bps_per_slot * 50` (L-2 floor), and
 *     `MMR >= r_gap + liquidation fee`;
 *   - `l_launch` in `[1x, tier]`, tier = floor(1e6 / engine IMR bps) (x100);
 *   - `max_abs_funding_e9_per_slot > 0` (single-slot markets);
 *   - `max_trading_fee_bps >= base + 100 + 500` (the 100 bps matcher fee channel plus the busy-side
 *     utilisation fee). The wizard asks for base + 600.
 * Anything it refuses here is refused on chain with 94 `GrowthInvalidConfig`, so every rule below
 * is a pre-sign refusal of the same rule.
 *
 * Seed order (the existing P3 order, unchanged, because tag 94 needs the creator as marketauth):
 *   InitMarket (+ the growth trailer)  ->  CreateLpVault (74)  ->  Earn seeds (75)
 *   ->  InitVaultLp (94 + l_launch)  ->  DepositJunior (96, >= $1)  ->  StakeInitPool (rotates marketauth).
 * `c_launch` is recorded at the FIRST junior deposit, so that deposit is never dust.
 */
import { encodeInitMarketV19, encodeInitVaultLpV19, rGapFloorBps, GROWTH_LEVERAGE_X100_ONE } from "./sdk";
import { encodeInitMarket, type InitMarketV17Args } from "@percolatorct/sdk";

/** Matches wrapper `GROWTH_FEE_HEADROOM`: base + 100 (matcher fee channel) + 500 (utilisation fee) = base + 600. */
export const GROWTH_FEE_HEADROOM_BPS = 600n;
/** The engine liquidation fee the wizard sends at InitMarket (`liquidationFeeBps: "50"`). */
export const LAUNCH_LIQUIDATION_FEE_BPS = 50;
/** Default funding ceiling: about 0.10% per hour (plan). */
export const DEFAULT_FUNDING_PCT_PER_HOUR = 0.1;
/** Solana's target 400 ms slot => 9,000 slots per hour. */
export const SLOTS_PER_HOUR = 9_000;
/** The creator's first junior deposit is at least this many dollars (collateral is a dollar token). */
export const MIN_JUNIOR_USD = 1;
/** Default starting leverage offered when the market's tier allows it. */
export const DEFAULT_LAUNCH_LEVERAGE_X100 = 500;

/** `max_abs_funding_e9_per_slot` for a %-per-hour ceiling (1e9 = 100% per slot), rounded to nearest, >= 1. */
export function fundingE9PerSlotFor(pctPerHour: number): bigint {
  if (!Number.isFinite(pctPerHour) || pctPerHour <= 0) return 0n;
  const v = Math.round((pctPerHour / 100 / SLOTS_PER_HOUR) * 1e9);
  return BigInt(Math.max(1, v));
}

/** The %-per-hour a stored per-slot ceiling stands for (for the "about 0.10% per hour" line). */
export function fundingPctPerHour(e9PerSlot: bigint): number {
  return (Number(e9PerSlot) * SLOTS_PER_HOUR * 100) / 1e9;
}

/** Protocol tier maximum leverage, x100: `floor(1e6 / engine IMR bps)`. */
export function growthTierX100(engineImrBps: number): number {
  if (!Number.isInteger(engineImrBps) || engineImrBps <= 0) return 0;
  return Math.floor(1_000_000 / engineImrBps);
}

export interface RGapRange {
  /** L-2 floor `max_price_move * 50` and the lowest honest value: the default. */
  min: number;
  /** `MMR - liquidation fee`. */
  max: number;
  /** min <= max (otherwise this market's margin cannot support a growth block at all). */
  feasible: boolean;
}

export function rGapRange(p: { maxPriceMoveBpsPerSlot: number; maintenanceMarginBps: number; liquidationFeeBps?: number }): RGapRange {
  const min = Number(rGapFloorBps(BigInt(p.maxPriceMoveBpsPerSlot)));
  const max = p.maintenanceMarginBps - (p.liquidationFeeBps ?? LAUNCH_LIQUIDATION_FEE_BPS);
  return { min, max, feasible: min <= max && min > 0 };
}

/** `maxTradingFeeBps` of a growth market: base + 600 (never below what the wrapper requires). */
export function growthMaxTradingFeeBps(baseFeeBps: number): bigint {
  return BigInt(baseFeeBps) + GROWTH_FEE_HEADROOM_BPS;
}

/** Atoms of the minimum junior deposit: $1, i.e. `10^decimals` of a dollar-pegged collateral. */
export function minJuniorAtoms(collateralDecimals: number): bigint {
  return BigInt(MIN_JUNIOR_USD) * 10n ** BigInt(collateralDecimals);
}

export interface GrowthLaunch {
  /** Starting leverage, x100 (550 = 5.5x). */
  lLaunchX100: number;
  rGapBps: number;
  maxAbsFundingE9PerSlot: bigint;
  /** What InitMarket sends as `maxTradingFeeBps` (base + 600). */
  maxTradingFeeBps: bigint;
}

export type GrowthLaunchIssue =
  | "leverage-out-of-range"
  | "r-gap-out-of-range"
  | "funding-zero"
  | "fee-cap-too-low"
  | "junior-below-minimum"
  | "not-single-asset";

export interface GrowthLaunchInput {
  engineImrBps: number;
  maintenanceMarginBps: number;
  maxPriceMoveBpsPerSlot: number;
  baseFeeBps: number;
  /** The wizard's pick; undefined = the default (min(tier, 5x)). */
  lLaunchX100?: number;
  /** undefined = the lowest honest value (the L-2 floor). */
  rGapBps?: number;
  /** undefined = about 0.10% per hour. */
  fundingPctPerHour?: number;
  /** Explicit values (what `params.growth` carries); they take precedence over the defaults above. */
  maxAbsFundingE9PerSlot?: bigint;
  maxTradingFeeBps?: bigint;
  juniorAtoms: bigint;
  collateralDecimals: number;
  /** The market is created with exactly one asset slot (the P3 path). */
  singleAsset: boolean;
}

/** The defaults a creator sees before touching anything. */
export function defaultGrowthLaunch(i: Omit<GrowthLaunchInput, "juniorAtoms" | "collateralDecimals" | "singleAsset">): GrowthLaunch {
  const tier = growthTierX100(i.engineImrBps);
  const range = rGapRange(i);
  return {
    lLaunchX100: i.lLaunchX100 ?? Math.min(tier, DEFAULT_LAUNCH_LEVERAGE_X100),
    rGapBps: i.rGapBps ?? range.min,
    maxAbsFundingE9PerSlot: fundingE9PerSlotFor(i.fundingPctPerHour ?? DEFAULT_FUNDING_PCT_PER_HOUR),
    maxTradingFeeBps: growthMaxTradingFeeBps(i.baseFeeBps),
  };
}

export function validateGrowthLaunch(i: GrowthLaunchInput): GrowthLaunchIssue | null {
  if (!i.singleAsset) return "not-single-asset";
  const g = defaultGrowthLaunch(i);
  const tier = growthTierX100(i.engineImrBps);
  if (!Number.isInteger(g.lLaunchX100) || g.lLaunchX100 < GROWTH_LEVERAGE_X100_ONE || g.lLaunchX100 > tier) return "leverage-out-of-range";
  const range = rGapRange(i);
  if (!range.feasible || !Number.isInteger(g.rGapBps) || g.rGapBps < range.min || g.rGapBps > range.max) return "r-gap-out-of-range";
  if ((i.maxAbsFundingE9PerSlot ?? g.maxAbsFundingE9PerSlot) <= 0n) return "funding-zero";
  if ((i.maxTradingFeeBps ?? g.maxTradingFeeBps) < BigInt(i.baseFeeBps) + GROWTH_FEE_HEADROOM_BPS) return "fee-cap-too-low";
  if (i.juniorAtoms < minJuniorAtoms(i.collateralDecimals)) return "junior-below-minimum";
  return null;
}

/** The InitMarket args with the growth block applied (fee cap and funding ceiling). */
export function withGrowthInitArgs(args: InitMarketV17Args, g: GrowthLaunch | undefined): InitMarketV17Args {
  if (!g) return args;
  return { ...args, maxTradingFeeBps: g.maxTradingFeeBps.toString(), maxAbsFundingE9PerSlot: g.maxAbsFundingE9PerSlot.toString() };
}

/** InitMarket instruction data: the legacy encoding, or with the growth trailer. */
export function encodeInitMarketData(args: InitMarketV17Args, g: GrowthLaunch | undefined): Uint8Array {
  return g ? encodeInitMarketV19(args, g.rGapBps, g.lLaunchX100) : encodeInitMarket(args);
}

/** InitVaultLp (94) data: `[94, floor]`, plus `l_launch` on a growth market. */
export function encodeInitVaultLpData(juniorFloorBps: number, g: GrowthLaunch | undefined, legacy: (floor: number) => Uint8Array): Uint8Array {
  return g ? encodeInitVaultLpV19(juniorFloorBps, g.lLaunchX100) : legacy(juniorFloorBps);
}

/** The relative order the growth seed must run in (asserted by the tests against the real sequence). */
export const GROWTH_SEED_ORDER = ["init-market", "create-lp-vault", "earn-seed", "init-vault-lp", "deposit-junior", "stake-init-pool"] as const;

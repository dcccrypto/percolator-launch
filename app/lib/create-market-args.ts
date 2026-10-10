/**
 * Market sizing and InitMarket args shared by every create path (hooks/useCreateMarket.ts),
 * the wizard's rent display (components/create/*) and the P3 BPF sim bridge
 * (scripts/limits-parity/p3-app-ixs.ts `init-market`). Plain module: no React, no wallet.
 */
import { v17MarketAccountLen, type InitMarketV17Args } from "@percolatorct/sdk";
import { marketAccountLen } from "@/lib/v22/layout";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import type { deriveMarketParams } from "@/lib/market-params";
import { withGrowthInitArgs, type GrowthLaunch } from "@/lib/v21/growth-launch";

/**
 * The program's cap on a market's asset slots (the wrapper's WRAPPER_MAX_PORTFOLIO_ASSETS, 14). It is
 * NOT what a launch allocates: markets created before the one-slot change hold 14, and an existing
 * market keeps whatever it was created with (see `assetSlotsForSlabLen`). Only the upper bound of
 * "which slot counts can an existing slab have".
 */
export const V17_MAX_PORTFOLIO_ASSETS = 14;
/**
 * v2.2 (wrapper VERSION 19): the program caps a portfolio, and therefore a market's asset slots, at 4
 * (percolator-prog#546; founder-confirmed 2026-10-08, FINAL). InitMarket refuses `max_portfolio_assets` of 0 or
 * above 4 (error 14). Capacity-4 slab = 592 + 806 + 4 x 2,661 = 12,042 B. Only the upper bound of "which slot
 * counts can an existing v2.2 slab have"; a launch allocates {@link LAUNCH_ASSET_SLOTS}.
 */
export const V22_MAX_PORTFOLIO_ASSETS = 4;

/** The program's cap on asset slots in the ACTIVE layout: 14 on v2.1 (flag off), 4 on v2.2 (flag on). */
export function maxPortfolioAssets(): number {
  return isDevnetV22Enabled() ? V22_MAX_PORTFOLIO_ASSETS : V17_MAX_PORTFOLIO_ASSETS;
}

/**
 * Asset slots EVERY new launch allocates, legacy and vault-LP alike. The app only ever uses slot 0
 * (asset index 0 in the keeper, indexer, trade, close and fee flows). The other 13 slots on a 14-slot
 * market cost rent, and on the deployed wrapper they are tradable asset indexes nobody watches: an
 * account holding many legs in one market can become impossible to settle or liquidate within the
 * compute limit (security review 2026-10-08, "Deployed v1"). The slab MUST be sized to exactly match
 * this capacity or InitMarket reverts (dynamic-length validation).
 */
export const LAUNCH_ASSET_SLOTS = 1;

/** The slab a fresh launch allocates: `v17MarketAccountLen(LAUNCH_ASSET_SLOTS)` (3_675 bytes). */
export const DEFAULT_SLAB_SIZE = v17MarketAccountLen(LAUNCH_ASSET_SLOTS);

/**
 * The slab a fresh launch allocates in the ACTIVE layout: `DEFAULT_SLAB_SIZE` (3,675 B) flag off, 592 + 806 + 1 x 2,661
 * = 4,059 B flag on. ONE slot on v2.2 too: the app only ever uses asset index 0, the v2.2 seed kit's markets use 1 slot,
 * and every extra slot costs 2,661 B of rent (0.0185 SOL) while being a tradable asset index nobody watches. Nothing in
 * the v2.2 design needs more: the 4-leg cap bounds a PORTFOLIO, and a multi-asset market is created by growth after the
 * fact, not at launch.
 */
export function defaultSlabSize(): number {
  return marketAccountLen(LAUNCH_ASSET_SLOTS);
}
/**
 * P3 (next FINAL, F14-Q2): a vault-owned-LP market is strictly SINGLE-asset. Tag 94 refuses any
 * market whose configured asset slots != 1 (VaultLpMultiAssetMarket, 86), so a P3 market must have
 * exactly one slot; legacy launches now allocate the same single slot.
 */
export const P3_MARKET_ASSET_SLOTS = 1;

/**
 * The asset-slot capacity of a market this launch is working on: a P3 market is 1; a market that
 * already exists (a resume, a stuck slab) carries `assetSlots`, read off the slab it was created
 * with (`assetSlotsForSlabLen`); otherwise a fresh launch gets LAUNCH_ASSET_SLOTS.
 */
export function marketAssetSlotsFor(p: { p3?: unknown; assetSlots?: number }): number {
  if (p.p3) return P3_MARKET_ASSET_SLOTS;
  return p.assetSlots ?? LAUNCH_ASSET_SLOTS;
}

/**
 * The asset-slot count of a market account of `len` bytes, or null when `len` is not the exact size
 * of any 1..14-slot market. Lets a resumed launch keep the capacity its slab was created with
 * (a pre-change 14-slot launch still in flight) instead of assuming today's default.
 */
export function assetSlotsForSlabLen(len: number): number | null {
  for (let n = 1; n <= maxPortfolioAssets(); n++) if (marketAccountLen(n) === len) return n;
  return null;
}

/** The asset-generation frontier of a market just created with `slots` slots (wrapper: `next_market_id = slots + 1`). */
export function initialAssetGenerationFrontier(slots: number): bigint {
  return BigInt(slots) + 1n;
}

/**
 * The InitMarket args every create path sends (fresh batch, sequential, recovery).
 * One builder so the paths cannot drift: `maxPortfolioAssets` is
 * `marketAssetSlotsFor(params)`: 1 for every new launch (a P3 market must be 1:
 * tag 94 refuses any other slot count with 86 VaultLpMultiAssetMarket), or the
 * capacity of the slab a resumed launch already holds. The P3 BPF sim builds its
 * market from this same function (bridge `init-market`).
 */
export function buildV17InitMarketArgs(
  params: { p3?: unknown; assetSlots?: number; initialPriceE6: bigint; tradingFeeBps: number; growth?: GrowthLaunch },
  derived: ReturnType<typeof deriveMarketParams>,
): InitMarketV17Args {
  // v2.2: InitMarket refuses more than 4 slots (error 14). Fail here, before a transaction is built, never on chain.
  const slots = marketAssetSlotsFor(params);
  if (slots > maxPortfolioAssets()) throw new Error(`InitMarket maxPortfolioAssets ${slots} exceeds the program cap of ${maxPortfolioAssets()}`);
  // Devnet v2.1: a growth block raises the fee cap to base + 600 and sets a funding ceiling; absent
  // (every launch today) the args are exactly what they were.
  return withGrowthInitArgs(baseV17InitMarketArgs(params, derived), params.growth);
}

function baseV17InitMarketArgs(
  params: { p3?: unknown; assetSlots?: number; initialPriceE6: bigint; tradingFeeBps: number },
  derived: ReturnType<typeof deriveMarketParams>,
): InitMarketV17Args {
  return {
    maxPortfolioAssets: marketAssetSlotsFor(params),
    hMin: "1000",
    hMax: "100000",
    initialPrice: params.initialPriceE6.toString(),
    minNonzeroMmReq: "1000000",
    minNonzeroImReq: "2000000",
    maintenanceMarginBps: String(derived.maintenanceMarginBps),
    initialMarginBps: BigInt(derived.initialMarginBps).toString(),
    maxTradingFeeBps: BigInt(params.tradingFeeBps).toString(),
    tradeFeeBaseBps: BigInt(params.tradingFeeBps).toString(),
    liquidationFeeBps: "50",
    liquidationFeeCap: "10000000000",
    minLiquidationAbs: "0",
    // Auto-derived from the creator's leverage — see lib/market-params.ts.
    // Was hardcoded 1 / 500, which froze new positions for ~17 min after a
    // 26% move (verified causally on devnet 2026-07-27).
    maxPriceMoveBpsPerSlot: String(derived.maxPriceMoveBpsPerSlot),
    maxAccrualDtSlots: String(derived.maxAccrualDtSlots),
    maxAbsFundingE9PerSlot: "0",
    minFundingLifetimeSlots: "500",
    maxAccountBSettlementChunks: "10",
    maxBankruptCloseChunks: "10",
    maxBankruptCloseLifetimeSlots: "500",
    publicBChunkAtoms: "1000000000000",
    maintenanceFeePerSlot: "0",
  };
}

/** Slab bytes the wizard will allocate (and rent) for a new launch. One slot for every launch. */
export function wizardSlabBytes(_p3?: boolean): number {
  return defaultSlabSize();
}
/** The slab size for the market `p` describes: always `v17MarketAccountLen(marketAssetSlotsFor(p))`, so the
 *  account and InitMarket's `maxPortfolioAssets` cannot disagree. */
export function slabSizeFor(p: { p3?: unknown; assetSlots?: number }): number {
  return marketAccountLen(marketAssetSlotsFor(p));
}

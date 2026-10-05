/**
 * Market sizing and InitMarket args shared by every create path (hooks/useCreateMarket.ts),
 * the wizard's rent display (components/create/*) and the P3 BPF sim bridge
 * (scripts/limits-parity/p3-app-ixs.ts `init-market`). Plain module: no React, no wallet.
 */
import { v17MarketAccountLen, type InitMarketV17Args } from "@percolatorct/sdk";
import type { deriveMarketParams } from "@/lib/market-params";
import { withGrowthInitArgs, type GrowthLaunch } from "@/lib/v21/growth-launch";

// v17: max assets per portfolio (= the market's asset-slot capacity); program cap = 14.
// The slab MUST be sized to exactly match this capacity or InitMarket reverts (dynamic-len validation).
export const V17_MAX_PORTFOLIO_ASSETS = 14;
// BUG 1 fix (2026-07-06): exported so callers (CreateMarketWizard, CostEstimate) size the
// slab + rent estimate against the actual v17 requirement instead of the stale v12.19
// tier.dataSize concept (96784/376432/1495024 bytes), which never equals this value for any
// tier and made every InitMarket revert with InvalidSlabLen while over-charging ~0.67 SOL rent.
export const DEFAULT_SLAB_SIZE = v17MarketAccountLen(V17_MAX_PORTFOLIO_ASSETS); // 33_900 bytes (cap-14; rust-p3-final.json marketAccountLen14)
/**
 * P3 (next FINAL, F14-Q2): a vault-owned-LP market is strictly SINGLE-asset. Tag 94 refuses any
 * market whose configured asset slots != 1 (VaultLpMultiAssetMarket, 86), so the P3 wizard
 * creates the market with maxPortfolioAssets = 1 and a slab sized for one asset. Legacy
 * (non-P3) launches keep 14.
 */
export const P3_MARKET_ASSET_SLOTS = 1;
export function marketAssetSlotsFor(p: { p3?: unknown }): number {
  return p.p3 ? P3_MARKET_ASSET_SLOTS : V17_MAX_PORTFOLIO_ASSETS;
}
/**
 * The InitMarket args every create path sends (fresh batch, sequential, recovery).
 * One builder so the paths cannot drift: `maxPortfolioAssets` is
 * `marketAssetSlotsFor(params)` = 1 on the P3 path (tag 94 refuses any other
 * slot count with 86 VaultLpMultiAssetMarket) and 14 on the legacy path. The
 * P3 BPF sim builds its market from this same function (bridge `init-market`).
 */
export function buildV17InitMarketArgs(
  params: { p3?: unknown; initialPriceE6: bigint; tradingFeeBps: number; growth?: GrowthLaunch },
  derived: ReturnType<typeof deriveMarketParams>,
): InitMarketV17Args {
  // Devnet v2.1: a growth block raises the fee cap to base + 600 and sets a funding ceiling; absent
  // (every launch today) the args are exactly what they were.
  return withGrowthInitArgs(baseV17InitMarketArgs(params, derived), params.growth);
}

function baseV17InitMarketArgs(
  params: { p3?: unknown; initialPriceE6: bigint; tradingFeeBps: number },
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

/** Slab bytes the wizard will allocate (and rent) for a P3 or legacy market. */
export function wizardSlabBytes(p3: boolean): number {
  return p3 ? v17MarketAccountLen(P3_MARKET_ASSET_SLOTS) : DEFAULT_SLAB_SIZE;
}
export function slabSizeFor(p: { p3?: unknown; slabDataSize?: number }): number {
  return p.p3 ? v17MarketAccountLen(P3_MARKET_ASSET_SLOTS) : (p.slabDataSize ?? DEFAULT_SLAB_SIZE);
}

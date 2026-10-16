/**
 * The cheapest token a Percolator market can be launched on at ALL.
 *
 * The create wizard blocks a launch whose opening price is under the trackable floor for the
 * chosen leverage (lib/initial-price.ts `minTrackablePriceE6`, mirroring the wrapper's
 * `clamp_toward_engine_dt`: the mark freezes when price x per-slot cap < 10,000 bps). Lower
 * leverage has a higher per-slot cap and so a LOWER floor, which makes the lowest leverage the
 * wizard offers (MIN_LEVERAGE_X, 2x) the most permissive: a token under THAT floor cannot get a
 * market at any leverage. Shared by the wizard (to suggest "try lower leverage" only when it can
 * help) and the trending list (to leave out tokens that cannot be launched).
 */
import { minTrackablePriceE6 } from "@/lib/initial-price";
import { MIN_LEVERAGE_X, deriveLaunchMarketParams } from "@/lib/market-params";

/** The trackable floor in USD at the lowest leverage the wizard offers. */
export function lowestLeverageTrackablePriceUsd(): number {
  const cap = deriveLaunchMarketParams({
    initialMarginBps: Math.ceil(10_000 / MIN_LEVERAGE_X),
    lpCollateral: 0n,
    initialPriceE6: 1_000_000n,
  }).maxPriceMoveBpsPerSlot;
  return Number(minTrackablePriceE6(cap)) / 1_000_000;
}

/**
 * Can a market be launched on a token at this USD price, at the lowest leverage? Also false under
 * the representable minimum ($0.000001, lib/initial-price MIN_REPRESENTABLE_PRICE), which the
 * trackable floor already exceeds. An unknown price is NOT launchable here: the caller decides
 * what a missing price means (the trending list fails closed).
 */
export function isLaunchablePriceUsd(priceUsd: number | null | undefined): boolean {
  if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) return false;
  return Math.round(priceUsd * 1_000_000) >= Math.round(lowestLeverageTrackablePriceUsd() * 1_000_000);
}

import type { DiscoveredMarket } from "@percolatorct/sdk";
import { resolveMarketPriceE6, sanitizePriceE6, applyInvert } from "@/lib/oraclePrice";
import { lotPriceToTokenE6 } from "@/lib/v22/lot";
import { markToTokenUsd } from "@/lib/v22/lot-view";

/** Resolve the display price (E6) for a discovered market, oracle-mode aware.
 *  v17 market group accounts carry no v12 config — the keeper-updated mark
 *  (configV17.markEwmaE6) is the price source, the same mapping SlabProvider
 *  uses for lastEffectivePriceE6 on v17 markets. Returns 0n when no on-chain
 *  price source exists (e.g. partial mock objects). */
export function resolveDiscoveredPriceE6(oc: DiscoveredMarket, lotExp: number | null = 0): bigint {
  // v2.2 (N1/F3): the on-chain mark is per LOT. `lotExp` 0 = no lots / flag off (identity); null = not known yet,
  // in which case there is NO price rather than a wrong one.
  if (lotExp === null) return 0n;
  if (oc.configV17) {
    return lotPriceToTokenE6(applyInvert(sanitizePriceE6(oc.configV17.markEwmaE6), oc.configV17.invert), lotExp);
  }
  if (!oc.config?.indexFeedId) return 0n;
  return resolveMarketPriceE6(oc.config);
}


/**
 * Per-token USD price of a discovered market WITHOUT the integer e6 floor of `resolveDiscoveredPriceE6`: a lot market
 * whose per-token price is below $0.000001 floors to 0n there and would read as "no oracle". null = no price (or
 * exponent unknown). At lotExp 0 it equals `Number(resolveDiscoveredPriceE6(..)) / 1e6`.
 */
export function resolveDiscoveredPriceUsd(oc: DiscoveredMarket, lotExp: number | null = 0): number | null {
  if (lotExp === null) return null;
  if (oc.configV17) {
    return markToTokenUsd(applyInvert(sanitizePriceE6(oc.configV17.markEwmaE6), oc.configV17.invert), lotExp);
  }
  const e6 = resolveDiscoveredPriceE6(oc, lotExp);
  return e6 > 0n ? Number(e6) / 1_000_000 : null;
}

import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { parseV17RiskParams } from "@/lib/v17-engine-config";
import { leverageFromMarginBps } from "@/lib/market-params";
import { isWrapperAccount } from "@/lib/v22/layout";

/**
 * Max leverage from the slab's REAL on-chain initial_margin_bps, via the same
 * shared function the list uses (lib/market-params.ts leverageFromMarginBps:
 * rounds only an exact launch round-trip, otherwise floors to 0.1x). null when
 * the engine-config region can't be read — the caller keeps whatever it had.
 *
 * The Supabase view's `max_leverage` column is a stored 10 for every market
 * (the indexer never derived it), so this route served 10x for a 6.5x market
 * while the list (loadMergedMarketRows) showed 6.5x — and the trade page's
 * OrderTicket / MarketStatsCard fallbacks read THIS route.
 */
export function maxLeverageFromSlab(data: Uint8Array): number | null {
  try {
    if (!isWrapperAccount(data)) return null;
    const cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);
    const risk = parseV17RiskParams(data, cfg.tradeFeeBps);
    if (!risk || risk.initialMarginBps <= 0n) return null;
    const lev = leverageFromMarginBps(Number(risk.initialMarginBps));
    return Number.isFinite(lev) && lev > 0 ? lev : null;
  } catch {
    return null;
  }
}

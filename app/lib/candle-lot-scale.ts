/**
 * Lot scale of one market for /api/candles (lib/indexer-db CandleLotScale): its lot_exp and a per-token anchor
 * price (the on-chain mark / 10^lot_exp). The candle SQL uses them to put rows written before the indexer knew
 * lot_exp (per-LOT prices) on the per-token scale of the newer rows. A failed read answers "no lots" (lotExp 0,
 * candles exactly as before) marked `unknown`: it is not cached here, and the route does not edge-cache it as
 * history, so one RPC blip cannot pin unnormalised bars.
 */
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { readCurrentWrapperSlab } from "@/lib/current-wrapper-slab";
import { lotExpOf } from "@/lib/v22/lot";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { markToTokenUsd } from "@/lib/v22/lot-view";
import type { CandleLotScale } from "@/lib/indexer-db";

const NO_LOTS: CandleLotScale = { lotExp: 0, anchor: null };
/** Same sanity ceiling as live-market-state (a garbage mark must not become the anchor). */
const MAX_SANE_PRICE_E6 = 1_000_000_000_000n;
/**
 * The anchor only has to be within 10^(lot_exp/2) (>= 3.16x) of the true price, so a minute-old mark is plenty.
 * Bounded so a scan of many slabs cannot grow it without limit.
 */
const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; scale: CandleLotScale }>();

/** Pure: lot scale from slab bytes. Exported for tests. */
export function candleLotScaleOf(data: Uint8Array): CandleLotScale {
  const lotExp = lotExpOf(data);
  if (lotExp === 0) return NO_LOTS;
  try {
    const e6 = parseWrapperConfigV17(data, V17_HEADER_LEN).markEwmaE6;
    const anchor = e6 > 0n && e6 < MAX_SANE_PRICE_E6 ? markToTokenUsd(e6, lotExp) : null;
    return anchor != null && anchor > 0 ? { lotExp, anchor } : NO_LOTS;
  } catch {
    return NO_LOTS;
  }
}

const UNKNOWN: CandleLotScale & { unknown: true } = { lotExp: 0, anchor: null, unknown: true };

export async function readCandleLotScale(slab: string, now = Date.now()): Promise<CandleLotScale & { unknown?: true }> {
  if (!isDevnetV22Enabled()) return NO_LOTS; // flag off: lotExpOf is always 0, so no RPC on the candle path
  const hit = cache.get(slab);
  if (hit && now - hit.at < TTL_MS) return hit.scale;
  let scale: CandleLotScale;
  try {
    const read = await readCurrentWrapperSlab(slab);
    if (read.ok) scale = candleLotScaleOf(read.data);
    else if (read.reason === "rpc") return UNKNOWN;
    else scale = NO_LOTS; // not a current-wrapper market: no lots to normalise
  } catch {
    return UNKNOWN;
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(slab, { at: now, scale });
  return scale;
}

/** Test hook. */
export function __clearCandleLotScaleCache(): void {
  cache.clear();
}

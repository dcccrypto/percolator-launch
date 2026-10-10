/**
 * Lot-aware READ model for display and API surfaces (companion to lib/v22/lot.ts, the one conversion module).
 *
 * Money values are LOT-INVARIANT: a position's notional is `q * mark_lot / POS_SCALE` where both factors are per lot,
 * so USD OI, PnL, margin and insurance coverage need no conversion. Only two things carry the lot and must be
 * converted at the display edge: the PRICE (per token = per lot / 10^k) and the SIZE (tokens = lots * 10^k).
 * lotExp 0 (no lots, v2.1, flag off) returns the inputs unchanged.
 */
import { POS_SCALE_V22, displayTokenPrice, lotPriceToTokenE6, qToTokenQ } from "./lot";

/** Per-lot e6 mark to a per-token USD number (null when the mark is unset). */
export function markToTokenUsd(markE6: bigint, lotExp: number): number | null {
  if (markE6 <= 0n) return null;
  return Number(markE6) / 1_000_000 / 10 ** lotExp;
}

export interface LotMarketNumbers {
  /** Per-token mark (null when unset). */
  priceUsd: number | null;
  /** OI in token-Q (POS_SCALE per token): what every consumer already divides by 1e6 to get whole tokens. */
  oiLong: number;
  oiShort: number;
  totalOi: number;
  /** Lot-invariant: engine Q x per-lot mark. */
  totalOiUsd: number;
}

export function lotMarketNumbers(i: { markE6: bigint; oiLongQ: bigint; oiShortQ: bigint }, lotExp: number): LotMarketNumbers {
  const priceUsd = markToTokenUsd(i.markE6, lotExp);
  const oiLong = Number(qToTokenQ(i.oiLongQ, lotExp));
  const oiShort = Number(qToTokenQ(i.oiShortQ, lotExp));
  const totalOi = oiLong + oiShort; // float sum, exactly the pre-lot expression at lotExp 0
  return {
    priceUsd,
    oiLong,
    oiShort,
    totalOi,
    // token-Q x per-token price == lots x per-lot price: lot-invariant.
    totalOiUsd: priceUsd != null ? (totalOi / Number(POS_SCALE_V22)) * priceUsd : 0,
  };
}

/** A position size in engine Q to the whole-token amount users see. */
export function qToDisplayTokens(q: bigint, lotExp: number): number {
  return Number(qToTokenQ(q < 0n ? -q : q, lotExp)) / Number(POS_SCALE_V22);
}

/** A per-lot mark to the exact per-token decimal string (charts, tooltips). */
export function formatMarkPerToken(markE6: bigint, lotExp: number): string {
  return displayTokenPrice(markE6, lotExp);
}

/** Per-lot e6 -> per-token e6 (rounded down) for APIs that must keep the e6 integer shape. */
export function markE6PerToken(markE6: bigint, lotExp: number): bigint {
  return lotPriceToTokenE6(markE6, lotExp);
}

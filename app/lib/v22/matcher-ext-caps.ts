/**
 * The ext-v3 caps the DEPLOYED wrapper hands the matcher on a growth leg, rebuilt from the growth view the app already reads (no extra RPC):
 * `(inventory_cap_q, liquidity_notional_e6)`. The matcher (release/v22-matcher 7d5aa26) prices the impact term on `min(ctx depth, this
 * liquidity)`; on a growth market the context's own depth is ~1e16, so the capital-derived liquidity is the one that binds and the spread
 * grows with order size: `impact = ceil(k * n / (D - n))`. See lib/limits/matcher-quote.ts and __tests__/lib/v22/spread-size-aware.test.ts.
 *
 * Port of `growth_matcher_caps` / `growth_matcher_caps_g8` (percolator-prog growth_v19.rs) in terms of the quote's own N_cap:
 *   closed (h-lock, no capacity)        -> (0, 0)
 *   otherwise cap = min(N_cap, engine position limit), liquidity = DEPTH_MULT x the capacity notional.
 * Capital-bound capacity (the usual case) is exact (`floor(C_m * lambda * 4 / 1e4)`); where the venue-depth cap binds the liquidity is
 * `4 x floor(N_cap x price / 1e6)`, which can only be at or below the program's (so the quoted spread is never under the charged one).
 */
import type { MatcherExtCaps } from "@/lib/limits/matcher-quote";
import type { GrowthMarketView } from "@/lib/v21/growth-market";
import { GROWTH_DEPTH_MULT, GROWTH_MAX_POSITION_ABS_Q, GROWTH_POS_SCALE, conservativeEquity, liquidityNotionalE6, nCapQ } from "@/lib/v22/sdk/records/growth-v19";

/** Null = the leg carries no caps (growth off for the asset): the matcher then prices on the context alone. */
export function matcherExtCapsFromGrowth(view: GrowthMarketView | null | undefined, priceE6: bigint): MatcherExtCaps | null {
  if (!view || !view.long.growthOn) return null;
  const closed: MatcherExtCaps = { inventoryCapQ: 0n, liquidityNotionalE6: 0n };
  if (view.hlockActive) return closed;
  const nCap = view.long.nCapQ;
  if (nCap === null || nCap <= 0n || priceE6 <= 0n) return closed;
  const cap = nCap > GROWTH_MAX_POSITION_ABS_Q ? GROWTH_MAX_POSITION_ABS_Q : nCap;
  const qi = view.quoteInput;
  const cM = conservativeEquity(qi.lpCapital, qi.lpPnl, qi.lpFeeCredits);
  const lam = view.long.lambdaEffBps ?? view.record.lambdaBps;
  const liqCapital = liquidityNotionalE6(cM, lam);
  const capitalCap = nCapQ(cM, lam, priceE6, GROWTH_POS_SCALE);
  const fromCap = ((nCap * priceE6) / GROWTH_POS_SCALE) * GROWTH_DEPTH_MULT;
  const liq = liqCapital !== null && capitalCap !== null && capitalCap === nCap ? liqCapital : liqCapital !== null && liqCapital < fromCap ? liqCapital : fromCap;
  return { inventoryCapQ: cap, liquidityNotionalE6: liq };
}

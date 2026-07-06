/**
 * Re-export trading math from @percolatorct/sdk for backward compatibility.
 * The canonical implementation lives in @percolatorct/sdk (math/trading).
 */
export {
  computeMarkPnl,
  computeLiqPrice,
  computePreTradeLiqPrice,
  computeTradingFee,
  computePnlPercent,
  computeEstimatedEntryPrice,
  computeFundingRateAnnualized,
  computeRequiredMargin,
  computeMaxLeverage,
} from "@percolatorct/sdk";
import { computeRequiredMargin as sdkComputeRequiredMargin } from "@percolatorct/sdk";

/**
 * Convert a `computeMarkPnl()` result into collateral-equivalent raw units.
 *
 * `computeMarkPnl` implements the on-chain "coin-margined" formula
 * (`diff * abs_pos / oracle` — see its own doc comment in the SDK): the
 * bigint it returns is scaled in the same native units as `positionSize`
 * itself, NOT already a collateral/USDC-denominated amount. For a
 * non-trivially-priced market (e.g. a $81 SOL-PERP) that native value is
 * off from the true collateral PnL by roughly a factor of the oracle price
 * — e.g. a real -$4.80 loss shows up as computeMarkPnl-native "-0.0592",
 * which is only correct once you multiply back by price.
 *
 * `ChartPnlBadge` already does this conversion (float `pnlTokens/10**dec *
 * priceUsd`) to show a correct dollar figure. This is the same conversion
 * expressed as pure BigInt math using the E6 oracle price directly (no
 * float `priceUsd` dependency, no precision loss), so every other consumer
 * — the positions row's PnL cell, its ROE%, its pool-cap comparison — can
 * share one properly-scaled number instead of re-deriving (or mis-using)
 * the raw native value.
 */
export function computeMarkPnlCollateral(pnlNative: bigint, oraclePriceE6: bigint): bigint {
  if (oraclePriceE6 <= 0n) return 0n;
  return (pnlNative * oraclePriceE6) / 1_000_000n;
}

/**
 * Initial margin an open position "locks", computed from the position's
 * OWN entry price and size — never a pending order's inputs. Reuses the
 * same notional-conversion pattern OrderTicket already uses for its
 * trading-fee receipt line (`positionSize * priceE6 / 1e6`) plus the SDK's
 * `computeRequiredMargin` (the same `notional * initialMarginBps / 10000`
 * basis behind every other margin/leverage figure this app shows), so a
 * losing/winning position's ROE is measured against what actually backs
 * it, and an order ticket can show how much of an account's capital is
 * already tied up by an open position on this market.
 */
export function computePositionInitialMargin(
  positionSize: bigint,
  entryPriceE6: bigint,
  initialMarginBps: bigint,
): bigint {
  if (positionSize === 0n || entryPriceE6 <= 0n) return 0n;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  const notional = (absPos * entryPriceE6) / 1_000_000n;
  return sdkComputeRequiredMargin(notional, initialMarginBps);
}

/**
 * Estimate an effective entry price when no on-chain or client-cached entry
 * price is available for a position.
 *
 * v17 doesn't store entry_price on-chain (same as v12.17 — see
 * useUserAccount's portfolioV17ToAccount), so the app normally recovers it
 * from a client-side cache saved at trade-open time (lib/entry-price.ts).
 * That cache is keyed to the browser that opened the trade, so it is NEVER
 * populated for a Position NFT received via transfer — the recipient's
 * browser never ran the trade. Naively substituting the current mark price
 * as "entry" makes the row look like the position has zero PnL (entry ==
 * mark), which then cascades into computeLiqPrice clamping to 0 ("N/A")
 * while a DIFFERENT, disconnected number is shown in the PnL column.
 *
 * Instead, invert the exact computeMarkPnl formula this app already trusts,
 * using the position's on-chain unrealized PnL as ground truth, to back out
 * the entry price implied by it. This keeps entry/liq/pnl/roe internally
 * self-consistent (computeMarkPnl(size, derivedEntry, mark) === onChainPnl)
 * instead of mixing an "entry == mark" placeholder with an unrelated PnL
 * figure. Falls back to `oraclePrice` (no distance travelled) when there's
 * no position or mark to work with, matching computeMarkPnl's own fallback.
 */
export function estimateEntryFromPnl(
  positionSize: bigint,
  onChainPnl: bigint,
  oraclePrice: bigint,
): bigint {
  if (positionSize === 0n || oraclePrice === 0n) return oraclePrice;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  // computeMarkPnl: pnl = diff * absPos / oraclePrice, where
  //   diff = oraclePrice - entry (longs) or entry - oraclePrice (shorts).
  // Invert: diff = onChainPnl * oraclePrice / absPos.
  const diff = (onChainPnl * oraclePrice) / absPos;
  const entry = positionSize > 0n ? oraclePrice - diff : oraclePrice + diff;
  return entry > 0n ? entry : oraclePrice;
}

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
import {
  computeRequiredMargin as sdkComputeRequiredMargin,
  computeMarkPnl,
  computePnlPercent,
} from "@percolatorct/sdk";

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
/**
 * Live-mark PnL + ROE% for one open position, given the CURRENT (possibly
 * WS-ticking) mark price. Extracted from three call sites that had
 * independently re-derived the exact same chain — the portfolio page's
 * `PositionCard`, `PositionsBar`'s `PositionChip`, and the portfolio hero's
 * live-total roll-up — so a fix to the math only needs to happen once.
 *
 * The chain is VERBATIM what `usePortfolio.ts`'s `buildV17Position` computes
 * with the POLLED oracle price, just re-run with a fresher mark:
 *   1. `computeMarkPnl` — the SDK's coin-margined formula. Its bigint result
 *      is scaled in NATIVE units (same scale as `positionSize`), NOT
 *      collateral/USD — see `computeMarkPnlCollateral`'s own doc comment.
 *   2. `computeMarkPnlCollateral` — converts that native PnL into
 *      collateral-scale raw units using the same mark price.
 *   3. ROE (`pnlPercent`) divides by the position's OWN locked initial
 *      margin (`computePositionInitialMargin`), not total account capital —
 *      capital can include collateral not backing this specific position.
 *      Falls back to `capitalFallback` (typically account capital) when the
 *      position has no computable initial margin (e.g. a flat/closed leg),
 *      then to `pnlPercentFallback` (typically the position's last-polled
 *      `pnlPercent`) if that's also unavailable.
 *
 * `entryPriceE6 <= 0n` / `markPriceE6 <= 0n` / a flat `positionSize` all fall
 * back to `unrealizedPnlFallback`/`pnlPercentFallback` (typically the
 * position's last-polled `unrealizedPnl`/`pnlPercent` from `usePortfolio`),
 * matching every call site's pre-extraction behavior exactly.
 */
export function computeLivePositionPnl(
  positionSize: bigint,
  entryPriceE6: bigint,
  markPriceE6: bigint,
  initialMarginBps: bigint,
  capitalFallback: bigint,
  unrealizedPnlFallback: bigint,
  pnlPercentFallback: number,
): { pnl: bigint; pnlPercent: number } {
  const pnl = (() => {
    if (positionSize === 0n || entryPriceE6 <= 0n || markPriceE6 <= 0n) return unrealizedPnlFallback;
    try {
      return computeMarkPnlCollateral(computeMarkPnl(positionSize, entryPriceE6, markPriceE6), markPriceE6);
    } catch {
      return unrealizedPnlFallback;
    }
  })();

  const pnlPercent = (() => {
    try {
      const initialMargin = computePositionInitialMargin(positionSize, entryPriceE6, initialMarginBps);
      if (initialMargin > 0n) return computePnlPercent(pnl, initialMargin);
      return capitalFallback > 0n ? computePnlPercent(pnl, capitalFallback) : pnlPercentFallback;
    } catch {
      return pnlPercentFallback;
    }
  })();

  return { pnl, pnlPercent };
}

export function estimateEntryFromPnl(
  positionSize: bigint,
  onChainPnl: bigint,
  oraclePrice: bigint,
): bigint {
  if (positionSize === 0n || oraclePrice === 0n) return oraclePrice;
  const absPos = positionSize < 0n ? -positionSize : positionSize;

  // `onChainPnl` is the portfolio's `pnl` field, which is COLLATERAL ATOMS —
  // not the coin-native value `computeMarkPnl` returns. Settled from the SDK
  // type (`capital`: "Collateral capital in atoms", `pnl`: "Unrealised P&L in
  // atoms" — the same unit) and, decisively, from the account layout: a
  // portfolio has 16 LEG slots each with its own `assetIndex`, but only ONE
  // scalar `pnl`. A single number summing P&L across several different assets
  // is only meaningful in a common unit, and coin-native cannot express it.
  //
  // So the relation to invert is the COLLATERAL one:
  //   pnl = absPos * (mark - entry) / 1e6        [long; sign flips for short]
  // giving
  //   (mark - entry) = pnl * 1e6 / absPos
  //
  // The previous formula inverted the coin-margined relation instead
  // (`diff = pnl * oraclePrice / absPos`), overstating `diff` by ~the price.
  // On a cache-miss (2nd device, cleared storage, NFT transfer) that produced:
  // a negative entry for winning longs (silently clamped back to mark, so
  // Entry showed as mark and PnL as $0), an absurd entry for losers (SOL @
  // $81.17 with a -$6.17 PnL rendered Entry $581.99 and PnL -$500.81), a liq
  // price above the mark on a long, and — worst — a `lockedMargin` computed
  // off that inflated entry that could exceed capital and zero out buying
  // power, locking the user out of trading a funded account.
  const diff = (onChainPnl * 1_000_000n) / absPos;
  const entry = positionSize > 0n ? oraclePrice - diff : oraclePrice + diff;
  return entry > 0n ? entry : oraclePrice;
}

/**
 * The slippage limit a matcher close (TradeCpi) is sent with on a v17/v18 market.
 *
 * Built from the engine's `effective_price` (AssetStateV16, decoded by
 * lib/limits/decode.ts) — the price the fill settles at and the matcher prices exec
 * from — never from the site feed. Left to useTrade, a close got a FEED-derived limit:
 * refused outright by the GH#2525 gate once feed and chain disagreed >2%, and even
 * ungated a short's close (buy at feed x 1.05) sat below the fill whenever the feed ran
 * low, so it reverted. Not markEwmaE6 either: the keeper mark can lead effective_price by
 * far more than the band during a catch-up. An explicit limit skips useTrade's feed gate,
 * which only guards feed-derived limits. A bad feed must never trap a user in a position.
 */
import { sanitizePriceE6 } from "@/lib/oraclePrice";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { UserFacingError } from "@/lib/errorMessages";
import type { MarketEngineView } from "@/lib/limits/decode";

/** Shown when the market price can't be read: no transaction was sent. */
export const CLOSE_PRICE_UNREADABLE = "Couldn't read the market price just now. Please try again.";

/**
 * Limit for a close of signed `closeSize` (>0 buy, <0 sell) around the engine's
 * effective price. Refuses (UserFacingError) rather than fall back to the feed when the
 * engine view is missing or its price is not sane — a feed-derived limit is exactly what
 * reverts or gets gated when the feed is off.
 */
export function closeLimitFromEngine(engine: Pick<MarketEngineView, "effectivePriceE6"> | null, closeSize: bigint): bigint {
  return limitFromEngine(engine, closeSize);
}

/**
 * The same limit for any signed size: a close, or an open (#3459, lib/open-limit.ts). Around the
 * engine's effective price, the price the matcher prices exec from and the trade settles at.
 */
export function limitFromEngine(engine: Pick<MarketEngineView, "effectivePriceE6"> | null, signedSize: bigint): bigint {
  const effectiveE6 = engine ? sanitizePriceE6(engine.effectivePriceE6) : 0n;
  if (effectiveE6 === 0n) throw new UserFacingError(CLOSE_PRICE_UNREADABLE);
  return computeLimitPriceE6({ markE6: effectiveE6, size: signedSize });
}

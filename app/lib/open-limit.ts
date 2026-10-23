/**
 * The worst-fill limit an OPEN from the order ticket is sent with (#3459).
 *
 * The ticket passes this limit explicitly (#2363: the number on the confirm screen is the number
 * sent), so useTrade's feed-vs-chain guard (#2538), which only guards a limit useTrade derives
 * itself, never ran for an open. A limit built from the site feed then meant nothing on chain:
 *
 *  - v17/v18: the wrapper checks the matcher's exec price, priced off the engine's
 *    `effective_price`, against the limit (`exec <= limit` for a buy). A feed reading a few %
 *    low failed every long with Custom(9) "slippage" while shorts went through; a feed reading
 *    high widened a long's band around a price the chain doesn't trade at. Built here from the
 *    engine's effective price instead, exactly like a close (lib/close-limit.ts, #2682); the
 *    feed is display only. No effective price: refuse (UserFacingError), never fall back to the
 *    feed.
 *  - legacy (no v17 wrapper config): the feed-derived limit, now actually checked against the
 *    on-chain reference with the same guard (FeedDisagreementError on > 200 bps). An unreadable
 *    reference keeps the guard's no-op.
 */
import type { MarketEngineView } from "@/lib/limits/decode";
import { limitFromEngine, CLOSE_PRICE_UNREADABLE } from "@/lib/close-limit";
import { assertFeedAgreesWithChain, computeLimitPriceE6 } from "@/lib/slippage";
import { UserFacingError } from "@/lib/errorMessages";

export function openLimitE6(a: {
  /** A v17/v18 market (the slab decoded a v17 wrapper config). */
  isV17: boolean;
  engine: Pick<MarketEngineView, "effectivePriceE6"> | null;
  /** The site feed's price, legacy markets only. */
  feedE6: bigint | null | undefined;
  /** The on-chain reference for the legacy guard; may throw or return 0 when unreadable. */
  onChainRefE6: () => bigint | null;
  /** Signed size: > 0 buy, < 0 sell. */
  size: bigint;
}): bigint {
  if (a.isV17) return limitFromEngine(a.engine, a.size);
  const feed = a.feedE6 ?? 0n;
  if (feed <= 0n) throw new UserFacingError(CLOSE_PRICE_UNREADABLE);
  let ref: bigint | null = null;
  try {
    const r = a.onChainRefE6();
    ref = r !== null && r > 0n ? r : null;
  } catch {
    ref = null;
  }
  assertFeedAgreesWithChain({ feedE6: feed, onChainE6: ref });
  return computeLimitPriceE6({ markE6: feed, size: a.size });
}

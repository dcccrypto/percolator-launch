/**
 * Slippage / limit-price helpers for the on-chain TradeCpi instruction.
 *
 * The on-chain handler treats `limit_price_e6 == 0` as an explicit "skip
 * slippage check" sentinel. Sending zero forfeits the protocol's documented
 * MEV/slippage protection (only the anti-off-market band — typically ~1% — is
 * left). User-initiated trades must compute a real limit from the live mark
 * price and a slippage tolerance.
 *
 * Direction is derived from the sign of `size`:
 *   - long  (size > 0): on-chain reverts if execution price > limit
 *                       → limit = mark * (1 + bps/10_000), rounded UP
 *   - short (size < 0): on-chain reverts if execution price < limit
 *                       → limit = mark * (1 - bps/10_000), rounded DOWN
 *
 * Rounding direction is chosen so a 1-unit truncation can only widen the
 * tolerance, never silently tighten it below the intended floor/ceiling.
 *
 * Both DEFAULT_SLIPPAGE_BPS and DEFAULT_SHORT_SLIPPAGE_BPS are 500 bps — see
 * the doc comment on DEFAULT_SHORT_SLIPPAGE_BPS for the devnet evidence behind
 * that number. They remain separate named exports (rather than a single
 * constant) so a future, market-specific re-tuning of one side doesn't
 * require touching every call site.
 */

/**
 * Default tolerance for the long/buy side (size > 0) when the caller doesn't
 * pass an explicit slippageBps.
 *
 * Originally 100 bps (matching the on-chain default anti-off-market band).
 * Devnet flow-testing (2026-07-01) found that was NOT a safe default once a
 * market has accumulated any real matcher inventory skew: a symmetric 100bps
 * long open on SLABS.JUP reliably failed on-chain with the generic
 * PercolatorError::InvalidInstruction (0x9) from `handle_trade_cpi`'s
 * post-fill check (`exec_price_e6 <= limit_price` for size_q>0,
 * v16_program.rs:7595-7602). Bisection (playground/debug-slippage-bisect-jup.ts)
 * showed 100 bps fails and 200+ bps clears — the same `skew_spread_mult_bps`
 * asymmetry documented for the short side below, just manifesting on the buy
 * side for this market's current inventory state. Since skew direction/
 * magnitude drifts with every trade, a bare 200bps minimum re-fails as soon as
 * skew grows further — so this was raised to match DEFAULT_SHORT_SLIPPAGE_BPS
 * (500 bps) rather than the empirically-observed minimum, for margin.
 */
export const DEFAULT_SLIPPAGE_BPS = 500n;
/**
 * Default tolerance for the short/sell side (size < 0) when the caller doesn't
 * pass an explicit slippageBps.
 *
 * Devnet flow-testing (2026-07-01) found that opening/adding a SHORT (and,
 * equivalently, closing a LONG — both are size<0 TradeCpi calls) reliably
 * fails on-chain with the generic PercolatorError::InvalidInstruction (0x9)
 * when limited to the symmetric 100 bps default, while the equivalent LONG
 * fill consistently lands within 100 bps. Bisection against a live devnet
 * passive matcher (kind=0) showed the short-side fill needs >200 bps and
 * <=500 bps of room to clear `handle_trade_cpi`'s post-fill check
 * (`exec_price_e6 >= limit_price` for size_q<0, v16_program.rs:7595-7602).
 * The likely structural cause is `skew_spread_mult_bps` in the matcher
 * (percolator-match/src/vamm.rs: "extra_bps = |inventory| * skew_spread_mult_bps
 * / 10_000") — an inventory-skew spread widener that is not symmetric between
 * the buy and sell sides for a given LP inventory state (and, per the long-side
 * finding above, can bite either direction depending on which way the book is
 * skewed at trade time). 500 bps is used here as an empirically-verified safe
 * default; it only applies when the caller omits slippageBps, so any call site
 * that wants a tighter/explicit tolerance (or the historical symmetric 100 bps)
 * is unaffected.
 */
export const DEFAULT_SHORT_SLIPPAGE_BPS = 500n;
export const MAX_SLIPPAGE_BPS = 10_000n;

export class SlippageError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SlippageError";
  }
}

export interface ComputeLimitArgs {
  markE6: bigint;
  size: bigint;
  slippageBps?: bigint;
}

/**
 * Maximum the off-chain feed may deviate from the ON-CHAIN oracle before its
 * value is refused as a basis for the slippage limit.
 *
 * PLAYGROUND.md documents the intended gap: the UI ticks off Pyth while trades
 * settle at the AuthMark, and the two sit ~0.1% apart. 2% is twenty times that,
 * so an honest feed never touches this bound.
 */
export const MAX_FEED_DEVIATION_BPS = 200n;

/**
 * GH#2525 (item 1): bound the off-chain mark against the on-chain oracle.
 *
 * `computeLimitPriceE6` derives `limit_price_e6` — the BINDING on-chain slippage
 * constraint — from `livePriceE6`, which comes from the unauthenticated WS feed,
 * then a REST `last_price` fallback, then an on-chain seed. The only sanitisation
 * was an ABSOLUTE band (reject <= 0, reject > $1,000,000), with nothing relative
 * to the oracle the trade actually settles against.
 *
 * That made the client-side guard worth almost nothing: a feed biased high
 * widens the band an adversarial matcher or LP can fill inside, and the "worst
 * fill price" shown to the user is only as honest as the feed. The user believes
 * they set a 0.5% limit; the limit is 0.5% around a number someone else chose.
 *
 * So the feed is now checked against the on-chain price before it is trusted:
 *
 *   within  MAX_FEED_DEVIATION_BPS  -> use the feed. It is fresher, and the small
 *                                      documented Pyth/AuthMark gap is real signal.
 *   beyond  it                      -> REFUSE, rather than clamp.
 *
 * Refusing rather than clamping is the deliberate choice. Clamping would silently
 * hand the user a limit computed from a different price than the one the UI quoted
 * them, which is its own trust problem — the number on the confirm screen would
 * stop matching the number in the transaction. A 2% disagreement between the feed
 * and the chain means something is wrong; the honest response is to stop and say
 * so, not to paper over it and trade anyway.
 *
 * This is defence in depth, not an independent exploit fix: it only bites if the
 * off-chain feed can be influenced, which is the separately-tracked oracle-keeper
 * price-integrity class. What it removes is the property that a bad feed silently
 * degrades a protection the user thinks they have.
 */
export function assertFeedAgreesWithChain(args: {
  /** The off-chain feed price the limit would be derived from. */
  feedE6: bigint;
  /**
   * The on-chain reference — the price the trade settles against. Pass `null`
   * when it genuinely could not be read; the check then no-ops rather than
   * blocking every trade, because failing closed here would take the whole app
   * down on an RPC hiccup for a defence-in-depth guard.
   */
  onChainE6: bigint | null;
}): void {
  const { feedE6, onChainE6 } = args;
  if (onChainE6 === null || onChainE6 <= 0n || feedE6 <= 0n) return;

  const diff = feedE6 > onChainE6 ? feedE6 - onChainE6 : onChainE6 - feedE6;
  const deviationBps = (diff * 10_000n) / onChainE6;
  if (deviationBps <= MAX_FEED_DEVIATION_BPS) return;

  throw new SlippageError(
    `Price feed disagrees with the on-chain oracle by ${deviationBps} bps ` +
      `(limit is ${MAX_FEED_DEVIATION_BPS}). Refusing to derive a slippage limit ` +
      `from it — the limit would not mean what the screen says. Wait for the feed ` +
      `to reconverge, or set an explicit limit price.`,
  );
}

export function computeLimitPriceE6(args: ComputeLimitArgs): bigint {
  const { markE6, size } = args;
  const slippageBps =
    args.slippageBps ?? (size < 0n ? DEFAULT_SHORT_SLIPPAGE_BPS : DEFAULT_SLIPPAGE_BPS);

  if (markE6 <= 0n) {
    throw new SlippageError(
      "Cannot compute slippage limit: live mark price unavailable. Wait for the oracle to load, then retry.",
    );
  }
  if (size === 0n) {
    throw new SlippageError("Cannot compute slippage limit: trade size is zero.");
  }
  if (slippageBps < 0n || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new SlippageError(`Slippage bps out of range: ${slippageBps}`);
  }

  const BPS_DENOM = 10_000n;
  let limit: bigint;
  if (size > 0n) {
    const numer = markE6 * (BPS_DENOM + slippageBps);
    limit = (numer + BPS_DENOM - 1n) / BPS_DENOM;
  } else {
    const numer = markE6 * (BPS_DENOM - slippageBps);
    limit = numer / BPS_DENOM;
  }
  // Floor guard: a very small markE6 combined with a large short-side
  // slippage can truncate to 0, which is the on-chain disable sentinel.
  // Clamp to 1n so the slippage check is always actually enforced.
  return limit > 0n ? limit : 1n;
}

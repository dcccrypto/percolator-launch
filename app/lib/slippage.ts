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
 * `DEFAULT_SLIPPAGE_BPS = 100` matches the on-chain default band
 * (max(2 * trading_fee_bps, 100) bps for typical markets), so the off-chain
 * limit becomes the binding constraint in the common case.
 */

export const DEFAULT_SLIPPAGE_BPS = 100n;
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

export function computeLimitPriceE6(args: ComputeLimitArgs): bigint {
  const { markE6, size } = args;
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

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

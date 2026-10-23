/**
 * Resolving a market's opening price, and saying why when we can't.
 *
 * The create wizard blocks launch behind `oraclePriceValid`, whose failure
 * message is always "Waiting on price feed". That message was wrong in two
 * different ways, and both of them stranded the user on a spinner with no way
 * forward:
 *
 * 1. THE PRICE RESOLVED, BUT TOO SMALL TO REPRESENT. `initialPriceE6` reaches
 *    the chain as a raw E6 integer with no decimal scaling, so the smallest
 *    non-zero price a market can carry is 1e-6 USD. A token trading below
 *    5e-7 — routine for pump.fun memecoins — rounds to 0, fails the non-zero
 *    gate, and reports a feed problem even though the feed answered correctly.
 *    Nothing the user waits for can ever fix that.
 *
 * 2. A GOOD PRICE WAS OVERWRITTEN WITH NOTHING. Two independent sources feed
 *    this: `/api/oracle/resolve/[mint]` (the wizard's `adminPrice`) and the
 *    DEX pool scan (`config.initialPrice`). `adminPrice` can be null while the
 *    pool price is perfectly good, and the wizard then assigned the null over
 *    it. The route reaches that state two ways: a non-ok response or timeout
 *    (the common one), and a 200 carrying `price: 0`, which is reachable only
 *    for the hardcoded MINT_TO_PYTH mints — everything else 404s when no
 *    source has a price. The 200 case is also cached for 5 minutes, so for
 *    those mints it is sticky rather than intermittent.
 *
 * Hence two exported pieces: one that merges the sources without ever
 * downgrading to nothing, and one that converts to E6 while distinguishing
 * "no price yet" from "this price cannot be represented".
 */

/** The smallest non-zero price an E6 market can carry: 0.000001 USD. */
export const MIN_REPRESENTABLE_PRICE = 1e-6;
/**
 * The largest price the protocol accepts: MAX_PRICE_E6 ($1,000,000) from
 * lib/oraclePrice.ts. Above it `sanitizePriceE6` returns 0n and every readout
 * renders "$—", and the keeper-cosign route 400s mid-launch. Bounding it here
 * means one helper answers "can this price be used", not just half of it.
 */
export const MAX_REPRESENTABLE_PRICE = 1_000_000;

export type InitialPriceE6 =
  | { ok: true; e6: bigint }
  /** No usable price yet — waiting on a feed is the correct thing to show. */
  | { ok: false; reason: "missing" }
  /** A real price arrived, but it is below what an E6 market can express. */
  | { ok: false; reason: "below-minimum"; price: number }
  /** A real price arrived, but it is above what the protocol will accept. */
  | { ok: false; reason: "above-maximum"; price: number }
  /**
   * Representable, but so small that the mark could not move once positions
   * are open (see `minTrackablePriceE6`). `minPrice` is the floor in USD.
   */
  | { ok: false; reason: "below-trackable"; price: number; minPrice: number };

/**
 * Merge the available price sources without ever losing a known price.
 *
 * Order note: the two sources are NOT the same pool. `/api/oracle/resolve`
 * takes the most liquid Solana pair with no supported-DEX filter and no
 * liquidity floor, while the pool scan requires a supported DEX and >= $100
 * liquidity — and it is the POOL's address the keeper is registered against
 * (`dexPoolAddress: wizard.dexPool?.poolAddress`), so the pool price is the
 * one the keeper will actually push. It therefore wins, with the resolve price
 * as the fallback for tokens the pool scan filtered out.
 *
 * What matters more than the order: a later null NEVER downgrades an earlier
 * value. That is the whole point.
 *
 * CALLER CONTRACT: `previous` must belong to the SAME token. Keeping a price
 * across a token change would let one asset's market launch at another's
 * price, which permanently mis-sizes the LP caps — so the wizard clears it in
 * `setMintAddress`.
 */
export function pickInitialPrice(
  previous: string | null | undefined,
  fromOracle: string | null | undefined,
  fromPool?: string | null | undefined,
): string | null {
  return usable(fromPool) ?? usable(fromOracle) ?? usable(previous) ?? null;
}

function usable(v: string | null | undefined): string | null {
  if (v == null || v === "") return null;
  const n = Number.parseFloat(v);
  // "0.000000" is what a sub-micro price becomes after a 6-dp format. It is
  // not a price, and must not win over a source that still holds the real one.
  return Number.isFinite(n) && n > 0 ? v : null;
}

/**
 * Convert a resolved price to the E6 integer the market is created with,
 * reporting WHY when it cannot be done rather than collapsing to zero.
 */
export function toInitialPriceE6(price: string | null | undefined): InitialPriceE6 {
  if (price == null || price === "") return { ok: false, reason: "missing" };
  const n = Number.parseFloat(price);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "missing" };
  if (n < MIN_REPRESENTABLE_PRICE) return { ok: false, reason: "below-minimum", price: n };
  if (n > MAX_REPRESENTABLE_PRICE) return { ok: false, reason: "above-maximum", price: n };
  return { ok: true, e6: BigInt(Math.round(n * 1_000_000)) };
}

/** A decimal price, plain or exponent form (what `String(number)` produces for small prices, e.g. "1.5e-7"). */
const DECIMAL_PRICE = /^\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * `round-half-up(price * 10^scale)`, computed EXACTLY from the price's decimal digits (no float maths), or null when the
 * string is not a positive finite price. Parsing accepts what `toInitialPriceE6` accepts (`Number.parseFloat` semantics):
 * a string with trailing junk is read as the number `parseFloat` gives.
 *
 * #3610: a v2.2 lot market prices 10^lotExp tokens, so its InitMarket price is `price * 10^(6 + lotExp)`. Rounding the
 * per-token price to a whole e6 first multiplied the rounding error by 10^lotExp (up to a third of the price for a
 * $0.000001-$0.00001 token). This rounds once, at the scale the caller sends.
 */
export function decimalPriceToScaled(price: string | null | undefined, scale: number): bigint | null {
  if (price == null || !Number.isInteger(scale) || scale < 0) return null;
  const n = Number.parseFloat(price);
  if (!Number.isFinite(n) || n <= 0) return null;
  const m = DECIMAL_PRICE.exec(price.trim()) ?? DECIMAL_PRICE.exec(String(n));
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  const frac = m[2] ?? "";
  const digits = BigInt(`${m[1]}${frac}` || "0");
  const shift = Number(m[3] ?? "0") - frac.length + scale;
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const d = 10n ** BigInt(-shift);
  const q = digits / d;
  return 2n * (digits % d) >= d ? q + 1n : q;
}

/**
 * Format a price for carrying between the hooks and the wizard.
 *
 * NOT `toFixed(6)`: that silently turns every price below 5e-7 into the string
 * "0.000000", which is indistinguishable from "no price" downstream and is
 * exactly how a working feed got reported as a missing one. Keeping full
 * precision lets `toInitialPriceE6` tell the user the real reason.
 */
export function formatResolvedPrice(price: number): string | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  return String(price);
}

/**
 * The smallest opening price (E6) whose mark can still move once the market
 * has open interest.
 *
 * Deployed rule (wrapper 553d76f0 `oracle_v16::clamp_toward_engine_dt`, and
 * the engine's `canonical_accrual_price_step_v16`, whose bps remainder resets
 * whenever the target changes, i.e. on every keeper push): while OI exists,
 * each accrual moves the effective price by at most
 *
 *     floor(p_last * max_price_move_bps_per_slot * dt_slots / 10_000)
 *
 * Accruals can land one slot apart (any crank or trade accrues), so with
 * dt = 1 the step is 0 whenever p_last * cap < 10_000: the mark freezes, the
 * position marks stop following the market, and nothing can be liquidated.
 * The smallest price that always moves is therefore ceil(10_000 / cap), e.g.
 * 2,500 ($0.0025) at the 4 bps cap a 10x market gets, 667 at 15 bps (2.5x).
 */
export function minTrackablePriceE6(maxPriceMoveBpsPerSlot: number): bigint {
  if (!Number.isFinite(maxPriceMoveBpsPerSlot) || maxPriceMoveBpsPerSlot <= 0) return 0n;
  const cap = BigInt(Math.floor(maxPriceMoveBpsPerSlot));
  if (cap <= 0n) return 0n;
  return (10_000n + cap - 1n) / cap;
}

/**
 * Apply the trackable floor to a resolved price. Pass the
 * `maxPriceMoveBpsPerSlot` the market will actually be created with (it
 * depends on the chosen leverage), so the floor matches what InitMarket sets.
 * `lotExp` (devnet v2.2): the market prices a LOT of 10^lotExp tokens, so the
 * mark that must move is the per-lot price; the floor is checked on that. The
 * result stays per token (`minPrice` too), as the wizard shows it.
 */
export function withTrackableFloor(
  resolved: InitialPriceE6,
  maxPriceMoveBpsPerSlot: number,
  lotExp = 0,
): InitialPriceE6 {
  if (!resolved.ok) return resolved;
  const min = minTrackablePriceE6(maxPriceMoveBpsPerSlot);
  const lot = 10n ** BigInt(Math.max(0, Math.floor(lotExp)));
  if (resolved.e6 * lot >= min) return resolved;
  return {
    ok: false,
    reason: "below-trackable",
    price: Number(resolved.e6) / 1_000_000,
    minPrice: Number(min) / Number(lot) / 1_000_000,
  };
}

/**
 * LOCAL PORT of percolator-sdk feat/v22-sdk @ bd79448 `src/abi/v22-trade-fee.ts` (QA Q-1), pure part verbatim:
 * `matcherFeeWorstCaseBpsV22`, `computeTradeFeeBpsToSignV22` and their constants. Not a repin: the app stays on
 * `@percolatorct/sdk` 8.0.0 + the ports in this directory. The SDK's raw reader (`readTradeFeeInputsV22`) uses 9.0 layout
 * helpers, so the app reads the same inputs with its own decoders (lib/limits/trade-fee-resolve.ts `readTradeFeeInputsApp`).
 * Only change vs the source: the two constants it imported are inlined below (values from the same commit).
 */
/*
 * Q-1 (2026-10-11): the max fee (`fee_bps`) a taker signs on a matcher trade (TradeCpi tag 10).
 *
 * The wrapper (percolator-prog RC 6c078a0e, `handle_trade_cpi`) refuses with Custom(9) when:
 *   1. `fee_bps < trade_fee_base_bps`                                (taker consent below the base fee)
 *   2. `max(fee_bps, base) > max_trading_fee_bps`                    (above the market maximum)
 *   3. `base + requested > fee_bps` or `> max_trading_fee_bps`, or
 *      `requested > max_requested_fee_bps`                           (`requested_fee_permitted`)
 * and with Custom(98) when an open above the utilisation kink adds a utilisation fee
 * (`base + requested + util > fee_bps`). `requested` is the matcher's quote as a fee
 * (percolator-match 2b08537a `v2::requested_fee_bps`: ceil(|exec - oracle| * 1e4 / oracle), at most
 * 1023), which the wrapper only accepts when the asset's `matcher_ext_mode == 1` and its
 * `max_requested_fee_bps != 0`. The matcher's total spread is clipped to its context's
 * `max_total_bps` (at most 9000), so its request never exceeds `max_total_bps + 1` (rounding).
 *
 * Signing only the base fee therefore fails every fill that carries a matcher fee (QA Q-1: JUP base 30,
 * fills request ~23; a cap of 50 fails, 55 lands, above 500 fails). The fee signed is a ceiling: the
 * taker is charged base + the actual request, not the ceiling.
 */

/** percolator-match 2b08537a `REQUESTED_FEE_BPS_MAX` (10-bit field). SDK: matcher-v2.ts `MATCHER_REQUESTED_FEE_BPS_MAX`. */
const MATCHER_REQUESTED_FEE_BPS_MAX = 1023;
/** P1 `matcher_ext_mode` v1. SDK: risk-limits-p1.ts `MATCHER_EXT_MODE_V1_P1`. */
const MATCHER_EXT_MODE_V1_P1 = 1;

/** Offset of `max_trading_fee_bps` (u64) inside the engine `V16ConfigAccount` (engine 3ce4cbd1, packed Pod). */
export const ENGINE_CONFIG_MAX_TRADING_FEE_BPS_OFF = 70;
/** Offset of `max_total_bps` (u32) inside the matcher context's vAMM block (percolator-match `MatcherCtx`). */
export const MATCHER_CTX_MAX_TOTAL_BPS_OFF = 56;
/** The matcher clips its total spread at min(max_total_bps, 9000) (`quote_adaptive`). */
export const MATCHER_MAX_TOTAL_BPS_CEILING = 9_000;
/** Default safety margin (bps) added above base + matcher fee, still bounded by the market maximum. */
export const TRADE_FEE_MARGIN_BPS_DEFAULT = 5;

/** On-chain inputs for {@link computeTradeFeeBpsToSignV22}. */
export interface TradeFeeInputsV22 {
  /** Wrapper config `trade_fee_base_bps`. */
  tradeFeeBaseBps: bigint;
  /** Engine config `max_trading_fee_bps` (the program's maximum for any signed fee). */
  maxTradingFeeBps: bigint;
  /** Asset's P1 `max_requested_fee_bps` (0 = the matcher fee channel is off). */
  maxRequestedFeeBps: number;
  /** Asset's P1 `matcher_ext_mode` (the channel needs 1). Omitted = treated as 1. */
  matcherExtMode?: number;
  /** Matcher context `max_total_bps`, when known (tightens the worst-case request). */
  matcherMaxTotalBps?: number;
}

/** Options for {@link computeTradeFeeBpsToSignV22}. */
export interface TradeFeeOptionsV22 {
  /**
   * The matcher fee from a fresh quote (bps). When given, the signed fee is base + this + margin instead of
   * the worst case; a fill that requests more than that then fails with 9, so keep a margin.
   */
  expectedMatcherFeeBps?: number;
  /** Utilisation fee (bps) for an open above the kink (growth assets; see previewGrowthOpenFee). */
  utilFeeBps?: number;
  /** Margin above base + matcher fee (+ util). Default {@link TRADE_FEE_MARGIN_BPS_DEFAULT}. */
  marginBps?: number;
}

/** Result of {@link computeTradeFeeBpsToSignV22}. */
export interface TradeFeeToSignV22 {
  /** The `fee_bps` to sign: min(base + matcher fee + util + margin, maxFeeBps). */
  feeBps: bigint;
  /** Lowest admissible signature (the base fee); below it the program returns 9. */
  minFeeBps: bigint;
  /** The program's maximum (`max_trading_fee_bps`); above it the program returns 9. */
  maxFeeBps: bigint;
  /** Largest matcher fee the program can accept on this asset (0 when the channel is off). */
  matcherFeeWorstCaseBps: number;
  /** base + worst-case matcher fee + util: the fee that admits every fill the program can accept. */
  worstCaseFeeBps: bigint;
  /** True when `feeBps` covers `worstCaseFeeBps` (no fill can fail on the fee cap). */
  coversWorstCase: boolean;
}

function nonNegInt(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer, got ${v}`);
  return v;
}

/**
 * The largest matcher fee (bps) the wrapper can accept for this asset.
 *
 * @param i  Inputs (see {@link TradeFeeInputsV22}).
 * @returns 0 when the fee channel is off, else min(max_requested_fee_bps, matcher max_total_bps + 1, 1023).
 * @example
 * ```ts
 * matcherFeeWorstCaseBpsV22({ tradeFeeBaseBps: 30n, maxTradingFeeBps: 500n, maxRequestedFeeBps: 100, matcherMaxTotalBps: 60 }); // 61
 * ```
 */
export function matcherFeeWorstCaseBpsV22(i: TradeFeeInputsV22): number {
  const maxReq = nonNegInt("maxRequestedFeeBps", i.maxRequestedFeeBps);
  const ext = i.matcherExtMode ?? MATCHER_EXT_MODE_V1_P1;
  if (maxReq === 0 || ext !== MATCHER_EXT_MODE_V1_P1) return 0;
  let worst = Math.min(maxReq, MATCHER_REQUESTED_FEE_BPS_MAX);
  if (i.matcherMaxTotalBps !== undefined) {
    const total = Math.min(nonNegInt("matcherMaxTotalBps", i.matcherMaxTotalBps), MATCHER_MAX_TOTAL_BPS_CEILING);
    worst = Math.min(worst, total + 1);
  }
  return worst;
}

/**
 * Compute the max fee (`fee_bps`) to sign on a matcher trade so the program does not refuse it with
 * Custom(9): base fee + the matcher's fee (+ utilisation fee) + a margin, bounded by the market's
 * `max_trading_fee_bps`. Apps should use this instead of signing the base fee alone.
 *
 * @param i     On-chain inputs (read them with {@link readTradeFeeInputsV22}).
 * @param opts  Optional quote-based matcher fee, utilisation fee and margin.
 * @returns The fee to sign and its bounds.
 * @throws If the market's base fee exceeds its maximum (no signature can pass).
 * @example
 * ```ts
 * const inputs = readTradeFeeInputsV22(marketInfo.data, 0, matcherCtxInfo.data);
 * const { feeBps } = computeTradeFeeBpsToSignV22(inputs);
 * const data = encodeTradeCpi({ ...args, feeBps });
 * ```
 */
export function computeTradeFeeBpsToSignV22(i: TradeFeeInputsV22, opts: TradeFeeOptionsV22 = {}): TradeFeeToSignV22 {
  const base = i.tradeFeeBaseBps;
  const max = i.maxTradingFeeBps;
  if (base < 0n || max < 0n) throw new Error("fee bps must be non-negative");
  if (base > max) {
    throw new Error(`market trade_fee_base_bps ${base} exceeds max_trading_fee_bps ${max}: every trade is refused (Custom 9)`);
  }
  const worstMatcher = matcherFeeWorstCaseBpsV22(i);
  const util = BigInt(nonNegInt("utilFeeBps", opts.utilFeeBps ?? 0));
  const margin = BigInt(nonNegInt("marginBps", opts.marginBps ?? TRADE_FEE_MARGIN_BPS_DEFAULT));
  const matcher = opts.expectedMatcherFeeBps === undefined
    ? worstMatcher
    : Math.min(nonNegInt("expectedMatcherFeeBps", opts.expectedMatcherFeeBps), worstMatcher);
  const want = base + BigInt(matcher) + util + margin;
  const feeBps = want < max ? want : max;
  const worstCaseFeeBps = base + BigInt(worstMatcher) + util;
  return {
    feeBps,
    minFeeBps: base,
    maxFeeBps: max,
    matcherFeeWorstCaseBps: worstMatcher,
    worstCaseFeeBps,
    coversWorstCase: feeBps >= worstCaseFeeBps,
  };
}

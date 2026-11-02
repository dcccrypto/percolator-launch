/**
 * v2.2 Band Safety Law pre-check: a pure mirror of what InitMarket validates for the rent and band
 * blocks, so a launch the program would refuse (105 / 106) is caught before it is sent.
 *
 * This file has NO imports so the app and the seed kit can vendor an exact byte-for-byte copy (the
 * sha256 is pinned in `test/v22-band-safety-law.test.ts` and in the consumers' parity tests).
 *
 * Program sources mirrored (wrapper percolator-prog rc23 34996503, engine 2f05df8c):
 * - wrapper `init_market_apply_phase4_view` (v16_program.rs:17413-17478): the rent block, the band
 *   block, and (prog #647, rc23 34996503) the occupancy rule: on a band market with rent, the law must
 *   also hold with `rent_max x OCC_BSL_RENT_MULTIPLE` (5), else 106. bbaa0e7b has no such rule.
 * - engine `V16Config::validate_public_user_fund` (v16.rs:5553-5657): the band/rent shape, the §1.6
 *   exact solvency envelope, and the Band Safety Law (`validate_band_safety_law`, v16.rs:5376).
 *
 * The law, for every risk notional `N` in `1..=MAX_ACCOUNT_NOTIONAL` (exact, with the engine's
 * ceilings), for both (P, T) = (max_price_move x max_accrual_dt, max_accrual_dt) and, on a band
 * market, (P, T) = (G(d), 2E):
 *
 *   ceil(N x (P x 1e9 + R x T x 1e4) / 1e13)
 *     + min(max(ceil(ceil(N x (1e4 + P) / 1e4) x liq_bps / 1e4), min_liq_abs), liq_cap)
 *   <= max(ceil(N x MMR / 1e4), min_nonzero_mm_req)
 *
 * with `R = max_abs_funding_e9_per_slot + rent_max_e9_per_slot x k` (k = 1, and on a band market with
 * rent also k = 5 on rc23 34996503) and `G(d) = ceil((1e4 + d)^2 / (1e4 - d)) - 1e4`.
 *
 * Mainnet-only rules (a growth market must carry a rent block with both fields > 0, and a
 * single-asset growth market a band block) are out of scope: v2.2 runs on devnet builds.
 *
 * @module
 */

/** Engine `band_rent::MAX_RENT_E9_PER_SLOT`. */
export const BSL_MAX_RENT_E9_PER_SLOT = 10_000n;
/** Wrapper `growth_v19::RENT_MIN_E9_PER_SLOT`: a non-zero rent ceiling is at least this. */
export const BSL_RENT_MIN_E9_PER_SLOT = 10n;
/** Wrapper `growth_v19::RENT_MAX_KINK_BPS`: the kink of a non-zero rent is at most this. */
export const BSL_RENT_MAX_KINK_BPS = 8_000n;
/** Engine `band_rent::MAX_BAND_BPS`. */
export const BSL_MAX_BAND_BPS = 2_000n;
/** Engine `band_rent::BAND_MIN_EPOCH_SLOTS`. */
export const BSL_BAND_MIN_EPOCH_SLOTS = 150n;
/** Engine `band_rent::BAND_MIN_PIN_EPOCHS`: `Pmax >= 8 x E`. */
export const BSL_BAND_MIN_PIN_EPOCHS = 8n;
/**
 * Wrapper `growth_v19::OCC_BSL_RENT_MULTIPLE` on rc23 34996503 (prog #647): utilisation rent plus the
 * per-slot occupancy charge of a minimum leg (`4 x rent_max`). Pass `1n` for a program without #647
 * (bbaa0e7b), or whatever multiple the per-notional rework (prog #572 follow-up) ships.
 */
export const BSL_OCCUPANCY_RENT_MULTIPLE_RC23 = 5n;

const BPS = 10_000n;
const FUNDING_DEN = 1_000_000_000n;
const ADL_ONE = 1_000_000_000_000_000n;
const MAX_ORACLE_PRICE = 1_000_000_000_000n;
const MAX_ACCOUNT_NOTIONAL = 100_000_000_000_000_000_000n;
const MAX_MARGIN_BPS = 10_000n;
const MAX_PROTOCOL_FEE_ABS = 1_000_000_000_000_000_000_000_000_000_000_000_000n;
const MAX_ABS_FUNDING_E9_PER_SLOT = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I128_MAX = (1n << 127n) - 1n;
const MAX_SOLVENCY_INTERVALS = 96;
const MAX_SOLVENCY_STEPS = 4096;
const EXACT_CHUNK = 64n;

/** The InitMarket fields the law reads (u64 / u128 as bigint, as the program sees them). */
export interface BandSafetyLawInputV22 {
  /** InitMarket `max_portfolio_assets`; a band market must be 1. */
  maxPortfolioAssets: number;
  maintenanceMarginBps: bigint;
  initialMarginBps: bigint;
  liquidationFeeBps: bigint;
  liquidationFeeCap: bigint;
  minLiquidationAbs: bigint;
  minNonzeroMmReq: bigint;
  minNonzeroImReq: bigint;
  maxPriceMoveBpsPerSlot: bigint;
  maxAccrualDtSlots: bigint;
  maxAbsFundingE9PerSlot: bigint;
  minFundingLifetimeSlots: bigint;
  /** The trailer's rent block (absent = no rent block). */
  rent?: { rentMaxE9PerSlot: number; rentKinkBps: number };
  /** The trailer's band block (absent or `bandBps` 0 = no band). */
  band?: { bandBps: number; bandMaxEpochSlots: number; bandMaxPinSlots: number; bandMinLegNotional: bigint };
}

/** Options of {@link checkBandSafetyLawV22}. */
export interface BandSafetyLawOptionsV22 {
  /**
   * The occupancy multiple of the program being targeted: {@link BSL_OCCUPANCY_RENT_MULTIPLE_RC23} (5, rc23
   * 34996503, the default) or `1n` (bbaa0e7b: no occupancy rule). Must be >= 1.
   */
  occupancyRentMultiple?: bigint;
}

/** Which program rule a refusal comes from. */
export type BandSafetyLawRuleV22 =
  | "base-config"
  | "rent-block"
  | "rent-envelope"
  | "band-shape-or-law"
  | "occupancy-law";

/** Result of {@link checkBandSafetyLawV22}. */
export type BandSafetyLawResultV22 =
  | { ok: true }
  | {
      ok: false;
      /** The InitMarket error the program returns: 106 HoldingRentConfigInvalid, 105 PriceBandConfigInvalid; null = the base config (no rent / band) is itself invalid, so InitMarket fails elsewhere. */
      code: 105 | 106 | null;
      rule: BandSafetyLawRuleV22;
      /** One plain sentence. */
      message: string;
    };

/** Internal: the engine config fields the validator reads. */
interface Cfg {
  maxPortfolioAssets: bigint;
  mm: bigint;
  im: bigint;
  liq: bigint;
  liqCap: bigint;
  minLiqAbs: bigint;
  minMm: bigint;
  minIm: bigint;
  pmove: bigint;
  dt: bigint;
  funding: bigint;
  lifetime: bigint;
  rent: bigint;
  band: bigint;
  e: bigint;
  pmax: bigint;
  positionsPerSide: bigint;
  minLeg: bigint;
}

class Invalid extends Error {}

const fail = (): never => {
  throw new Invalid("InvalidConfig");
};

const u128 = (v: bigint): bigint => (v > U128_MAX || v < 0n ? fail() : v);

const ceilDiv = (n: bigint, d: bigint): bigint => {
  if (d === 0n) return fail();
  const q = n / d;
  return u128(n % d === 0n ? q : q + 1n);
};

/**
 * The engine's worst two-epoch adverse move `G(d) = ceil((1e4 + d)^2 / (1e4 - d)) - 1e4` (bps).
 *
 * @param bandBps  Band half-width `d` in bps (1..=2000).
 * @returns `G(d)`, or null when `d` is out of range.
 * @example
 * ```ts
 * bandWorstAdverseBpsV22(130n); // 397n
 * ```
 */
export function bandWorstAdverseBpsV22(bandBps: bigint): bigint | null {
  if (bandBps <= 0n || bandBps > BSL_MAX_BAND_BPS) return null;
  const num = (BPS + bandBps) * (BPS + bandBps);
  const den = BPS - bandBps;
  return num / den + (num % den === 0n ? 0n : 1n) - BPS;
}

function shapeOk(c: Cfg): boolean {
  if (c.maxPortfolioAssets === 0n) return false;
  if (c.minMm === 0n || c.minMm >= c.minIm) return false;
  if (
    c.mm > c.im ||
    c.im > MAX_MARGIN_BPS ||
    c.liq > MAX_MARGIN_BPS ||
    c.minLiqAbs > c.liqCap ||
    c.liqCap > MAX_PROTOCOL_FEE_ABS ||
    c.dt === 0n ||
    c.lifetime < c.dt ||
    c.funding > MAX_ABS_FUNDING_E9_PER_SLOT ||
    c.pmove === 0n ||
    c.pmove > MAX_MARGIN_BPS
  ) {
    return false;
  }
  if (c.rent > BSL_MAX_RENT_E9_PER_SLOT) return false;
  if (c.band === 0n) {
    return c.e === 0n && c.pmax === 0n && c.positionsPerSide === 0n && c.minLeg === 0n;
  }
  return !(
    c.band > BSL_MAX_BAND_BPS ||
    c.e < BSL_BAND_MIN_EPOCH_SLOTS ||
    c.pmax < c.e * BSL_BAND_MIN_PIN_EPOCHS ||
    c.positionsPerSide === 0n ||
    c.minLeg === 0n ||
    c.positionsPerSide > 256n ||
    c.maxPortfolioAssets !== 1n
  );
}

function headroom(c: Cfg, slots: bigint): void {
  if (ADL_ONE * MAX_ORACLE_PRICE * c.funding * slots > I128_MAX) fail();
}

function total(c: Cfg, n: bigint, lossNum: bigint, lossDen: bigint, priceBudget: bigint): bigint {
  const loss = ceilDiv(n * lossNum, lossDen);
  const worstLiqNotional = ceilDiv(n * u128(BPS + priceBudget), BPS);
  const raw = ceilDiv(worstLiqNotional * c.liq, BPS);
  const lo = raw > c.minLiqAbs ? raw : c.minLiqAbs;
  const fee = lo < c.liqCap ? lo : c.liqCap;
  return u128(loss + fee);
}

function mmReq(c: Cfg, n: bigint): bigint {
  const prop = ceilDiv(n * c.mm, BPS);
  return prop > c.minMm ? prop : c.minMm;
}

function holds(c: Cfg, n: bigint, lossNum: bigint, lossDen: bigint, pb: bigint): boolean {
  return total(c, n, lossNum, lossDen, pb) <= mmReq(c, n);
}

function rangeOk(c: Cfg, lo: bigint, hi: bigint, lossNum: bigint, lossDen: bigint, pb: bigint): void {
  if (lo > hi) return;
  const stack: [bigint, bigint][] = [[lo, hi]];
  let steps = 0;
  while (stack.length !== 0) {
    steps += 1;
    if (steps > MAX_SOLVENCY_STEPS) fail();
    const [rlo, rhi] = stack.pop() as [bigint, bigint];
    if (total(c, rhi, lossNum, lossDen, pb) <= mmReq(c, rlo)) continue;
    if (rhi === rlo || rhi - rlo <= EXACT_CHUNK) {
      for (let n = rlo; n <= rhi; n++) if (!holds(c, n, lossNum, lossDen, pb)) fail();
      continue;
    }
    const mid = rlo + (rhi - rlo) / 2n;
    if (stack.length + 2 > MAX_SOLVENCY_INTERVALS) fail();
    stack.push([mid + 1n, rhi], [rlo, mid]);
  }
}

function envelopeWith(c: Cfg, pb: bigint, slots: bigint, rate: bigint): void {
  const fundingNum = rate * slots * BPS;
  const lossNum = pb * FUNDING_DEN + fundingNum;
  const lossDen = BPS * FUNDING_DEN;
  const fundingCeil = ceilDiv(fundingNum, FUNDING_DEN);
  const lossCeil = u128(pb + fundingCeil);
  const worstLiqCeil = ceilDiv(u128(BPS + pb) * c.liq, BPS);
  const linear = u128(lossCeil + worstLiqCeil);
  if (c.mm === 10_000n && lossCeil === 10_000n && worstLiqCeil === 0n && c.minLiqAbs === 0n) return;
  u128(lossNum);
  const domainMax = MAX_ACCOUNT_NOTIONAL;
  if (c.mm === 0n) {
    if (holds(c, domainMax, lossNum, lossDen, pb)) return;
    fail();
  }
  const floorRegionMax = u128((c.minMm * BPS) / c.mm);
  const floorRegionEnd = floorRegionMax < domainMax ? floorRegionMax : domainMax;
  if (floorRegionEnd !== 0n && !holds(c, floorRegionEnd, lossNum, lossDen, pb)) fail();
  if (floorRegionMax >= domainMax) return;
  const exactStart = floorRegionEnd + 1n;
  if (linear < c.mm) {
    const tailLinear = ceilDiv(30_000n, c.mm - linear);
    const lossGap = c.mm - lossCeil;
    const tailFeeFloor = ceilDiv((c.minLiqAbs + 2n) * BPS, lossGap);
    const exactTail = tailLinear > tailFeeFloor ? tailLinear : tailFeeFloor;
    if (exactTail <= exactStart) return;
    const end = exactTail - 1n < domainMax ? exactTail - 1n : domainMax;
    rangeOk(c, exactStart, end, lossNum, lossDen, pb);
    return;
  }
  if (lossCeil >= c.mm) {
    rangeOk(c, exactStart, domainMax, lossNum, lossDen, pb);
    return;
  }
  const exactTail = ceilDiv((c.liqCap + 3n) * BPS, c.mm - lossCeil);
  if (exactTail <= exactStart) return;
  const end = exactTail - 1n < domainMax ? exactTail - 1n : domainMax;
  rangeOk(c, exactStart, end, lossNum, lossDen, pb);
}

/** Engine `validate_public_user_fund` restricted to the InitMarket-derived fields: true iff it accepts. */
function validates(c: Cfg): boolean {
  try {
    if (!shapeOk(c)) return false;
    const pbFast = c.pmove * c.dt;
    const rate = c.funding + c.rent;
    const fast = c.mm === 10_000n && pbFast <= 10_000n && rate === 0n && c.liq === 0n && c.minLiqAbs === 0n;
    if (!fast) {
      headroom(c, c.dt);
      headroom(c, c.lifetime);
      envelopeWith(c, pbFast, c.dt, rate);
    }
    if (c.band !== 0n) {
      const g = bandWorstAdverseBpsV22(c.band);
      if (g === null) return false;
      envelopeWith(c, g, c.e * 2n, rate);
    }
    return true;
  } catch (e) {
    if (e instanceof Invalid) return false;
    throw e;
  }
}

const nonNeg = (name: string, v: bigint, max: bigint): bigint => {
  if (typeof v !== "bigint" || v < 0n || v > max) throw new RangeError(`${name} must be a bigint in 0..=${max}`);
  return v;
};
const intField = (name: string, v: number, max: number): bigint => {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new RangeError(`${name} must be an integer in 0..=${max}`);
  return BigInt(v);
};

/**
 * Pre-check an InitMarket config against the v2.2 Band Safety Law and the rent / band block rules, the way
 * the wrapper's `init_market_apply_phase4_view` and the engine's `validate_public_user_fund` evaluate them.
 * Pure: no RPC. Exact (the same breakpoint validator, the same ceilings, the same step limits).
 *
 * Order (as the program): rent block (106), rent in the §1.6 envelope (106), band shape and law (105), then on
 * a band market with rent, the law at `rent_max x occupancyRentMultiple` (106). A config whose base (no rent, no
 * band) is itself invalid returns `code: null` (InitMarket refuses it for another reason).
 *
 * @param input  The InitMarket fields the law reads, plus the trailer's rent / band blocks.
 * @param opts   `occupancyRentMultiple`: 5 (rc23 34996503, default) or 1 (bbaa0e7b).
 * @returns `{ ok: true }`, or the refusal with the program's error code and the rule.
 * @throws RangeError on a malformed input (negative, non-integer, or wider than the instruction field).
 * @example
 * ```ts
 * const r = checkBandSafetyLawV22({
 *   maxPortfolioAssets: 1, maintenanceMarginBps: 1000n, initialMarginBps: 2000n, liquidationFeeBps: 50n,
 *   liquidationFeeCap: 10_000_000_000n, minLiquidationAbs: 0n, minNonzeroMmReq: 1_000_000n, minNonzeroImReq: 2_000_000n,
 *   maxPriceMoveBpsPerSlot: 1n, maxAccrualDtSlots: 500n, maxAbsFundingE9PerSlot: 111n, minFundingLifetimeSlots: 500n,
 *   rent: { rentMaxE9PerSlot: 100, rentKinkBps: 5000 },
 *   band: { bandBps: 130, bandMaxEpochSlots: 600, bandMaxPinSlots: 9000, bandMinLegNotional: 100_000_000n },
 * });
 * r.ok; // true (the seed's band pilot)
 * ```
 */
export function checkBandSafetyLawV22(input: BandSafetyLawInputV22, opts: BandSafetyLawOptionsV22 = {}): BandSafetyLawResultV22 {
  const k = opts.occupancyRentMultiple ?? BSL_OCCUPANCY_RENT_MULTIPLE_RC23;
  if (typeof k !== "bigint" || k < 1n) throw new RangeError("occupancyRentMultiple must be a bigint >= 1");
  const base: Cfg = {
    maxPortfolioAssets: intField("maxPortfolioAssets", input.maxPortfolioAssets, 0xffff),
    mm: nonNeg("maintenanceMarginBps", input.maintenanceMarginBps, U64_MAX),
    im: nonNeg("initialMarginBps", input.initialMarginBps, U64_MAX),
    liq: nonNeg("liquidationFeeBps", input.liquidationFeeBps, U64_MAX),
    liqCap: nonNeg("liquidationFeeCap", input.liquidationFeeCap, U128_MAX),
    minLiqAbs: nonNeg("minLiquidationAbs", input.minLiquidationAbs, U128_MAX),
    minMm: nonNeg("minNonzeroMmReq", input.minNonzeroMmReq, U128_MAX),
    minIm: nonNeg("minNonzeroImReq", input.minNonzeroImReq, U128_MAX),
    pmove: nonNeg("maxPriceMoveBpsPerSlot", input.maxPriceMoveBpsPerSlot, U64_MAX),
    dt: nonNeg("maxAccrualDtSlots", input.maxAccrualDtSlots, U64_MAX),
    funding: nonNeg("maxAbsFundingE9PerSlot", input.maxAbsFundingE9PerSlot, U64_MAX),
    lifetime: nonNeg("minFundingLifetimeSlots", input.minFundingLifetimeSlots, U64_MAX),
    rent: 0n, band: 0n, e: 0n, pmax: 0n, positionsPerSide: 0n, minLeg: 0n,
  };
  const r = input.rent;
  if (!r) {
    if (input.band && input.band.bandBps !== 0) throw new RangeError("a band block requires a rent block (grammar growth [lot] [rent [band]])");
    return { ok: true };
  }
  const rent = intField("rentMaxE9PerSlot", r.rentMaxE9PerSlot, 0xffff_ffff);
  const kink = intField("rentKinkBps", r.rentKinkBps, 0xffff);
  if (rent > BSL_MAX_RENT_E9_PER_SLOT || kink > BPS || (rent !== 0n && (rent < BSL_RENT_MIN_E9_PER_SLOT || kink > BSL_RENT_MAX_KINK_BPS))) {
    return { ok: false, code: 106, rule: "rent-block", message: `holding fee ceiling ${rent} e9/slot / kink ${kink} bps is outside the program's range (0, or ${BSL_RENT_MIN_E9_PER_SLOT}..=${BSL_MAX_RENT_E9_PER_SLOT} with kink <= ${BSL_RENT_MAX_KINK_BPS})` };
  }
  const baseOk = validates(base);
  const withRent: Cfg = { ...base, rent };
  if (baseOk && !validates(withRent)) {
    return { ok: false, code: 106, rule: "rent-envelope", message: `holding fee ceiling ${rent} e9/slot does not fit the market's margin (solvency envelope)` };
  }
  const b = input.band;
  if (!b || b.bandBps === 0) return baseOk ? { ok: true } : baseInvalid();
  const rentOk = validates(withRent);
  const withBand: Cfg = {
    ...withRent,
    band: intField("bandBps", b.bandBps, 0xffff),
    e: intField("bandMaxEpochSlots", b.bandMaxEpochSlots, 0xffff_ffff),
    pmax: intField("bandMaxPinSlots", b.bandMaxPinSlots, 0xffff_ffff),
    positionsPerSide: 256n,
    minLeg: nonNeg("bandMinLegNotional", b.bandMinLegNotional, U64_MAX),
  };
  if (rentOk && !validates(withBand)) {
    return { ok: false, code: 105, rule: "band-shape-or-law", message: `price protection ${b.bandBps} bps / epoch ${b.bandMaxEpochSlots} slots breaks the Band Safety Law or the band's shape at this margin` };
  }
  if (rentOk && rent !== 0n && !validates({ ...withBand, rent: rent * k })) {
    return { ok: false, code: 106, rule: "occupancy-law", message: `holding fee ceiling ${rent} e9/slot x ${k} (utilisation + slot occupancy) breaks the Band Safety Law at this margin` };
  }
  return baseOk ? { ok: true } : baseInvalid();
}

const baseInvalid = (): BandSafetyLawResultV22 => ({
  ok: false, code: null, rule: "base-config", message: "the market's base risk config is invalid on its own (InitMarket refuses it for another reason)",
});

/**
 * The largest holding-fee ceiling (`rent_max_e9_per_slot`) the program accepts for this config, by bisection over
 * {@link checkBandSafetyLawV22} (the law is monotone in rent). The `rent` block's kink is kept; its ceiling is ignored.
 *
 * @param input  As {@link checkBandSafetyLawV22}; `rent` supplies the kink (default 5000).
 * @param opts   As {@link checkBandSafetyLawV22}.
 * @returns The maximum accepted `rent_max_e9_per_slot` (>= 10), or null if not even 10 is accepted.
 * @example
 * ```ts
 * maxAcceptedRentE9PerSlotV22(seedBandPilot); // 2000n (x5: the engine ceiling 10,000 / 5)
 * ```
 */
export function maxAcceptedRentE9PerSlotV22(input: BandSafetyLawInputV22, opts: BandSafetyLawOptionsV22 = {}): bigint | null {
  const kink = input.rent?.rentKinkBps ?? 5_000;
  const ok = (v: bigint): boolean => checkBandSafetyLawV22({ ...input, rent: { rentMaxE9PerSlot: Number(v), rentKinkBps: kink } }, opts).ok;
  let lo = BSL_RENT_MIN_E9_PER_SLOT;
  if (!ok(lo)) return null;
  let hi = BSL_MAX_RENT_E9_PER_SLOT;
  if (ok(hi)) return hi;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

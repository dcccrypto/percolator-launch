/**
 * P2 matcher v2: client ports of the kind-2 (adaptive) quote from
 * `percolator-match feat/p2-matcher-v2@4a0f696` `src/v2.rs` (`adaptive_fee_bps`
 * :525, `cp_impact_bps` :588, `skew_potential_num` :619, `skew_net_bps` :655,
 * `price_with_total_bps` :696, `quote_adaptive` :734) and the fill clipping of
 * `vamm.rs::execute_leg` / `compute_adaptive_execution` (:831-990).
 *
 * Integer-exact, same rounding direction as Rust (toward the LP). A `null`
 * result mirrors Rust `None` (overflow => the program fails the call).
 *
 * C-1: on v18.2 / P1 fills SETTLE AT THE MARK. This quote decides only how
 * much fills and whether the taker's limit passes. The UI must not call it a
 * charge unless the wrapper routes `requested_fee_bps` (flag p2FeeCharged).
 */
import { BPS } from "./constants";
import type { MatcherCtxView, V2BlockView } from "./decode";

const U128_MAX = (1n << 128n) - 1n;

/** `isqrt_u64`: exact floor(sqrt(n)). */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** `adaptive_fee_bps`: cold fee while warming up, else clamp(lo + a·σ + σ²/b). */
export function adaptiveFeeBps(v: V2BlockView): bigint {
  const lo = BigInt(v.feeLoBps);
  const hiRaw = BigInt(v.feeHiBps);
  const hi = hiRaw > lo ? hiRaw : lo;
  const clamp = (x: bigint) => (x < lo ? lo : x > hi ? hi : x);
  if (v.volWarmupLeft > 0) return clamp(BigInt(v.feeColdBps));
  const sigmaC = isqrt(v.volVarE4);
  const lin = (BigInt(v.volAMilli) * sigmaC) / 100_000n;
  const quad = v.volBDen === 0 ? 0n : v.volVarE4 / (BigInt(v.volBDen) * 10_000n);
  return clamp(lo + lin + quad);
}

const divCeil = (a: bigint, b: bigint): bigint => a / b + (a % b === 0n ? 0n : 1n);

/** `cp_impact_bps`: ceil(k·n/(D−n)); null when n >= D (infinite impact). */
export function cpImpactBps(notionalE6: bigint, depthE6: bigint, kBps: number): bigint | null {
  if (kBps === 0 || notionalE6 === 0n) return 0n;
  if (notionalE6 >= depthE6) return null;
  return divCeil(BigInt(kBps) * notionalE6, depthE6 - notionalE6);
}

/** `skew_potential_num`: 2·ref·W(x), quadratic to the knee then linear. */
export function skewPotentialNum(x: bigint, multBps: number, capBps: number, refInv: bigint): bigint {
  if (multBps === 0 || capBps === 0 || x === 0n) return 0n;
  const m = BigInt(multBps);
  const c = BigInt(capBps);
  const knee = (c * refInv) / m;
  if (x <= knee) return m * x * x;
  return m * knee * knee + 2n * refInv * c * (x - knee);
}

/**
 * `skew_net_bps`: signed skew term (positive = surcharge paid by the taker,
 * negative = thin-side rebate) for the LP inventory path pre -> post.
 */
export function skewNetBps(
  invPre: bigint,
  fill: bigint,
  lpSells: boolean,
  sMultBps: number,
  rMultBps: number,
  skewCapBps: number,
  rebateCapBps: number,
  refInv: bigint,
): bigint {
  if (fill === 0n || refInv === 0n || (sMultBps === 0 && rMultBps === 0)) return 0n;
  const invPost = lpSells ? invPre - fill : invPre + fill;
  const a = invPre < 0n ? -invPre : invPre;
  const b = invPost < 0n ? -invPost : invPost;
  const crosses = (invPre > 0n && invPost < 0n) || (invPre < 0n && invPost > 0n);
  const ws = (x: bigint) => skewPotentialNum(x, sMultBps, skewCapBps, refInv);
  const wr = (x: bigint) => skewPotentialNum(x, rMultBps, rebateCapBps, refInv);
  let p: bigint;
  let n: bigint;
  if (crosses) {
    p = ws(b);
    n = wr(a);
  } else if (b >= a) {
    p = ws(b) - ws(a);
    n = 0n;
  } else {
    p = 0n;
    n = wr(a) - wr(b);
  }
  const den = 2n * refInv * fill;
  return p >= n ? divCeil(p - n, den) : -((n - p) / den);
}

/** `price_with_total_bps`: oracle ± total, rounded toward the LP. */
export function priceWithTotalBps(oracleE6: bigint, totalBps: bigint, takerBuys: boolean): bigint | null {
  if (totalBps > BPS) return null;
  const p = takerBuys ? divCeil(oracleE6 * (BPS + totalBps), BPS) : (oracleE6 * (BPS - totalBps)) / BPS;
  if (p === 0n || p > 0xffff_ffff_ffff_ffffn) return null;
  return p;
}

export interface AdaptiveQuoteIn {
  oracleE6: bigint;
  fill: bigint;
  takerBuys: boolean;
  invPre: bigint;
  baseSpreadBps: number;
  maxTotalBps: number;
  feeBps: bigint;
  impactKBps: number;
  depthE6: bigint;
  sMultBps: number;
  rMultBps: number;
  skewCapBps: number;
  rebateCapBps: number;
  refInv: bigint;
}

function impactAndSkew(q: AdaptiveQuoteIn, fill: bigint): { impact: bigint; skew: bigint } {
  const notional = (fill * q.oracleE6) / 1_000_000n;
  let impact: bigint;
  if (q.impactKBps > 0 && notional >= q.depthE6) impact = U128_MAX;
  else impact = cpImpactBps(notional, q.depthE6, q.impactKBps) ?? U128_MAX;
  const skew = skewNetBps(q.invPre, fill, q.takerBuys, q.sMultBps, q.rMultBps, q.skewCapBps, q.rebateCapBps, q.refInv);
  return { impact, skew };
}

function grossPosBps(q: AdaptiveQuoteIn, fill: bigint): bigint {
  if (fill === 0n) return 0n;
  const { impact, skew } = impactAndSkew(q, fill);
  const s = BigInt(q.baseSpreadBps) + q.feeBps + impact + (skew > 0n ? skew : 0n);
  return s > U128_MAX ? U128_MAX : s;
}

export interface AdaptiveQuote {
  fill: bigint;
  priceE6: bigint;
  totalBps: bigint;
  impactBps: bigint;
  /** Signed: + surcharge, − rebate. */
  skewBps: bigint;
  /** True when max_total (or the band) clipped the fill below the request. */
  clippedByTotal: boolean;
}

/** `quote_adaptive` @4a0f696 (binary search identical to Rust, at most 128 steps; LP-reducing exemption; impact capped at 9000). */
export function quoteAdaptive(q: AdaptiveQuoteIn): AdaptiveQuote | null {
  const maxTotal = BigInt(Math.min(q.maxTotalBps, 9_000));
  const zero: AdaptiveQuote = { fill: 0n, priceE6: q.oracleE6, totalBps: 0n, impactBps: 0n, skewBps: 0n, clippedByTotal: false };
  if (q.fill === 0n) return zero;
  let fill: bigint;
  if (grossPosBps(q, q.fill) <= maxTotal) {
    fill = q.fill;
  } else {
    let lo = 0n;
    let hi = q.fill;
    let i = 0;
    while (hi - lo > 1n && i < 128) {
      const mid = lo + (hi - lo) / 2n;
      if (grossPosBps(q, mid) <= maxTotal) lo = mid;
      else hi = mid;
      i++;
    }
    fill = lo;
  }
  // 4a0f696: a request that REDUCES the LP's |inventory| is always fillable up
  // to |inventory| (priced at the max_total clamp if it must be).
  const lpReduces = (q.takerBuys && q.invPre > 0n) || (!q.takerBuys && q.invPre < 0n);
  if (lpReduces) {
    const absInv = q.invPre < 0n ? -q.invPre : q.invPre;
    const exempt = q.fill < absInv ? q.fill : absInv;
    if (exempt > fill) fill = exempt;
  }
  if (fill === 0n) return { ...zero, clippedByTotal: true };
  const is = impactAndSkew(q, fill);
  const impact = is.impact > 9_000n ? 9_000n : is.impact;
  const skew = is.skew;
  const gross = BigInt(q.baseSpreadBps) + q.feeBps + impact + skew;
  const g = gross < 0n ? 0n : gross;
  const total = g > maxTotal ? maxTotal : g;
  const price = priceWithTotalBps(q.oracleE6, total, q.takerBuys);
  if (price === null) return null;
  return { fill, priceE6: price, totalBps: total, impactBps: impact, skewBps: skew, clippedByTotal: fill < q.fill };
}

/**
 * `check_inventory_limit` (vamm.rs:1440) clip: how much of `fillAbs` fits
 * under `max_inventory_abs` in the taker's direction. 0 cap = unlimited.
 */
export function inventoryClip(inv: bigint, maxInvAbs: bigint, fillAbs: bigint, takerBuys: boolean): bigint {
  if (maxInvAbs === 0n) return fillAbs;
  const next = takerBuys ? inv - fillAbs : inv + fillAbs;
  if ((next < 0n ? -next : next) <= maxInvAbs) return fillAbs;
  if (takerBuys) {
    if (inv <= -maxInvAbs) return 0n;
    const room = inv + maxInvAbs; // > 0 here
    return fillAbs < room ? fillAbs : room;
  }
  if (inv >= maxInvAbs) return 0n;
  const room = maxInvAbs - inv;
  return fillAbs < room ? fillAbs : room;
}

/** The wrapper's ext-v3 caps for one leg (growth markets): `inventory_cap_q` (0 = CLOSED to LP growth) and the depth `liquidity_notional_e6` (0 = keep the context's). */
export interface MatcherExtCaps {
  inventoryCapQ: bigint;
  liquidityNotionalE6: bigint;
}

/** `SKEW_REF_MAX_INVENTORY_Q` (vamm.rs): an ext cap at or above it is the wrapper's neutral value, not a real cap. */
export const SKEW_REF_MAX_INVENTORY_Q = 100_000_000_000_000n;

/**
 * `vol_update` (v2.rs): the matcher folds the CURRENT oracle price into its volatility estimate BEFORE it prices a fill, so the adaptive fee
 * a fill pays is the one after this step, not the stored one. The stored ctx lags: it only moves on fills. Same integer math as Rust.
 */
export function volUpdate(v: V2BlockView, priceE6: bigint, nowSlot: bigint): V2BlockView {
  if (priceE6 === 0n) return v;
  if (v.volLastPriceE6 === 0n) return { ...v, volLastPriceE6: priceE6, volLastSlot: nowSlot };
  if (nowSlot < v.volLastSlot) return v;
  const dt = nowSlot - v.volLastSlot;
  const refSlots = BigInt(Math.max(v.volRefSlots, 1));
  if (dt < refSlots) return v;
  const last = v.volLastPriceE6;
  const diff = priceE6 > last ? priceE6 - last : last - priceE6;
  const cap = BigInt(Math.max(v.volMoveCap10bps, 1)) * 10n;
  const moveBps = (() => { const m = (diff * BPS) / last; return m > cap ? cap : m; })();
  let r2 = (moveBps * moveBps * 10_000n * refSlots) / dt;
  const r2Max = cap * cap * 10_000n;
  if (r2 > r2Max) r2 = r2Max;
  const variance = v.volVarE4;
  const alpha = BigInt(Math.min(Math.max(v.volAlphaBps, 1), 10_000));
  // Rust i128 `/` truncates toward zero, as BigInt does.
  const delta = ((r2 - variance) * alpha) / 10_000n;
  let nv = variance + delta;
  if (nv < 0n) nv = 0n;
  if (nv > 0xffff_ffff_ffff_ffffn) nv = 0xffff_ffff_ffff_ffffn;
  return { ...v, volVarE4: nv, volWarmupLeft: Math.max(v.volWarmupLeft - 1, 0), volLastPriceE6: priceE6, volLastSlot: nowSlot };
}

export interface PreTradeQuote {
  kind: "adaptive" | "legacy";
  requestedQ: bigint;
  fillQ: bigint;
  /** Matcher exec price (adaptive only; legacy = null, bounded by max_total). */
  quotePriceE6: bigint | null;
  totalBps: bigint | null;
  baseSpreadBps: number;
  adaptiveFeeBps: bigint | null;
  feeCold: boolean;
  impactBps: bigint | null;
  skewBps: bigint | null;
  /** Effective max total after the band (EXEC_BAND clamps max_total). */
  maxTotalBps: number;
  clippedByTotal: boolean;
}

/**
 * The ticket's pre-trade quote for a taker of |size| `sizeQ` in the given
 * direction: applies the same effective limits `execute_leg` does (band ->
 * max_total, headroom -> max_fill, per-fill cap, inventory cap) then prices.
 */
export function preTradeQuote(
  ctx: MatcherCtxView,
  oracleE6: bigint,
  sizeQ: bigint,
  takerBuys: boolean,
  opts: {
    bandBps?: number;
    headroomQ?: bigint;
    /**
     * The deployed matcher (release/v22-matcher 7d5aa26) prices a growth leg with the wrapper's ext-v3 caps: the depth is `min(ctx, ext)` and the
     * skew reference is capped at the inventory cap. The context's own depth is huge on a growth market, so without this the impact term
     * reads ~0 at every size while the chain charges `k*n/(D-n)` on the real (capital-derived) depth. Null / absent = a leg with no caps (v2 ext).
     */
    ext?: MatcherExtCaps | null;
    /** The wrapper marks the leg TAKER_REDUCING (the order only reduces the taker's position). With `ext`, the close exemption applies. */
    takerReducing?: boolean;
    /** The cluster slot the quote is for: folds the current price into the volatility estimate first (`volUpdate`), as the matcher does. */
    nowSlot?: bigint;
  } = {},
): PreTradeQuote | null {
  let maxTotal = ctx.maxTotalBps;
  if (opts.bandBps !== undefined && opts.bandBps < maxTotal) maxTotal = opts.bandBps;
  // execute_leg: `if eff.max_fill_abs > rem { eff.max_fill_abs = rem }`.
  let maxFill = ctx.maxFillAbs;
  if (opts.headroomQ !== undefined && maxFill > opts.headroomQ) maxFill = opts.headroomQ;
  const base = {
    requestedQ: sizeQ,
    baseSpreadBps: ctx.baseSpreadBps,
    maxTotalBps: maxTotal,
  };
  if (ctx.kind !== 2 || !ctx.v2) {
    return {
      ...base,
      kind: "legacy",
      fillQ: sizeQ,
      quotePriceE6: null,
      totalBps: null,
      adaptiveFeeBps: null,
      feeCold: false,
      impactBps: null,
      skewBps: null,
      clippedByTotal: false,
    };
  }
  const v2 = opts.nowSlot !== undefined ? volUpdate(ctx.v2, oracleE6, opts.nowSlot) : ctx.v2;
  const fee = adaptiveFeeBps(v2);
  const ext = opts.ext ?? null;
  // vamm.rs `v3_effective_ctx` (caps present): cap_active, close exemption, effective inventory cap / closed room, effective depth.
  const capActive = ext !== null && ext.inventoryCapQ < SKEW_REF_MAX_INVENTORY_Q;
  const closeExempt = ext !== null && opts.takerReducing === true;
  let maxInv = ctx.maxInventoryAbs;
  let skewRefCap: bigint | null = null;
  if (ext !== null && capActive) {
    if (ext.inventoryCapQ === 0n) {
      // CLOSED: only a fill that reduces the LP's |inventory| (up to flat); the close exemption lifts it.
      const inv = ctx.inventoryBase;
      const lpReducesNow = (takerBuys && inv > 0n) || (!takerBuys && inv < 0n);
      const room = lpReducesNow ? (inv < 0n ? -inv : inv) : 0n;
      if (!closeExempt && maxFill > room) maxFill = room;
    } else {
      const eff = maxInv === 0n || ext.inventoryCapQ < maxInv ? ext.inventoryCapQ : maxInv;
      if (!closeExempt) maxInv = eff;
      skewRefCap = eff;
    }
  }
  const depth =
    ext !== null && ext.liquidityNotionalE6 !== 0n && ext.liquidityNotionalE6 < ctx.liquidityNotionalE6 ? ext.liquidityNotionalE6 : ctx.liquidityNotionalE6;
  let refInv = v2.skewRefInventory;
  if (skewRefCap !== null) {
    const m64 = skewRefCap > 0xffff_ffff_ffff_ffffn ? 0xffff_ffff_ffff_ffffn : skewRefCap;
    if (m64 < refInv) refInv = m64;
  }
  // compute_adaptive_execution: `max_fill_abs == 0` => zero fill (kind 2 has no "unlimited").
  let fillAbs = maxFill === 0n ? 0n : sizeQ < maxFill ? sizeQ : maxFill;
  fillAbs = inventoryClip(ctx.inventoryBase, maxInv, fillAbs, takerBuys);
  let q = quoteAdaptive({
    oracleE6,
    fill: fillAbs,
    takerBuys,
    invPre: ctx.inventoryBase,
    baseSpreadBps: ctx.baseSpreadBps,
    maxTotalBps: maxTotal,
    feeBps: fee,
    impactKBps: ctx.impactKBps,
    depthE6: depth,
    sMultBps: ctx.skewSpreadMultBps,
    rMultBps: v2.thinRebateMultBps,
    skewCapBps: v2.skewCapBps,
    rebateCapBps: v2.rebateCapBps,
    refInv,
  });
  // `v3_close_exempt_fill`: a wrapper-verified reduction is filled in FULL, priced at the max-total clamp when the size budget would have clipped it.
  if (q && closeExempt && q.fill < fillAbs) {
    const clamp = BigInt(Math.min(maxTotal, 9_000));
    const price = priceWithTotalBps(oracleE6, clamp, takerBuys);
    q = price === null ? null : { ...q, fill: fillAbs, priceE6: price, totalBps: clamp, clippedByTotal: true };
  }
  if (!q) return null;
  return {
    ...base,
    kind: "adaptive",
    fillQ: q.fill,
    quotePriceE6: q.fill === 0n ? null : q.priceE6,
    totalBps: q.totalBps,
    adaptiveFeeBps: fee,
    feeCold: v2.volWarmupLeft > 0,
    impactBps: q.impactBps,
    skewBps: q.skewBps,
    clippedByTotal: q.clippedByTotal,
  };
}

/**
 * Would the taker's slippage limit refuse this quote? (wrapper TradeCpi: buy
 * needs exec <= limit, sell needs exec >= limit; limit 0 = no limit).
 */
export function quoteFailsLimit(quotePriceE6: bigint | null, limitE6: bigint, takerBuys: boolean): boolean {
  if (quotePriceE6 === null || limitE6 === 0n) return false;
  return takerBuys ? quotePriceE6 > limitE6 : quotePriceE6 < limitE6;
}

/** Book skew as signed bps of the reference inventory (LP inventory; LP short => traders long). */
export function skewIndicatorBps(inventoryBase: bigint, refInv: bigint): number {
  if (refInv === 0n) return 0;
  const bps = (inventoryBase * BPS) / refInv;
  const capped = bps > 10_000n ? 10_000n : bps < -10_000n ? -10_000n : bps;
  return Number(capped);
}

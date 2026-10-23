/**
 * The DEPLOYED wrapper's growth gate for one opening order, ported for the ticket (pure; no I/O). It answers three questions with the
 * numbers the program uses, so the ticket's room, its leverage refusal and the confirm dialog cannot disagree with Custom 92 / 93:
 *
 *  1. CLIP (`p1_cpi_preflight_before_matcher`, v16_program.rs ~42285): an opening TradeCpi is cut to `N_cap - users' OI on the side`
 *     (`growth_open_room_q`), `N_cap = floor(C_m * lambda * 1e6 / (1e4 * price))` from the LP's conservative equity BEFORE the fill.
 *  2. GATE (`growth_post_fill_view` -> `growth_gate`, ~41467 / growth_v19.rs:414): AFTER the fill, the taker's WHOLE position must satisfy
 *     `taker_equity >= ceil(notional_after * IMR_dyn(users' OI after / N_cap) / 1e4)`, `N_cap` from the LP equity BEFORE this fill
 *     (verified against the program on live JUP: the LP's fee credit lands after the gate), `taker_equity` the taker's conservative
 *     equity (capital + min(pnl,0) + min(fee_credits,0)) AFTER the fee. At u = 1 the dynamic IMR is 100%.
 *  3. So an order is refused (92) when the account's equity is below that, whatever the slider says; the answer the ticket owes is
 *     "how much fits" and "how much collateral would make it fit", not a leverage figure.
 *
 * Not modelled (documented): the engine health certificate of OTHER legs (a one-asset account has none), `min_nonzero_im_req`
 * (a floor on tiny legs), and the matcher's own per-fill cap.
 */
import { ceilingImrBps, dynImrBps, openingPartQ, usersSideOiQ, utilFeeMaxEffectiveBps, utilisationFeeBps } from "@/lib/v21/sdk";
import type { GrowthMarketView } from "@/lib/v21/growth-market";

const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export interface GrowthGateParams {
  view: GrowthMarketView;
  direction: "long" | "short";
  /** The taker's ADL-effective signed position on the asset (Q). */
  takerEffQ: bigint;
  /** The order size asked (Q, unsigned). */
  askQ: bigint;
  /** The taker's conservative equity BEFORE this fill: capital (+ the deposit bundled with it) + min(pnl,0) + min(fee_credits,0). */
  takerEquity: bigint;
  /** The matcher's quote fee on the fill (bps of the fill notional). Default 0 (unknown). */
  quoteFeeBps?: bigint;
  /** Initial requirement of the taker's OTHER legs (atoms). Default 0 (a one-asset account). */
  otherLegsImReq?: bigint;
}

export interface GrowthGateResult {
  /** `N_cap - users' OI on the side` before the fill (Q): what the program clips an opening order to. */
  roomQ: bigint;
  /** The size that will fill after the clip (Q, unsigned). */
  clipQ: bigint;
  /** The program clips this order (clip < ask). */
  clipped: boolean;
  /** The gate passes at `clipQ`. */
  passes: boolean;
  /** The largest fill <= clipQ the gate passes (Q); 0 when none. Equals `clipQ` when it passes. */
  maxPassingQ: bigint;
  /** Extra equity (atoms) the account needs for `clipQ` to pass; 0 when it passes. */
  extraEquityNeeded: bigint;
  /** Equity the gate compares (after the fee) and the requirement, at `clipQ`. */
  equityAtClip: bigint;
  requiredAtClip: bigint;
  /** `maxPassingQ` for a closed side / unreadable inputs is 0. */
  closed: boolean;
}

interface Eval { pass: boolean; equity: bigint; required: bigint; }

function evalFill(p: GrowthGateParams, fillQ: bigint): Eval {
  const { view } = p;
  const q = p.direction === "long" ? view.long : view.short;
  const qi = view.quoteInput;
  const g = view.record;
  const price = qi.priceE6;
  const signed = p.direction === "long" ? fillQ : -fillQ;
  const afterQ = p.takerEffQ + signed;
  const openingQ = openingPartQ(p.takerEffQ, afterQ);
  const lpEff = qi.lpEffectivePositionQ;
  const long = p.direction === "long";
  const usersBefore = usersSideOiQ(long ? qi.oiEffLongQ : qi.oiEffShortQ, lpEff, long);
  const usersAfter = usersBefore + openingQ;
  const nCapPre = q.nCapQ;
  if (nCapPre === null || openingQ === 0n) return { pass: openingQ === 0n, equity: p.takerEquity, required: 0n };
  // Fee: base + utilisation (pre-fill N_cap, scaled to the opening share) + the matcher quote, on the fill notional.
  const notionalFill = ceilDiv(fillQ * price, 1_000_000n);
  const utilRaw = utilisationFeeBps(usersAfter, nCapPre, g.kinkBps, utilFeeMaxEffectiveBps(g.utilFeeMaxBps)) ?? 0;
  const utilBps = fillQ === 0n ? 0n : (BigInt(utilRaw) * (openingQ < fillQ ? openingQ : fillQ)) / fillQ;
  const baseBps = view.tradeFeeBaseBps;
  const totalBps = baseBps + utilBps + (p.quoteFeeBps ?? 0n);
  const fee = ceilDiv(notionalFill * totalBps, 10_000n);
  const base = ceilingImrBps(qi.engineImrBps, q.ceilingX100 > 0 ? q.ceilingX100 : Math.min(g.lLaunchX100, g.lTierX100));
  const equity = p.takerEquity - fee;
  if (base === null) return { pass: false, equity, required: 0n };
  let imr: bigint | null;
  if (q.crowd) imr = dynImrBps(usersAfter, nCapPre, base, g.kinkBps);
  else imr = usersAfter > nCapPre ? null : base;
  if (imr === null) return { pass: false, equity, required: 0n };
  const notionalAfter = ceilDiv(abs(afterQ) * price, 1_000_000n);
  const required = ceilDiv(notionalAfter * imr, 10_000n) + (p.otherLegsImReq ?? 0n);
  return { pass: equity >= required, equity, required };
}

/** The program's clip and gate for one order. Reduces and closes always pass untouched. */
export function growthGate(p: GrowthGateParams): GrowthGateResult {
  const q = p.direction === "long" ? p.view.long : p.view.short;
  const signed = p.direction === "long" ? p.askQ : -p.askQ;
  const openingAsk = openingPartQ(p.takerEffQ, p.takerEffQ + signed);
  const none: GrowthGateResult = {
    roomQ: 0n, clipQ: p.askQ, clipped: false, passes: true, maxPassingQ: p.askQ, extraEquityNeeded: 0n, equityAtClip: p.takerEquity, requiredAtClip: 0n, closed: false,
  };
  if (p.askQ <= 0n || openingAsk === 0n || !q.growthOn) return none;
  const room = q.closed ? 0n : (q.headroomQ ?? 0n);
  const closing = p.askQ - openingAsk;
  const clipOpening = openingAsk < room ? openingAsk : room;
  const clipQ = closing + clipOpening;
  if (q.closed || clipQ === 0n) {
    return { ...none, roomQ: room, clipQ: 0n, clipped: true, passes: false, maxPassingQ: 0n, closed: true };
  }
  const at = evalFill(p, clipQ);
  const base = { roomQ: room, clipQ, clipped: clipQ < p.askQ, equityAtClip: at.equity, requiredAtClip: at.required, closed: false };
  if (at.pass) return { ...base, passes: true, maxPassingQ: clipQ, extraEquityNeeded: 0n };
  // Requirement grows with the fill (IMR, notional, fee all rise): bisect the largest passing fill.
  let lo = closing, hi = clipQ; // lo passes (a pure close part) or 0; hi fails
  if (lo > 0n && !evalFill(p, lo).pass) lo = 0n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (evalFill(p, mid).pass) lo = mid; else hi = mid;
  }
  const extra = at.required > at.equity ? at.required - at.equity : 0n;
  return { ...base, passes: false, maxPassingQ: lo, extraEquityNeeded: extra };
}

/**
 * The most the account can order on this side right now (unsigned total size, Q): the closing part of any opposite position plus the
 * opening part the program fills AND the gate passes. For the ticket's Max chip and clamp. Null when growth does not apply.
 */
export function growthFillCapQ(p: Omit<GrowthGateParams, "askQ">): bigint | null {
  const q = p.direction === "long" ? p.view.long : p.view.short;
  if (!q.growthOn) return null;
  const closing = (p.direction === "long" ? p.takerEffQ < 0n : p.takerEffQ > 0n) ? abs(p.takerEffQ) : 0n;
  const room = q.closed ? 0n : (q.headroomQ ?? 0n);
  const g = growthGate({ ...p, askQ: closing + room });
  return g.passes ? g.clipQ : g.maxPassingQ;
}

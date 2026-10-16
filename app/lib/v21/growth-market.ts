/**
 * Growth-v19 market read model (pure). Turns the bytes the app already polls (market slab, the
 * vault LP portfolio) into what the ticket needs: the live max leverage per side, the capacity
 * numbers, and the utilisation fee to sign.
 *
 * FEATURE DETECTION. `AssetGrowthV19` lives at asset-slot [672, 792), which is all zero on every
 * market of today's programs ("all-zero means OFF"). `decodeGrowthRecord` returns null for those,
 * so a legacy market gets no growth view and the ticket is exactly what it is today. Nothing here
 * reads the network and nothing here throws on short or foreign bytes.
 */
import { ceilingImrBps, dynImrBps, isBankruptcyHlockActive, leverageX100ForImrBps, openingPartQ } from "./sdk";
// R2.1: the quote, the fee preview and their types are the v2.2 growth port (a superset: without `v22` input the quote is the growth-1 one).
import {
  previewGrowthOpenFee,
  quoteMaxLeverage,
  type AssetGrowthV19,
  type GrowthOpenFeePreview,
  type MaxLeverageQuote,
  type QuoteMaxLeverageInput,
} from "../v22/sdk/records/growth-v19";
import { decodeAssetGrowthV19 } from "../v22/records";
import { layoutOf } from "../v22/layout";

/**
 * Absolute offset of the bankruptcy h-lock byte: `groupOff + (layout.group.mode - 5)`. 592 + 621 = 1213 on v2.1
 * (VERSION 18); the layout row moves it with the 48 B config growth on v2.2. Null when the account is not a
 * market of a known VERSION (flag on) so nothing is claimed.
 */
function hlockOffset(raw: Uint8Array): number | null {
  try {
    const L = layoutOf(raw, "readBankruptcyHlockActive");
    return L.marketGroupOff + (L.group.mode - 5);
  } catch {
    return null;
  }
}

/**
 * Whether the DEPLOYED wrapper (devnet 6kpg2wi7, percolator-prog 81ed7fdf) applies the v2.2 growth depth rules (lambda_eff, kappa cap,
 * stored ratchet ceiling). It does not: `growth_ceiling_x100` is `min(L_launch, L_tier)` ("absent depth is tier 0") and every N_cap is the
 * plain `n_cap_q(C_m, lambda_bps, effective_price)`. Flip this when the growth-depth upgrade is deployed; the quote logic stays.
 */
export const GROWTH_DEPTH_RULES_DEPLOYED = false;

/** A tier threshold nothing can reach (whole USD, u32 range): used only to pin the tier to 0 while the clock is unknown. */
const NO_TIER_USD = 4_000_000_000;

/** The record, or null when growth is OFF / the bytes are not a market account. Never throws. */
export function decodeGrowthRecord(raw: Uint8Array | null | undefined, assetIndex = 0): AssetGrowthV19 | null {
  if (!raw) return null;
  try {
    return decodeAssetGrowthV19(raw, assetIndex);
  } catch {
    return null;
  }
}

/** The market's bankruptcy h-lock is latched (the byte is non-zero; it is not only 0/1 any more). */
export function readBankruptcyHlockActive(raw: Uint8Array | null | undefined): boolean {
  if (!raw) return false;
  const off = hlockOffset(raw);
  if (off === null || raw.length <= off) return false;
  return isBankruptcyHlockActive(raw[off] as number);
}

export interface GrowthMarketInput {
  raw: Uint8Array | null | undefined;
  assetIndex?: number;
  engine: {
    initialMarginBps: bigint;
    effectivePriceE6: bigint;
    oiEffLongQ: bigint;
    oiEffShortQ: bigint;
    tradeFeeBaseBps: bigint;
    maxTradingFeeBps: bigint;
  };
  /** The bound vault LP portfolio's money fields; null while unread. */
  lp: { capital: bigint; pnl: bigint; feeCredits: bigint } | null;
  /** The vault LP's ADL-effective signed position (Q); null while unread. */
  lpEffectiveQ: bigint | null;
  /** The market's LP IS the asset's bound vault LP. */
  bound: boolean;
  /**
   * Devnet v2.2: engine `band_bps` and the polled cluster slot (null = unknown). Present, the quote applies the depth tier
   * (lambda_eff, kappa cap), graduation and the stored ratchet; with the slot unknown the CONSERVATIVE reading is used
   * (depth absent: tier 0, lambda 1x, no kappa cap). Absent, the growth-1 quote (flag off).
   */
  v22?: { bandBps: number; nowSlot: bigint | null };
}

export interface GrowthMarketView {
  record: AssetGrowthV19;
  quoteInput: QuoteMaxLeverageInput;
  long: MaxLeverageQuote;
  short: MaxLeverageQuote;
  hlockActive: boolean;
  tradeFeeBaseBps: bigint;
  maxTradingFeeBps: bigint;
}

/** Null when growth is OFF for this asset or the LP is not read yet (then nothing is claimed). */
export function growthMarketView(i: GrowthMarketInput): GrowthMarketView | null {
  const decoded = decodeGrowthRecord(i.raw, i.assetIndex ?? 0);
  if (!decoded || !i.lp || i.lpEffectiveQ === null) return null;
  // Clock unknown = the MOST conservative reading, never looser than a slot-known one: no tier can be earned (thresholds no pool
  // can reach: tier 0, so lambda 1x and the ceiling stays at launch), and the stored depth is read as fresh (the "now" is its own
  // slot), so the tier-0 kappa cap (0.5 x depth) still applies whenever a reading was ever stored. Slot-known readings only loosen.
  const unknownClock = !!i.v22 && i.v22.nowSlot === null;
  const record: AssetGrowthV19 = unknownClock
    ? { ...decoded, tierThresholdUsd: [NO_TIER_USD, NO_TIER_USD, NO_TIER_USD] }
    : decoded;
  const hlockActive = readBankruptcyHlockActive(i.raw);
  const quoteInput: QuoteMaxLeverageInput = {
    engineImrBps: i.engine.initialMarginBps,
    growth: record,
    lpCapital: i.lp.capital,
    lpPnl: i.lp.pnl,
    lpFeeCredits: i.lp.feeCredits,
    lpEffectivePositionQ: i.lpEffectiveQ,
    assetBound: i.bound,
    oiEffLongQ: i.engine.oiEffLongQ,
    oiEffShortQ: i.engine.oiEffShortQ,
    priceE6: i.engine.effectivePriceE6,
    bankruptcyHlockActive: hlockActive,
    ...(i.v22 ? { v22: { bandBps: i.v22.bandBps, nowSlot: i.v22.nowSlot ?? decoded.depthSlot } } : {}),
  };
  return {
    record,
    quoteInput,
    long: quoteMaxLeverage(quoteInput, "long"),
    short: quoteMaxLeverage(quoteInput, "short"),
    hlockActive,
    tradeFeeBaseBps: i.engine.tradeFeeBaseBps,
    maxTradingFeeBps: i.engine.maxTradingFeeBps,
  };
}

/** The order reduces or closes the taker's position (never blocked or clipped by growth capacity). */
export function isReducingOrder(takerEffQ: bigint, direction: "long" | "short", sizeQ: bigint): boolean {
  if (takerEffQ === 0n || sizeQ <= 0n) return false;
  const signed = direction === "long" ? sizeQ : -sizeQ;
  const after = takerEffQ + signed;
  if (after === 0n) return true;
  return (takerEffQ > 0n) === (after > 0n) && (after < 0n ? -after : after) <= (takerEffQ < 0n ? -takerEffQ : takerEffQ);
}

export interface GrowthFill {
  /** The opening part of the order the program would try to open (Q, unsigned). */
  openingQ: bigint;
  /** Room left on this side: `N_cap - users' OI` (Q); null when growth does not apply (a reduce / close, growth off). */
  roomQ: bigint | null;
  /** The size that will actually fill (Q, unsigned): the closing part plus `min(opening, room)`. Equals `sizeQ` when nothing is trimmed. */
  fillQ: bigint;
  /** The program trims this order to the side's room (it still lands; the fill is smaller than the ask). */
  trimmed: boolean;
}

/**
 * What the wrapper does to an order BEFORE the matcher (`p1_cpi_preflight_before_matcher`): an opening TradeCpi is clipped to
 * `min(ask, N_cap - users' OI on the side, LP headroom)`; a fill may land exactly on N_cap. A reduce / close is never clipped; a
 * flip keeps its closing part and only the opening part is clipped. Pure: `roomQ` is the quote's `headroomQ` (same N_cap and
 * same users' OI the program reads). A closed side has room 0.
 */
export function growthFillForOrder(view: GrowthMarketView, direction: "long" | "short", takerEffQ: bigint, sizeQ: bigint): GrowthFill {
  const quote = direction === "long" ? view.long : view.short;
  const none: GrowthFill = { openingQ: 0n, roomQ: null, fillQ: sizeQ, trimmed: false };
  if (sizeQ <= 0n || !quote.growthOn) return none;
  const signed = direction === "long" ? sizeQ : -sizeQ;
  const openingQ = openingPartQ(takerEffQ, takerEffQ + signed);
  if (openingQ === 0n) return none;
  const roomQ = quote.headroomQ ?? (quote.closed ? 0n : null);
  if (roomQ === null) return { ...none, openingQ };
  const fillOpening = openingQ < roomQ ? openingQ : roomQ;
  return { openingQ, roomQ, fillQ: sizeQ - openingQ + fillOpening, trimmed: fillOpening < openingQ };
}

export interface GrowthTicketDecision {
  /** The side quote the slider cap comes from. */
  quote: MaxLeverageQuote;
  /** Leverage cap for NEW risk (x, 2 dp); `null` = no cap from growth (a reduce, or growth off). */
  maxLeverage: number | null;
  /** New risk on this side is refused now (reduces and closes are never). */
  closed: boolean;
  /** Utilisation of this side, 0..1 (for the capacity bar); null while unknown. */
  utilisation: number | null;
  /** Utilisation fee preview for THIS order (zero for a reduce/close). */
  fee: GrowthOpenFeePreview | null;
  /** The order is a reduce or close: growth does not apply. */
  reducing: boolean;
  /** Room left on this side in Q (N_cap - users' OI, 0 when closed); null when growth does not apply. */
  roomQ: bigint | null;
  /** The size that will actually fill (Q); equals the ask unless the program trims it to the room. */
  fillQ: bigint;
  /** The program trims this order to the room (it lands as a partial fill; it is not refused). */
  trimmed: boolean;
  /** The leverage (x, 2 dp) the program allows at the post-fill users' OI of the size that FILLS; null when it does not apply (no size, reduce, closed). */
  fillMaxLeverage: number | null;
}

export function growthTicketDecision(
  view: GrowthMarketView,
  direction: "long" | "short",
  takerEffQ: bigint,
  sizeQ: bigint,
): GrowthTicketDecision {
  const d = growthTicketDecisionCore(view, direction, takerEffQ, sizeQ);
  return { ...d, fillMaxLeverage: maxLeverageAtFill(view, d, sizeQ) };
}

function growthTicketDecisionCore(
  view: GrowthMarketView,
  direction: "long" | "short",
  takerEffQ: bigint,
  sizeQ: bigint,
): Omit<GrowthTicketDecision, "fillMaxLeverage"> {
  const quote = direction === "long" ? view.long : view.short;
  const reducing = isReducingOrder(takerEffQ, direction, sizeQ);
  const utilisation = quote.utilizationBps === null ? null : Math.min(1, Number(quote.utilizationBps) / 10_000);
  const fill = growthFillForOrder(view, direction, takerEffQ, sizeQ);
  // The fee (and the users' OI after) is charged on the size that FILLS, not on the ask.
  const signedFill = direction === "long" ? fill.fillQ : -fill.fillQ;
  const fee = fill.fillQ > 0n ? previewGrowthOpenFee(view.quoteInput, takerEffQ, signedFill, view.tradeFeeBaseBps) : null;
  return {
    quote,
    reducing,
    roomQ: reducing ? null : fill.roomQ ?? (quote.growthOn ? quote.headroomQ : null),
    fillQ: fill.fillQ,
    trimmed: fill.trimmed,
    maxLeverage: reducing || quote.closed ? null : quote.maxLeverageX100 / 100,
    closed: !reducing && quote.closed,
    utilisation,
    fee: reducing ? null : fee,
  };
}

/**
 * The most leverage the program lets THIS order open (Custom 92's own limit), as a plain number (x, 2 dp, rounded DOWN so the
 * figure always passes). The wrapper checks the requirement at the users' open interest AFTER the fill, so on the crowd side this is
 * `floor(1e6 / dynImr(OI_users + opening part, N_cap, base, kink))`, not the current-OI quote (an upper bound); on the thin side it is
 * the launch ceiling. `null` when growth does not apply to the order (a reduce / close, a closed side, an unreadable view) or the
 * fill would push the side past capacity (that is Custom 93, not 92): the caller then says nothing numeric.
 */
export function growthMaxLeverageForOrder(
  view: GrowthMarketView,
  direction: "long" | "short",
  takerEffQ: bigint,
  sizeQ: bigint,
): number | null {
  return maxLeverageAtFill(view, growthTicketDecisionCore(view, direction, takerEffQ, sizeQ), sizeQ);
}

function maxLeverageAtFill(view: GrowthMarketView, d: Omit<GrowthTicketDecision, "fillMaxLeverage">, sizeQ: bigint): number | null {
  if (d.reducing || d.closed || sizeQ <= 0n) return null;
  const q = d.quote;
  if (!q.growthOn) return null;
  if (!q.crowd) return q.maxLeverageX100 > 0 ? q.maxLeverageX100 / 100 : null;
  const nCap = q.nCapQ;
  const g = view.record;
  // The ceiling in force (graduation / tiers when the v2.2 rules apply), the same number the gate and the quote use.
  const base = ceilingImrBps(view.quoteInput.engineImrBps, q.ceilingX100 > 0 ? q.ceilingX100 : Math.min(g.lLaunchX100, g.lTierX100));
  const usersAfter = d.fee?.usersOiAfterQ;
  if (nCap === null || base === null || usersAfter === undefined) return null;
  const dyn = dynImrBps(usersAfter, nCap, base, g.kinkBps);
  if (dyn === null) return null;
  const x100 = leverageX100ForImrBps(dyn);
  return x100 === null || x100 <= 0n ? null : Number(x100) / 100;
}

/**
 * The ticket's leverage pre-check (Custom 92's mirror). Returns the max leverage to name when the order is genuinely over-leveraged,
 * else `null`.
 *
 * An order that the program trims to the side's room is judged on what FILLS, never on the ask: the margin the trader set aside for
 * the ask now backs `fillQ` only, so its leverage is `leverage * fillQ / sizeQ`, compared with the leverage the program allows at the
 * post-fill users' OI of that clipped size ({@link growthMaxLeverageForOrder}). An untrimmed order keeps the quote's marginal cap.
 */
export function growthLeverageRefusal(
  view: GrowthMarketView,
  direction: "long" | "short",
  takerEffQ: bigint,
  sizeQ: bigint,
  leverage: number,
): number | null {
  const d = growthTicketDecision(view, direction, takerEffQ, sizeQ);
  if (d.reducing || d.closed || sizeQ <= 0n) return null;
  if (!d.trimmed) return d.maxLeverage !== null && leverage > d.maxLeverage ? d.maxLeverage : null;
  if (d.fillQ <= 0n) return null;
  const allowed = growthMaxLeverageForOrder(view, direction, takerEffQ, sizeQ);
  if (allowed === null) return null;
  const effective = (leverage * Number(d.fillQ)) / Number(sizeQ);
  return effective > allowed ? allowed : null;
}

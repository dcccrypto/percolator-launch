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
import {
  isBankruptcyHlockActive,
  previewGrowthOpenFee,
  quoteMaxLeverage,
  type AssetGrowthV19,
  type GrowthOpenFeePreview,
  type MaxLeverageQuote,
  type QuoteMaxLeverageInput,
} from "./sdk";
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
  const record = decodeGrowthRecord(i.raw, i.assetIndex ?? 0);
  if (!record || !i.lp || i.lpEffectiveQ === null) return null;
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
}

export function growthTicketDecision(
  view: GrowthMarketView,
  direction: "long" | "short",
  takerEffQ: bigint,
  sizeQ: bigint,
): GrowthTicketDecision {
  const quote = direction === "long" ? view.long : view.short;
  const reducing = isReducingOrder(takerEffQ, direction, sizeQ);
  const utilisation = quote.utilizationBps === null ? null : Math.min(1, Number(quote.utilizationBps) / 10_000);
  const signed = direction === "long" ? sizeQ : -sizeQ;
  const fee = sizeQ > 0n ? previewGrowthOpenFee(view.quoteInput, takerEffQ, signed, view.tradeFeeBaseBps) : null;
  return {
    quote,
    reducing,
    maxLeverage: reducing || quote.closed ? null : quote.maxLeverageX100 / 100,
    closed: !reducing && quote.closed,
    utilisation,
    fee: reducing ? null : fee,
  };
}

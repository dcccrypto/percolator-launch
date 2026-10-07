/**
 * Lot pricing (wrapper Wave A item 7, docs/v22-wave-a-wire.md:40-46). A market's base unit is a LOT of 10^lot_exp
 * tokens: every mark and `initial_price` is PER LOT and every position `q` is IN LOTS (POS_SCALE per lot). The engine,
 * matcher and wrapper convert nothing, so EVERY app surface must convert through THIS module and nowhere else:
 *
 *   price per token  = mark_e6 / 1e6 / 10^lotExp        (displayPrice)
 *   size in tokens   = q / POS_SCALE * 10^lotExp        (qToTokens)
 *   size in lots (q) = trunc(tokens / 10^lotExp)        (tokensToQ, remainder reported, never silently dropped)
 *
 * `lotExpOf(raw)` reads the market's lot exponent (0 on a v2.1 market, a flag-off build, or any unreadable buffer, so
 * a market without lots is untouched).
 */
import { isDevnetV22Enabled } from "./flag";
import { LAYOUT_V22, UnknownLayoutError, displayPriceV22, resolveMarketGeometry, tokensToLotsV22 } from "./sdk";

/** Engine position scale: Q units per lot (or per token when lotExp = 0). */
export const POS_SCALE_V22 = 1_000_000n;

let lotMarketsOverride: boolean | null = null;
/**
 * Whether the wizard may CREATE a lot market (token under $10). It stays false until every trade surface converts
 * through this module (see __tests__/lib/v22/lot-surfaces.test.ts, one test per surface). Test seam only.
 */
export function __setLotMarketsEnabledForTest(v: boolean | null): void {
  lotMarketsOverride = v;
}
export function lotMarketsEnabled(): boolean {
  return lotMarketsOverride ?? LOT_MARKETS_ENABLED;
}
export const LOT_MARKETS_ENABLED = false;

/** The market's lot exponent for asset `assetIndex`; 0 when there is none or the account is not a v2.2 market. */
export function lotExpOf(raw: Uint8Array | null | undefined, assetIndex = 0): number {
  if (!raw || !isDevnetV22Enabled()) return 0;
  try {
    const g = resolveMarketGeometry(raw, { parser: "lotExpOf", strictLength: false });
    if (assetIndex < 0 || assetIndex >= g.slotCount || g.layout.version !== LAYOUT_V22.version) return 0;
    return raw[g.slotOff(assetIndex) + g.layout.wrapperSlot.profileLotExp] ?? 0;
  } catch (e) {
    if (e instanceof UnknownLayoutError) return 0;
    return 0;
  }
}

const TEN = 10n;
const pow10 = (k: number): bigint => TEN ** BigInt(k);

/** Per-lot e6 price to the per-TOKEN e6 price (integer, rounded down). lotExp 0 returns the input. */
export function lotPriceToTokenE6(perLotE6: bigint, lotExp: number): bigint {
  return lotExp === 0 ? perLotE6 : perLotE6 / pow10(lotExp);
}

/** Per-token e6 price to the per-lot e6 price. */
export function tokenPriceToLotE6(perTokenE6: bigint, lotExp: number): bigint {
  return perTokenE6 * pow10(lotExp);
}

/** Exact decimal string of the per-token price (SDK `displayPriceV22`). */
export function displayTokenPrice(perLotE6: bigint, lotExp: number): string {
  return lotExp === 0 ? (Number(perLotE6) / 1e6).toString() : displayPriceV22(perLotE6, lotExp);
}

/** Engine Q (signed or not) to whole-token-scaled Q: `q * 10^lotExp` keeps POS_SCALE as the unit, now per TOKEN. */
export function qToTokenQ(q: bigint, lotExp: number): bigint {
  return lotExp === 0 ? q : q * pow10(lotExp);
}

/**
 * A size typed in tokens (as Q units per token, POS_SCALE = 1e6) to the engine Q in lots, rounding toward zero.
 * `remainderTokenQ` is the part that cannot be expressed in lots (show it; never send it).
 */
export function tokenQToQ(tokenQ: bigint, lotExp: number): { q: bigint; remainderTokenQ: bigint } {
  if (lotExp === 0) return { q: tokenQ, remainderTokenQ: 0n };
  const neg = tokenQ < 0n;
  const abs = neg ? -tokenQ : tokenQ;
  const { lots, remainderTokens } = tokensToLotsV22(abs, lotExp);
  return { q: neg ? -lots : lots, remainderTokenQ: neg ? -remainderTokens : remainderTokens };
}

/** A value per unit of Q (a per-lot PnL / notional input) cannot be rescaled: only q and price carry the lot. */
export const LOT_NOTE = "1 lot = 10^lotExp tokens";

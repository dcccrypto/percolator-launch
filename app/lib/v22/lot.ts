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

// ── Trade-surface helpers (G3) ───────────────────────────────────────────
import { formatMarkPrice, formatTokenAmount, formatUsdPriceE6 } from "../format";

/** Q-units of float / atom-truncation slack when quantising a typed size to lots (see quantizeQToLots). */
export const QUANTISE_TOLERANCE_Q = 2n;

/** Whole lots only: a typed size is quantised DOWN to a lot multiple (Q is POS_SCALE per lot). Identity when lotExp = 0. */
export function quantizeQToLots(q: bigint, lotExp: number): { q: bigint; remainderQ: bigint } {
  if (lotExp === 0) return { q, remainderQ: 0n };
  const neg = q < 0n;
  const abs = neg ? -q : q;
  let whole = (abs / POS_SCALE_V22) * POS_SCALE_V22;
  let rem = abs - whole;
  // The ticket derives Q from a margin truncated to collateral atoms, so an EXACT whole-lot size typed in tokens can land
  // a hair under the lot (e.g. 999,999 of 1,000,000 Q). Within QUANTISE_TOLERANCE_Q of the next lot counts as that lot
  // (2e-6 of a lot; far below one atom of margin at the $10 per-lot floor), never more.
  if (POS_SCALE_V22 - rem <= QUANTISE_TOLERANCE_Q && rem !== 0n) {
    whole += POS_SCALE_V22;
    rem = 0n;
  }
  return { q: neg ? -whole : whole, remainderQ: neg ? -rem : rem };
}

/** The tokens a Q (in lots) is worth, as a Q-scaled bigint (POS_SCALE per token). Same as qToTokenQ. */
export const lotQToTokenQ = qToTokenQ;

/** USD price per TOKEN from the per-lot USD price (a float, for display / typed-size maths). Identity at lotExp = 0. */
export function tokenUsdOfLotUsd(perLotUsd: number, lotExp: number): number {
  return lotExp === 0 ? perLotUsd : perLotUsd / 10 ** lotExp;
}

/** Display a per-lot e6 mark/entry/liquidation price per token. Byte-identical to formatUsdPriceE6 at lotExp = 0. */
export function formatLotPriceE6(perLotE6: bigint | null | undefined, lotExp: number, fallback = "—"): string {
  if (lotExp === 0 || perLotE6 == null) return formatUsdPriceE6(perLotE6, fallback);
  if (perLotE6 <= 0n) return fallback;
  return formatMarkPrice(tokenUsdOfLotUsd(Number(perLotE6) / 1e6, lotExp), fallback);
}

/** Display a position size (engine Q in lots) in TOKENS. Byte-identical to formatTokenAmount at lotExp = 0. */
export function formatLotQ(q: bigint | null | undefined, decimals: number, lotExp: number, maxDisplayDecimals?: number): string {
  if (q == null || lotExp === 0) return formatTokenAmount(q, decimals, maxDisplayDecimals);
  return formatTokenAmount(qToTokenQ(q, lotExp), decimals, maxDisplayDecimals);
}

/*
 * UNIT CONTRACT (set by fork G4, relied on by every surface):
 *  - Everything INSIDE the app's price/size plumbing stays in the engine's unit: price per LOT (e6), size in LOTS (Q,
 *    POS_SCALE per lot). PnL, margin, liquidation maths and the price store therefore need no conversion.
 *  - priceStore (lib/priceStore) stores per-LOT prices: feeds that quote per TOKEN (WS ticks, the DB / API `last_price`)
 *    are scaled by 10^lotExp on ingestion (`setLotExp`, driven by useLivePrice from the slab bytes).
 *  - CONVERSION HAPPENS ONLY AT THE EDGES: display (formatLotPriceE6 / formatLotQ / tokenUsdOfLotUsd), typed input
 *    (tokenQToQ / quantizeQToLots) and API output (lib/v22/lot-view.ts). The /api/markets, /api/markets/[slab] and
 *    /api/open-interest routes OUTPUT per-token prices and token-scaled OI (what external consumers expect).
 */

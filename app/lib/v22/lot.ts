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
import {
  displayPriceV22,
  lotExpOfMarketV22,
  lotPriceToTokenE6V22,
  qToTokenQV22,
  quantizeQToLotsV22,
  tokenPriceToLotE6V22,
  tokenQToQV22,
} from "./sdk";

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

/** The market's lot exponent for asset `assetIndex` (SDK `lotExpOfMarketV22`); 0 when flag off / not a v2.2 market / unreadable. */
export function lotExpOf(raw: Uint8Array | null | undefined, assetIndex = 0): number {
  if (!raw || !isDevnetV22Enabled()) return 0;
  try {
    return lotExpOfMarketV22(raw, assetIndex);
  } catch {
    return 0;
  }
}

/** Per-lot e6 price to the per-TOKEN e6 price (SDK, integer, rounded down). lotExp 0 returns the input. */
export const lotPriceToTokenE6 = (perLotE6: bigint, lotExp: number): bigint => (lotExp === 0 ? perLotE6 : lotPriceToTokenE6V22(perLotE6, lotExp));

/** Per-token e6 price to the per-lot e6 price (SDK). */
export const tokenPriceToLotE6 = (perTokenE6: bigint, lotExp: number): bigint => (lotExp === 0 ? perTokenE6 : tokenPriceToLotE6V22(perTokenE6, lotExp));

/** Exact decimal string of the per-token price (SDK `displayPriceV22`). */
export function displayTokenPrice(perLotE6: bigint, lotExp: number): string {
  return lotExp === 0 ? (Number(perLotE6) / 1e6).toString() : displayPriceV22(perLotE6, lotExp);
}

/** Engine Q in lots to Q per TOKEN (`q * 10^lotExp`, SDK). */
export const qToTokenQ = (q: bigint, lotExp: number): bigint => (lotExp === 0 ? q : qToTokenQV22(q, lotExp));

/** A size typed in tokens (Q units per token) to the engine Q in lots, truncating toward zero; the remainder is shown, never sent (SDK). */
export function tokenQToQ(tokenQ: bigint, lotExp: number): { q: bigint; remainderTokenQ: bigint } {
  return lotExp === 0 ? { q: tokenQ, remainderTokenQ: 0n } : tokenQToQV22(tokenQ, lotExp);
}

/** A value per unit of Q (a per-lot PnL / notional input) cannot be rescaled: only q and price carry the lot. */
export const LOT_NOTE = "1 lot = 10^lotExp tokens";

// ── Trade-surface helpers (G3) ───────────────────────────────────────────
import { formatMarkPrice, formatTokenAmount, formatUsdPriceE6 } from "../format";

/**
 * Whole lots only: a Q is truncated toward zero to a lot multiple (SDK `quantizeQToLotsV22`) and the remainder is
 * reported. It NEVER rounds up (the old 2-Q tolerance is gone): an exact whole-lot size is made exact by deriving Q
 * from the typed token size in the ticket, not by rounding a margin-derived Q up. Identity when lotExp = 0.
 */
export function quantizeQToLots(q: bigint, lotExp: number): { q: bigint; remainderQ: bigint } {
  return lotExp === 0 ? { q, remainderQ: 0n } : quantizeQToLotsV22(q);
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

/**
 * The Q (in lots) an order carries: the margin-derived Q truncated to whole lots, EXCEPT that an exact whole-lot size typed
 * in tokens stays exact. The ticket derives Q from a margin truncated to collateral atoms, which can land a hair under the
 * lot (999,999 of 1,000,000 Q); instead of rounding that up we take the typed token size when it agrees with the
 * margin-derived Q to within one lot. `typedTokenQ` is the typed size as Q per token (POS_SCALE), or null.
 */
export function lotOrderQ(marginDerivedQ: bigint, typedTokenQ: bigint | null, lotExp: number): { q: bigint; remainderQ: bigint } {
  const base = marginDerivedQ < 0n ? 0n : marginDerivedQ;
  if (lotExp === 0) return { q: base, remainderQ: 0n };
  let source = base;
  if (typedTokenQ !== null && typedTokenQ > 0n) {
    const typedQ = tokenQToQ(typedTokenQ, lotExp).q;
    const diff = typedQ > base ? typedQ - base : base - typedQ;
    if (typedQ > 0n && diff <= POS_SCALE_V22) source = typedQ;
  }
  return quantizeQToLots(source, lotExp);
}

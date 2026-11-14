/**
 * Safety caps for bot orders, checked inside the builder (TradeBuildRequest.preflight) once the market, the limit and the
 * owner's position are known and before anything is simulated. Defaults are deliberately tighter than the app's:
 * a refused order is safe, an overfilled one is not.
 *
 *   slippage   default 100 bps around the engine effective price, max 1000 (the app uses 500, lib/slippage.ts:44)
 *   limit      an explicit limitPriceE6 may not sit more than 1000 bps on the adverse side of the effective price
 *   notional   |size| x effective price <= min(caller maxNotionalUsd, BOT_API_MAX_NOTIONAL_USD, default 5000), PER ORDER (not per position)
 *   leverage   after the order: notional / conservative equity <= min(caller maxLeverage, market max, BOT_API_MAX_LEVERAGE, default 10)
 *              (builders/equity.ts: capital less the open legs' unrealized loss, stored AND pending K/F, and negative fee credits; the same equity
 *              GET /v1/account reports leverage on)
 *   reduceOnly refuse unless the order shrinks the position without flipping it
 *   size       |size| <= the market's per-side maximum (checkOpenMarketGuards), and the oracle must be fresh
 * The position every check uses is the ADL-EFFECTIVE one (lib/limits/effective-quantity.ts), the quantity the engine
 * applies a trade to. An unreadable position refuses every order.
 * A reducing order skips the notional, leverage, size and freshness checks (it lowers risk; a cap must never trap a
 * position open).
 * Sizes: q units; notional atoms = |q| x priceE6 / 1e6 (lib/trading.ts computePositionInitialMargin). The USD value of an
 * atom comes from the market's collateral mint (builders/collateral.ts); a mint it cannot value is market_unsupported.
 */
import { ApiError } from "@/lib/bot-api/errors";
import type { TradePreflight } from "@/lib/v22/trade-build";
import { decodePortfolioRisk } from "@/lib/limits/decode";
import { maxLeverageFromSlab } from "@/lib/slab-max-leverage";
import type { Connection } from "@solana/web3.js";
import { requireValuedCollateral } from "./collateral";
import { conservativeEquity } from "./equity";
import { openLegsValuePnl } from "../reads/account";
import { decodeMarket } from "../reads/market";
import { buildQuoteSource, expectedFee, matcherQuote } from "../reads/quote";
import { quoteFailsLimit } from "@/lib/limits/matcher-quote";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { UNLIMITED_CAPACITY } from "@/lib/marketCapacity";

export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 1000;
export const DEFAULT_MAX_NOTIONAL_USD = 5000;
export const DEFAULT_MAX_LEVERAGE = 10;

export interface OrderCaps {
  reduceOnly: boolean;
  /** Effective slippage the limit is built from (ignored when limitPriceE6 is explicit). */
  slippageBps: number;
  maxNotionalUsd: number;
  maxLeverage: number;
  explicitLimit: boolean;
}

function envNumber(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export function serverCaps() {
  return {
    maxNotionalUsd: envNumber("BOT_API_MAX_NOTIONAL_USD", DEFAULT_MAX_NOTIONAL_USD),
    maxLeverage: envNumber("BOT_API_MAX_LEVERAGE", DEFAULT_MAX_LEVERAGE),
  };
}

/** Caller values lowered to the server's caps (a caller can only tighten). */
export function resolveCaps(req: { reduceOnly?: boolean; slippageBps?: number; maxNotionalUsd?: number; maxLeverage?: number; explicitLimit: boolean }): OrderCaps {
  const s = serverCaps();
  if (req.slippageBps !== undefined && req.slippageBps > MAX_SLIPPAGE_BPS) throw new ApiError("slippage_cap_exceeded", `slippageBps must be <= ${MAX_SLIPPAGE_BPS}`);
  return {
    reduceOnly: req.reduceOnly ?? false,
    slippageBps: req.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    maxNotionalUsd: Math.min(req.maxNotionalUsd ?? s.maxNotionalUsd, s.maxNotionalUsd),
    maxLeverage: Math.min(req.maxLeverage ?? s.maxLeverage, s.maxLeverage),
    explicitLimit: req.explicitLimit,
  };
}

const abs = (n: bigint) => (n < 0n ? -n : n);

/** The USD cap in collateral atoms of `decimals`, at micro-USD precision (a fractional cap is honoured, not floored to whole USD). */
export function notionalCapAtoms(maxNotionalUsd: number, decimals: number): bigint {
  const micro = BigInt(Math.floor(maxNotionalUsd * 1e6));
  return (micro * 10n ** BigInt(decimals)) / 1_000_000n;
}

/** The preflight the order builder runs. Throws ApiError; returns the applied numbers for the summary. */
export function checkOrderCaps(caps: OrderCaps, p: TradePreflight): { notionalUsd: number; leverageAfter: number | null; marketMaxLeverage: number | null } {
  const px = p.effectivePriceE6;
  if (px <= 0n) throw new ApiError("market_unreadable", "the market's effective price is unreadable; nothing built");
  // The position is unreadable (the engine would refuse the leg, or the market's engine view does not decode): every order
  // is refused, because leverage and reduce-only both need it. Never read as a flat account.
  if (p.positionBeforeQ === null) throw new ApiError("market_unreadable", "the current position is unreadable, so the order cannot be checked");
  const before = p.positionBeforeQ;

  if (caps.reduceOnly && !p.reducing) {
    throw new ApiError(before === 0n ? "no_position" : "reduce_only_violation");
  }

  if (caps.explicitLimit) {
    // Adverse side: a buy pays up to the limit, a sell receives down to it.
    const adverse = p.size > 0n ? p.limitPriceE6 - px : px - p.limitPriceE6;
    if (adverse > 0n && adverse * 10_000n > px * BigInt(MAX_SLIPPAGE_BPS)) {
      throw new ApiError("slippage_cap_exceeded", `limitPriceE6 is more than ${MAX_SLIPPAGE_BPS} bps worse than the effective price ${px}`);
    }
  }

  const marketMax = maxLeverageFromSlab(p.marketData);
  if (p.reducing) {
    // Reporting only: a reducing order is never refused for its size, so an unvalued mint just reports 0.
    return { notionalUsd: 0, leverageAfter: null, marketMaxLeverage: marketMax };
  }

  // Everything below is in the market's collateral atoms; the mint decides what an atom is worth.
  const { decimals } = requireValuedCollateral(p.marketData);
  const orderNotional = (abs(p.size) * px) / 1_000_000n;
  const notionalUsd = Number(orderNotional) / 10 ** decimals;
  if (orderNotional > notionalCapAtoms(caps.maxNotionalUsd, decimals)) {
    throw new ApiError("notional_cap_exceeded", `order notional ${notionalUsd.toFixed(2)} USD is above the ${caps.maxNotionalUsd} USD per-order cap`, {
      details: { notionalUsd, capUsd: caps.maxNotionalUsd },
    });
  }

  const afterNotional = (abs(before + p.size) * px) / 1_000_000n;
  const risk = p.portfolioData ? decodePortfolioRisk(p.portfolioData) : null;
  if (!risk || !p.portfolioData) throw new ApiError("market_unreadable", "the trading account is unreadable, so leverage cannot be checked");
  // The account's PnL at the effective price: stored pnl + the K/F each open leg has accrued since its snapshot (the engine's
  // settle arithmetic, reads/pending-pnl.ts). An under-water position, settled or not, lowers the equity the cap divides by.
  // 0 is a valid stored pnl; only a leg whose pending cannot be computed (older ADL epoch, stale leg) is unreadable.
  const leg = openLegsValuePnl(p.marketData, p.portfolioData);
  if (leg.kind === "unreadable") throw new ApiError("market_unreadable", "the open position cannot be valued, so leverage cannot be checked");
  const equity = conservativeEquity(risk.capital, leg.kind === "open" ? leg.valuePnl : risk.pnl, risk.feeCredits);
  const cap = Math.min(caps.maxLeverage, marketMax ?? caps.maxLeverage);
  if (equity <= 0n) throw new ApiError("insufficient_margin", "the trading account has no equity");
  // afterNotional / equity > cap  <=>  afterNotional * 100 > cap*100 * equity  (cap to 0.01x)
  const capX100 = BigInt(Math.floor(cap * 100));
  const leverageAfter = Number((afterNotional * 10_000n) / equity) / 10_000;
  if (afterNotional * 100n > capX100 * equity) {
    throw new ApiError("leverage_cap_exceeded", `leverage after this order would be ${leverageAfter.toFixed(2)}x, above the ${cap}x cap`, {
      details: { leverageAfter, cap },
    });
  }
  return { notionalUsd, leverageAfter, marketMaxLeverage: marketMax };
}

/**
 * The smallest whole slippageBps (measured from the effective price, the mark) whose limit still accepts an expected fill at
 * `execE6`: slippage is not measured from the fill, so it has to cover the spread, the matcher's fee and the size impact too.
 * Uses the builder's own rounding (computeLimitPriceE6), so slippageBps = this value passes the check below.
 */
export function minSlippageBpsFor(markE6: bigint, execE6: bigint, buy: boolean): number {
  const adverse = buy ? execE6 - markE6 : markE6 - execE6;
  // Start just under the exact figure and walk up: the builder's limit rounds against the taker, so the exact ceiling can be one too high.
  let bps = adverse <= 0n ? 1n : (adverse * 10_000n) / markE6 - 1n;
  if (bps < 1n) bps = 1n;
  const size = buy ? 1n : -1n;
  for (let i = 0; i < 6 && quoteFailsLimit(execE6, computeLimitPriceE6({ markE6, size, slippageBps: bps }), buy); i++) bps += 1n;
  return Number(bps);
}

export interface MarketGuardResult {
  /** What the fill is expected to charge (bps of notional, atoms); null when unknown. See reads/quote.ts expectedFee. */
  expectedFeeBps: number | null;
  expectedFeeAtoms: bigint | null;
}
const NO_FEE: MarketGuardResult = { expectedFeeBps: null, expectedFeeAtoms: null };

/**
 * Checks that need a fresh read of the market, the LP and the matcher, for orders that add risk:
 *  - the oracle is fresh, by the SAME rule GET /v1/markets exposes (reads/market.ts oracle.stale): else market_stale;
 *  - |size| is within the market's per-side maximum (the quote's maxSizePerSide, from the taker's effective position):
 *    else size_cap_exceeded.
 * A reducing order is NEVER refused here (a stale oracle or a size cap must not trap a position open); the read is still
 * tried so its fee estimate can be reported, and any failure of it just leaves the estimate null.
 * One getMultipleAccountsInfoAndContext; its context slot is the read's slot.
 */
export async function checkOpenMarketGuards(connection: Pick<Connection, "getMultipleAccountsInfoAndContext">, p: TradePreflight): Promise<MarketGuardResult> {
  const enforce = !p.reducing;
  try {
    const res = await connection.getMultipleAccountsInfoAndContext([p.market, p.lp.matcherCtx, p.lp.accountB], "confirmed").catch(() => {
      throw new ApiError("rpc_unavailable");
    });
    const [m, c, pf] = res.value;
    if (!m) throw new ApiError("market_not_found");
    if (!c || !pf) throw new ApiError("no_lp");
    const at = { market: p.market, programId: p.programId, slot: res.context.slot };
    const md = new Uint8Array(m.data);
    const view = decodeMarket(md, at);
    if (enforce && view.oracle.stale) {
      throw new ApiError("market_stale", `the market's oracle price is stale (${view.oracle.ageSecs === null ? "never pushed" : `${Math.round(view.oracle.ageSecs)} s old`}, bound ${view.oracle.staleBoundSecs} s); orders that add risk are refused until it is refreshed`, {
        details: { ageSecs: view.oracle.ageSecs, staleBoundSecs: view.oracle.staleBoundSecs },
      });
    }
    const src = buildQuoteSource(md, new Uint8Array(c.data), new Uint8Array(pf.data), p.lp.accountB, at, p.positionBeforeQ ?? 0n);
    const mq = matcherQuote(src, p.size);
    if (enforce && mq && mq.fillQ > 0n && mq.quotePriceE6 !== null) {
      // The program refuses a fill past the limit (buy: exec <= limit; sell: exec >= limit) with an opaque InvalidInstruction. The
      // matcher's own estimate (the quote's estExecPriceE6) is checked first, so the caller gets the number that would pass. Not
      // applied to a reducing order: the estimate does not model the close exemption, so it can only be worse than the real fill.
      const buy = p.size > 0n;
      if (quoteFailsLimit(mq.quotePriceE6, p.limitPriceE6, buy)) {
        const minSlippageBps = minSlippageBpsFor(src.effectivePriceE6, mq.quotePriceE6, buy);
        throw new ApiError(
          "slippage_cap_exceeded",
          `the limit ${p.limitPriceE6} is ${buy ? "below" : "above"} the matcher's estimated fill price ${mq.quotePriceE6}; slippage is measured from the mark (${src.effectivePriceE6}), so it must also cover the spread, fee and size impact: ${minSlippageBps <= MAX_SLIPPAGE_BPS ? `use slippageBps >= ${minSlippageBps} or a looser limitPriceE6` : `the fill needs ${minSlippageBps} bps, above the ${MAX_SLIPPAGE_BPS} bps maximum; try a smaller size`}`,
          { details: { limitPriceE6: p.limitPriceE6.toString(), estExecPriceE6: mq.quotePriceE6.toString(), minSlippageBps } },
        );
      }
    }
    if (enforce) {
      const side = p.size > 0n ? "long" : "short";
      const max = src.maxSizePerSide[side];
      if (max.maxQ < UNLIMITED_CAPACITY && abs(p.size) > max.maxQ) {
        throw new ApiError("size_cap_exceeded", `order size ${abs(p.size)} is above the market's current ${p.size > 0n ? "buy" : "sell"} maximum of ${max.maxQ} (${max.reason})`, {
          details: { maxQ: max.maxQ.toString(), side, reason: max.reason },
        });
      }
    }
    const f = expectedFee(src.baseFeeBps, mq, (abs(p.size) * src.effectivePriceE6) / 1_000_000n);
    return { expectedFeeBps: f.bps, expectedFeeAtoms: f.atoms };
  } catch (e) {
    if (enforce) throw e;
    return NO_FEE;
  }
}

/**
 * Safety caps for bot orders, checked inside the builder (TradeBuildRequest.preflight) once the market, the limit and the
 * owner's position are known and before anything is simulated. Defaults are deliberately tighter than the app's:
 * a refused order is safe, an overfilled one is not.
 *
 *   slippage   default 100 bps around the engine effective price, max 1000 (the app uses 500, lib/slippage.ts:44)
 *   limit      an explicit limitPriceE6 may not sit more than 1000 bps on the adverse side of the effective price
 *   notional   |size| x effective price <= min(caller maxNotionalUsd, BOT_API_MAX_NOTIONAL_USD, default 5000)
 *   leverage   after the order: notional / conservative equity <= min(caller maxLeverage, market max, BOT_API_MAX_LEVERAGE, default 10)
 *   reduceOnly refuse unless the order shrinks the position without flipping it
 * A reducing order skips the notional and leverage caps (it lowers risk; a cap must never trap a position open).
 * Sizes: q units; notional atoms = |q| x priceE6 / 1e6 (lib/trading.ts computePositionInitialMargin); collateral is a
 * 6-decimal USD stable on devnet, so 1 USD = 1e6 atoms.
 */
import { ApiError } from "@/lib/bot-api/errors";
import type { TradePreflight } from "@/lib/v22/trade-build";
import { decodePortfolioRisk } from "@/lib/limits/decode";
import { maxLeverageFromSlab } from "@/lib/slab-max-leverage";

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
const USD = 1_000_000n;

/** The preflight the order builder runs. Throws ApiError; returns the applied numbers for the summary. */
export function checkOrderCaps(caps: OrderCaps, p: TradePreflight): { notionalUsd: number; leverageAfter: number | null; marketMaxLeverage: number | null } {
  const px = p.effectivePriceE6;
  if (px <= 0n) throw new ApiError("market_unreadable", "the market's effective price is unreadable; nothing built");

  if (caps.reduceOnly && !p.reducing) {
    throw new ApiError(
      p.positionBeforeQ === null ? "market_unreadable" : p.positionBeforeQ === 0n ? "no_position" : "reduce_only_violation",
      p.positionBeforeQ === null ? "the current position is unreadable, so reduce-only cannot be checked" : undefined,
    );
  }

  if (caps.explicitLimit) {
    // Adverse side: a buy pays up to the limit, a sell receives down to it.
    const adverse = p.size > 0n ? p.limitPriceE6 - px : px - p.limitPriceE6;
    if (adverse > 0n && adverse * 10_000n > px * BigInt(MAX_SLIPPAGE_BPS)) {
      throw new ApiError("slippage_cap_exceeded", `limitPriceE6 is more than ${MAX_SLIPPAGE_BPS} bps worse than the effective price ${px}`);
    }
  }

  const orderNotional = (abs(p.size) * px) / 1_000_000n;
  const notionalUsd = Number(orderNotional) / 1e6;
  const marketMax = maxLeverageFromSlab(p.marketData);
  if (p.reducing) return { notionalUsd, leverageAfter: null, marketMaxLeverage: marketMax };

  if (orderNotional > BigInt(Math.floor(caps.maxNotionalUsd)) * USD) {
    throw new ApiError("notional_cap_exceeded", `order notional ${notionalUsd.toFixed(2)} USD is above the ${caps.maxNotionalUsd} USD cap`, {
      details: { notionalUsd, capUsd: caps.maxNotionalUsd },
    });
  }

  const before = p.positionBeforeQ ?? 0n;
  const afterNotional = (abs(before + p.size) * px) / 1_000_000n;
  const risk = p.portfolioData ? decodePortfolioRisk(p.portfolioData) : null;
  if (!risk) throw new ApiError("market_unreadable", "the trading account is unreadable, so leverage cannot be checked");
  const negPnl = risk.pnl < 0n ? risk.pnl : 0n;
  const negFee = risk.feeCredits < 0n ? risk.feeCredits : 0n;
  const equity = risk.capital + negPnl + negFee;
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

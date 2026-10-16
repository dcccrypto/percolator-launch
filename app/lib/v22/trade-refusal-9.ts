/**
 * Q-1 / Q-6 (v2.2 QA 2026-10-11): name the cause of a Custom(9) InvalidInstruction on a v2.2 trade.
 *
 * Wrapper RC 6c078a0e `handle_trade_cpi` answers 9 for (among client bugs that never happen from the
 * app's builder): the taker's signed fee cap below base + the matcher's request (or above the
 * market's max_trading_fee_bps), the matcher's fill price outside the taker's limit price, and a new
 * asset on an account that already holds the maximum of 4 positions (v2.2 cap; QA P-1: refused 9,
 * not a named error). The code alone can't tell them apart, so the old line guessed "slippage".
 *
 * This reads the market, the LP's matcher context and the taker's portfolio once (failure path
 * only, bounded by a deadline) and picks the cause that the state PROVES; otherwise an honest
 * line with no guess. Flag-gated by the caller (isDevnetV22Enabled).
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeMarketEngineView, decodeMatcherCtx, decodePortfolioLegs } from "@/lib/limits/decode";
import { preTradeQuote } from "@/lib/limits/matcher-quote";
import { resolveTradeFeeBps } from "@/lib/limits/trade-fee-resolve";

import { V22_CUSTOM9_COPY, positionCapBlocksOpen, positionCapCopy, type V22Custom9Cause } from "./trade-refusal-9-copy";
import { readMaxPortfolioAssets } from "./market-cap";

export { V22_CUSTOM9_COPY, V22_CUSTOM9_GENERIC, V22_MAX_POSITIONS, V22_POSITION_CAP_COPY, positionCapBlocksOpen, positionCapCopy, type V22Custom9Cause } from "./trade-refusal-9-copy";

export interface V22Custom9Facts {
  /** Assets with an active leg on the taker's account (null = unread). */
  heldAssets: number[] | null;
  assetIndex: number;
  /** The market's `max_portfolio_assets` (null / undefined = unread: the program cap applies). */
  maxPositions?: number | null;
  /** Matcher quote price for this order (null = unknown). */
  quotePriceE6: bigint | null;
  /** The limit the order signed (0 / undefined = none). */
  limitPriceE6?: bigint;
  takerBuys: boolean;
  /** fee_bps the order signed and what the chain needs now (null = unknown). */
  signedFeeBps?: bigint | null;
  neededFeeBps?: bigint | null;
}

/** Pure: the cause the facts prove, in the order the program checks them that the app can see. */
export function classifyV22Custom9(f: V22Custom9Facts): V22Custom9Cause {
  if (f.heldAssets && positionCapBlocksOpen(f.heldAssets, f.assetIndex, f.maxPositions ?? undefined)) return "position-cap";
  if (f.signedFeeBps != null && f.neededFeeBps != null && f.signedFeeBps < f.neededFeeBps) return "fee-cap";
  if (f.quotePriceE6 !== null && f.limitPriceE6 && f.limitPriceE6 > 0n) {
    if (f.takerBuys ? f.quotePriceE6 > f.limitPriceE6 : f.quotePriceE6 < f.limitPriceE6) return "price-limit";
  }
  return "undetermined";
}

export interface V22Custom9Input {
  market: PublicKey;
  /** The LP's matcher context (from the trade's resolved accounts), if known. */
  matcherCtx?: PublicKey | null;
  /** The taker's portfolio on this market, if it exists. */
  takerPortfolio?: PublicKey | null;
  sizeQ: bigint;
  limitPriceE6?: bigint;
  assetIndex?: number;
}

/** Reads the state once and returns the copy for the proven cause. Never throws. */
export async function diagnoseV22TradeCustom9(
  connection: Pick<Connection, "getMultipleAccountsInfo">,
  i: V22Custom9Input,
  deadlineMs = 4000,
): Promise<string> {
  let maxPositions: number | null = null;
  const read = async (): Promise<V22Custom9Cause> => {
    const keys = [i.market, i.matcherCtx ?? null, i.takerPortfolio ?? null].filter((k): k is PublicKey => k instanceof PublicKey);
    const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
    const by = (k: PublicKey | null | undefined) => {
      if (!k) return null;
      const idx = keys.findIndex((x) => x.equals(k));
      const a = idx >= 0 ? infos[idx] : null;
      return a ? new Uint8Array(a.data) : null;
    };
    const m = by(i.market);
    maxPositions = readMaxPortfolioAssets(m);
    const ctxData = by(i.matcherCtx);
    const pf = by(i.takerPortfolio);
    const takerBuys = i.sizeQ > 0n;
    const abs = i.sizeQ < 0n ? -i.sizeQ : i.sizeQ;
    const e = m ? decodeMarketEngineView(m, i.assetIndex ?? 0) : null;
    const ctx = ctxData ? decodeMatcherCtx(ctxData) : null;
    const q = e && ctx && abs > 0n ? preTradeQuote(ctx, e.effectivePriceE6, abs, takerBuys) : null;
    const fee = m ? resolveTradeFeeBps({ marketData: m, matcherCtxData: ctxData }) : null;
    return classifyV22Custom9({
      heldAssets: i.takerPortfolio ? (pf ? decodePortfolioLegs(pf).map((l) => l.assetIndex) : null) : [],
      assetIndex: i.assetIndex ?? 0,
      maxPositions,
      quotePriceE6: q?.quotePriceE6 ?? null,
      limitPriceE6: i.limitPriceE6,
      takerBuys,
      // The signed fee is not re-derived here (it was resolved at send time from the same state);
      // fee-cap is only claimed by callers that pass both values.
      signedFeeBps: null,
      neededFeeBps: fee ? fee.worstCaseFeeBps : null,
    });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const cause = await Promise.race([
      read(),
      new Promise<V22Custom9Cause>((resolve) => {
        timer = setTimeout(() => resolve("undetermined"), deadlineMs);
      }),
    ]);
    return cause === "position-cap" ? positionCapCopy(maxPositions) : V22_CUSTOM9_COPY[cause];
  } catch {
    return V22_CUSTOM9_COPY.undetermined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Server-side pre-trade quote and depth. There is NO order book on v2.2: a taker trades against the market's LP at a price
 * the LP's matcher computes from its context (spread, fee, size impact, inventory skew). So "depth" is that curve sampled at a
 * ladder of sizes, and "quote" is one point of it.
 *
 * Same inputs as the ticket's pre-trade spread (hooks/useSpreadQuoter.ts): the market, the LP's portfolio and its matcher
 * context read together in ONE getMultipleAccountsInfoAndContext, the LP's real engine position as the matcher's inventory,
 * and for a growth asset the wrapper's ext-v3 caps rebuilt from the growth view (without them the impact term reads ~0).
 * Prices are rounded toward the LP exactly as the matcher does (lib/limits/matcher-quote.ts preTradeQuote, pinned to the
 * deployed matcher by __tests__/lib/v22/spread-size-aware.test.ts).
 *
 * Not modelled: the taker's own position (so a reducing order's close exemption is not applied: a reducing quote can only be
 * at or better than the one shown) and the growth gate / leverage guard caps on top of P1 limits (`maxSizePerSide` is the P1
 * + matcher bound; the builder still refuses beyond what the program allows).
 */
import { PublicKey } from "@solana/web3.js";
import { ApiError } from "../errors";
import { rpc, type ReadConnection } from "./common";
import { loadMarket, type RawMarket } from "./market-source";
import { decodeMarket } from "./market";
import {
  decodeAssetRiskLimits,
  decodeAssetVaultLp,
  decodeMarketEngineView,
  decodeMatcherCtx,
  decodePortfolioRisk,
  signedPositionForAsset,
  type MatcherCtxView,
} from "@/lib/limits/decode";
import { lpEffectiveSignedQ } from "@/lib/limits/lp-inventory-room";
import { preTradeQuote, quoteFailsLimit, type MatcherExtCaps, type PreTradeQuote } from "@/lib/limits/matcher-quote";
import { growthFor } from "@/lib/limits/growth-for";
import { growthRecordPresence } from "@/lib/v21/growth-market";
import { matcherExtCapsFromGrowth } from "@/lib/v22/matcher-ext-caps";
import { effectiveExecBandBps, maxTradeSizePerSide, type SideLimit } from "@/lib/limits/risk-limits";
import { resolveTradeFeeBps } from "@/lib/limits/trade-fee-resolve";
import { feeChannelOf } from "@/lib/limits/fee-channel";
import { resolveLpTradeAccounts } from "@/lib/v22/trade-accounts";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { sanitizePriceE6 } from "@/lib/oraclePrice";
import { UNLIMITED_CAPACITY } from "@/lib/marketCapacity";
import { VAULT_LP_DEFAULT_MAX_LEV_BPS } from "@/lib/limits/constants";

export const DEFAULT_QUOTE_SLIPPAGE_BPS = 100;
export const MAX_QUOTE_SLIPPAGE_BPS = 1000;
/** Notional steps (USD, collateral is 6-decimal sim-USDC) of the depth ladder. */
export const DEPTH_LADDER_USD = [25, 100, 400, 1000, 2500, 5000] as const;
const MAX_ABS_Q = (1n << 127n) - 1n;

// ── LP lookup, cached 60 s like lib/v22/trade-build.ts (a market-wide scan that only changes on SetMatcherConfig) ──
type Lp = Awaited<ReturnType<typeof resolveLpTradeAccounts>>;
const LP_TTL_MS = 60_000;
const lpCache = new Map<string, { at: number; value: Lp }>();
const lpInflight = new Map<string, Promise<Lp>>();
export function __clearQuoteCacheForTest(): void {
  lpCache.clear();
  lpInflight.clear();
}

async function cachedLp(connection: ReadConnection, meta: { rpcCalls: number }, programId: PublicKey, market: PublicKey, now = Date.now()): Promise<Lp> {
  const k = `${programId.toBase58()}|${market.toBase58()}`;
  const hit = lpCache.get(k);
  if (hit && now - hit.at < LP_TTL_MS) return hit.value;
  let p = lpInflight.get(k);
  if (!p) {
    meta.rpcCalls += 1;
    p = resolveLpTradeAccounts(connection as never, programId, market)
      .then((value) => {
        lpCache.set(k, { at: Date.now(), value });
        return value;
      })
      .finally(() => lpInflight.delete(k));
    lpInflight.set(k, p);
  }
  try {
    return await p;
  } catch (e) {
    // The scan's own failure wording is "Failed to scan ..." (RPC); anything else is "no usable LP". Never forward the text.
    if (e instanceof Error && e.message.startsWith("Failed to scan")) throw new ApiError("rpc_unavailable");
    throw new ApiError("no_lp");
  }
}

export interface QuoteSource {
  market: string;
  slot: number;
  lotExp: number;
  effectivePriceE6: bigint;
  /** Fee cap the builder would sign right now (base + the matcher's request), bps; null when unreadable. */
  feeBps: bigint | null;
  baseFeeBps: bigint;
  ctx: MatcherCtxView;
  ext: MatcherExtCaps | null;
  bandBps: number | undefined;
  feeInPrice: boolean;
  maxSizePerSide: Record<"long" | "short", SideLimit>;
}

/** Pure: everything the quote needs from three accounts' bytes. */
export function buildQuoteSource(m: Uint8Array, c: Uint8Array, pf: Uint8Array, lp: PublicKey, at: { market: PublicKey; programId: PublicKey; slot: number }): QuoteSource {
  const view = decodeMarket(m, at); // throws market_unsupported / market_unreadable
  const engine = decodeMarketEngineView(m, 0);
  const ctx0 = decodeMatcherCtx(c);
  const risk = decodePortfolioRisk(pf);
  const effective = sanitizePriceE6(engine?.effectivePriceE6 ?? 0n);
  if (!engine || !ctx0 || !risk || effective <= 0n) throw new ApiError("market_unreadable");
  // The wrapper tells the matcher the LP's REAL engine position on every fill and the matcher prices from it, not from its counter.
  const lpRealQ = lpEffectiveSignedQ(pf, engine, 0, engine.marketId);
  const ctx: MatcherCtxView = lpRealQ !== null ? { ...ctx0, inventoryBase: lpRealQ } : ctx0;
  let vaultLp = null;
  try {
    vaultLp = decodeAssetVaultLp(m, 0);
  } catch {
    vaultLp = null;
  }
  const lpView = { ...risk, address: lp, posQ: signedPositionForAsset(pf, 0, engine.marketId) };
  const growthPresent = growthRecordPresence(m, 0) !== "absent";
  const growth = growthPresent ? growthFor({ engine, vaultLp }, { lp: lpView }, lpRealQ, m, 0, BigInt(at.slot)) : null;
  let ext: MatcherExtCaps | null = null;
  if (growthPresent) {
    // A growth asset whose caps cannot be rebuilt is UNKNOWN: never priced on the context's depth (impact would read ~0).
    ext = matcherExtCapsFromGrowth(growth, effective);
    if (!ext) throw new ApiError("market_unreadable");
  }
  const limits = decodeAssetRiskLimits(m, 0);
  // P1 size limits, as lib/limits/ticket.ts deriveTicketLimits feeds them (no taker position: 0).
  const boundVault =
    vaultLp?.bound && vaultLp.vaultLpPortfolio.length === lp.toBytes().length && lp.toBytes().every((b, k) => b === vaultLp!.vaultLpPortfolio[k])
      ? { levBps: vaultLp.vaultLpMaxLevBps !== 0 ? vaultLp.vaultLpMaxLevBps : growth ? growth.long.lambdaEffBps ?? growth.record.lambdaBps : VAULT_LP_DEFAULT_MAX_LEV_BPS }
      : null;
  const maxSizePerSide = limits
    ? maxTradeSizePerSide({
        priceE6: engine.effectivePriceE6,
        initialMarginBps: engine.initialMarginBps,
        oiEffLongQ: engine.oiEffLongQ,
        oiEffShortQ: engine.oiEffShortQ,
        limits: growth && limits.lpExposureKBps === 0 ? { ...limits, lpExposureKBps: growth.long.lambdaEffBps ?? growth.record.lambdaBps } : limits,
        lp: lpView,
        takerPosQ: 0n,
        // syncLive false: the conservative reading (room from the tighter of the counter and the real position).
        matcher: { maxFillAbs: ctx0.maxFillAbs, maxInventoryAbs: ctx0.maxInventoryAbs, inventoryBase: ctx0.inventoryBase, lpRealQ, syncLive: false },
        vaultLp: boundVault,
      })
    : { long: { maxQ: UNLIMITED_CAPACITY, reason: "none" as const, halted: false }, short: { maxQ: UNLIMITED_CAPACITY, reason: "none" as const, halted: false } };
  const fee = resolveTradeFeeBps({ marketData: m, matcherCtxData: c });
  return {
    market: view.market,
    slot: at.slot,
    lotExp: view.lotExp,
    effectivePriceE6: effective,
    feeBps: fee ? fee.feeBps : null,
    baseFeeBps: view.feeBps,
    ctx,
    ext,
    bandBps: limits ? effectiveExecBandBps(limits.execBandBps) : undefined,
    feeInPrice: feeChannelOf(limits).enabled,
    maxSizePerSide,
  };
}

/** The matcher's quote for |sizeQ| on a side, as the program would price it at the source's slot. null = the matcher cannot price it. */
export function matcherQuote(src: QuoteSource, sizeQ: bigint): PreTradeQuote | null {
  const abs = sizeQ < 0n ? -sizeQ : sizeQ;
  return preTradeQuote(src.ctx, src.effectivePriceE6, abs, sizeQ > 0n, {
    ...(src.bandBps !== undefined ? { bandBps: src.bandBps } : {}),
    ext: src.ext,
    nowSlot: BigInt(src.slot),
  });
}

const limitView = (l: SideLimit) => ({ maxQ: l.maxQ >= UNLIMITED_CAPACITY ? null : l.maxQ, reason: l.reason, halted: l.halted });

export function quoteView(src: QuoteSource, sizeQ: bigint, slippageBps: number) {
  const buy = sizeQ > 0n;
  const abs = buy ? sizeQ : -sizeQ;
  const q = matcherQuote(src, sizeQ);
  if (!q) throw new ApiError("market_unreadable", "the matcher cannot price this size");
  const limitPriceE6 = computeLimitPriceE6({ markE6: src.effectivePriceE6, size: sizeQ, slippageBps: BigInt(slippageBps) });
  const max = src.maxSizePerSide[buy ? "long" : "short"];
  return {
    market: src.market,
    side: buy ? "buy" : "sell",
    sizeQ,
    notionalAtoms: (abs * src.effectivePriceE6) / 1_000_000n,
    effectivePriceE6: src.effectivePriceE6,
    slippageBps,
    limitPriceE6,
    estExecPriceE6: q.quotePriceE6,
    priceImpactBps: q.impactBps,
    totalSpreadBps: q.totalBps,
    // Whether the program would accept this fill at that limit (buy: exec <= limit, sell: exec >= limit); null = the matcher is unquoted.
    withinLimit: q.quotePriceE6 === null ? null : !quoteFailsLimit(q.quotePriceE6, limitPriceE6, buy),
    matcher: {
      kind: q.kind,
      fillQ: q.fillQ,
      clipped: q.fillQ < abs,
      clippedByTotal: q.clippedByTotal,
      baseSpreadBps: q.baseSpreadBps,
      maxTotalBps: q.maxTotalBps,
      adaptiveFeeBps: q.adaptiveFeeBps,
      skewBps: q.skewBps,
      feeCold: q.feeCold,
    },
    feeBps: src.feeBps,
    baseFeeBps: src.baseFeeBps,
    feeChargedInPrice: src.feeInPrice,
    maxSizePerSide: { long: limitView(src.maxSizePerSide.long), short: limitView(src.maxSizePerSide.short) },
    exceedsMaxSize: max.maxQ < UNLIMITED_CAPACITY && abs > max.maxQ,
    lotExp: src.lotExp,
  };
}

/** Size (engine q) of `usd` of notional at `priceE6`: atoms (6 decimals) -> q at 1e6 q per unit of price. */
export const sizeForUsd = (usd: number, priceE6: bigint): bigint => (BigInt(usd) * 1_000_000n * 1_000_000n) / priceE6;

export function depthView(src: QuoteSource) {
  const row = (usd: number, buy: boolean) => {
    const sizeQ = sizeForUsd(usd, src.effectivePriceE6);
    const q = sizeQ > 0n ? matcherQuote(src, buy ? sizeQ : -sizeQ) : null;
    return {
      notionalUsd: usd,
      sizeQ,
      fillQ: q ? q.fillQ : null,
      filledFully: q ? q.fillQ >= sizeQ : false,
      execPriceE6: q ? q.quotePriceE6 : null,
      spreadBps: q ? q.totalBps : null,
      impactBps: q ? q.impactBps : null,
    };
  };
  return {
    market: src.market,
    effectivePriceE6: src.effectivePriceE6,
    model: "lp-curve",
    note: "Percolator v2.2 has no order book. You trade against the market's LP at the matcher's curve; each row is the price the matcher would give for that notional on that side (buy = ask, sell = bid), before the wrapper's fee row.",
    asks: DEPTH_LADDER_USD.map((u) => row(u, true)),
    bids: DEPTH_LADDER_USD.map((u) => row(u, false)),
    maxSizePerSide: { long: limitView(src.maxSizePerSide.long), short: limitView(src.maxSizePerSide.short) },
    feeBps: src.feeBps,
    baseFeeBps: src.baseFeeBps,
    lotExp: src.lotExp,
  };
}

/** Reads market + LP + matcher context and builds the source. `slot` is the context slot of the three-account read. */
export async function loadQuoteSource(connection: ReadConnection, meta: { rpcCalls: number }, market: PublicKey): Promise<QuoteSource> {
  const first: RawMarket = await loadMarket(connection, meta, market);
  decodeMarket(first.raw, { market, programId: first.programId, slot: first.slot }); // unsupported / unreadable before the LP scan
  const lp = await cachedLp(connection, meta, first.programId, market);
  const res = await rpc(meta, () => connection.getMultipleAccountsInfoAndContext([market, lp.matcherCtx, lp.accountB], "confirmed"));
  const [m, c, p] = res.value;
  if (!m) throw new ApiError("market_not_found");
  if (!c || !p) throw new ApiError("no_lp");
  return buildQuoteSource(new Uint8Array(m.data), new Uint8Array(c.data), new Uint8Array(p.data), lp.accountB, { market, programId: first.programId, slot: res.context.slot });
}

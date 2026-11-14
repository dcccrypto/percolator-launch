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
import { explainNoLp } from "./no-lp";
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
import { feeChannelOf, requestedFeeBps } from "@/lib/limits/fee-channel";
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
  /** Oracle freshness, by the same rule GET /v1/markets exposes. */
  oracle: { stale: boolean; ageSecs: number | null; staleBoundSecs: number };
  ctx: MatcherCtxView;
  ext: MatcherExtCaps | null;
  bandBps: number | undefined;
  feeInPrice: boolean;
  maxSizePerSide: Record<"long" | "short", SideLimit>;
}

/** Pure: everything the quote needs from three accounts' bytes. */
export function buildQuoteSource(m: Uint8Array, c: Uint8Array, pf: Uint8Array, lp: PublicKey, at: { market: PublicKey; programId: PublicKey; slot: number }, takerPosQ: bigint = 0n): QuoteSource {
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
  // P1 size limits, as lib/limits/ticket.ts deriveTicketLimits feeds them (the quote has no taker position: 0; the order preflight passes the taker's effective one).
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
        takerPosQ,
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
    oracle: { stale: view.oracle.stale, ageSecs: view.oracle.ageSecs, staleBoundSecs: view.oracle.staleBoundSecs },
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

const num = (b: bigint | null): number | null => (b === null ? null : Number(b));

/**
 * What a fill costs, from the matcher's estimate. Two figures, kept apart so nothing is counted twice:
 *
 *  - `bps` / `atoms` (expectedFeeBps / expectedFeeAtoms): the FEE the wrapper charges, on top of the fill. The market's base fee,
 *    plus - only on a market whose fee channel is on (`feeInPrice`, `feeChargedInPrice` on the wire) - the matcher's requested fee,
 *    `ceil(|estExec - mark| x 1e4 / mark)` (lib/limits/fee-channel.ts requestedFeeBps, the program's own formula; the ticket signs the
 *    same sum). Channel off: the base fee alone. Utilisation fees of growth markets are not included.
 *  - `allInBps` / `allInAtoms` (allInCostBps / allInCostAtoms): the whole cost of the fill against the mark, in bps and atoms:
 *    base fee + the spread the matcher quotes (adaptive fee, base spread, skew and size impact, which are all INSIDE
 *    `totalSpreadBps`, so the adaptive fee is counted once). On a fee-channel market that spread is charged as the requested fee and
 *    the trade settles at the mark; otherwise it is paid in the price. The sum is the same either way. Do NOT add expectedFeeBps to
 *    the spread: on a fee-channel market they overlap.
 * It is NOT the cap: a build signs `feeCapBps` (base + the matcher's worst case + a margin), the most a fill may ever charge.
 * Both null when the matcher fills nothing.
 */
export function expectedFee(
  src: Pick<QuoteSource, "baseFeeBps" | "feeInPrice" | "effectivePriceE6">,
  q: PreTradeQuote | null,
  notionalAtoms: bigint,
): { bps: number | null; atoms: bigint | null; allInBps: number | null; allInAtoms: bigint | null } {
  if (!q || q.fillQ <= 0n) return { bps: null, atoms: null, allInBps: null, allInAtoms: null };
  // A matcher without an exact quote (legacy kind) has no spread to read: the fee is the base fee, and the all-in cost is unknown.
  if (q.quotePriceE6 === null) return { bps: Number(src.baseFeeBps), atoms: (notionalAtoms * src.baseFeeBps + 9_999n) / 10_000n, allInBps: null, allInAtoms: null };
  const spread = requestedFeeBps(src.effectivePriceE6, q.quotePriceE6);
  const bps = src.baseFeeBps + (src.feeInPrice ? spread : 0n);
  const allIn = src.baseFeeBps + spread;
  return {
    bps: Number(bps),
    atoms: (notionalAtoms * bps + 9_999n) / 10_000n,
    allInBps: Number(allIn),
    allInAtoms: (notionalAtoms * allIn + 9_999n) / 10_000n,
  };
}

export function quoteView(src: QuoteSource, sizeQ: bigint, slippageBps: number) {
  const buy = sizeQ > 0n;
  const abs = buy ? sizeQ : -sizeQ;
  const limitPriceE6 = computeLimitPriceE6({ markE6: src.effectivePriceE6, size: sizeQ, slippageBps: BigInt(slippageBps) });
  const max = src.maxSizePerSide[buy ? "long" : "short"];
  const exceedsMaxSize = max.maxQ < UNLIMITED_CAPACITY && abs > max.maxQ;
  // The size the market can actually take: an order beyond the per-side maximum fills only up to it (and is refused by the builder),
  // so the price, impact, fee and limit check are those of the FILLABLE size, not of the unfillable request.
  const fillableAbs = exceedsMaxSize ? max.maxQ : abs;
  const q = fillableAbs > 0n ? matcherQuote(src, buy ? fillableAbs : -fillableAbs) : null;
  if (!q && !exceedsMaxSize) throw new ApiError("market_unreadable", "the matcher cannot price this size");
  // A matcher that fills nothing (halted LP, or a side with no room) has no price: its impact and spread are not 0, they are unknown.
  const fills = q !== null && q.fillQ > 0n;
  const notionalAtoms = (abs * src.effectivePriceE6) / 1_000_000n;
  const fee = expectedFee(src, q, (fillableAbs * src.effectivePriceE6) / 1_000_000n);
  return {
    market: src.market,
    side: buy ? "buy" : "sell",
    sizeQ,
    notionalAtoms,
    effectivePriceE6: src.effectivePriceE6,
    oracle: src.oracle,
    slippageBps,
    limitPriceE6,
    estExecPriceE6: fills && q ? q.quotePriceE6 : null,
    priceImpactBps: fills && q ? num(q.impactBps) : null,
    totalSpreadBps: fills && q ? num(q.totalBps) : null,
    // Whether the program would accept this fill at that limit (buy: exec <= limit, sell: exec >= limit); null = the matcher is unquoted.
    withinLimit: !fills || !q || q.quotePriceE6 === null ? null : !quoteFailsLimit(q.quotePriceE6, limitPriceE6, buy),
    matcher: {
      kind: q ? q.kind : null,
      fillQ: q ? q.fillQ : 0n,
      clipped: (q ? q.fillQ : 0n) < abs,
      clippedByTotal: q ? q.clippedByTotal : false,
      baseSpreadBps: q ? q.baseSpreadBps : null,
      maxTotalBps: q ? q.maxTotalBps : null,
      adaptiveFeeBps: fills && q ? num(q.adaptiveFeeBps) : null,
      skewBps: fills && q ? num(q.skewBps) : null,
      feeCold: q ? q.feeCold : false,
    },
    expectedFeeBps: fee.bps,
    expectedFeeAtoms: fee.atoms,
    allInCostBps: fee.allInBps,
    allInCostAtoms: fee.allInAtoms,
    feeCapBps: num(src.feeBps),
    baseFeeBps: Number(src.baseFeeBps),
    feeChargedInPrice: src.feeInPrice,
    maxSizePerSide: { long: limitView(src.maxSizePerSide.long), short: limitView(src.maxSizePerSide.short) },
    exceedsMaxSize,
    // The size the figures above are for: the request, or the per-side maximum when the request is beyond it.
    fillableQ: fillableAbs,
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
      execPriceE6: q && q.fillQ > 0n ? q.quotePriceE6 : null,
      spreadBps: q && q.fillQ > 0n ? num(q.totalBps) : null,
      impactBps: q && q.fillQ > 0n ? num(q.impactBps) : null,
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
    oracle: src.oracle,
    feeCapBps: num(src.feeBps),
    baseFeeBps: Number(src.baseFeeBps),
    lotExp: src.lotExp,
  };
}

/** Reads market + LP + matcher context and builds the source. `slot` is the context slot of the three-account read. */
export async function loadQuoteSource(connection: ReadConnection, meta: { rpcCalls: number }, market: PublicKey): Promise<QuoteSource> {
  const first: RawMarket = await loadMarket(connection, meta, market);
  decodeMarket(first.raw, { market, programId: first.programId, slot: first.slot }); // unsupported / unreadable before the LP scan
  const lp = await cachedLp(connection, meta, first.programId, market).catch((e) => {
    throw e instanceof ApiError && e.code === "no_lp" ? explainNoLp(first.raw, { market, programId: first.programId, slot: first.slot }) : e;
  });
  const res = await rpc(meta, () => connection.getMultipleAccountsInfoAndContext([market, lp.matcherCtx, lp.accountB], "confirmed"));
  const [m, c, p] = res.value;
  if (!m) throw new ApiError("market_not_found");
  if (!c || !p) throw new ApiError("no_lp");
  return buildQuoteSource(new Uint8Array(m.data), new Uint8Array(c.data), new Uint8Array(p.data), lp.accountB, { market, programId: first.programId, slot: res.context.slot });
}

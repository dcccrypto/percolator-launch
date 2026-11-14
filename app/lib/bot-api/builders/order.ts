/**
 * Orders for the bot API: open, increase, reduce, close, all through the ONE trade builder the app's flow shares
 * (lib/v22/trade-build.ts buildV22Trade), with the caps (./caps.ts) as its preflight and a final simulation of the exact
 * returned bytes (./common.ts finalizeTx). v2.2 has no resting orders: every order fills now against the market's LP or
 * is refused, bounded by its limit price.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { ApiError } from "@/lib/bot-api/errors";
import { buildV22Trade, effectiveTakerPosition, TradeBuildRefusal } from "@/lib/v22/trade-build";
import { findOwnerPortfolio } from "@/lib/owner-portfolio";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { checkOrderCaps, checkOpenMarketGuards, resolveCaps, MAX_SLIPPAGE_BPS } from "./caps";
import {
  finalizeTx,
  refusalToApi,
  noTradingAccount,
  onlyKeys,
  pubkeyField,
  uintStringField,
  intField,
  numberField,
  boolField,
  MAX_I128_ABS,
  MAX_U64,
  type ReturnedTx,
} from "./common";

export interface OrderInput {
  owner: PublicKey;
  market: PublicKey;
  /** Signed q: > 0 buy, < 0 sell. */
  size: bigint;
  reduceOnly?: boolean;
  slippageBps?: number;
  limitPriceE6?: bigint;
  maxFeeBps?: bigint;
  maxNotionalUsd?: number;
  maxLeverage?: number;
  portfolio?: PublicKey;
}

export interface OrderResponse {
  transactions: ReturnedTx[];
  blockhash: string;
  lastValidBlockHeight: number;
  resubmitAfter: boolean;
  summary: Record<string, unknown>;
  caps: { reduceOnly: boolean; slippageBps: number | null; maxNotionalUsd: number; maxLeverage: number; notionalUsd: number | null; leverageAfter: number | null };
}

const ORDER_FIELDS = ["owner", "market", "side", "size", "reduceOnly", "slippageBps", "limitPriceE6", "maxFeeBps", "maxNotionalUsd", "maxLeverage", "portfolio", "expiresAfter"] as const;

/** POST /v1/orders body -> OrderInput. Strict: unknown fields are refused (a typo like reduce_only must not be ignored). */
export function parseOrderBody(b: Record<string, unknown>): OrderInput {
  onlyKeys(b, ORDER_FIELDS);
  const owner = pubkeyField(b, "owner", true);
  const market = pubkeyField(b, "market", true);
  if (b.side !== "buy" && b.side !== "sell") throw new ApiError("bad_request", 'side must be "buy" or "sell"');
  const q = uintStringField(b, "size", { required: true, max: MAX_I128_ABS, positive: true })!;
  const out: OrderInput = { owner, market, size: b.side === "buy" ? q : -q };
  out.reduceOnly = boolField(b, "reduceOnly");
  out.slippageBps = intField(b, "slippageBps", { min: 1, max: MAX_SLIPPAGE_BPS, overCode: "slippage_cap_exceeded" });
  out.limitPriceE6 = uintStringField(b, "limitPriceE6", { required: false, max: MAX_U64, positive: true });
  if (out.limitPriceE6 !== undefined && out.slippageBps !== undefined) throw new ApiError("bad_request", "give slippageBps or limitPriceE6, not both");
  const fee = intField(b, "maxFeeBps", { min: 0, max: 10_000 });
  if (fee !== undefined) out.maxFeeBps = BigInt(fee);
  out.maxNotionalUsd = numberField(b, "maxNotionalUsd", { minExclusive: 0, max: 1e12 });
  out.maxLeverage = numberField(b, "maxLeverage", { minExclusive: 0, max: 1000 });
  out.portfolio = pubkeyField(b, "portfolio", false);
  return out;
}

/**
 * The build summary for the API. The shared builder's `feeBps` is the fee CAP the transaction signs (base fee + the matcher's
 * worst case + a margin, so far above the market's listed base fee): renamed feeCapBps. expectedFeeBps / expectedFeeAtoms are
 * what the fill is expected to charge (reads/quote.ts expectedFee); a fill never charges more than the cap.
 */
export function orderSummary(base: Record<string, unknown> & { feeBps?: string | null }, size: bigint, fees: { expectedFeeBps: number | null; expectedFeeAtoms: bigint | null }): Record<string, unknown> {
  const { feeBps, ...rest } = base;
  return {
    ...rest,
    side: size > 0n ? "buy" : "sell",
    feeCapBps: feeBps === null || feeBps === undefined ? null : Number(feeBps),
    expectedFeeBps: fees.expectedFeeBps,
    expectedFeeAtoms: fees.expectedFeeAtoms === null ? null : fees.expectedFeeAtoms.toString(),
  };
}

export async function buildOrder(connection: Connection, input: OrderInput, meta: { rpcCalls: number; sims: number }): Promise<OrderResponse> {
  const caps = resolveCaps({
    reduceOnly: input.reduceOnly,
    slippageBps: input.slippageBps,
    maxNotionalUsd: input.maxNotionalUsd,
    maxLeverage: input.maxLeverage,
    explicitLimit: input.limitPriceE6 !== undefined,
  });
  let applied: ReturnType<typeof checkOrderCaps> | null = null;
  let fees: Awaited<ReturnType<typeof checkOpenMarketGuards>> = { expectedFeeBps: null, expectedFeeAtoms: null };
  let r: Awaited<ReturnType<typeof buildV22Trade>>;
  try {
    meta.rpcCalls += 8; // market, LP (cached), portfolio scan, identities, fee, lev guard, blockhash, priority fee
    meta.sims += 1;
    r = await buildV22Trade(connection, {
      owner: input.owner,
      slab: input.market,
      size: input.size,
      ...(input.limitPriceE6 !== undefined ? { limitPriceE6: input.limitPriceE6 } : { slippageBps: BigInt(caps.slippageBps) }),
      ...(input.maxFeeBps !== undefined ? { maxFeeBps: input.maxFeeBps } : {}),
      ...(input.portfolio ? { portfolio: input.portfolio } : {}),
      crankOnLossStale: true,
      preflight: async (p) => {
        applied = checkOrderCaps(caps, p);
        fees = await checkOpenMarketGuards(connection, p);
      },
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof TradeBuildRefusal) throw refusalToApi(e);
    throw new ApiError("rpc_unavailable");
  }
  const transactions: ReturnedTx[] = [];
  for (const t of r.transactions) transactions.push(await finalizeTx(connection, t.transaction, t.purpose, meta));
  const a = applied as ReturnType<typeof checkOrderCaps> | null;
  return {
    transactions,
    blockhash: r.blockhash,
    lastValidBlockHeight: r.lastValidBlockHeight,
    resubmitAfter: r.resubmitAfter,
    summary: orderSummary(r.summary, input.size, fees),
    caps: {
      reduceOnly: caps.reduceOnly,
      slippageBps: caps.explicitLimit ? null : caps.slippageBps,
      maxNotionalUsd: caps.maxNotionalUsd,
      maxLeverage: caps.maxLeverage,
      notionalUsd: a?.notionalUsd ?? null,
      leverageAfter: a?.leverageAfter ?? null,
    },
  };
}

const CLOSE_FIELDS = ["owner", "market", "size", "slippageBps", "maxFeeBps", "portfolio", "expiresAfter"] as const;

/**
 * POST /v1/positions/close: reduce-only order for the whole position (or `size` of it, never more), against the
 * ADL-effective position read now (a prior-reset leg owns nothing: no_position). The builder re-reads it and the reduce-only preflight refuses if it changed in between.
 */
export async function buildClose(connection: Connection, b: Record<string, unknown>, meta: { rpcCalls: number; sims: number }): Promise<OrderResponse> {
  onlyKeys(b, CLOSE_FIELDS);
  const owner = pubkeyField(b, "owner", true);
  const market = pubkeyField(b, "market", true);
  const part = uintStringField(b, "size", { required: false, max: MAX_I128_ABS, positive: true });
  const slippageBps = intField(b, "slippageBps", { min: 1, max: MAX_SLIPPAGE_BPS, overCode: "slippage_cap_exceeded" });
  const fee = intField(b, "maxFeeBps", { min: 0, max: 10_000 });
  let portfolio = pubkeyField(b, "portfolio", false);

  let before: bigint;
  let legReset = false;
  try {
    meta.rpcCalls += 3;
    const info = await connection.getAccountInfo(market, "confirmed");
    if (!info) throw new ApiError("market_not_found");
    const engine = decodeMarketEngineView(new Uint8Array(info.data));
    if (!engine || engine.marketId === null || engine.marketId === undefined) throw new ApiError("market_unreadable");
    portfolio = portfolio ?? (await findOwnerPortfolio(connection, info.owner, market, owner)) ?? undefined;
    if (!portfolio) throw noTradingAccount();
    const pinfo = await connection.getAccountInfo(portfolio, "confirmed");
    if (!pinfo) throw noTradingAccount();
    // The ADL-EFFECTIVE position, the quantity the engine applies a close to (hooks/useClosePosition.ts effectiveLeg): a close
    // sized from the raw basis over-closes after an ADL and the engine refuses the flip.
    const eff = effectiveTakerPosition(new Uint8Array(pinfo.data), engine);
    if (eff.q === null) throw new ApiError("market_unreadable", "the engine would refuse this position (epoch or ADL index mismatch), so it cannot be closed from here; try again after the market is cranked");
    before = eff.q;
    legReset = eff.reset;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("rpc_unavailable");
  }
  if (legReset) throw new ApiError("no_position", "the position was already cleared by a market reset; there is nothing to close");
  if (before === 0n) throw new ApiError("no_position");
  const absBefore = before < 0n ? -before : before;
  const q = part === undefined ? absBefore : part;
  if (q > absBefore) throw new ApiError("reduce_only_violation", `size ${q} is larger than the position ${absBefore}`);
  return buildOrder(
    connection,
    {
      owner,
      market,
      size: before > 0n ? -q : q,
      reduceOnly: true,
      ...(slippageBps !== undefined ? { slippageBps } : {}),
      ...(fee !== undefined ? { maxFeeBps: BigInt(fee) } : {}),
      portfolio,
    },
    meta,
  );
}

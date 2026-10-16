/**
 * Q-1 / SOL-1 (v2.2 QA, 2026-10-11): the fee_bps a TradeCpi SIGNS, resolved from the chain at send time,
 * so a trade on a fee-channel market is never refused Custom(9) for an under-signed fee.
 *
 * The rule is the SDK's (percolator-sdk feat/v22-sdk bd79448 `computeTradeFeeBpsToSignV22`, ported verbatim
 * in lib/v22/sdk/v22-trade-fee.ts): base fee + the WORST-CASE matcher fee the program can accept on this
 * asset (min(max_requested_fee_bps, matcher max_total_bps + 1, 1023); 0 when the channel is off) + 5 bps,
 * capped at the market's max_trading_fee_bps. The signed value is the taker's CAP: the fill charges base +
 * the matcher's ACTUAL request (wrapper RC 6c078a0e `handle_trade_cpi`, `requested_fee_permitted`).
 *
 * Measured on the v2.2 devnet markets (SOL / JUP / CHILLHOUSE): base 30, max_trading 700, max_requested 100,
 * matcher max_total 100 => 135. The app signed 30 (base only) and every fill (~53 charged) was refused 9.
 * Inputs come from the app's own decoders (same fields as the SDK's `readTradeFeeInputsV22`).
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { decodeAssetRiskLimits, decodeMarketEngineView, decodeMatcherCtx } from "./decode";
import { decodeGrowthRecord } from "@/lib/v21/growth-market";
import { utilFeeMaxEffectiveBps } from "@/lib/v22/sdk/records/growth-v19";
import { computeTradeFeeBpsToSignV22, type TradeFeeInputsV22, type TradeFeeToSignV22 } from "@/lib/v22/sdk/v22-trade-fee";

/** The SDK's `TradeFeeInputsV22`, read with the app decoders. null = the market bytes are not decodable. */
export function readTradeFeeInputsApp(marketData: Uint8Array, assetIndex: number, matcherCtxData: Uint8Array | null): TradeFeeInputsV22 | null {
  const e = decodeMarketEngineView(marketData, assetIndex);
  if (!e) return null;
  const rl = decodeAssetRiskLimits(marketData, assetIndex);
  const ctx = matcherCtxData ? decodeMatcherCtx(matcherCtxData) : null;
  return {
    tradeFeeBaseBps: e.tradeFeeBaseBps,
    maxTradingFeeBps: e.maxTradingFeeBps,
    // An unreadable P1 record is treated as "channel off" (the program refuses such bytes anyway).
    maxRequestedFeeBps: rl?.maxRequestedFeeBps ?? 0,
    matcherExtMode: rl?.matcherExtMode ?? 0,
    ...(ctx ? { matcherMaxTotalBps: ctx.maxTotalBps } : {}),
  };
}

/** The asset's utilisation fee at full utilisation (bps); 0 when the asset has no growth record. */
export function utilFeeMaxBpsOf(marketData: Uint8Array, assetIndex = 0): number {
  const g = decodeGrowthRecord(marketData, assetIndex);
  return g ? utilFeeMaxEffectiveBps(g.utilFeeMaxBps) : 0;
}

/** Pure: the SDK rule on raw bytes. null when the market cannot be decoded or its base exceeds its maximum. */
export function resolveTradeFeeBps(i: { marketData: Uint8Array; matcherCtxData: Uint8Array | null; assetIndex?: number; withUtilMax?: boolean }): TradeFeeToSignV22 | null {
  const inputs = readTradeFeeInputsApp(i.marketData, i.assetIndex ?? 0, i.matcherCtxData);
  if (!inputs) return null;
  try {
    // v2.2 QA U-2: after a 98 the cap also covers the asset's utilisation fee at its maximum (the growth record's
    // util_fee_max; 0 when growth is off). The fill still charges only base + the matcher's request + the fee for THIS
    // fill (wrapper RC 6c078a0e handle_trade_cpi: `base + requested + util <= fee_bps` and `<= max_trading_fee_bps`).
    const utilFeeBps = i.withUtilMax ? utilFeeMaxBpsOf(i.marketData, i.assetIndex ?? 0) : 0;
    return computeTradeFeeBpsToSignV22(inputs, utilFeeBps > 0 ? { utilFeeBps } : {});
  } catch {
    return null;
  }
}

/**
 * Reads the market + matcher context and returns the fee to sign (the SDK rule). Read / decode failure =>
 * `fallback` (the legacy base fee) so a flaky RPC never blocks a trade the pre-sign simulation would accept.
 */
export async function fetchTradeFeeBps(
  connection: Pick<Connection, "getMultipleAccountsInfo">,
  market: PublicKey,
  matcherCtx: PublicKey,
  p: { fallback?: bigint; assetIndex?: number; withUtilMax?: boolean },
): Promise<bigint | undefined> {
  try {
    const [m, c] = await connection.getMultipleAccountsInfo([market, matcherCtx], "confirmed");
    if (!m) return p.fallback;
    const r = resolveTradeFeeBps({ marketData: new Uint8Array(m.data), matcherCtxData: c ? new Uint8Array(c.data) : null, assetIndex: p.assetIndex, withUtilMax: p.withUtilMax });
    return r ? r.feeBps : p.fallback;
  } catch {
    return p.fallback;
  }
}

/** 98 GrowthUtilisationFeeNotCovered from the wrapper (or unattributed), in any of the error shapes. */
export function isUtilFeeNotCovered(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 98) return true;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /custom program error: 0x62\b|"Custom":98\b|Custom\(98\)/.test(msg);
}

/**
 * v2.2 QA U-2: send; on a 98 rebuild ONCE with the fee cap that covers the utilisation fee and send again (the first
 * refusal is the pre-sign simulation, so the wallet has not opened). A second 98 means base + matcher + utilisation fee
 * is over the market's maximum for this size, which no signature fixes: it is thrown for the "too busy" line.
 */
export async function sendWithUtilFeeRetry<T>(send: (raised: boolean) => Promise<T>): Promise<T> {
  try {
    return await send(false);
  } catch (e) {
    if (!isUtilFeeNotCovered(e)) throw e;
    try {
      return await send(true);
    } catch (e2) {
      if (isUtilFeeNotCovered(e2)) throw new UtilFeeOverMaxError(e2);
      throw e2;
    }
  }
}

/** base + matcher + utilisation fee exceeds the market's maximum for this order: nothing can be signed that passes. */
export class UtilFeeOverMaxError extends Error {
  constructor(cause: unknown) {
    super("This side is too busy for an order this size right now. Try a smaller size or the other side. Nothing was sent.", { cause });
    this.name = "UtilFeeOverMaxError";
  }
}

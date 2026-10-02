/**
 * Liquidity floor for PumpSwap pools, mirroring the oracle keeper EXACTLY
 * (percolator-oracle-keeper src/cross-cluster/price-reader.ts, #100):
 *
 *   - `pumpswapQuoteDepthUsdE6`: the QUOTE-side vault balance in USD (E6). Quote depth is what
 *     an attacker must put up to move the mark; base depth is in the token whose price is in doubt.
 *   - floor = env `MIN_POOL_LIQUIDITY_USD` (decimal USD). The live keeper runs it at 1000. The
 *     keeper's own default is "off"; the app defaults to the same $1000 so the wizard cannot offer
 *     a pool the live keeper refuses (2026-10-02: BOME on GmoZsr3G..., depth $1.64).
 *   - unknown depth (unreadable vault, WSOL-quoted with no SOL/USD) is REFUSED, never passed.
 *
 * Only PumpSwap is floored, as in the keeper: the SDK's parseDexPool exposes vault addresses for
 * PumpSwap only (Meteora DLMM prices from binStep and returns no reserves), so the keeper has no
 * depth for DLMM and applies no floor to it. Mirroring that, DLMM pools are not floored here.
 *
 * Pure functions + one batched read helper; the classification wiring lives in dex-pool-owner.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { computeDexSpotPriceE6 } from "@percolatorct/sdk";

/** SPL token-account minimum length for the amount field at offset 64 (keeper MIN_VAULT_LEN). */
const MIN_VAULT_LEN = 72;

export const DEFAULT_MIN_POOL_LIQUIDITY_USD = "1000";

/** Parse a decimal USD amount to E6. Same grammar as the keeper; null when malformed. */
export function parseUsdToE6(raw: string): bigint | null {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

/**
 * The floor in USD E6. 0 disables it. Unset -> $1000. A malformed value falls back to the
 * default rather than throwing at import (the keeper throws; a module-load crash here would take
 * down every route that imports dex-pool-owner).
 */
export function minPoolLiquidityUsdE6(env: string | undefined = process.env.MIN_POOL_LIQUIDITY_USD): bigint {
  const raw = (env ?? "").trim();
  return parseUsdToE6(raw === "" ? DEFAULT_MIN_POOL_LIQUIDITY_USD : raw) ?? parseUsdToE6(DEFAULT_MIN_POOL_LIQUIDITY_USD)!;
}

/** Decimals of the only quote mints that reach the floor (WSOL, USDC, USDT; see USD_PRICEABLE_QUOTE_MINTS). */
const WSOL = "So11111111111111111111111111111111111111112";
export function quoteDecimals(quoteMint: string): number {
  return quoteMint === WSOL ? 9 : 6;
}

/** Keeper's SOL/USD reference pool (SOL_USD_REFERENCE_POOL, a Raydium CLMM). */
export const SOL_USD_REFERENCE_POOL =
  process.env.SOL_USD_REFERENCE_POOL?.trim() || "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";

/** SOL/USD (E6) from the reference pool's bytes, as the keeper reads it. undefined when unusable. */
export function solUsdE6FromReferencePool(data: Uint8Array | null | undefined): bigint | undefined {
  if (!data) return undefined;
  try {
    const p = computeDexSpotPriceE6("raydium-clmm", data);
    return p > 0n ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Keeper's pumpswapQuoteDepthUsdE6, verbatim semantics. null = unknown. */
export function pumpswapQuoteDepthUsdE6(
  quoteVaultData: Uint8Array,
  quoteDecimalsN: number,
  isWsolQuoted: boolean,
  solPriceE6: bigint | undefined,
): bigint | null {
  if (quoteVaultData.length < MIN_VAULT_LEN) return null;
  const dv = new DataView(quoteVaultData.buffer, quoteVaultData.byteOffset, quoteVaultData.byteLength);
  const amount = BigInt(dv.getUint32(64, true)) | (BigInt(dv.getUint32(68, true)) << 32n);
  if (amount === 0n) return 0n;
  const scale = 10n ** BigInt(quoteDecimalsN);
  if (isWsolQuoted) {
    if (solPriceE6 === undefined || solPriceE6 <= 0n) return null;
    return (amount * solPriceE6) / scale;
  }
  return (amount * 1_000_000n) / scale;
}

/** True when the pool must be refused: unknown depth or depth under the floor. */
export function isBelowFloor(depthE6: bigint | null, floorE6: bigint): boolean {
  return floorE6 > 0n && (depthE6 === null || depthE6 < floorE6);
}

export function floorUsdLabel(floorE6: bigint): string {
  return `$${(Number(floorE6) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** Wizard / API copy. Floor is interpolated so it tracks MIN_POOL_LIQUIDITY_USD. */
export function belowLiquidityFloorReason(floorE6: bigint = minPoolLiquidityUsdE6()): string {
  return (
    `This token's pool is too shallow to price safely (under ${floorUsdLabel(floorE6)} of quote-side liquidity). ` +
    "The price feed refuses to quote pools this thin, so a market launched on it would never get a price. " +
    "Pick a deeper pool, or wait until the pool has more liquidity."
  );
}

export interface PumpswapDepthInput {
  /** pool address -> its quote vault and quote mint */
  pools: Array<{ pool: string; quoteVault: PublicKey; quoteMint: string }>;
}

/**
 * Depth (USD E6, null = unknown) for each PumpSwap pool, in ONE getMultipleAccountsInfo call
 * (quote vaults + the SOL/USD reference pool when any pool is WSOL-quoted). Throws on RPC failure
 * so callers fail closed.
 */
export async function readPumpswapDepths(
  input: PumpswapDepthInput,
  conn: Pick<Connection, "getMultipleAccountsInfo">,
): Promise<Record<string, bigint | null>> {
  const out: Record<string, bigint | null> = {};
  if (input.pools.length === 0) return out;
  const needSol = input.pools.some((p) => p.quoteMint === WSOL);
  const keys = input.pools.map((p) => p.quoteVault);
  if (needSol) keys.push(new PublicKey(SOL_USD_REFERENCE_POOL));
  const infos = await conn.getMultipleAccountsInfo(keys);
  const solPrice = needSol ? solUsdE6FromReferencePool(infos[input.pools.length] ? new Uint8Array(infos[input.pools.length]!.data) : null) : undefined;
  input.pools.forEach((p, i) => {
    const info = infos[i];
    out[p.pool] = info
      ? pumpswapQuoteDepthUsdE6(new Uint8Array(info.data), quoteDecimals(p.quoteMint), p.quoteMint === WSOL, solPrice)
      : null;
  });
  return out;
}

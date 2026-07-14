/**
 * dexPoolReader.ts — reads a mainnet DEX pool's spot price for the local
 * dev price-WS server (scripts/local-price-ws-server.ts).
 *
 * This is a deliberate, cited PORT of
 * `~/percolator-oracle-keeper/src/cross-cluster/price-reader.ts`'s
 * `readPoolPriceE6` — function-for-function identical dispatch logic,
 * copied rather than imported because percolator-oracle-keeper is a
 * separate repo/package with no workspace link into percolator-launch.
 * Both call sites (the real cross-cluster keeper, and this local dev
 * server) delegate the actual price math to the SAME `@percolatorct/sdk`
 * primitives (`detectDexType` / `parseDexPool` / `computeDexSpotPriceE6` /
 * `fetchMintDecimals`) — that SDK module is the true single source of
 * truth for "how do we compute a spot price from raw pool bytes"; this
 * file and price-reader.ts are both thin, identical dispatch wrappers
 * around it, not two independent implementations.
 *
 * Node-only (uses @solana/web3.js `Connection` for direct RPC reads) — not
 * imported by any Next.js route or client component, only by the
 * standalone `scripts/local-price-ws-server.ts` entrypoint.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  detectDexType,
  parseDexPool,
  computeDexSpotPriceE6,
  fetchMintDecimals,
  WSOL_MINT,
  type DexType,
} from "@percolatorct/sdk";

/** Per-pool cached mint decimals (keyed by pool address string) — Meteora DLMM + PumpSwap. */
export type DecimalsCache = Map<string, { base: number; quote: number }>;

export interface PoolReadEntry {
  poolAddress: string;
  dexType: DexType;
  label: string;
}

export interface PriceReadResult {
  priceE6: bigint;
  source: string;
  skipped?: boolean;
  skipReason?: string;
}

const MAX_RETRIES = 4;

function is429(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("429") || msg.includes("too many requests");
}

async function withRpcBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let delayMs = 500;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (is429(err) && attempt < MAX_RETRIES - 1) {
        const jitter = Math.floor(Math.random() * 0.2 * delayMs);
        const wait = delayMs + jitter;
        console.warn(`[dexPoolReader] RPC 429 — backoff ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, wait));
        delayMs = Math.min(delayMs * 2, 8_000);
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

/**
 * Read the spot price (in e6) from a mainnet DEX pool. Identical behaviour
 * to `percolator-oracle-keeper`'s `readPoolPriceE6` — see file header.
 *
 * `solPriceE6` (current SOL/USD price, e6) is REQUIRED to produce a USD
 * price for PumpSwap pools quoted in native WSOL (the vast majority of
 * pump.fun pools) — callers should resolve it from a SOL/USD reference
 * market (e.g. the SOL raydium-clmm entry) before calling this for a
 * pumpswap entry. A WSOL-quoted pool with no `solPriceE6` supplied is
 * skipped (not thrown). Ignored for raydium-clmm / meteora-dlmm.
 */
export async function readPoolPriceE6(
  mainnetConn: Connection,
  entry: PoolReadEntry,
  decimalsCache: DecimalsCache,
  solPriceE6?: bigint,
): Promise<PriceReadResult> {
  const poolPk = new PublicKey(entry.poolAddress);
  const shortPool = entry.poolAddress.slice(0, 8) + "…";
  const source = `${entry.dexType}:${shortPool}`;

  const poolInfo = await withRpcBackoff(() => mainnetConn.getAccountInfo(poolPk, "confirmed"));
  if (!poolInfo) {
    return { priceE6: 0n, source, skipped: true, skipReason: "pool account not found on mainnet" };
  }
  if (poolInfo.data.length === 0) {
    return { priceE6: 0n, source, skipped: true, skipReason: "pool account has empty data" };
  }
  const data = new Uint8Array(poolInfo.data);

  const detectedDex = detectDexType(poolInfo.owner);
  if (detectedDex !== entry.dexType) {
    return {
      priceE6: 0n,
      source,
      skipped: true,
      skipReason: `pool owner ${poolInfo.owner.toBase58()} does not match dexType=${entry.dexType} (detected: ${detectedDex ?? "unknown"})`,
    };
  }

  if (entry.dexType === "raydium-clmm") {
    const priceE6 = computeDexSpotPriceE6("raydium-clmm", data);
    if (priceE6 === 0n) {
      return { priceE6: 0n, source, skipped: true, skipReason: "Raydium CLMM: sqrtPriceX64=0 (pool not initialised or live)" };
    }
    return { priceE6, source };
  }

  if (entry.dexType === "meteora-dlmm") {
    if (!decimalsCache.has(entry.poolAddress)) {
      const poolParsed = parseDexPool("meteora-dlmm", poolPk, data);
      const [baseDecimals, quoteDecimals] = await Promise.all([
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.baseMint)),
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.quoteMint)),
      ]);
      decimalsCache.set(entry.poolAddress, { base: baseDecimals, quote: quoteDecimals });
      console.log(
        `[dexPoolReader] Meteora ${shortPool} decimals cached: base=${baseDecimals} quote=${quoteDecimals}`,
      );
    }
    const dec = decimalsCache.get(entry.poolAddress)!;
    const priceE6 = computeDexSpotPriceE6("meteora-dlmm", data, undefined, dec);
    if (priceE6 === 0n) {
      return { priceE6: 0n, source, skipped: true, skipReason: "Meteora DLMM: binStep=0 (pool not initialised or live)" };
    }
    return { priceE6, source };
  }

  if (entry.dexType === "pumpswap") {
    const poolParsed = parseDexPool("pumpswap", poolPk, data);
    if (!poolParsed.baseVault || !poolParsed.quoteVault) {
      return { priceE6: 0n, source, skipped: true, skipReason: "PumpSwap: vault addresses missing from pool data" };
    }
    const [baseVaultInfo, quoteVaultInfo] = await Promise.all([
      withRpcBackoff(() => mainnetConn.getAccountInfo(poolParsed.baseVault!, "confirmed")),
      withRpcBackoff(() => mainnetConn.getAccountInfo(poolParsed.quoteVault!, "confirmed")),
    ]);
    if (!baseVaultInfo || !quoteVaultInfo) {
      return { priceE6: 0n, source, skipped: true, skipReason: "PumpSwap: vault account(s) not found on mainnet" };
    }
    const baseVaultData = new Uint8Array(baseVaultInfo.data);
    const quoteVaultData = new Uint8Array(quoteVaultInfo.data);
    const MIN_VAULT_LEN = 72;
    if (baseVaultData.length < MIN_VAULT_LEN || quoteVaultData.length < MIN_VAULT_LEN) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: `PumpSwap: vault data too short (base=${baseVaultData.length}, quote=${quoteVaultData.length})`,
      };
    }
    const baseDv = new DataView(baseVaultData.buffer, baseVaultData.byteOffset, baseVaultData.byteLength);
    const baseAmount = BigInt(baseDv.getUint32(64, true)) | (BigInt(baseDv.getUint32(68, true)) << 32n);
    if (baseAmount === 0n) {
      return { priceE6: 0n, source, skipped: true, skipReason: "PumpSwap: base vault amount=0 (pool not seeded / not live)" };
    }

    // Cache mint decimals after the first successful read (same pattern as
    // Meteora above) — pump.fun base tokens are almost always 6dp and WSOL is
    // 9dp, but decimals are fetched from the real mints rather than assumed.
    if (!decimalsCache.has(entry.poolAddress)) {
      const [baseDecimals, quoteDecimals] = await Promise.all([
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.baseMint)),
        withRpcBackoff(() => fetchMintDecimals(mainnetConn, poolParsed.quoteMint)),
      ]);
      decimalsCache.set(entry.poolAddress, { base: baseDecimals, quote: quoteDecimals });
      console.log(
        `[dexPoolReader] PumpSwap ${shortPool} decimals cached: base=${baseDecimals} quote=${quoteDecimals}`,
      );
    }
    const dec = decimalsCache.get(entry.poolAddress)!;

    const isWsolQuoted = poolParsed.quoteMint.equals(WSOL_MINT);
    if (isWsolQuoted && solPriceE6 === undefined) {
      return {
        priceE6: 0n,
        source,
        skipped: true,
        skipReason: "PumpSwap: pool is WSOL-quoted but no SOL/USD price was available this cycle",
      };
    }

    let priceE6: bigint;
    try {
      priceE6 = computeDexSpotPriceE6("pumpswap", data, { base: baseVaultData, quote: quoteVaultData }, dec, solPriceE6);
    } catch (err) {
      return { priceE6: 0n, source, skipped: true, skipReason: `PumpSwap: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (priceE6 === 0n) {
      return { priceE6: 0n, source, skipped: true, skipReason: "PumpSwap: computed price=0n" };
    }
    return { priceE6, source };
  }

  return { priceE6: 0n, source, skipped: true, skipReason: `unsupported dexType: ${String(entry.dexType)}` };
}

import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  encodePushOraclePrice,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  type MarketConfig,
} from "@percolator/core";
import { config } from "../config.js";
import { getConnection, loadKeypair, sendWithRetry } from "../utils/solana.js";
import { eventBus } from "./events.js";

interface PriceEntry {
  priceE6: bigint;
  source: string;
  timestamp: number;
}

// BL2: Extract magic numbers to named constants
const API_TIMEOUT_MS = 10_000; // 10 second timeout for external API calls
const PRICE_E6_MULTIPLIER = 1_000_000; // Price precision (6 decimals)
const CACHED_PRICE_MAX_AGE_MS = 60_000; // Reject cached prices older than 60s

// Cross-source validation: reject if DexScreener and Jupiter diverge by more than this %
const MAX_CROSS_SOURCE_DEVIATION_PCT = 10;

// DexScreener rate limit: cache responses for 10s to avoid hitting limits
const dexScreenerCache = new Map<string, { data: DexScreenerResponse; fetchedAt: number }>();
const DEX_SCREENER_CACHE_TTL_MS = 10_000;

interface DexScreenerResponse {
  pairs?: Array<{ priceUsd?: string; liquidity?: { usd?: number } }>;
}

function sortPairsByLiquidity(pairs: DexScreenerResponse["pairs"]): DexScreenerResponse["pairs"] {
  if (!pairs) return pairs;
  return [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
}

interface JupiterResponse {
  data?: Record<string, { price?: string }>;
}

export class OracleService {
  private priceHistory = new Map<string, PriceEntry[]>();
  private lastPushTime = new Map<string, number>();
  private _nonAuthorityLogged = new Set<string>();
  private readonly rateLimitMs = 5_000;
  private readonly maxHistory = 100;
  private readonly maxTrackedMarkets = 500;
  // BM2: Deduplicate concurrent requests for the same mint
  private inFlightRequests = new Map<string, Promise<bigint | null>>();

  /** Fetch price from DexScreener (with rate-limit cache) */
  async fetchDexScreenerPrice(mint: string): Promise<bigint | null> {
    // BM2: Deduplicate concurrent requests
    const inFlight = this.inFlightRequests.get(`dex:${mint}`);
    if (inFlight) return inFlight;
    
    const promise = this._fetchDexScreenerPriceInternal(mint);
    this.inFlightRequests.set(`dex:${mint}`, promise);
    
    try {
      return await promise;
    } finally {
      this.inFlightRequests.delete(`dex:${mint}`);
    }
  }

  private async _fetchDexScreenerPriceInternal(mint: string): Promise<bigint | null> {
    try {
      // BH7: Atomic cache check — capture timestamp once to avoid race condition
      const now = Date.now();
      const cached = dexScreenerCache.get(mint);
      
      if (cached) {
        const age = now - cached.fetchedAt;
        if (age < DEX_SCREENER_CACHE_TTL_MS) {
          // Cache hit — return cached value
          const pair = sortPairsByLiquidity(cached.data.pairs)?.[0];
          if (!pair?.priceUsd) return null;
          const p = parseFloat(pair.priceUsd);
          if (!isFinite(p) || p <= 0) return null;
          return BigInt(Math.round(p * PRICE_E6_MULTIPLIER));
        }
      }

      // Cache miss or expired — fetch fresh data
      // BM1: Add 10s timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      const json = (await res.json()) as DexScreenerResponse;
      // BH7: Use captured timestamp for atomicity
      dexScreenerCache.set(mint, { data: json, fetchedAt: now });

      const pair = sortPairsByLiquidity(json.pairs)?.[0];
      if (!pair?.priceUsd) return null;
      const parsed = parseFloat(pair.priceUsd);
      if (!isFinite(parsed) || parsed <= 0) return null;
      return BigInt(Math.round(parsed * PRICE_E6_MULTIPLIER));
    } catch {
      return null;
    }
  }

  /** Fetch price from Jupiter */
  async fetchJupiterPrice(mint: string): Promise<bigint | null> {
    // BM2: Deduplicate concurrent requests
    const inFlight = this.inFlightRequests.get(`jup:${mint}`);
    if (inFlight) return inFlight;
    
    const promise = this._fetchJupiterPriceInternal(mint);
    this.inFlightRequests.set(`jup:${mint}`, promise);
    
    try {
      return await promise;
    } finally {
      this.inFlightRequests.delete(`jup:${mint}`);
    }
  }

  private async _fetchJupiterPriceInternal(mint: string): Promise<bigint | null> {
    try {
      // BM1: Add 10s timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      
      const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      const json = (await res.json()) as JupiterResponse;
      const priceStr = json.data?.[mint]?.price;
      if (!priceStr) return null;
      const parsed = parseFloat(priceStr);
      if (!isFinite(parsed) || parsed <= 0) return null;
      return BigInt(Math.round(parsed * PRICE_E6_MULTIPLIER));
    } catch {
      return null;
    }
  }

  /**
   * Fetch price with cross-source validation and fallback.
   *
   * Strategy:
   *   1. Fetch DexScreener and Jupiter in parallel
   *   2. If both respond, cross-validate (reject if divergence > CROSS_SOURCE_MAX_DEVIATION_PCT)
   *   3. Use the higher-confidence source (DexScreener preferred, Jupiter fallback)
   *   4. If both fail, use cached price (reject if stale >60s)
   *   5. Historical deviation check (reject if >30% change from last known price)
   */
  async fetchPrice(mint: string, slabAddress: string): Promise<PriceEntry | null> {
    // Fetch both sources in parallel for cross-validation
    const [dexPrice, jupPrice] = await Promise.all([
      this.fetchDexScreenerPrice(mint),
      this.fetchJupiterPrice(mint),
    ]);

    // Cross-source validation: if both sources respond, check agreement
    if (dexPrice !== null && jupPrice !== null && dexPrice > 0n && jupPrice > 0n) {
      const larger = dexPrice > jupPrice ? dexPrice : jupPrice;
      const smaller = dexPrice > jupPrice ? jupPrice : dexPrice;
      const divergencePct = Number((larger - smaller) * 100n / smaller);

      if (divergencePct > MAX_CROSS_SOURCE_DEVIATION_PCT) {
        console.warn(
          `[OracleService] Cross-source divergence ${divergencePct}% exceeds ${MAX_CROSS_SOURCE_DEVIATION_PCT}% for ${mint} ` +
          `(dex=${dexPrice}, jup=${jupPrice}). Rejecting both — potential manipulation.`
        );
        return null;
      }
    }

    // Select best available price (DexScreener preferred)
    let priceE6: bigint | null = dexPrice;
    let source = "dexscreener";
    if (priceE6 === null) {
      priceE6 = jupPrice;
      source = "jupiter";
    }

    if (priceE6 === null) {
      const history = this.priceHistory.get(slabAddress);
      if (history && history.length > 0) {
        const last = history[history.length - 1];
        // Reject stale cached prices (>60s) to prevent bad liquidations
        if (Date.now() - last.timestamp > CACHED_PRICE_MAX_AGE_MS) {
          console.warn(`[OracleService] Cached price for ${mint} is stale (${Math.round((Date.now() - last.timestamp) / 1000)}s old), rejecting`);
          return null;
        }
        return { ...last, source: "cached" };
      }
      return null;
    }

    // R2-S4: Historical deviation check — reject if >30% change from last known price
    const history = this.priceHistory.get(slabAddress);
    if (history && history.length > 0) {
      const lastPrice = history[history.length - 1].priceE6;
      if (lastPrice > 0n) {
        const deviation = priceE6 > lastPrice
          ? Number((priceE6 - lastPrice) * 100n / lastPrice)
          : Number((lastPrice - priceE6) * 100n / lastPrice);
        if (deviation > 30) {
          console.warn(
            `[OracleService] Price deviation ${deviation}% exceeds 30% threshold for ${mint} ` +
            `(last=${lastPrice}, new=${priceE6}, source=${source}). Skipping.`
          );
          return null;
        }
      }
    }

    const entry: PriceEntry = { priceE6, source, timestamp: Date.now() };
    this.recordPrice(slabAddress, entry);
    return entry;
  }

  private recordPrice(slabAddress: string, entry: PriceEntry): void {
    let history = this.priceHistory.get(slabAddress);
    if (!history) {
      history = [];
      this.priceHistory.set(slabAddress, history);
    }
    history.push(entry);
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }
    // Evict least recently updated market if we exceed the global limit
    if (this.priceHistory.size > this.maxTrackedMarkets) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, hist] of this.priceHistory) {
        if (key === slabAddress) continue;
        const lastTs = hist.length > 0 ? hist[hist.length - 1].timestamp : 0;
        if (lastTs < oldestTime) {
          oldestTime = lastTs;
          oldestKey = key;
        }
      }
      if (oldestKey) this.priceHistory.delete(oldestKey);
    }
  }

  /** Push oracle price on-chain for admin-oracle market */
  async pushPrice(slabAddress: string, marketConfig: MarketConfig, marketProgramId?: PublicKey): Promise<boolean> {
    const now = Date.now();
    const lastPush = this.lastPushTime.get(slabAddress) ?? 0;
    if (now - lastPush < this.rateLimitMs) return false;

    // For coin-margined markets (collateral IS the index token), use collateralMint
    // For USDC-margined markets, we'd need a separate indexMint field
    // Currently all percolator markets are coin-margined, so collateralMint is correct
    const mint = marketConfig.collateralMint.toBase58();
    let priceEntry = await this.fetchPrice(mint, slabAddress);

    // Fallback for devnet test tokens with no external price source:
    // use the last on-chain authority price, or default to 1.0
    if (!priceEntry) {
      const onChainPrice = marketConfig.authorityPriceE6;
      if (onChainPrice > 0n) {
        priceEntry = { priceE6: onChainPrice, source: "on-chain", timestamp: Date.now() };
        console.log(`[OracleService] No external price for ${mint}, using on-chain: ${onChainPrice}`);
      } else {
        console.warn(`[OracleService] No price source for ${mint}, skipping`);
        return false; // Don't push a guessed price
      }
    }

    try {
      const connection = getConnection();
      const keypair = loadKeypair(config.crankKeypair);
      const slabPubkey = new PublicKey(slabAddress);
      const programId = marketProgramId ?? new PublicKey(config.programId);

      // BC4: Validate that crank keypair is the oracle authority
      if (!keypair.publicKey.equals(marketConfig.oracleAuthority)) {
        // Skip silently for markets we don't control — only log once per market
        if (!this._nonAuthorityLogged.has(slabAddress)) {
          this._nonAuthorityLogged.add(slabAddress);
          console.log(`[OracleService] Skipping ${slabAddress}: not oracle authority (our=${keypair.publicKey.toBase58().slice(0, 8)}... theirs=${marketConfig.oracleAuthority.toBase58().slice(0, 8)}...)`);
        }
        return false;
      }

      const data = encodePushOraclePrice({
        priceE6: priceEntry.priceE6,
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      });

      const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
        keypair.publicKey,
        slabPubkey,
      ]);

      const ix = buildIx({ programId, keys, data });
      console.log(`[OracleService] Pushing price ${priceEntry.priceE6} to ${slabAddress} via program ${programId.toBase58()}`);
      const sig = await sendWithRetry(connection, ix, [keypair]);
      console.log(`[OracleService] Price pushed OK: ${sig}`);

      this.lastPushTime.set(slabAddress, now);
      eventBus.publish("price.updated", slabAddress, {
        priceE6: priceEntry.priceE6.toString(),
        source: priceEntry.source,
      });
      return true;
    } catch (err) {
      console.error(`[OracleService] Failed to push price for ${slabAddress}:`, err);
      return false;
    }
  }

  /** Get current price for a market */
  getCurrentPrice(slabAddress: string): PriceEntry | null {
    const history = this.priceHistory.get(slabAddress);
    if (!history || history.length === 0) return null;
    return history[history.length - 1];
  }

  /** Get price history for a market */
  getPriceHistory(slabAddress: string): PriceEntry[] {
    return this.priceHistory.get(slabAddress) ?? [];
  }
}

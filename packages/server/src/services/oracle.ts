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

// DexScreener rate limit: cache responses for 10s to avoid hitting limits
const dexScreenerCache = new Map<string, { data: DexScreenerResponse; fetchedAt: number }>();
const DEX_SCREENER_CACHE_TTL_MS = 10_000;

interface DexScreenerResponse {
  pairs?: Array<{ priceUsd?: string }>;
}

interface JupiterResponse {
  data?: Record<string, { price?: string }>;
}

export class OracleService {
  private priceHistory = new Map<string, PriceEntry[]>();
  private lastPushTime = new Map<string, number>();
  private readonly rateLimitMs = 5_000;
  private readonly maxHistory = 100;
  private readonly maxTrackedMarkets = 500;

  /** Fetch price from DexScreener (with rate-limit cache) */
  async fetchDexScreenerPrice(mint: string): Promise<bigint | null> {
    try {
      // Check cache first
      const cached = dexScreenerCache.get(mint);
      if (cached && Date.now() - cached.fetchedAt < DEX_SCREENER_CACHE_TTL_MS) {
        const pair = cached.data.pairs?.[0];
        if (!pair?.priceUsd) return null;
        return BigInt(Math.round(parseFloat(pair.priceUsd) * 1_000_000));
      }

      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const json = (await res.json()) as DexScreenerResponse;
      dexScreenerCache.set(mint, { data: json, fetchedAt: Date.now() });

      const pair = json.pairs?.[0];
      if (!pair?.priceUsd) return null;
      return BigInt(Math.round(parseFloat(pair.priceUsd) * 1_000_000));
    } catch {
      return null;
    }
  }

  /** Fetch price from Jupiter */
  async fetchJupiterPrice(mint: string): Promise<bigint | null> {
    try {
      const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
      const json = (await res.json()) as JupiterResponse;
      const priceStr = json.data?.[mint]?.price;
      if (!priceStr) return null;
      return BigInt(Math.round(parseFloat(priceStr) * 1_000_000));
    } catch {
      return null;
    }
  }

  /** Fetch price with fallback: DexScreener → Jupiter → cached */
  async fetchPrice(mint: string, slabAddress: string): Promise<PriceEntry | null> {
    let priceE6 = await this.fetchDexScreenerPrice(mint);
    let source = "dexscreener";

    if (priceE6 === null) {
      priceE6 = await this.fetchJupiterPrice(mint);
      source = "jupiter";
    }

    if (priceE6 === null) {
      const history = this.priceHistory.get(slabAddress);
      if (history && history.length > 0) {
        return { ...history[history.length - 1], source: "cached" };
      }
      return null;
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
      const fallbackE6 = onChainPrice > 0n ? onChainPrice : 1_000_000n;
      priceEntry = { priceE6: fallbackE6, source: "fallback", timestamp: Date.now() };
      console.log(`[OracleService] No external price for ${mint}, using fallback: ${fallbackE6}`);
    }

    try {
      const connection = getConnection();
      const keypair = loadKeypair(config.crankKeypair);
      const slabPubkey = new PublicKey(slabAddress);
      const programId = marketProgramId ?? new PublicKey(config.programId);

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

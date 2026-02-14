/**
 * StatsCollector — Populates market_stats and oracle_prices tables.
 *
 * Runs after each crank cycle to read on-chain slab data and persist:
 * - Market stats (OI, vault, accounts, insurance, prices)
 * - Oracle prices (for price chart history)
 *
 * This closes two architecture gaps:
 * 1. market_stats table was never populated
 * 2. oracle_prices table was never populated
 */
import { PublicKey } from "@solana/web3.js";
import {
  parseEngine,
  parseConfig,
  parseAllAccounts,
  type EngineState,
  type MarketConfig,
} from "@percolator/core";
import { getConnection } from "../utils/solana.js";
import { upsertMarketStats, insertOraclePrice, get24hVolume } from "../db/queries.js";
import type { CrankService } from "./crank.js";
import type { OracleService } from "./oracle.js";

/** How often to collect stats (every 30s — runs after crank cycles) */
const COLLECT_INTERVAL_MS = 30_000;

/** How often to log oracle prices to DB (every 60s per market to avoid bloat) */
const ORACLE_LOG_INTERVAL_MS = 60_000;

export class StatsCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _collecting = false;
  private lastOracleLogTime = new Map<string, number>();

  constructor(
    private readonly crankService: CrankService,
    private readonly oracleService: OracleService,
  ) {}

  start(): void {
    if (this._running) return;
    this._running = true;

    // Initial collection after a short delay
    setTimeout(() => this.collect(), 10_000);

    // Periodic collection
    this.timer = setInterval(() => this.collect(), COLLECT_INTERVAL_MS);

    console.log("[StatsCollector] Started — collecting every 30s");
  }

  stop(): void {
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[StatsCollector] Stopped");
  }

  /**
   * Collect stats for all known markets by reading on-chain slab accounts.
   */
  private async collect(): Promise<void> {
    if (this._collecting || !this._running) return;
    this._collecting = true;

    try {
      const markets = this.crankService.getMarkets();
      if (markets.size === 0) return;

      const connection = getConnection();
      let updated = 0;
      let errors = 0;

      // Process markets in batches of 5 to avoid RPC rate limits
      const entries = Array.from(markets.entries());
      for (let i = 0; i < entries.length; i += 5) {
        const batch = entries.slice(i, i + 5);

        await Promise.all(batch.map(async ([slabAddress, state]) => {
          try {
            const slabPubkey = new PublicKey(slabAddress);
            const accountInfo = await connection.getAccountInfo(slabPubkey);
            if (!accountInfo?.data) return;

            const data = new Uint8Array(accountInfo.data);

            // Parse engine state
            let engine: EngineState;
            let marketConfig: MarketConfig;
            try {
              engine = parseEngine(data);
              marketConfig = parseConfig(data);
            } catch (parseErr) {
              // Slab too small or invalid — skip
              return;
            }

            // Calculate open interest (separate long/short)
            let oiLong = 0n;
            let oiShort = 0n;
            try {
              const accounts = parseAllAccounts(data);
              for (const { account } of accounts) {
                if (account.positionSize > 0n) {
                  oiLong += account.positionSize;
                } else if (account.positionSize < 0n) {
                  oiShort += -account.positionSize;
                }
              }
            } catch {
              // If account parsing fails, use engine aggregate
              oiLong = engine.totalOpenInterest > 0n ? engine.totalOpenInterest / 2n : 0n;
              oiShort = oiLong;
            }

            // Get current price from oracle service
            const priceEntry = this.oracleService.getCurrentPrice(slabAddress);
            const priceE6 = priceEntry?.priceE6 ?? marketConfig.authorityPriceE6;
            const priceUsd = priceE6 > 0n ? Number(priceE6) / 1_000_000 : null;

            // Calculate 24h volume from trades table
            let volume24h: number | null = null;
            try {
              const { volume } = await get24hVolume(slabAddress);
              volume24h = Number(volume);
            } catch (volErr) {
              // Non-fatal — volume calculation failure shouldn't break stats collection
              console.warn(`[StatsCollector] 24h volume calculation failed for ${slabAddress}:`, volErr instanceof Error ? volErr.message : volErr);
            }

            // Upsert market stats
            await upsertMarketStats({
              slab_address: slabAddress,
              last_price: priceUsd,
              mark_price: priceUsd, // Same as last_price for now (no funding adjustment)
              index_price: priceUsd,
              open_interest_long: Number(oiLong),
              open_interest_short: Number(oiShort),
              insurance_fund: Number(engine.insuranceFund.balance),
              total_accounts: engine.numUsedAccounts,
              funding_rate: Number(engine.fundingRateBpsPerSlotLast),
              volume_24h: volume24h,
              updated_at: new Date().toISOString(),
            });

            // Log oracle price to DB (rate-limited per market)
            if (priceE6 > 0n) {
              const lastLog = this.lastOracleLogTime.get(slabAddress) ?? 0;
              if (Date.now() - lastLog >= ORACLE_LOG_INTERVAL_MS) {
                try {
                  await insertOraclePrice({
                    slab_address: slabAddress,
                    price_e6: priceE6.toString(),
                    timestamp: Math.floor(Date.now() / 1000),
                  });
                  this.lastOracleLogTime.set(slabAddress, Date.now());
                } catch (oracleErr) {
                  // Non-fatal — oracle logging shouldn't break stats collection
                  console.warn(`[StatsCollector] Oracle price log failed for ${slabAddress}:`, oracleErr instanceof Error ? oracleErr.message : oracleErr);
                }
              }
            }

            updated++;
          } catch (err) {
            errors++;
            console.warn(`[StatsCollector] Failed for ${slabAddress}:`, err instanceof Error ? err.message : err);
          }
        }));

        // Small delay between batches
        if (i + 5 < entries.length) {
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }

      if (updated > 0 || errors > 0) {
        console.log(`[StatsCollector] Updated ${updated}/${markets.size} markets (${errors} errors)`);
      }
    } catch (err) {
      console.error("[StatsCollector] Collection failed:", err);
    } finally {
      this._collecting = false;
    }
  }
}

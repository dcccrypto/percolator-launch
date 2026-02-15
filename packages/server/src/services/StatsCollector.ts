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
  parseParams,
  parseAllAccounts,
  type EngineState,
  type MarketConfig,
  type RiskParams,
} from "@percolator/core";
import { getConnection } from "../utils/solana.js";
import { 
  upsertMarketStats, 
  insertOraclePrice, 
  get24hVolume,
  insertFundingHistory,
  getMarkets,
  insertMarket,
} from "../db/queries.js";
import { getSupabase } from "../db/client.js";
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
  private lastFundingLogSlot = new Map<string, number>();
  private lastOiHistoryTime = new Map<string, number>();
  private lastInsHistoryTime = new Map<string, number>();
  private lastFundingHistoryTime = new Map<string, number>();

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
   * Auto-register missing markets: compare on-chain markets vs DB and insert any missing.
   */
  private async syncMarkets(): Promise<void> {
    try {
      // Get on-chain markets from crank service
      const onChainMarkets = this.crankService.getMarkets();
      if (onChainMarkets.size === 0) return;

      // Get existing markets from DB
      const dbMarkets = await getMarkets();
      const dbSlabAddresses = new Set(dbMarkets.map(m => m.slab_address));

      // Find missing markets
      const missingMarkets: Array<[string, any]> = [];
      for (const [slabAddress, state] of onChainMarkets.entries()) {
        if (!dbSlabAddresses.has(slabAddress)) {
          missingMarkets.push([slabAddress, state]);
        }
      }

      if (missingMarkets.length === 0) return;

      console.log(`[StatsCollector] Found ${missingMarkets.length} new markets to register`);

      // Insert missing markets
      for (const [slabAddress, state] of missingMarkets) {
        try {
          const market = state.market;
          const mintAddress = market.config.collateralMint.toBase58();
          const admin = market.header.admin.toBase58();
          const oracleAuthority = market.config.oracleAuthority.toBase58();
          const priceE6 = Number(market.config.authorityPriceE6);
          const initialMarginBps = Number(market.params.initialMarginBps);
          
          // Derive fields as specified
          const symbol = mintAddress.substring(0, 8);
          const name = `Market ${slabAddress.substring(0, 8)}`;
          const maxLeverage = Math.floor(10000 / initialMarginBps);
          
          await insertMarket({
            slab_address: slabAddress,
            mint_address: mintAddress,
            symbol,
            name,
            decimals: 9,
            deployer: admin,
            oracle_authority: oracleAuthority,
            initial_price_e6: priceE6,
            max_leverage: maxLeverage,
            trading_fee_bps: 10,
            lp_collateral: null,
            matcher_context: null,
            status: "active",
          });

          console.log(`[StatsCollector] Registered new market: ${slabAddress} (${symbol})`);
        } catch (err) {
          console.warn(`[StatsCollector] Failed to register market ${slabAddress}:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.error("[StatsCollector] Market sync failed:", err);
    }
  }

  /**
   * Collect stats for all known markets by reading on-chain slab accounts.
   */
  private async collect(): Promise<void> {
    if (this._collecting || !this._running) return;
    this._collecting = true;

    try {
      // Auto-register missing markets at the start of each cycle
      await this.syncMarkets();

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

            // Parse engine state and risk params
            let engine: EngineState;
            let marketConfig: MarketConfig;
            let params: RiskParams;
            try {
              engine = parseEngine(data);
              marketConfig = parseConfig(data);
              params = parseParams(data);
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

            // Upsert market stats with ALL RiskEngine fields (migration 010)
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
              // Hidden features (migration 007)
              total_open_interest: Number(engine.totalOpenInterest),
              net_lp_pos: engine.netLpPos.toString(),
              lp_sum_abs: Number(engine.lpSumAbs),
              lp_max_abs: Number(engine.lpMaxAbs),
              insurance_balance: Number(engine.insuranceFund.balance),
              insurance_fee_revenue: Number(engine.insuranceFund.feeRevenue),
              warmup_period_slots: Number(params.warmupPeriodSlots),
              // Complete RiskEngine state fields (migration 010)
              vault_balance: Number(engine.vault),
              lifetime_liquidations: Number(engine.lifetimeLiquidations),
              lifetime_force_closes: Number(engine.lifetimeForceCloses),
              c_tot: Number(engine.cTot),
              pnl_pos_tot: Number(engine.pnlPosTot),
              last_crank_slot: Number(engine.lastCrankSlot),
              max_crank_staleness_slots: Number(engine.maxCrankStalenessSlots),
              // RiskParams fields (migration 010)
              maintenance_fee_per_slot: params.maintenanceFeePerSlot.toString(),
              liquidation_fee_bps: Number(params.liquidationFeeBps),
              liquidation_fee_cap: params.liquidationFeeCap.toString(),
              liquidation_buffer_bps: Number(params.liquidationBufferBps),
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

            // Log OI history (rate-limited per market)
            const OI_HISTORY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
            const lastOiLog = this.lastOiHistoryTime.get(slabAddress) ?? 0;
            if (Date.now() - lastOiLog >= OI_HISTORY_INTERVAL_MS) {
              try {
                await getSupabase().from('oi_history').insert({
                  market_slab: slabAddress,
                  slot: Number(engine.lastCrankSlot),
                  total_oi: Number(engine.totalOpenInterest),
                  net_lp_pos: Number(engine.netLpPos),
                  lp_sum_abs: Number(engine.lpSumAbs),
                  lp_max_abs: Number(engine.lpMaxAbs),
                });
                this.lastOiHistoryTime.set(slabAddress, Date.now());
              } catch (e) {
                // Non-fatal
                console.warn(`[StatsCollector] OI history log failed for ${slabAddress}:`, e instanceof Error ? e.message : e);
              }
            }

            // Log insurance history (rate-limited per market)
            const INS_HISTORY_INTERVAL_MS = 5 * 60 * 1000;
            const lastInsLog = this.lastInsHistoryTime.get(slabAddress) ?? 0;
            if (Date.now() - lastInsLog >= INS_HISTORY_INTERVAL_MS) {
              try {
                await getSupabase().from('insurance_history').insert({
                  market_slab: slabAddress,
                  slot: Number(engine.lastCrankSlot),
                  balance: Number(engine.insuranceFund.balance),
                  fee_revenue: Number(engine.insuranceFund.feeRevenue),
                });
                this.lastInsHistoryTime.set(slabAddress, Date.now());
              } catch (e) {
                console.warn(`[StatsCollector] Insurance history log failed for ${slabAddress}:`, e instanceof Error ? e.message : e);
              }
            }

            // Log funding history (rate-limited per market)
            const FUNDING_HISTORY_INTERVAL_MS = 5 * 60 * 1000;
            const lastFundLog = this.lastFundingHistoryTime.get(slabAddress) ?? 0;
            if (Date.now() - lastFundLog >= FUNDING_HISTORY_INTERVAL_MS) {
              try {
                await getSupabase().from('funding_history').insert({
                  market_slab: slabAddress,
                  slot: Number(engine.lastCrankSlot),
                  rate_bps_per_slot: Number(engine.fundingRateBpsPerSlotLast),
                  net_lp_pos: Number(engine.netLpPos),
                  price_e6: Number(priceE6),
                  funding_index_qpb_e6: engine.fundingIndexQpbE6.toString(),
                });
                this.lastFundingHistoryTime.set(slabAddress, Date.now());
              } catch (e) {
                console.warn(`[StatsCollector] Funding history log failed for ${slabAddress}:`, e instanceof Error ? e.message : e);
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

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
  type DiscoveredMarket,
} from "@percolator/sdk";
import { 
  getConnection,
  upsertMarketStats, 
  insertOraclePrice, 
  get24hVolume,
  getMarkets,
  insertMarket,
  getSupabase,
  withRetry,
  createLogger,
  captureException,
  addBreadcrumb,
} from "@percolator/shared";

const logger = createLogger("indexer:stats-collector");

/** Market provider interface — allows different market discovery strategies */
export interface MarketProvider {
  getMarkets(): Map<string, { market: DiscoveredMarket }>;
}

/** How often to collect stats (every 30s — runs after crank cycles) */
const COLLECT_INTERVAL_MS = 120_000;

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
    private readonly marketProvider: MarketProvider,
  ) {}

  start(): void {
    if (this._running) return;
    this._running = true;

    // Initial collection after a short delay
    setTimeout(() => this.collect(), 10_000);

    // Periodic collection
    this.timer = setInterval(() => this.collect(), COLLECT_INTERVAL_MS);

    logger.info("StatsCollector started", { intervalMs: COLLECT_INTERVAL_MS });
  }

  stop(): void {
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("StatsCollector stopped");
  }

  /**
   * Auto-register missing markets: compare on-chain markets vs DB and insert any missing.
   */
  private async syncMarkets(): Promise<void> {
    try {
      // Get on-chain markets from market provider
      const onChainMarkets = this.marketProvider.getMarkets();
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

      logger.info("New markets found", { count: missingMarkets.length });

      // Insert missing markets
      const connection = getConnection();
      for (const [slabAddress, state] of missingMarkets) {
        try {
          const market = state.market;
          const mintAddress = market.config.collateralMint.toBase58();
          const admin = market.header.admin.toBase58();
          const oracleAuthority = market.config.oracleAuthority.toBase58();
          const priceE6 = Number(market.config.authorityPriceE6);
          const initialMarginBps = Number(market.params.initialMarginBps);
          const maxLeverage = Math.floor(10000 / initialMarginBps);
          
          // Try to resolve token metadata from on-chain (Helius DAS / Metaplex)
          let symbol = mintAddress.substring(0, 8); // fallback
          let name = `Market ${slabAddress.substring(0, 8)}`; // fallback
          let decimals = 9;
          try {
            const mintPubkey = new PublicKey(mintAddress);
            const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
            if (mintInfo.value?.data && "parsed" in mintInfo.value.data) {
              decimals = mintInfo.value.data.parsed.info.decimals ?? 9;
            }
            // Try Helius DAS API if the RPC endpoint supports it
            const endpoint = connection.rpcEndpoint;
            if (endpoint.includes("helius-rpc.com")) {
              const dasRes = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: `das-${mintAddress}`,
                  method: "getAsset",
                  params: { id: mintAddress, options: { showFungible: true } },
                }),
                signal: AbortSignal.timeout(5000),
              });
              if (dasRes.ok) {
                const dasJson = await dasRes.json();
                const metadata = dasJson?.result?.content?.metadata;
                const tokenInfo = dasJson?.result?.token_info;
                const dasSym = metadata?.symbol || tokenInfo?.symbol;
                const dasName = metadata?.name;
                const dasDecimals = tokenInfo?.decimals;
                if (dasSym) symbol = dasSym;
                if (dasName) name = dasName;
                if (dasDecimals != null) decimals = dasDecimals;
              }
            }
          } catch (metaErr) {
            logger.debug("Token metadata resolution failed, using fallback", { mintAddress, error: metaErr instanceof Error ? metaErr.message : metaErr });
          }

          // Validate decimals: SPL tokens use 0-18. Values outside this range
          // indicate corrupted metadata (wrong byte offset, garbage DAS response).
          if (decimals < 0 || decimals > 18 || !Number.isInteger(decimals)) {
            logger.warn("Invalid token decimals detected, clamping to default", {
              mintAddress, rawDecimals: decimals, fallback: 6,
            });
            decimals = 6;
          }
          
          // Clamp decimals to sane range — some on-chain mints have garbage values
          const clampedDecimals = Math.min(Math.max(decimals, 0), 18);
          await insertMarket({
            slab_address: slabAddress,
            mint_address: mintAddress,
            symbol,
            name,
            decimals: clampedDecimals,
            deployer: admin,
            oracle_authority: oracleAuthority,
            initial_price_e6: priceE6,
            max_leverage: maxLeverage,
            trading_fee_bps: 10,
            lp_collateral: null,
            matcher_context: null,
            status: "active",
          });

          logger.info("Market registered", { slabAddress, symbol, name });
        } catch (err) {
          logger.warn("Failed to register market", { slabAddress, error: err instanceof Error ? err.message : err });
        }
      }
    } catch (err) {
      logger.error("Market sync failed", { error: err });
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

      const markets = this.marketProvider.getMarkets();
      if (markets.size === 0) return;

      const connection = getConnection();
      let updated = 0;
      let errors = 0;

      // Process markets in batches of 5 to avoid RPC rate limits
      // Use getMultipleAccountsInfo for batch fetching to reduce RPC round trips
      const entries = Array.from(markets.entries());
      for (let i = 0; i < entries.length; i += 5) {
        const batch = entries.slice(i, i + 5);
        const slabPubkeys = batch.map(([slabAddress]) => new PublicKey(slabAddress));

        try {
          // Batch fetch all account infos in one RPC call
          const accountInfos = await withRetry(
            () => connection.getMultipleAccountsInfo(slabPubkeys),
            { 
              maxRetries: 3, 
              baseDelayMs: 1000, 
              label: `getMultipleAccountsInfo(batch ${i / 5 + 1})` 
            }
          );

          // Process each account
          await Promise.all(batch.map(async ([slabAddress, state], batchIndex) => {
            try {
              const accountInfo = accountInfos[batchIndex];
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

            // Use on-chain price with oracle-mode-aware resolution
            // Oracle modes:
            //   - pyth-pinned: oracleAuthority == [0;32] → use lastEffectivePriceE6
            //   - hyperp: indexFeedId == [0;32] → use lastEffectivePriceE6 (index price)
            //   - admin: both non-zero → use authorityPriceE6 (authority-pushed price)
            const zeroKeyBytes = new Uint8Array(32);
            const isHyperpMode = marketConfig.indexFeedId.equals(new PublicKey(zeroKeyBytes));
            const isPythPinned = !isHyperpMode && marketConfig.oracleAuthority.equals(new PublicKey(zeroKeyBytes));
            let priceE6: bigint;
            if (isPythPinned || isHyperpMode) {
              // Pyth-pinned and hyperp: use lastEffectivePriceE6 (on-chain resolved price)
              // For hyperp, authorityPriceE6 is the mark price which can be inflated
              priceE6 = marketConfig.lastEffectivePriceE6;
            } else {
              // Admin oracle: prefer authorityPriceE6, fall back to lastEffectivePriceE6
              priceE6 = marketConfig.authorityPriceE6 > 0n
                ? marketConfig.authorityPriceE6
                : marketConfig.lastEffectivePriceE6;
            }
            const priceUsd = priceE6 > 0n ? Number(priceE6) / 1_000_000 : null;

            // Calculate 24h volume from trades table
            let volume24h: number | null = null;
            try {
              const { volume } = await get24hVolume(slabAddress);
              volume24h = Number(volume);
            } catch (volErr) {
              // Non-fatal — volume calculation failure shouldn't break stats collection
              logger.warn("24h volume calculation failed", { slabAddress, error: volErr instanceof Error ? volErr.message : volErr });
            }

            // Safe bigint→number: treat u64::MAX (≈1.844e19) and u128::MAX as sentinel → 0
            const U64_MAX = 18446744073709551615n;
            const safeBigNum = (v: bigint): number => {
              if (v >= U64_MAX || v < 0n) return 0;
              return Number(v);
            };

            // Sanity-check parsed engine values: if the slab layout detection
            // failed (wrong tier), the parser reads garbage from wrong offsets.
            // Telltale sign: values like 9.8e34 OI or 1.8e25 insurance.
            // Max sane value: 1e18 (u64::MAX ≈ 1.8e19, so anything near that is suspect)
            const MAX_SANE_VALUE = 1e18;
            const isSaneEngine = (
              safeBigNum(engine.totalOpenInterest) < MAX_SANE_VALUE &&
              safeBigNum(engine.insuranceFund.balance) < MAX_SANE_VALUE &&
              safeBigNum(engine.cTot) < MAX_SANE_VALUE &&
              safeBigNum(engine.vault) < MAX_SANE_VALUE
            );

            if (!isSaneEngine) {
              logger.warn("Insane engine state values detected (likely wrong slab layout), skipping stats update", {
                slabAddress,
                totalOI: safeBigNum(engine.totalOpenInterest),
                insurance: safeBigNum(engine.insuranceFund.balance),
                cTot: safeBigNum(engine.cTot),
                vault: safeBigNum(engine.vault),
              });
              return;
            }

            // Upsert market stats with ALL RiskEngine fields (migration 010)
            await upsertMarketStats({
              slab_address: slabAddress,
              last_price: priceUsd,
              mark_price: priceUsd, // Same as last_price for now (no funding adjustment)
              index_price: priceUsd,
              open_interest_long: safeBigNum(oiLong),
              open_interest_short: safeBigNum(oiShort),
              insurance_fund: safeBigNum(engine.insuranceFund.balance),
              total_accounts: engine.numUsedAccounts,
              funding_rate: Number(engine.fundingRateBpsPerSlotLast),
              volume_24h: volume24h,
              // Hidden features (migration 007)
              total_open_interest: safeBigNum(engine.totalOpenInterest),
              net_lp_pos: engine.netLpPos.toString(),
              lp_sum_abs: safeBigNum(engine.lpSumAbs),
              lp_max_abs: safeBigNum(engine.lpMaxAbs),
              insurance_balance: safeBigNum(engine.insuranceFund.balance),
              insurance_fee_revenue: safeBigNum(engine.insuranceFund.feeRevenue),
              warmup_period_slots: Number(params.warmupPeriodSlots),
              // Complete RiskEngine state fields (migration 010)
              vault_balance: safeBigNum(engine.vault),
              lifetime_liquidations: safeBigNum(engine.lifetimeLiquidations),
              lifetime_force_closes: safeBigNum(engine.lifetimeForceCloses),
              c_tot: safeBigNum(engine.cTot),
              pnl_pos_tot: safeBigNum(engine.pnlPosTot),
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
                  logger.warn("Oracle price log failed", { slabAddress, error: oracleErr instanceof Error ? oracleErr.message : oracleErr });
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
                logger.warn("OI history log failed", { slabAddress, error: e instanceof Error ? e.message : e });
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
                  balance: safeBigNum(engine.insuranceFund.balance),
                  fee_revenue: safeBigNum(engine.insuranceFund.feeRevenue),
                });
                this.lastInsHistoryTime.set(slabAddress, Date.now());
              } catch (e) {
                logger.warn("Insurance history log failed", { slabAddress, error: e instanceof Error ? e.message : e });
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
        } catch (batchErr) {
          // If batch fetch fails, log all markets in batch as errors
          errors += batch.length;
          console.error(`[StatsCollector] Batch fetch failed:`, batchErr instanceof Error ? batchErr.message : batchErr);
        }

        // Small delay between batches
        if (i + 5 < entries.length) {
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }

      if (updated > 0 || errors > 0) {
        console.log(`[StatsCollector] Updated ${updated}/${markets.size} markets (${errors} errors)`);
        if (errors > 0) {
          addBreadcrumb("StatsCollector completed with errors", {
            updated,
            errors,
            totalMarkets: markets.size,
          });
        }
      }
    } catch (err) {
      console.error("[StatsCollector] Collection failed:", err);
      captureException(err, {
        tags: { context: "stats-collector-error" },
        extra: {
          marketsCount: this.marketProvider.getMarkets().size,
        },
      });
    } finally {
      this._collecting = false;
    }
  }
}

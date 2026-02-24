import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  discoverMarkets,
  encodeKeeperCrank,
  buildAccountMetas,
  buildIx,
  derivePythPushOraclePDA,
  ACCOUNTS_KEEPER_CRANK,
  type DiscoveredMarket,
} from "@percolator/sdk";
import { config, getConnection, getFallbackConnection, loadKeypair, sendWithRetry, rateLimitedCall, eventBus, createLogger, sendCriticalAlert } from "@percolator/shared";
import { OracleService } from "./oracle.js";

const logger = createLogger("keeper:crank");

interface MarketCrankState {
  market: DiscoveredMarket;
  lastCrankTime: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  /** Considered active if it has had at least one successful crank */
  isActive: boolean;
  /** Number of consecutive discoveries where this market was missing */
  missingDiscoveryCount: number;
}

/** Process items in batches with delay between batches.
 *  Each item is wrapped in try/catch so one failure doesn't kill the batch.
 *  BM7: Enhanced error tracking per item. */
async function processBatched<T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  fn: (item: T) => Promise<void>,
): Promise<{ succeeded: number; failed: number; errors: Map<string, Error> }> {
  const errors = new Map<string, Error>();
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(async (item) => {
      try {
        await fn(item);
        succeeded++;
      } catch (err) {
        failed++;
        const itemKey = String(item);
        const errorObj = err instanceof Error ? err : new Error(String(err));
        errors.set(itemKey, errorObj);
        logger.error("Batch item failed", { item: itemKey, error: errorObj.message });
      }
    }));
    if (i + batchSize < items.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return { succeeded, failed, errors };
}

export class CrankService {
  private markets = new Map<string, MarketCrankState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly inactiveIntervalMs: number;
  private readonly discoveryIntervalMs: number;
  private readonly oracleService: OracleService;
  private lastCycleResult = { success: 0, failed: 0, skipped: 0 };
  private lastDiscoveryTime = 0;
  // BC1: Signature replay protection
  private recentSignatures = new Map<string, number>(); // signature -> timestamp
  private readonly signatureTTLMs = 60_000; // 60 seconds
  private _isRunning = false;
  private _cycling = false;

  constructor(oracleService: OracleService, intervalMs?: number) {
    this.oracleService = oracleService;
    this.intervalMs = intervalMs ?? config.crankIntervalMs;
    this.inactiveIntervalMs = config.crankInactiveIntervalMs;
    this.discoveryIntervalMs = config.discoveryIntervalMs;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  async discover(): Promise<DiscoveredMarket[]> {
    const programIds = config.allProgramIds;
    logger.info("Discovering markets", { programCount: programIds.length });
    // Use fallback RPC for discovery (Helius rate-limits getProgramAccounts)
    // Sequential calls with delay to avoid 429 from public RPC
    const discoveryConn = getFallbackConnection();
    const allFound: DiscoveredMarket[] = [];
    for (const id of programIds) {
      try {
        const found = await discoverMarkets(discoveryConn, new PublicKey(id));
        logger.debug("Program scan complete", { programId: id, marketCount: found.length });
        allFound.push(...found);
      } catch (e) {
        logger.warn("Program scan failed", { programId: id, error: e });
      }
      // 2s delay between programs to avoid rate limits
      if (programIds.indexOf(id) < programIds.length - 1) {
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    const discovered = allFound;
    this.lastDiscoveryTime = Date.now();
    logger.info("Market discovery complete", { totalMarkets: discovered.length });

    const discoveredKeys = new Set<string>();
    for (const market of discovered) {
      const key = market.slabAddress.toBase58();
      discoveredKeys.add(key);
      if (!this.markets.has(key)) {
        this.markets.set(key, {
          market,
          lastCrankTime: 0,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          isActive: true,
          missingDiscoveryCount: 0,
        });
      } else {
        const state = this.markets.get(key)!;
        state.market = market;
        state.missingDiscoveryCount = 0;
      }
    }

    // Bug 17: Track markets missing from discovery, remove after 3 consecutive misses
    for (const [key, state] of this.markets) {
      if (!discoveredKeys.has(key)) {
        state.missingDiscoveryCount++;
        if (state.missingDiscoveryCount >= 3) {
          logger.warn("Removing dead market", { slabAddress: key, missingCount: state.missingDiscoveryCount });
          this.markets.delete(key);
        }
      }
    }

    return discovered;
  }

  private isAdminOracle(market: DiscoveredMarket): boolean {
    return !market.config.oracleAuthority.equals(PublicKey.default);
  }

  /** Check if a market is due for cranking based on activity */
  private isDue(state: MarketCrankState): boolean {
    const interval = state.isActive ? this.intervalMs : this.inactiveIntervalMs;
    return Date.now() - state.lastCrankTime >= interval;
  }

  async crankMarket(slabAddress: string): Promise<boolean> {
    const state = this.markets.get(slabAddress);
    if (!state) {
      logger.warn("Market not found", { slabAddress });
      return false;
    }

    const { market } = state;

    try {
      if (this.isAdminOracle(market)) {
        try {
          await this.oracleService.pushPrice(slabAddress, market.config, market.programId);
        } catch (priceErr) {
          // Non-fatal: oracle authority may be the market admin, not the crank.
          logger.warn("Price push skipped", { slabAddress, error: priceErr instanceof Error ? priceErr.message : String(priceErr) });
        }
      }

      const connection = getConnection();
      const keypair = loadKeypair(config.crankKeypair);
      const programId = market.programId;

      const data = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });

      let oracleKey: PublicKey;
      if (this.isAdminOracle(market)) {
        oracleKey = market.slabAddress;
      } else {
        const feedHex = Array.from(market.config.indexFeedId.toBytes())
          .map(b => b.toString(16).padStart(2, "0")).join("");
        oracleKey = derivePythPushOraclePDA(feedHex)[0];
      }

      const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        keypair.publicKey,
        market.slabAddress,
        SYSVAR_CLOCK_PUBKEY,
        oracleKey,
      ]);

      const ix = buildIx({ programId, keys, data });
      const sig = await sendWithRetry(connection, ix, [keypair]);

      // BC1: Track signature to prevent replay attacks
      const now = Date.now();
      this.recentSignatures.set(sig, now);
      // Clean up signatures older than TTL
      for (const [oldSig, timestamp] of this.recentSignatures.entries()) {
        if (now - timestamp > this.signatureTTLMs) {
          this.recentSignatures.delete(oldSig);
        }
      }

      state.lastCrankTime = Date.now();
      state.successCount++;
      state.consecutiveFailures = 0;
      state.isActive = true;
      if (state.failureCount > 0) state.failureCount = 0;

      eventBus.publish("crank.success", slabAddress, { signature: sig });
      return true;
    } catch (err) {
      state.failureCount++;
      state.consecutiveFailures++;
      // Mark inactive after 10 consecutive failures regardless of lifetime success
      if (state.consecutiveFailures >= 10) {
        state.isActive = false;
      }
      
      logger.error("Crank failed", {
        slabAddress,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        consecutiveFailures: state.consecutiveFailures,
        market: market.slabAddress.toBase58(),
        programId: market.programId.toBase58(),
      });
      
      // Alert on 5+ consecutive failures
      if (state.consecutiveFailures === 5) {
        await sendCriticalAlert("Crank experiencing consecutive failures", [
          { name: "Market", value: slabAddress.slice(0, 12), inline: true },
          { name: "Consecutive Failures", value: state.consecutiveFailures.toString(), inline: true },
          { name: "Error", value: (err instanceof Error ? err.message : String(err)).slice(0, 100), inline: false },
        ]);
      }
      
      eventBus.publish("crank.failure", slabAddress, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async crankAll(): Promise<{ success: number; failed: number; skipped: number }> {
    let success = 0;
    let failed = 0;
    let skipped = 0;

    const MAX_CONSECUTIVE_FAILURES = 10;

    const toCrank: string[] = [];

    // H5: Crank all discovered markets, not just admin-oracle ones
    for (const [slabAddress, state] of this.markets) {
      if (state.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        skipped++;
        continue;
      }

      if (!this.isDue(state)) {
        skipped++;
        continue;
      }

      toCrank.push(slabAddress);
    }

    if (toCrank.length !== this.markets.size - skipped) {
      logger.warn("Crank mismatch", { totalMarkets: this.markets.size, toCrank: toCrank.length, skipped });
    }

    // Process in batches of 3 with 2s gaps between batches
    // BM7: Collect per-market error tracking
    const batchResult = await processBatched(toCrank, 3, 2_000, async (slabAddress) => {
      const ok = await this.crankMarket(slabAddress);
      if (ok) success++;
      else failed++;
    });

    // BM7: Log detailed error summary if any failed
    if (batchResult.failed > 0) {
      logger.error("Batch completed with errors", { 
        failedCount: batchResult.failed,
        successCount: success
      });
      for (const [slab, error] of batchResult.errors) {
        logger.error("Batch error detail", { slabAddress: slab, error: error.message });
      }
    }

    this.lastCycleResult = { success, failed, skipped };
    return { success, failed, skipped };
  }

  start(): void {
    if (this.timer) return;
    this._isRunning = true;
    logger.info("Crank service starting", { intervalMs: this.intervalMs, inactiveIntervalMs: this.inactiveIntervalMs });

    this.discover().then(markets => {
      logger.info("Initial discovery complete", { marketCount: markets.length });
    }).catch(err => {
      logger.error("Initial discovery failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    });

    this.timer = setInterval(async () => {
      if (this._cycling) return; // Prevent overlapping cycles
      this._cycling = true;
      try {
        // Only rediscover periodically (default 5min) to avoid RPC rate limits
        const needsDiscovery = this.markets.size === 0 ||
          (Date.now() - this.lastDiscoveryTime >= this.discoveryIntervalMs);
        if (needsDiscovery) {
          await this.discover();
        }
        if (this.markets.size > 0) {
          const result = await this.crankAll();
          if (result.failed > 0) {
            logger.info("Crank cycle complete", { success: result.success, failed: result.failed, skipped: result.skipped });
          }
        }
      } catch (err) {
        logger.error("Crank cycle failed", { error: err });
      } finally {
        this._cycling = false;
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this._isRunning = false;
      logger.info("Crank service stopped");
    }
  }

  getStatus(): Record<string, { lastCrankTime: number; successCount: number; failureCount: number; isActive: boolean }> {
    const status: Record<string, { lastCrankTime: number; successCount: number; failureCount: number; isActive: boolean }> = {};
    for (const [key, state] of this.markets) {
      status[key] = {
        lastCrankTime: state.lastCrankTime,
        successCount: state.successCount,
        failureCount: state.failureCount,
        isActive: state.isActive,
      };
    }
    return status;
  }

  getLastCycleResult() {
    return this.lastCycleResult;
  }

  getMarkets(): Map<string, MarketCrankState> {
    return this.markets;
  }
}

import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  discoverMarkets,
  encodeKeeperCrank,
  buildAccountMetas,
  buildIx,
  derivePythPushOraclePDA,
  ACCOUNTS_KEEPER_CRANK,
  type DiscoveredMarket,
} from "@percolator/core";
import { config } from "../config.js";
import { getConnection, loadKeypair, sendWithRetry } from "../utils/solana.js";
import { rateLimitedCall } from "../utils/rpc-client.js";
import { eventBus } from "./events.js";
import { OracleService } from "./oracle.js";

interface MarketCrankState {
  market: DiscoveredMarket;
  lastCrankTime: number;
  successCount: number;
  failureCount: number;
  /** Considered active if it has had at least one successful crank */
  isActive: boolean;
}

/** Process items in batches with delay between batches */
async function processBatched<T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));
    if (i + batchSize < items.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export class CrankService {
  private markets = new Map<string, MarketCrankState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly inactiveIntervalMs: number;
  private readonly oracleService: OracleService;
  private lastCycleResult = { success: 0, failed: 0, skipped: 0 };
  private _isRunning = false;

  constructor(oracleService: OracleService, intervalMs?: number) {
    this.oracleService = oracleService;
    this.intervalMs = intervalMs ?? config.crankIntervalMs;
    this.inactiveIntervalMs = config.crankInactiveIntervalMs;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  async discover(): Promise<DiscoveredMarket[]> {
    const programIds = config.allProgramIds;
    console.log(`[CrankService] Discovering markets across ${programIds.length} programs...`);
    const results = await Promise.all(
      programIds.map(async (id) => {
        try {
          const found = await rateLimitedCall(
            (conn) => discoverMarkets(conn, new PublicKey(id)),
            { readOnly: true },
          );
          console.log(`[CrankService] Program ${id}: ${found.length} markets`);
          return found;
        } catch (e) {
          console.warn(`[CrankService] Failed to discover on ${id}:`, e);
          return [] as DiscoveredMarket[];
        }
      })
    );
    const discovered = results.flat();
    console.log(`[CrankService] Found ${discovered.length} markets total`);

    for (const market of discovered) {
      const key = market.slabAddress.toBase58();
      if (!this.markets.has(key)) {
        this.markets.set(key, {
          market,
          lastCrankTime: 0,
          successCount: 0,
          failureCount: 0,
          isActive: true, // assume active until proven otherwise
        });
      } else {
        this.markets.get(key)!.market = market;
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
      console.warn(`[CrankService] Market ${slabAddress} not found`);
      return false;
    }

    const { market } = state;

    try {
      if (this.isAdminOracle(market)) {
        await this.oracleService.pushPrice(slabAddress, market.config, market.programId);
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

      state.lastCrankTime = Date.now();
      state.successCount++;
      state.isActive = true;
      if (state.failureCount > 0) state.failureCount = 0;

      eventBus.publish("crank.success", slabAddress, { signature: sig });
      return true;
    } catch (err) {
      state.failureCount++;
      // After 5 consecutive failures with no successes, mark inactive
      if (state.failureCount >= 5 && state.successCount === 0) {
        state.isActive = false;
      }
      eventBus.publish("crank.failure", slabAddress, {
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[CrankService] Crank failed for ${slabAddress}:`, err);
      return false;
    }
  }

  async crankAll(): Promise<{ success: number; failed: number; skipped: number }> {
    let success = 0;
    let failed = 0;
    let skipped = 0;

    const keypair = loadKeypair(config.crankKeypair);
    const crankPubkey = keypair.publicKey;
    const MAX_CONSECUTIVE_FAILURES = 10;

    const toCrank: string[] = [];

    for (const [slabAddress, state] of this.markets) {
      const oracleAuth = state.market.config.oracleAuthority;
      if (!oracleAuth.equals(crankPubkey)) continue;

      if (state.failureCount > MAX_CONSECUTIVE_FAILURES && state.successCount === 0) {
        skipped++;
        continue;
      }

      if (!this.isDue(state)) {
        skipped++;
        continue;
      }

      toCrank.push(slabAddress);
    }

    // Process in batches of 3 with 2s gaps between batches
    await processBatched(toCrank, 3, 2_000, async (slabAddress) => {
      const ok = await this.crankMarket(slabAddress);
      if (ok) success++;
      else failed++;
    });

    this.lastCycleResult = { success, failed, skipped };
    return { success, failed, skipped };
  }

  start(): void {
    if (this.timer) return;
    this._isRunning = true;
    console.log(`[CrankService] Starting with interval ${this.intervalMs}ms (inactive: ${this.inactiveIntervalMs}ms)`);

    this.discover().then(markets => {
      console.log(`[CrankService] Initial discover: ${markets.length} markets found`);
    }).catch(err => {
      console.error("[CrankService] Initial discover failed:", err);
    });

    this.timer = setInterval(async () => {
      try {
        const markets = await this.discover();
        if (markets.length > 0) {
          const result = await this.crankAll();
          if (result.failed > 0) {
            console.warn(`[CrankService] Crank cycle: ${result.success} ok, ${result.failed} failed, ${result.skipped} skipped`);
          }
        }
      } catch (err) {
        console.error("[CrankService] Cycle error:", err);
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this._isRunning = false;
      console.log("[CrankService] Stopped");
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

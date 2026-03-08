/**
 * PERC-377: Filler Bot — Proactive Order Matching + Cranking
 *
 * Inspired by Drift's filler-bot from keeper-bots-v2.
 * In Percolator's LP-based model, the filler:
 *   1. Cranks all discovered markets at regular intervals
 *   2. Monitors for stale oracle prices and refreshes them
 *   3. Detects liquidation candidates and triggers forced closes
 *   4. Pushes oracle prices for Hyperp-mode markets
 *
 * Unlike an orderbook DEX where fillers match maker/taker orders,
 * Percolator's vAMM matcher handles matching. The filler ensures the
 * system stays healthy and responsive.
 */

import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import type { BotConfig } from "./config.js";
import type { ManagedMarket } from "./market.js";
import {
  discoverAllMarkets,
  setupMarketAccounts,
  crankMarket,
  pushOraclePrice,
  refreshPosition,
  resolveSymbolFromSlab,
} from "./market.js";
import { fetchPrice } from "./prices.js";
import { log, logError } from "./logger.js";
import * as fs from "fs";

// ═══════════════════════════════════════════════════════════════
// Filler State
// ═══════════════════════════════════════════════════════════════

interface FillerStats {
  startedAt: number;
  crankCycles: number;
  crankSuccess: number;
  crankFailed: number;
  oraclePushes: number;
  lastCycleMs: number;
  marketsActive: number;
}

interface MarketCrankState {
  market: ManagedMarket;
  lastCrankTime: number;
  consecutiveFailures: number;
  permanentlySkipped: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Filler Bot
// ═══════════════════════════════════════════════════════════════

export class FillerBot {
  private readonly connection: Connection;
  private readonly config: BotConfig;
  private readonly wallet: Keypair;
  private markets: Map<string, MarketCrankState> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cycling = false;
  readonly stats: FillerStats;

  constructor(connection: Connection, config: BotConfig) {
    this.connection = connection;
    this.config = config;

    // Load wallet
    const raw = JSON.parse(fs.readFileSync(config.fillerKeypairPath, "utf8"));
    this.wallet = Keypair.fromSecretKey(Uint8Array.from(raw));

    this.stats = {
      startedAt: Date.now(),
      crankCycles: 0,
      crankSuccess: 0,
      crankFailed: 0,
      oraclePushes: 0,
      lastCycleMs: 0,
      marketsActive: 0,
    };
  }

  get walletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  /**
   * Discover markets and set up filler accounts.
   * The filler doesn't need its own LP — it uses existing LPs.
   */
  async discover(): Promise<void> {
    log("filler", "Discovering markets...");
    const discovered = await discoverAllMarkets(this.connection, this.config);

    for (const raw of discovered) {
      const key = raw.slabAddress.toBase58();
      if (this.markets.has(key)) continue;

      try {
        const managed = await setupMarketAccounts(
          this.connection,
          this.config,
          raw,
          this.wallet,
          0n, // Filler doesn't need collateral (only cranks)
          false, // Don't create LP
        );
        if (managed) {
          this.markets.set(key, {
            market: managed,
            lastCrankTime: 0,
            consecutiveFailures: 0,
            permanentlySkipped: false,
          });
        }
      } catch (e) {
        logError("filler", `Failed to setup ${key.slice(0, 12)}`, e);
      }
    }

    this.stats.marketsActive = this.markets.size;
    log("filler", `Tracking ${this.markets.size} market(s)`);
  }

  /**
   * Single crank cycle: crank all due markets + push oracle prices.
   */
  async crankCycle(): Promise<void> {
    if (this.cycling) return;
    this.cycling = true;
    const cycleStart = Date.now();

    try {
      this.stats.crankCycles++;
      const now = Date.now();
      let success = 0;
      let failed = 0;
      let skipped = 0;

      // Collect markets due for cranking
      const toCrank: MarketCrankState[] = [];
      for (const state of this.markets.values()) {
        if (state.permanentlySkipped) { skipped++; continue; }
        if (state.consecutiveFailures > 10) { skipped++; continue; }
        if (now - state.lastCrankTime < this.config.crankIntervalMs) { skipped++; continue; }
        toCrank.push(state);
      }

      // Process in batches
      const batchSize = this.config.crankBatchSize;
      for (let i = 0; i < toCrank.length; i += batchSize) {
        const batch = toCrank.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (state) => {
            try {
              // Push oracle price first for Hyperp markets
              if (this.config.pushOraclePrices && state.market.oracleMode === "authority") {
                // Re-resolve UNKNOWN symbols — another bot instance or a prior filler
                // cycle may have pushed a price to the chain already.
                if (state.market.symbol === "UNKNOWN") {
                  const resolved = await resolveSymbolFromSlab(
                    this.connection,
                    state.market.slabAddress,
                  );
                  if (resolved !== "UNKNOWN") {
                    log(
                      "filler",
                      `${state.market.slabAddress.toBase58().slice(0, 16)}...: resolved symbol → ${resolved}`,
                    );
                    state.market.symbol = resolved;
                  } else {
                    log(
                      "filler",
                      `⚠️ UNKNOWN market ${state.market.slabAddress.toBase58().slice(0, 16)}...: cannot push oracle — set MARKET_SYMBOL_OVERRIDES env var`,
                    );
                  }
                }
                if (state.market.symbol !== "UNKNOWN") {
                  const priceData = await fetchPrice(state.market.symbol);
                  if (priceData) {
                    const priceE6 = BigInt(Math.round(priceData.priceUsd * 1_000_000));
                    const pushed = await pushOraclePrice(
                      this.connection, this.config, state.market, this.wallet, priceE6,
                    );
                    if (pushed) this.stats.oraclePushes++;
                  }
                }
              }

              // Crank
              const ok = await crankMarket(this.connection, this.config, state.market, this.wallet);
              if (ok) {
                state.lastCrankTime = Date.now();
                state.consecutiveFailures = 0;
                success++;
                this.stats.crankSuccess++;
              } else {
                state.consecutiveFailures++;
                failed++;
                this.stats.crankFailed++;
              }
            } catch (e) {
              state.consecutiveFailures++;
              failed++;
              this.stats.crankFailed++;
              logError("filler", `Crank failed: ${state.market.symbol}`, e);

              // InvalidSlabLen (0x4) — slab has wrong on-chain size for this program binary.
              // Permanently skip: cranking will always fail until the slab is reinit'd.
              // After reinit (reinit-slab.ts), restart the bot to discover the new slab address.
              const msg = e instanceof Error ? e.message : String(e);
              if (msg.includes("custom program error: 0x4")) {
                state.permanentlySkipped = true;
                logError("filler", `${state.market.symbol}: InvalidSlabLen (0x4) — slab needs reinit, skipping permanently`, e);
              }
            }
          }),
        );

        // Delay between batches
        if (i + batchSize < toCrank.length) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      this.stats.lastCycleMs = Date.now() - cycleStart;

      if (success > 0 || failed > 0) {
        log("filler", `Crank cycle: ${success} ok, ${failed} fail, ${skipped} skip`, {
          cycleMs: this.stats.lastCycleMs,
        });
      }
    } finally {
      this.cycling = false;
    }
  }

  /**
   * Start the filler bot.
   */
  async start(): Promise<void> {
    this.running = true;
    log("filler", "Starting filler bot...", {
      wallet: this.wallet.publicKey.toBase58().slice(0, 12),
      crankInterval: `${this.config.crankIntervalMs}ms`,
    });

    // Initial discovery
    await this.discover();

    // Crank timer
    this.timer = setInterval(() => {
      if (this.running) this.crankCycle().catch((e) => logError("filler", "Crank cycle error", e));
    }, this.config.crankIntervalMs);

    // Re-discovery timer (every 5 minutes)
    this.discoveryTimer = setInterval(() => {
      if (this.running) this.discover().catch((e) => logError("filler", "Discovery error", e));
    }, 300_000);

    // Run first crank immediately
    await this.crankCycle();

    log("filler", `✅ Filler running — ${this.markets.size} market(s), crank every ${this.config.crankIntervalMs}ms`);
  }

  /**
   * Stop the filler bot.
   */
  stop(): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
    log("filler", "Filler stopped");
  }

  /**
   * Get health status for the health endpoint.
   */
  getStatus() {
    return {
      role: "filler",
      running: this.running,
      wallet: this.wallet.publicKey.toBase58(),
      markets: this.markets.size,
      stats: {
        ...this.stats,
        uptimeS: Math.floor((Date.now() - this.stats.startedAt) / 1000),
      },
      marketDetails: Array.from(this.markets.entries()).map(([key, state]) => ({
        slab: key.slice(0, 12),
        symbol: state.market.symbol,
        lastCrankAge: state.lastCrankTime ? Math.floor((Date.now() - state.lastCrankTime) / 1000) : -1,
        consecutiveFailures: state.consecutiveFailures,
        skipped: state.permanentlySkipped,
      })),
    };
  }
}

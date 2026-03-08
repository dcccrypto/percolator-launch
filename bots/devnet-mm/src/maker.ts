/**
 * PERC-377: Maker Bot — Two-Sided Quoter
 *
 * Inspired by Drift's FloatingMaker from keeper-bots-v2.
 * Oracle-anchored two-sided market maker with:
 *   - Position-aware skewing (widens spread on the risky side)
 *   - Random spread/size noise for organic orderbook appearance
 *   - Multi-source price feeds (Binance → CoinGecko fallback)
 *   - Auto-discovery of new markets
 *   - Oracle price pushing for Hyperp-mode markets
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
  executeTrade,
  pushOraclePrice,
  refreshPosition,
  resolveSymbolFromSlab,
} from "./market.js";
import { fetchPrice } from "./prices.js";
import { log, logError } from "./logger.js";
import * as fs from "fs";

// ═══════════════════════════════════════════════════════════════
// Maker State
// ═══════════════════════════════════════════════════════════════

interface MakerStats {
  startedAt: number;
  quoteCycles: number;
  tradesExecuted: number;
  tradesFailed: number;
  lastCycleMs: number;
  marketsActive: number;
}

// ═══════════════════════════════════════════════════════════════
// Quoting Logic
// ═══════════════════════════════════════════════════════════════

interface QuoteResult {
  bidPrice: number;
  askPrice: number;
  bidSize: bigint;
  askSize: bigint;
  skewFactor: number;
  effectiveSpreadBps: number;
}

/**
 * Calculate bid/ask quotes with position-aware skewing.
 *
 * When flat: symmetric spread around oracle
 * When long: widen bid (less willing to buy), tighten ask (want to sell)
 * When short: tighten bid (want to buy), widen ask (less willing to sell)
 */
function calculateQuotes(
  oraclePrice: number,
  positionSize: bigint,
  collateral: bigint,
  config: BotConfig,
): QuoteResult {
  // Apply random spread noise
  let spreadBps = config.spreadBps;
  if (config.spreadNoiseBps > 0) {
    const noise = (Math.random() * 2 - 1) * config.spreadNoiseBps;
    spreadBps = Math.max(1, spreadBps + noise);
  }

  const spreadFrac = spreadBps / 10_000;
  const collateralUsd = Number(collateral) / 1_000_000;
  const positionUsd = Number(positionSize) / 1_000_000;
  const maxQuoteSize = BigInt(config.maxQuoteSizeUsdc) * 1_000_000n;

  // Exposure: position / (collateral × maxPositionPct%)
  const maxPosUsd = collateralUsd * (config.maxPositionPct / 100);
  const exposure = maxPosUsd > 0
    ? Math.max(-1, Math.min(1, positionUsd / maxPosUsd))
    : 0;

  const skewFactor = exposure;

  // Skew spread multipliers
  const bidSpreadMul = 1 + Math.max(0, skewFactor) * (config.skewMaxMultiplier - 1);
  const askSpreadMul = 1 + Math.max(0, -skewFactor) * (config.skewMaxMultiplier - 1);

  const bidPrice = oraclePrice * (1 - spreadFrac * bidSpreadMul);
  const askPrice = oraclePrice * (1 + spreadFrac * askSpreadMul);

  // Size scaling: reduce size as exposure grows
  const absExposure = Math.abs(exposure);
  const sizeFactor = Math.max(0.1, 1 - absExposure * 0.8);

  let bidSize = maxQuoteSize;
  let askSize = maxQuoteSize;

  if (absExposure >= 0.95) {
    // At max: only quote reducing side
    if (exposure > 0) bidSize = 0n;
    else askSize = 0n;
  } else {
    const baseSize = BigInt(Math.floor(Number(maxQuoteSize) * sizeFactor));

    // Apply size jitter for organic appearance
    if (config.sizeJitter > 0) {
      const jitterFactor = 1 + (Math.random() * 2 - 1) * config.sizeJitter;
      const jitteredSize = BigInt(Math.floor(Number(baseSize) * Math.max(0.1, jitterFactor)));
      bidSize = jitteredSize;
      askSize = jitteredSize;
    } else {
      bidSize = baseSize;
      askSize = baseSize;
    }
  }

  return { bidPrice, askPrice, bidSize, askSize, skewFactor, effectiveSpreadBps: spreadBps };
}

// ═══════════════════════════════════════════════════════════════
// Maker Bot
// ═══════════════════════════════════════════════════════════════

export class MakerBot {
  private readonly connection: Connection;
  private readonly config: BotConfig;
  private readonly wallet: Keypair;
  private markets: ManagedMarket[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cycling = false;
  readonly stats: MakerStats;

  constructor(connection: Connection, config: BotConfig) {
    this.connection = connection;
    this.config = config;

    const raw = JSON.parse(fs.readFileSync(config.makerKeypairPath, "utf8"));
    this.wallet = Keypair.fromSecretKey(Uint8Array.from(raw));

    this.stats = {
      startedAt: Date.now(),
      quoteCycles: 0,
      tradesExecuted: 0,
      tradesFailed: 0,
      lastCycleMs: 0,
      marketsActive: 0,
    };
  }

  get walletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  /**
   * Discover and set up markets with LP + user accounts.
   */
  async discover(): Promise<void> {
    log("maker", "Discovering markets...");
    const discovered = await discoverAllMarkets(this.connection, this.config);

    for (const raw of discovered) {
      const key = raw.slabAddress.toBase58();
      // Skip if we already manage this market
      if (this.markets.find((m) => m.slabAddress.toBase58() === key)) continue;

      try {
        const managed = await setupMarketAccounts(
          this.connection,
          this.config,
          raw,
          this.wallet,
          this.config.initialCollateralUsdc,
          true, // Create LP for maker
        );
        if (managed) {
          this.markets.push(managed);
        }
      } catch (e) {
        logError("maker", `Failed to setup ${key.slice(0, 12)}`, e);
      }
    }

    this.stats.marketsActive = this.markets.length;
    log("maker", `Managing ${this.markets.length} market(s)`);
  }

  /**
   * Single quote cycle for one market.
   */
  async quoteMarket(market: ManagedMarket): Promise<void> {
    // If symbol was not resolved at discovery time (Hyperp market with no initial
    // oracle price), re-check on-chain — filler may have pushed a price since startup.
    if (market.symbol === "UNKNOWN" && market.oracleMode === "authority") {
      const resolved = await resolveSymbolFromSlab(this.connection, market.slabAddress);
      if (resolved !== "UNKNOWN") {
        log("maker", `${market.slabAddress.toBase58().slice(0, 16)}...: resolved symbol → ${resolved} (was UNKNOWN)`);
        market.symbol = resolved;
      } else {
        log("maker", `⚠️ UNKNOWN market ${market.slabAddress.toBase58().slice(0, 16)}...: no oracle price yet — set MARKET_SYMBOL_OVERRIDES env var`);
        return;
      }
    }

    // Fetch price
    const priceData = await fetchPrice(market.symbol);
    if (!priceData) {
      log("maker", `⚠️ ${market.symbol}: no price from Binance/CoinGecko, skipping`);
      return;
    }

    // Push oracle price if Hyperp mode
    if (this.config.pushOraclePrices && market.oracleMode === "authority") {
      const priceE6 = BigInt(Math.round(priceData.priceUsd * 1_000_000));
      await pushOraclePrice(this.connection, this.config, market, this.wallet, priceE6);
    }

    // Refresh position periodically
    await refreshPosition(this.connection, market, this.wallet);

    // Calculate quotes
    const quotes = calculateQuotes(
      priceData.priceUsd,
      market.positionSize,
      market.collateral,
      this.config,
    );

    const posUsd = Number(market.positionSize) / 1e6;
    const colUsd = Number(market.collateral) / 1e6;
    log("maker", `${market.symbol}: $${priceData.priceUsd.toFixed(2)} (${priceData.source}) | pos=$${posUsd.toFixed(2)} | col=$${colUsd.toFixed(0)} | skew=${(quotes.skewFactor * 100).toFixed(1)}% | spread=${quotes.effectiveSpreadBps.toFixed(0)}bps`);

    // Execute bid (buy/long)
    if (quotes.bidSize > 0n) {
      const sizeUsd = Number(quotes.bidSize) / 1e6;
      log("maker", `  BID @ $${quotes.bidPrice.toFixed(4)} | $${sizeUsd.toFixed(0)}`);
      const result = await executeTrade(
        this.connection,
        this.config,
        market,
        this.wallet,
        quotes.bidSize,
        `BID@${quotes.bidPrice.toFixed(2)}`,
      );
      if (result.success) this.stats.tradesExecuted++;
      else this.stats.tradesFailed++;
    }

    // Brief delay between bid and ask
    await new Promise((r) => setTimeout(r, 500));

    // Execute ask (sell/short) — guard against stop() during delay
    if (!this.running) return;
    if (quotes.askSize > 0n) {
      const sizeUsd = Number(quotes.askSize) / 1e6;
      log("maker", `  ASK @ $${quotes.askPrice.toFixed(4)} | $${sizeUsd.toFixed(0)}`);
      const result = await executeTrade(
        this.connection,
        this.config,
        market,
        this.wallet,
        -quotes.askSize,
        `ASK@${quotes.askPrice.toFixed(2)}`,
      );
      if (result.success) this.stats.tradesExecuted++;
      else this.stats.tradesFailed++;
    }

    market.lastQuoteTime = Date.now();
  }

  /**
   * Full quote cycle across all markets.
   */
  async quoteCycle(): Promise<void> {
    if (this.cycling) return;
    this.cycling = true;
    const cycleStart = Date.now();

    try {
      this.stats.quoteCycles++;

      for (const market of this.markets) {
        if (!this.running) break;
        try {
          await this.quoteMarket(market);
        } catch (e) {
          logError("maker", `Quote error: ${market.symbol}`, e);
        }
      }

      this.stats.lastCycleMs = Date.now() - cycleStart;
    } finally {
      this.cycling = false;
    }
  }

  /**
   * Start the maker bot.
   */
  async start(): Promise<void> {
    this.running = true;
    log("maker", "Starting maker bot...", {
      wallet: this.wallet.publicKey.toBase58().slice(0, 12),
      spread: `${this.config.spreadBps}bps`,
      maxQuote: `$${this.config.maxQuoteSizeUsdc}`,
      interval: `${this.config.quoteIntervalMs}ms`,
    });

    // Initial discovery
    await this.discover();
    if (this.markets.length === 0) {
      log("maker", "No markets found, retrying in 30s...");
      await new Promise((r) => setTimeout(r, 30_000));
      await this.discover();
    }

    if (this.markets.length === 0) {
      logError("maker", "No markets available after retry");
      this.running = false;
      return;
    }

    // Quote timer
    this.timer = setInterval(() => {
      if (this.running) this.quoteCycle().catch((e) => logError("maker", "Quote cycle error", e));
    }, this.config.quoteIntervalMs);

    // Re-discovery every 5 minutes
    this.discoveryTimer = setInterval(() => {
      if (this.running) this.discover().catch((e) => logError("maker", "Discovery error", e));
    }, 300_000);

    // Run first cycle immediately
    await this.quoteCycle();

    log("maker", `✅ Maker running — ${this.markets.length} market(s), quoting every ${this.config.quoteIntervalMs}ms`);
  }

  /**
   * Stop the maker bot.
   */
  stop(): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
    log("maker", "Maker stopped");
  }

  /**
   * Get health status for the health endpoint.
   */
  getStatus() {
    return {
      role: "maker",
      running: this.running,
      wallet: this.wallet.publicKey.toBase58(),
      markets: this.markets.length,
      stats: {
        ...this.stats,
        uptimeS: Math.floor((Date.now() - this.stats.startedAt) / 1000),
      },
      positions: this.markets.map((m) => ({
        symbol: m.symbol,
        slab: m.slabAddress.toBase58().slice(0, 12),
        positionUsd: Number(m.positionSize) / 1e6,
        collateralUsd: Number(m.collateral) / 1e6,
        oracleMode: m.oracleMode,
        lastQuoteAge: m.lastQuoteTime ? Math.floor((Date.now() - m.lastQuoteTime) / 1000) : -1,
      })),
    };
  }
}

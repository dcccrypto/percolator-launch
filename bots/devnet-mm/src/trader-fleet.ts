/**
 * PERC-404: Simulated Trader Fleet
 *
 * Runs 5-10 simulated trader wallets placing random long/short trades
 * across devnet markets to generate organic-looking volume and OI.
 *
 * Each trader:
 *   - Gets funded (SOL airdrop + token mint) on first run
 *   - Has a personality: aggressive | passive | trend
 *   - Participates in 2-4 markets
 *   - Places random trades every 30-180 seconds
 *   - Closes positions after a random hold duration (20 min – 2 h)
 *
 * Environment variables (all optional):
 *   TRADER_FLEET_SIZE            number of simulated traders (default 5)
 *   TRADER_MIN_SIZE_USDC         min trade size in micro-USDC (default 50_000_000 = $50)
 *   TRADER_MAX_SIZE_USDC         max trade size in micro-USDC (default 1_000_000_000 = $1 000)
 *   TRADER_COLLATERAL_USDC       initial collateral per market (default 5_000_000_000 = $5 000)
 *   TRADER_MIN_INTERVAL_MS       min ms between trades per wallet (default 30 000)
 *   TRADER_MAX_INTERVAL_MS       max ms between trades per wallet (default 180 000)
 *   TRADER_MARKETS               markets per trader (default 3)
 *   TRADER_MIN_HOLD_MS           min position hold time (default 1 200 000 = 20 min)
 *   TRADER_MAX_HOLD_MS           max position hold time (default 7 200 000 = 2 h)
 *   TRADER_KEYPAIR_JSON_0 … _N   inline JSON secret-key arrays for each trader
 *   MINT_AUTHORITY_KEYPAIR_JSON  JSON secret-key array of the token mint authority
 *   TEST_USDC_MINT               SPL token mint address for devnet USDC
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import type { DiscoveredMarket } from "@percolator/sdk";
import type { BotConfig } from "./config.js";
import type { ManagedMarket } from "./market.js";
import {
  discoverAllMarkets,
  executeTrade,
  refreshPosition,
  setupMarketAccounts,
} from "./market.js";
import { log, logError } from "./logger.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

type Personality = "aggressive" | "passive" | "trend";

/** Per-trader state */
interface SimTrader {
  id: string;
  wallet: Keypair;
  personality: Personality;
  /** Markets this trader is set up in (account indices resolved) */
  markets: ManagedMarket[];
  /** When this trader will next attempt a trade (epoch ms) */
  nextTradeAt: number;
  /** Per-market: epoch ms to hold position until before considering close */
  holdUntil: Map<string, number>;
  /** Long-term directional bias: +1 → bullish, -1 → bearish, drifts over time */
  bias: number;
  tradesExecuted: number;
  tradesFailed: number;
}

export interface FleetStats {
  startedAt: number;
  cycleCount: number;
  totalTrades: number;
  totalFailed: number;
  activeTraders: number;
  lastCycleMs: number;
}

// ═══════════════════════════════════════════════════════════════
// Fleet Config
// ═══════════════════════════════════════════════════════════════

interface TraderFleetConfig {
  fleetSize: number;
  minTradeSizeE6: bigint;
  maxTradeSizeE6: bigint;
  initialCollateralE6: bigint;
  minIntervalMs: number;
  maxIntervalMs: number;
  marketsPerTrader: number;
  minHoldMs: number;
  maxHoldMs: number;
  mintAuthorityJson: string | null;
  usdcMint: string | null;
}

function loadFleetConfig(): TraderFleetConfig {
  return {
    fleetSize: Number(process.env.TRADER_FLEET_SIZE ?? 5),
    minTradeSizeE6: BigInt(process.env.TRADER_MIN_SIZE_USDC ?? "50000000"),    // $50
    maxTradeSizeE6: BigInt(process.env.TRADER_MAX_SIZE_USDC ?? "1000000000"),  // $1 000
    initialCollateralE6: BigInt(process.env.TRADER_COLLATERAL_USDC ?? "5000000000"), // $5 000
    minIntervalMs: Number(process.env.TRADER_MIN_INTERVAL_MS ?? 30_000),
    maxIntervalMs: Number(process.env.TRADER_MAX_INTERVAL_MS ?? 180_000),
    marketsPerTrader: Number(process.env.TRADER_MARKETS ?? 3),
    minHoldMs: Number(process.env.TRADER_MIN_HOLD_MS ?? 20 * 60_000),    // 20 min
    maxHoldMs: Number(process.env.TRADER_MAX_HOLD_MS ?? 120 * 60_000),   // 2 h
    mintAuthorityJson: process.env.MINT_AUTHORITY_KEYPAIR_JSON ?? null,
    usdcMint: process.env.TEST_USDC_MINT ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Uniformly sample a random BigInt in [min, max) using CSPRNG bytes.
 * Avoids converting range to Number, which loses precision for ranges > 2^53.
 * Uses rejection sampling to eliminate modulo bias.
 */
function randBigInt(min: bigint, max: bigint): bigint {
  if (max <= min) return min;
  const range = max - min;
  // Calculate how many bytes we need to cover the range
  const rangeBits = range.toString(2).length;
  const byteCount = Math.ceil(rangeBits / 8);
  const mask = (1n << BigInt(rangeBits)) - 1n;
  // Rejection sampling: retry until the sample falls within [0, range)
  let sample: bigint;
  do {
    const buf = randomBytes(byteCount);
    sample = BigInt("0x" + buf.toString("hex")) & mask;
  } while (sample >= range);
  return min + sample;
}

function pickPersonality(idx: number): Personality {
  const personalities: Personality[] = ["aggressive", "passive", "trend"];
  return personalities[idx % personalities.length];
}

/**
 * Randomly select `n` items from array without replacement.
 * Captures the target count upfront so shrinking copy.length doesn't truncate.
 */
function sampleN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const count = Math.min(n, copy.length);
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

/**
 * Load or generate a keypair for a trader slot.
 * Tries env var `TRADER_KEYPAIR_JSON_<idx>` first, then generates a new one.
 */
function loadOrGenerateKeypair(idx: number, dir: string): Keypair {
  const envKey = `TRADER_KEYPAIR_JSON_${idx}`;
  const envVal = process.env[envKey];

  if (envVal) {
    try {
      const arr = JSON.parse(envVal);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      logError("fleet", `${envKey} is not valid JSON — generating new keypair`);
    }
  }

  // Try file
  const filePath = path.join(dir, `trader-${idx}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const arr = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      logError("fleet", `Failed to load keypair from ${filePath}`);
    }
  }

  // Generate fresh keypair and save it
  const kp = Keypair.generate();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  log("fleet", `🔑 Generated trader-${idx}: ${kp.publicKey.toBase58()} → ${filePath}`);
  return kp;
}

// ═══════════════════════════════════════════════════════════════
// Funding
// ═══════════════════════════════════════════════════════════════

/**
 * Airdrop SOL if balance is below threshold.
 */
async function ensureSol(
  connection: Connection,
  wallet: Keypair,
  label: string,
  minSol = 0.5,
): Promise<void> {
  try {
    const bal = await connection.getBalance(wallet.publicKey);
    if (bal / LAMPORTS_PER_SOL >= minSol) return;

    log("fleet", `${label}: low SOL (${(bal / LAMPORTS_PER_SOL).toFixed(3)}) — requesting airdrop...`);
    const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    log("fleet", `${label}: ✅ airdrop +2 SOL`);
  } catch (e) {
    logError("fleet", `${label}: SOL airdrop failed`, e);
  }
}

/**
 * Mint devnet USDC tokens to a trader wallet from the mint authority.
 */
async function fundTokens(
  connection: Connection,
  mintAuthority: Keypair,
  usdcMint: PublicKey,
  recipient: PublicKey,
  amount: bigint,
  label: string,
): Promise<boolean> {
  try {
    const ata = await getAssociatedTokenAddress(usdcMint, recipient);
    const tx = new Transaction();

    // Create ATA if needed
    const ataInfo = await connection.getAccountInfo(ata);
    if (!ataInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          mintAuthority.publicKey,
          ata,
          recipient,
          usdcMint,
        ),
      );
    }

    // Check existing balance to avoid minting too much
    let existingBalance = 0n;
    if (ataInfo) {
      try {
        const tokenBal = await connection.getTokenAccountBalance(ata);
        existingBalance = BigInt(tokenBal.value.amount);
      } catch {
        // ignore
      }
    }

    if (existingBalance >= amount) {
      log("fleet", `${label}: already has $${Number(existingBalance) / 1e6} USDC — skip mint`);
      return true;
    }

    const mintAmount = amount - existingBalance;
    tx.add(createMintToInstruction(usdcMint, ata, mintAuthority.publicKey, mintAmount));

    const sig = await sendAndConfirmTransaction(connection, tx, [mintAuthority], {
      commitment: "confirmed",
    });
    log("fleet", `${label}: ✅ minted $${Number(mintAmount) / 1e6} USDC → ${sig.slice(0, 16)}...`);
    return true;
  } catch (e) {
    logError("fleet", `${label}: token mint failed`, e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Trade Decision Logic
// ═══════════════════════════════════════════════════════════════

/**
 * Decide whether to open, hold, or close a position on a market.
 * Returns: positive bigint = open long, negative = open short, null = hold/skip
 */
function decideAction(
  trader: SimTrader,
  market: ManagedMarket,
  fleetConfig: TraderFleetConfig,
): bigint | null {
  const now = Date.now();
  const key = market.slabAddress.toBase58();
  const holdUntil = trader.holdUntil.get(key) ?? 0;

  const hasPosition = market.positionSize !== 0n;

  // If holding a position and not past hold time → skip
  if (hasPosition && now < holdUntil) return null;

  // If past hold time and has position → close
  if (hasPosition && now >= holdUntil) {
    const closeSize = -market.positionSize;
    log("fleet", `  ${trader.id} ${market.symbol}: closing position (held, size=${market.positionSize})`);
    // Clear hold timer; next trade will open fresh
    trader.holdUntil.delete(key);
    return closeSize;
  }

  // No position → decide to open
  // Drift bias over time (random walk, ±5% per decision)
  trader.bias = Math.max(-1, Math.min(1, trader.bias + (Math.random() - 0.5) * 0.1));

  // Personality-adjusted direction probability
  let longProb = 0.5 + trader.bias * 0.3;
  switch (trader.personality) {
    case "aggressive":
      // Follows bias strongly
      longProb = 0.5 + trader.bias * 0.45;
      break;
    case "passive":
      // Contrarian — fades the bias
      longProb = 0.5 - trader.bias * 0.2;
      break;
    case "trend":
      // Follows bias, moderate
      longProb = 0.5 + trader.bias * 0.35;
      break;
  }

  const goLong = Math.random() < longProb;

  // Size: randomize between min and max based on personality
  let minSize = fleetConfig.minTradeSizeE6;
  let maxSize = fleetConfig.maxTradeSizeE6;
  switch (trader.personality) {
    case "aggressive":
      // Larger sizes
      minSize = (fleetConfig.maxTradeSizeE6 * 4n) / 10n;
      maxSize = fleetConfig.maxTradeSizeE6;
      break;
    case "passive":
      // Smaller sizes
      minSize = fleetConfig.minTradeSizeE6;
      maxSize = (fleetConfig.maxTradeSizeE6 * 3n) / 10n;
      break;
    case "trend":
      // Medium
      minSize = (fleetConfig.minTradeSizeE6 + fleetConfig.maxTradeSizeE6) / 4n;
      maxSize = (fleetConfig.maxTradeSizeE6 * 7n) / 10n;
      break;
  }

  const size = randBigInt(minSize, maxSize);
  const holdMs = randInt(fleetConfig.minHoldMs, fleetConfig.maxHoldMs);

  // Set hold timer
  trader.holdUntil.set(key, now + holdMs);

  const direction = goLong ? 1n : -1n;
  return size * direction;
}

// ═══════════════════════════════════════════════════════════════
// TraderFleetBot
// ═══════════════════════════════════════════════════════════════

export class TraderFleetBot {
  private readonly connection: Connection;
  private readonly botConfig: BotConfig;
  private readonly fleetConfig: TraderFleetConfig;
  private traders: SimTrader[] = [];
  private discoveredMarkets: DiscoveredMarket[] = [];
  private running = false;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  readonly stats: FleetStats;

  constructor(connection: Connection, botConfig: BotConfig) {
    this.connection = connection;
    this.botConfig = botConfig;
    this.fleetConfig = loadFleetConfig();
    this.stats = {
      startedAt: Date.now(),
      cycleCount: 0,
      totalTrades: 0,
      totalFailed: 0,
      activeTraders: 0,
      lastCycleMs: 0,
    };
  }

  // ── Init ──────────────────────────────────────────────────────

  /**
   * Initialize traders: load keypairs, fund wallets, discover markets,
   * and set up accounts.
   */
  async initialize(): Promise<void> {
    const { fleetSize, marketsPerTrader, initialCollateralE6 } = this.fleetConfig;
    const keypairDir = path.join(os.tmpdir(), "percolator-traders");

    log("fleet", `Initializing fleet of ${fleetSize} simulated traders...`);

    // Load or generate keypairs
    const wallets: Keypair[] = [];
    for (let i = 0; i < fleetSize; i++) {
      wallets.push(loadOrGenerateKeypair(i, keypairDir));
    }

    // Discover markets
    log("fleet", "Discovering markets...");
    this.discoveredMarkets = await discoverAllMarkets(this.connection, this.botConfig);
    if (this.discoveredMarkets.length === 0) {
      logError("fleet", "No active markets found — trader fleet will wait for markets");
      return;
    }
    log("fleet", `Found ${this.discoveredMarkets.length} active markets`);

    // Load mint authority (for token funding)
    let mintAuthority: Keypair | null = null;
    let usdcMint: PublicKey | null = null;

    if (this.fleetConfig.mintAuthorityJson) {
      try {
        mintAuthority = Keypair.fromSecretKey(
          Uint8Array.from(JSON.parse(this.fleetConfig.mintAuthorityJson)),
        );
        log("fleet", `Mint authority: ${mintAuthority.publicKey.toBase58()}`);
      } catch {
        logError("fleet", "MINT_AUTHORITY_KEYPAIR_JSON is invalid JSON — traders must be pre-funded");
      }
    }

    if (this.fleetConfig.usdcMint) {
      try {
        usdcMint = new PublicKey(this.fleetConfig.usdcMint);
      } catch {
        logError("fleet", "TEST_USDC_MINT is not a valid public key");
      }
    }

    // Set up each trader
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      const personality = pickPersonality(i);
      const label = `trader-${i}(${personality})`;

      log("fleet", `Setting up ${label}: ${wallet.publicKey.toBase58()}`);

      // 1. Ensure SOL
      await ensureSol(this.connection, wallet, label, 0.3);

      // 2. Fund tokens if mint authority available
      if (mintAuthority && usdcMint) {
        const mintAmt = initialCollateralE6 * BigInt(marketsPerTrader) * 2n; // 2x buffer
        await fundTokens(
          this.connection,
          mintAuthority,
          usdcMint,
          wallet.publicKey,
          mintAmt,
          label,
        );
      }

      // 3. Pick markets for this trader (random subset)
      const assignedMarkets = sampleN(
        this.discoveredMarkets,
        Math.min(marketsPerTrader, this.discoveredMarkets.length),
      );

      // 4. Set up user accounts on each assigned market
      const managedMarkets: ManagedMarket[] = [];
      for (const dm of assignedMarkets) {
        await sleep(500); // rate-limit RPC
        const mm = await setupMarketAccounts(
          this.connection,
          this.botConfig,
          dm,
          wallet,
          initialCollateralE6,
          false, // don't create LP — traders are users only
        );
        if (mm) {
          managedMarkets.push(mm);
          log("fleet", `  ${label} ✅ ${mm.symbol} (user=${mm.userIdx})`);
        }
      }

      if (managedMarkets.length === 0) {
        logError("fleet", `${label}: failed to set up any markets — skipping trader`);
        continue;
      }

      const trader: SimTrader = {
        id: `trader-${i}`,
        wallet,
        personality,
        markets: managedMarkets,
        nextTradeAt: Date.now() + randInt(0, this.fleetConfig.maxIntervalMs / 2),
        holdUntil: new Map(),
        bias: (Math.random() - 0.5) * 0.4, // start with slight random bias
        tradesExecuted: 0,
        tradesFailed: 0,
      };

      this.traders.push(trader);
    }

    this.stats.activeTraders = this.traders.length;
    log("fleet", `✅ Fleet initialized: ${this.traders.length}/${fleetSize} traders active`);
  }

  // ── Start / Stop ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    // Guard: TraderFleetBot is DEVNET ONLY — refuse to start on mainnet.
    const rpcUrl = this.botConfig.rpcUrl.toLowerCase();
    const MAINNET_PATTERNS = ["mainnet-beta", "mainnet"];
    if (MAINNET_PATTERNS.some((p) => rpcUrl.includes(p))) {
      throw new Error(
        `TraderFleetBot refuses to start on a mainnet RPC endpoint: ${this.botConfig.rpcUrl}\n` +
        `This bot generates simulated volume on DEVNET ONLY.\n` +
        `Set RPC_URL to a devnet endpoint (e.g. https://api.devnet.solana.com).`,
      );
    }

    await this.initialize();

    if (this.traders.length === 0) {
      log("fleet", "⚠️ No traders initialized — fleet will retry after market discovery");
    }

    this.running = true;

    // Main trade loop — check every 5 seconds which traders are ready
    this.loopTimer = setInterval(() => this._tradeCycle().catch(() => {}), 5_000);

    // Refresh positions + re-discover markets every 30 minutes
    this.discoveryTimer = setInterval(
      () => this._refreshAll().catch(() => {}),
      30 * 60_000,
    );

    log("fleet", `🚀 Trader fleet started — ${this.traders.length} wallets active`);
  }

  stop(): void {
    this.running = false;
    if (this.loopTimer) clearInterval(this.loopTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    log("fleet", "Fleet stopped");
  }

  getStatus() {
    return {
      stats: { ...this.stats },
      traders: this.traders.map((t) => ({
        id: t.id,
        personality: t.personality,
        markets: t.markets.map((m) => m.symbol),
        tradesExecuted: t.tradesExecuted,
        tradesFailed: t.tradesFailed,
        bias: t.bias.toFixed(2),
        nextTradeIn: Math.max(0, t.nextTradeAt - Date.now()),
      })),
    };
  }

  // ── Trade Cycle ───────────────────────────────────────────────

  private async _tradeCycle(): Promise<void> {
    if (!this.running || this.traders.length === 0) return;

    const cycleStart = Date.now();
    this.stats.cycleCount++;

    for (const trader of this.traders) {
      if (Date.now() < trader.nextTradeAt) continue;

      // Pick one market to trade this cycle (rotate through markets)
      const market = trader.markets[this.stats.cycleCount % trader.markets.length];
      if (!market) continue;

      // Refresh on-chain position state
      try {
        await refreshPosition(this.connection, market, trader.wallet);
      } catch {
        // Non-fatal
      }

      // Decide action
      const tradeSize = decideAction(trader, market, this.fleetConfig);

      if (tradeSize === null) {
        // Holding — schedule next check after a shorter interval
        trader.nextTradeAt = Date.now() + randInt(10_000, 30_000);
        continue;
      }

      const direction = tradeSize > 0n ? "LONG" : "SHORT";
      const absSize = tradeSize > 0n ? tradeSize : -tradeSize;
      const label = `${direction} $${Number(absSize) / 1e6}`;

      if (this.botConfig.dryRun) {
        log(
          "fleet",
          `[DRY RUN] ${trader.id} ${market.symbol}: ${label} (personality=${trader.personality})`,
        );
        trader.tradesExecuted++;
        this.stats.totalTrades++;
      } else {
        const result = await executeTrade(
          this.connection,
          this.botConfig,
          market,
          trader.wallet,
          tradeSize,
          `${trader.id} ${label}`,
        );

        if (result.success) {
          trader.tradesExecuted++;
          this.stats.totalTrades++;
          log(
            "fleet",
            `✅ ${trader.id} ${market.symbol}: ${label} | personality=${trader.personality} | bias=${trader.bias.toFixed(2)}`,
          );
        } else {
          trader.tradesFailed++;
          this.stats.totalFailed++;
          logError("fleet", `${trader.id} ${market.symbol}: trade failed — ${result.error}`);
        }
      }

      // Schedule next trade with random interval
      const interval = randInt(this.fleetConfig.minIntervalMs, this.fleetConfig.maxIntervalMs);
      // Personality affects trade frequency
      let multiplier = 1.0;
      switch (trader.personality) {
        case "aggressive": multiplier = 0.6; break; // trades more often
        case "passive":    multiplier = 1.8; break; // trades less often
        case "trend":      multiplier = 1.0; break;
      }
      trader.nextTradeAt = Date.now() + Math.round(interval * multiplier);
    }

    this.stats.lastCycleMs = Date.now() - cycleStart;
  }

  // ── Periodic Refresh ──────────────────────────────────────────

  private async _refreshAll(): Promise<void> {
    log("fleet", "Refreshing all trader positions...");

    for (const trader of this.traders) {
      for (const market of trader.markets) {
        try {
          await refreshPosition(this.connection, market, trader.wallet);
        } catch {
          // Non-fatal
        }
        await sleep(200);
      }
    }

    // Re-discover markets (new ones may have been created)
    try {
      const fresh = await discoverAllMarkets(this.connection, this.botConfig);
      if (fresh.length > this.discoveredMarkets.length) {
        log(
          "fleet",
          `Discovery: ${fresh.length} markets (was ${this.discoveredMarkets.length}) — reassigning traders`,
        );
        this.discoveredMarkets = fresh;
        // Traders keep existing markets; new ones get picked up next init cycle
      }
    } catch {
      // Non-fatal
    }
  }
}

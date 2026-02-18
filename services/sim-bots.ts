/**
 * sim-bots.ts — Percolator Risk Engine Simulator: Bot Fleet
 *
 * 15 bots across 3 market types:
 *   - 5 Trend Followers  (long/short based on price momentum)
 *   - 5 Mean Reverters   (fade large moves)
 *   - 5 Market Makers    (dual-sided, tight spreads)
 *
 * Env: RPC_URL, SIM_ADMIN_KEYPAIR (base58), loaded via SimOracle instance
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  encodeInitUser,
  encodeDepositCollateral,
  encodeTradeNoCpi,
  buildAccountMetas,
} from "../packages/core/src/abi/index.js";
import { buildIx } from "../packages/core/src/runtime/tx.js";
import {
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TRADE_NOCPI,
} from "../packages/core/src/abi/accounts.js";
import { deriveVaultAuthority } from "../packages/core/src/solana/pda.js";
import type { SimOracle, OraclePrice, ActiveScenario } from "./sim-oracle.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants ──────────────────────────────────────────────────────────────

// Read program ID from deploy config (sim program, not production)
function findSimConfig(): string {
  const candidates = [
    path.resolve(__dirname, "../config/sim-markets.json"),
    path.resolve(__dirname, "../app/config/sim-markets.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`sim-markets.json not found in: ${candidates.join(", ")}`);
}
const SIM_CONFIG_PATH = findSimConfig();
const simConfig = JSON.parse(fs.readFileSync(SIM_CONFIG_PATH, "utf-8"));
const PROGRAM_ID = new PublicKey(simConfig.programId);
const PRIORITY_FEE = 30_000;
const INITIAL_DEPOSIT_RAW = 1_000_000_000n; // 1,000 simUSDC (6 decimals)
const LP_IDX = 0; // LP slot 0 is the sim LP

// ─── Types ──────────────────────────────────────────────────────────────────

type BotType = "trend_follower" | "mean_reverter" | "market_maker";

interface BotWallet {
  botId: string;
  type: BotType;
  market: string;
  publicKey: string;
  secretKey: number[];
  userIdx?: number; // assigned after InitUser
}

interface BotWalletsConfig {
  generatedAt: string;
  bots: BotWallet[];
}

interface SimMarket {
  slab: string;
  name: string;
  mint?: string;
}

interface SimMarketsConfig {
  network: string;
  simUSDC: { mint: string; decimals: number };
  markets: Record<string, SimMarket>;
}

interface PriceHistory {
  price: number;
  ts: number;
}

interface BotState {
  wallet: BotWallet;
  keypair: Keypair;
  ata?: PublicKey;     // simUSDC ATA
  initialized: boolean;
  userIdx: number | null;
  positionSize: bigint; // +long, -short, 0 = flat
  positionOpenedAt: number; // timestamp ms
  nextTradeAt: number;   // scheduled next trade
  priceHistory: PriceHistory[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

// 30–120 second jitter for next trade
function nextTradeDelay(): number {
  return randInt(30, 120) * 1_000;
}

// 5–30 minute position hold time
function positionHoldMs(): number {
  return randInt(5, 30) * 60_000;
}

function sizeToBigInt(usdSize: number, priceE6: bigint, leverage: number): bigint {
  // size in e6 = usdSize * leverage * 1e6 / price... actually percolator size is notional in e6
  // notional = usd * leverage, as e6
  return BigInt(Math.round(usdSize * leverage * 1_000_000));
}

// ─── Bot Strategy Logic ───────────────────────────────────────────────────────

function trendFollowerDecision(
  state: BotState,
  price: OraclePrice,
  scenario: ActiveScenario | null,
): bigint | null {
  const history = state.priceHistory;
  if (history.length < 2) return null;

  // 5-min price change
  const fiveMinAgo = Date.now() - 5 * 60_000;
  const old = history.find((h) => h.ts <= fiveMinAgo) ?? history[0];
  const pctChange = (price.adjustedPrice - old.price) / old.price;

  // Trend followers go aggressive on squeeze
  const aggressiveMode = scenario?.type === "short_squeeze" || scenario?.type === "gentle_trend";
  const threshold = aggressiveMode ? 0.005 : 0.01;

  const leverage = aggressiveMode ? 5 : rand(3, 5);
  const usdSize = rand(100, 500);

  if (pctChange >= threshold) {
    // Price up → go long (positive size)
    return sizeToBigInt(usdSize, price.priceE6, leverage);
  } else if (pctChange <= -threshold) {
    // Price down → go short (negative size)
    return -sizeToBigInt(usdSize, price.priceE6, leverage);
  }
  return null;
}

function meanReverterDecision(
  state: BotState,
  price: OraclePrice,
  _scenario: ActiveScenario | null,
): bigint | null {
  const history = state.priceHistory;
  if (history.length < 5) return null;

  // 5-min average
  const fiveMinAgo = Date.now() - 5 * 60_000;
  const recent = history.filter((h) => h.ts >= fiveMinAgo);
  if (recent.length < 2) return null;
  const avg = recent.reduce((s, h) => s + h.price, 0) / recent.length;
  const pctDev = (price.adjustedPrice - avg) / avg;

  const leverage = rand(2, 3);
  const usdSize = rand(200, 600);

  if (pctDev >= 0.02) {
    // Price too high → short (fade the move)
    return -sizeToBigInt(usdSize, price.priceE6, leverage);
  } else if (pctDev <= -0.02) {
    // Price too low → long
    return sizeToBigInt(usdSize, price.priceE6, leverage);
  }
  return null;
}

function marketMakerDecision(
  state: BotState,
  price: OraclePrice,
  _scenario: ActiveScenario | null,
): bigint | null {
  // Market makers alternate sides with small sizes, 2x leverage
  const usdSize = rand(50, 150);
  const leverage = 2;
  // Alternate long/short each trade
  const isLong = Math.random() > 0.5;
  const size = sizeToBigInt(usdSize, price.priceE6, leverage);
  return isLong ? size : -size;
}

function botDecision(
  state: BotState,
  price: OraclePrice,
  scenario: ActiveScenario | null,
): bigint | null {
  switch (state.wallet.type) {
    case "trend_follower":
      return trendFollowerDecision(state, price, scenario);
    case "mean_reverter":
      return meanReverterDecision(state, price, scenario);
    case "market_maker":
      return marketMakerDecision(state, price, scenario);
  }
}

// ─── On-chain interactions ────────────────────────────────────────────────────

// ─── Slab layout constants ────────────────────────────────────────────────────
const ENGINE_OFF = 392;
const ACCOUNT_SIZE = 240;
const ACCT_OWNER_OFF = 176;  // empirically verified from devnet slab data

function slabAccountsOffset(maxAccounts: number): number {
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 24;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = 408 + bitmapBytes + postBitmap + nextFreeBytes;
  return Math.ceil(preAccountsLen / 16) * 16;
}

/** Find a user's account index in the slab by owner pubkey */
function findUserIdx(slabData: Buffer, owner: PublicKey): number {
  const ownerBytes = owner.toBuffer();
  // Detect maxAccounts from data length
  const maxAccounts = [64, 256, 1024, 4096].find((n) => {
    const accountsOff = slabAccountsOffset(n);
    return slabData.length === ENGINE_OFF + accountsOff + n * ACCOUNT_SIZE;
  }) ?? 64;

  const accountsOff = slabAccountsOffset(maxAccounts);
  const accountsBase = ENGINE_OFF + accountsOff;

  for (let i = 0; i < maxAccounts; i++) {
    const base = accountsBase + i * ACCOUNT_SIZE;
    if (base + ACCOUNT_SIZE > slabData.length) break;
    const acctOwner = slabData.subarray(base + ACCT_OWNER_OFF, base + ACCT_OWNER_OFF + 32);
    if (acctOwner.equals(ownerBytes)) return i;
  }
  return -1;
}

const INIT_FEE_RAW = 1_000_000n;  // 1 simUSDC — must match on-chain new_account_fee
const BOT_INITIAL_MINT = INITIAL_DEPOSIT_RAW + INIT_FEE_RAW; // deposit + fee

async function initBot(
  connection: Connection,
  payer: Keypair, // admin pays for bot init
  bot: BotState,
  slab: PublicKey,
  mintPk: PublicKey,
  vault: PublicKey,
): Promise<{ userIdx: number; ata: PublicKey }> {
  // Get/create ATA for the bot
  const ataInfo = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintPk,
    bot.keypair.publicKey,
  );
  bot.ata = ataInfo.address;

  // Mint simUSDC to bot's ATA (fee + initial deposit)
  await mintTo(
    connection,
    payer,        // payer for tx
    mintPk,       // simUSDC mint
    ataInfo.address, // bot's ATA
    payer,        // mint authority = admin
    BOT_INITIAL_MINT,
  );

  // InitUser — bot keypair must sign, fee_payment must match new_account_fee
  const initData = encodeInitUser({ feePayment: INIT_FEE_RAW });
  const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
    bot.keypair.publicKey,
    slab,
    ataInfo.address,
    vault,
    TOKEN_PROGRAM_ID,
  ]);

  const initTx = new Transaction();
  initTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  initTx.add(buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData }));
  await sendAndConfirmTransaction(connection, initTx, [payer, bot.keypair], {
    commitment: "confirmed",
    skipPreflight: true,
  });

  // Read slab to find the bot's userIdx (just assigned by InitUser)
  const slabInfo = await connection.getAccountInfo(slab);
  if (!slabInfo) throw new Error("Slab account not found after InitUser");
  // num_used_accounts is at a known offset in RiskEngine (after params)
  // For small slabs: magic(4) + version(4) + ... we need to find the bot's index
  // The bot was the last user added, so userIdx = num_used_accounts - 1
  // num_used_accounts is a u16 at offset in EngineState
  // For now, scan accounts to find ours by pubkey match
  const userIdx = findUserIdx(slabInfo.data, bot.keypair.publicKey);
  if (userIdx < 0) throw new Error("Could not find bot's userIdx in slab after InitUser");

  // Deposit initial collateral — bot must sign (tokens come from bot's ATA)
  const depositData = encodeDepositCollateral({ userIdx, amount: INITIAL_DEPOSIT_RAW.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    bot.keypair.publicKey,
    slab,
    ataInfo.address,
    vault,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
  await sendAndConfirmTransaction(connection, depositTx, [payer, bot.keypair], {
    commitment: "confirmed",
    skipPreflight: true,
  });

  return { userIdx, ata: ataInfo.address };
}

async function executeTrade(
  connection: Connection,
  bot: BotState,
  slab: PublicKey,
  size: bigint,
  oracleSlab: PublicKey, // oracle = slab for admin-oracle markets
): Promise<string> {
  if (bot.userIdx === null) throw new Error("Bot not initialized");

  const tradeData = encodeTradeNoCpi({
    lpIdx: LP_IDX,
    userIdx: bot.userIdx,
    size: size.toString(),
  });

  // For TradeNoCpi: user, lp (we use payer as LP signer placeholder), slab, clock, oracle
  // Note: actual LP keypair would be needed; for sim we use the bot keypair as user
  // and a separate LP keypair. For simplicity, the admin acts as LP proxy.
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
    bot.keypair.publicKey,
    bot.keypair.publicKey, // LP signer (sim: same keypair for demo)
    slab,
    SYSVAR_CLOCK_PUBKEY,
    oracleSlab,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
  const sig = await sendAndConfirmTransaction(connection, tx, [bot.keypair], {
    commitment: "confirmed",
    skipPreflight: true,
  });
  return sig;
}

// ─── BotFleet ─────────────────────────────────────────────────────────────────

export class BotFleet {
  private connection: Connection;
  private adminKeypair: Keypair;
  private oracle: SimOracle;
  private bots: BotState[] = [];
  private markets: SimMarketsConfig;
  private running = false;
  private activeScenario: ActiveScenario | null = null;

  constructor(opts: {
    rpcUrl: string;
    adminKeypair: Keypair;
    oracle: SimOracle;
  }) {
    this.connection = new Connection(opts.rpcUrl, "confirmed");
    this.adminKeypair = opts.adminKeypair;
    this.oracle = opts.oracle;

    this.markets = JSON.parse(fs.readFileSync(SIM_CONFIG_PATH, "utf-8")) as SimMarketsConfig;

    this.loadBotWallets();
  }

  private loadBotWallets(): void {
    // Try env var first (for Docker/Railway), then file
    let config: BotWalletsConfig;
    const envWallets = process.env.SIM_BOT_WALLETS;
    if (envWallets) {
      config = JSON.parse(envWallets) as BotWalletsConfig;
      console.log("[bots] Loaded bot wallets from SIM_BOT_WALLETS env var");
    } else {
      const candidates = [
        path.resolve(__dirname, "../config/sim-bot-wallets.json"),
        path.resolve(__dirname, "../app/config/sim-bot-wallets.json"),
      ];
      const walletsPath = candidates.find((p) => fs.existsSync(p));
      if (!walletsPath) {
        console.warn("[bots] sim-bot-wallets.json not found and SIM_BOT_WALLETS env not set — run setup-sim-bots.ts first");
        return;
      }
      config = JSON.parse(fs.readFileSync(walletsPath, "utf-8")) as BotWalletsConfig;
    }
    for (const wallet of config.bots) {
      const keypair = Keypair.fromSecretKey(Uint8Array.from(wallet.secretKey));
      this.bots.push({
        wallet,
        keypair,
        initialized: false,
        userIdx: null,
        positionSize: 0n,
        positionOpenedAt: 0,
        nextTradeAt: Date.now() + randInt(5, 30) * 1_000,
        priceHistory: [],
      });
    }
    console.log(`[bots] Loaded ${this.bots.length} bot wallets`);
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("[bots] Starting bot fleet...");
    // Main bot loop — tick every second, each bot has its own schedule
    while (this.running) {
      const now = Date.now();
      // Update price history for all bots
      this.updatePriceHistory(now);
      // Check scenario
      this.activeScenario = this.oracle.latestPrices.size > 0
        ? this.deriveScenario()
        : null;

      // Run bots that are due
      for (const bot of this.bots) {
        if (!this.running) break;
        if (now >= bot.nextTradeAt) {
          await this.runBot(bot).catch((err) =>
            console.error(`[bots] bot ${bot.wallet.botId} error:`, err),
          );
          bot.nextTradeAt = now + nextTradeDelay();
        }
      }

      await sleep(1_000);
    }
    console.log("[bots] Stopped.");
  }

  stop(): void {
    this.running = false;
  }

  private updatePriceHistory(now: number): void {
    for (const bot of this.bots) {
      const price = this.oracle.latestPrices.get(bot.wallet.market);
      if (!price) continue;
      bot.priceHistory.push({ price: price.adjustedPrice, ts: now });
      // Keep 10 minutes of history
      const cutoff = now - 10 * 60_000;
      bot.priceHistory = bot.priceHistory.filter((h) => h.ts >= cutoff);
    }
  }

  // Simple heuristic: infer scenario from price volatility/trend
  private deriveScenario(): ActiveScenario | null {
    // Bots read the oracle's active scenario indirectly via the oracle's price adjustments
    // For now they just act on price signals — scenario awareness is implicit
    return null;
  }

  private async runBot(bot: BotState): Promise<void> {
    const market = this.markets.markets[bot.wallet.market];
    if (!market?.slab) return; // market not deployed yet

    const price = this.oracle.latestPrices.get(bot.wallet.market);
    if (!price) return; // no price yet

    const slabPk = new PublicKey(market.slab);
    const mintPk = new PublicKey(this.markets.simUSDC.mint);
    const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabPk);
    // Vault ATA = associated token account owned by vaultPda
    const vaultAta = await getAssociatedTokenAddress(mintPk, vaultPda, true);

    // Initialize bot on first run
    if (!bot.initialized) {
      try {
        const { userIdx, ata } = await initBot(
          this.connection,
          this.adminKeypair,
          bot,
          slabPk,
          mintPk,
          vaultAta,
        );
        bot.userIdx = userIdx;
        bot.ata = ata;
        bot.initialized = true;
        console.log(`[bots] ${bot.wallet.botId} initialized (userIdx=${userIdx})`);
      } catch (err) {
        console.error(`[bots] init failed for ${bot.wallet.botId}:`, err);
        return;
      }
    }

    // Check if position should be closed (time or stop loss)
    const now = Date.now();
    if (bot.positionSize !== 0n && bot.positionOpenedAt > 0) {
      const holdTime = now - bot.positionOpenedAt;
      const holdLimit = positionHoldMs();
      // Stop loss: 5% adverse move
      // (simplified: just close after hold time)
      if (holdTime >= holdLimit) {
        await this.closePosition(bot, slabPk);
        return;
      }
    }

    // Skip if already positioned (only market makers double-side)
    if (bot.positionSize !== 0n && bot.wallet.type !== "market_maker") return;

    // Decide trade
    const size = botDecision(bot, price, this.activeScenario);
    if (!size) return;

    try {
      const sig = await executeTrade(this.connection, bot, slabPk, size, slabPk);
      bot.positionSize = size;
      bot.positionOpenedAt = now;
      console.log(
        `[bots] ${bot.wallet.botId} (${bot.wallet.type}) ${size > 0n ? "LONG" : "SHORT"} ${bot.wallet.market} @ ${price.adjustedPrice.toFixed(2)} sig=${sig.slice(0, 12)}...`,
      );
    } catch (err) {
      console.error(`[bots] trade failed for ${bot.wallet.botId}:`, err);
    }
  }

  private async closePosition(bot: BotState, slabPk: PublicKey): Promise<void> {
    if (bot.positionSize === 0n || bot.userIdx === null) return;
    // Close by trading in opposite direction with same size
    const closeSize = -bot.positionSize;
    try {
      const sig = await executeTrade(this.connection, bot, slabPk, closeSize, slabPk);
      console.log(
        `[bots] ${bot.wallet.botId} CLOSED position sig=${sig.slice(0, 12)}...`,
      );
      bot.positionSize = 0n;
      bot.positionOpenedAt = 0;
    } catch (err) {
      console.error(`[bots] close failed for ${bot.wallet.botId}:`, err);
    }
  }
}

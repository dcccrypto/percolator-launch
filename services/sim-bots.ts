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
  holdTarget: number;   // ms to hold before closing (set once on open)
  entryPrice: number;   // USD price when position opened
  nextTradeAt: number;   // scheduled next trade
  priceHistory: PriceHistory[];
  tradeCount: number;    // total trades for leaderboard
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

// 5–15 second jitter for next trade (aggressive for demo activity)
function nextTradeDelay(): number {
  return randInt(5, 15) * 1_000;
}

// 30s–3 minute position hold time (fast cycling for visible leaderboard)
function positionHoldMs(): number {
  return randInt(30, 180) * 1_000;
}

function sizeToBigInt(usdSize: number, priceE6: bigint, leverage: number): bigint {
  // percolator position_size is in base-asset units at 6-decimal scale
  // notional_e6 = position_size * price_e6 / 1e6
  // => position_size = usdNotional * 1e12 / price_e6
  const usdNotional = usdSize * leverage;
  return BigInt(Math.round(usdNotional * 1_000_000_000_000 / Number(priceE6)));
}

// ─── Bot Strategy Logic ───────────────────────────────────────────────────────

function trendFollowerDecision(
  state: BotState,
  price: OraclePrice,
  scenario: ActiveScenario | null,
): bigint | null {
  const history = state.priceHistory;
  if (history.length < 2) return null;

  // 1-min price change (fast response for active trading)
  const oneMinAgo = Date.now() - 60_000;
  const old = history.find((h) => h.ts <= oneMinAgo) ?? history[0];
  const pctChange = (price.adjustedPrice - old.price) / old.price;

  // Trend followers go aggressive on squeeze
  const t = scenario?.type?.replace(/_/g, "-") ?? "";
  const aggressiveMode = t === "short-squeeze" || t === "gentle-trend";
  const threshold = aggressiveMode ? 0.001 : 0.002; // very low = always trading

  const leverage = aggressiveMode ? 8 : rand(4, 8);
  const usdSize = rand(500, 2000);

  if (pctChange >= threshold) {
    return sizeToBigInt(usdSize, price.priceE6, leverage);
  } else if (pctChange <= -threshold) {
    return -sizeToBigInt(usdSize, price.priceE6, leverage);
  }
  // Fallback: follow micro-trend direction even below threshold
  const size = sizeToBigInt(usdSize, price.priceE6, leverage);
  return pctChange >= 0 ? size : -size;
}

function meanReverterDecision(
  state: BotState,
  price: OraclePrice,
  _scenario: ActiveScenario | null,
): bigint | null {
  const history = state.priceHistory;
  if (history.length < 5) return null;

  // 1-min average (fast response)
  const oneMinAgo = Date.now() - 60_000;
  const recent = history.filter((h) => h.ts >= oneMinAgo);
  if (recent.length < 2) return null;
  const avg = recent.reduce((s, h) => s + h.price, 0) / recent.length;
  const pctDev = (price.adjustedPrice - avg) / avg;

  const leverage = rand(3, 6);
  const usdSize = rand(500, 1500);

  if (pctDev >= 0.001) {
    // Price above average → short (fade the move)
    return -sizeToBigInt(usdSize, price.priceE6, leverage);
  } else if (pctDev <= -0.001) {
    // Price below average → long
    return sizeToBigInt(usdSize, price.priceE6, leverage);
  }
  // Fallback: trade anyway with slight contrarian bias
  const size = sizeToBigInt(usdSize, price.priceE6, leverage);
  return pctDev >= 0 ? -size : size;
}

function marketMakerDecision(
  state: BotState,
  price: OraclePrice,
  _scenario: ActiveScenario | null,
): bigint | null {
  // Market makers alternate sides with decent sizes
  const usdSize = rand(300, 1000);
  const leverage = rand(2, 4);
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
// Offsets from packages/core/src/solana/slab.ts (authoritative source)
const ENGINE_OFF = 392;
const ACCOUNT_SIZE = 240;
const ACCT_POSITION_SIZE_OFF = 80;   // position_size (I128, 16 bytes)
const ACCT_MATCHER_PROG_OFF = 120;   // matcher_program [u8;32]
const ACCT_MATCHER_CTX_OFF = 152;    // matcher_context [u8;32]
const ACCT_OWNER_OFF = 184;          // owner [u8;32]

function slabAccountsOffset(maxAccounts: number): number {
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const bitmapBytes = bitmapWords * 8;
  const postBitmap = 24;
  const nextFreeBytes = maxAccounts * 2;
  const preAccountsLen = 408 + bitmapBytes + postBitmap + nextFreeBytes;
  return Math.ceil(preAccountsLen / 16) * 16;
}

/** Try both aligned and unaligned layouts (some builds don't pad to 16) */
function detectSlabLayout(dataLen: number): { maxAccounts: number; accountsOff: number } {
  for (const n of [64, 256, 1024, 4096]) {
    // Aligned variant
    const aligned = slabAccountsOffset(n);
    if (dataLen === ENGINE_OFF + aligned + n * ACCOUNT_SIZE) {
      return { maxAccounts: n, accountsOff: aligned };
    }
    // Unaligned variant (small builds)
    const bitmapWords = Math.ceil(n / 64);
    const bitmapBytes = bitmapWords * 8;
    const unaligned = 408 + bitmapBytes + 24 + n * 2;
    if (dataLen === ENGINE_OFF + unaligned + n * ACCOUNT_SIZE) {
      return { maxAccounts: n, accountsOff: unaligned };
    }
  }
  // Fallback: assume 64 aligned
  return { maxAccounts: 64, accountsOff: slabAccountsOffset(64) };
}

/** Find a user's account index in the slab by owner pubkey */
function findUserIdx(slabData: Buffer, owner: PublicKey): number {
  const ownerBytes = owner.toBuffer();
  const { maxAccounts, accountsOff } = detectSlabLayout(slabData.length);
  const accountsBase = ENGINE_OFF + accountsOff;

  for (let i = 0; i < maxAccounts; i++) {
    const base = accountsBase + i * ACCOUNT_SIZE;
    if (base + ACCOUNT_SIZE > slabData.length) break;
    const acctOwner = slabData.subarray(base + ACCT_OWNER_OFF, base + ACCT_OWNER_OFF + 32);
    if (acctOwner.equals(ownerBytes)) return i;
  }
  return -1;
}

/** Read I128 (signed, little-endian) from buffer */
function readI128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  const unsigned = (hi << 64n) | lo;
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) {
    return unsigned - (1n << 128n);
  }
  return unsigned;
}

/** Read a bot's on-chain position size from slab data */
function readPositionSize(slabData: Buffer, userIdx: number): bigint {
  const { accountsOff } = detectSlabLayout(slabData.length);
  const base = ENGINE_OFF + accountsOff + userIdx * ACCOUNT_SIZE;
  if (base + ACCOUNT_SIZE > slabData.length) return 0n;
  return readI128LE(slabData, base + ACCT_POSITION_SIZE_OFF);
}

/** Read LP account's matcher program and context from slab data */
function readLpMatcherInfo(slabData: Buffer, lpIdx: number): { matcherProg: PublicKey; matcherCtx: PublicKey; lpOwner: PublicKey } {
  const { accountsOff } = detectSlabLayout(slabData.length);
  const base = ENGINE_OFF + accountsOff + lpIdx * ACCOUNT_SIZE;
  return {
    matcherProg: new PublicKey(slabData.subarray(base + ACCT_MATCHER_PROG_OFF, base + ACCT_MATCHER_PROG_OFF + 32)),
    matcherCtx: new PublicKey(slabData.subarray(base + ACCT_MATCHER_CTX_OFF, base + ACCT_MATCHER_CTX_OFF + 32)),
    lpOwner: new PublicKey(slabData.subarray(base + ACCT_OWNER_OFF, base + ACCT_OWNER_OFF + 32)),
  };
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
  payer: Keypair,        // admin (LP owner) — must sign TradeNoCpi
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

  // TradeNoCpi: user(signer), lp(signer=LP owner=payer), slab, clock, oracle
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
    bot.keypair.publicKey,
    payer.publicKey,   // LP owner must sign
    slab,
    SYSVAR_CLOCK_PUBKEY,
    oracleSlab,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));

  // Both bot (user) and admin (LP owner) must sign — retry once on timeout
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [bot.keypair, payer], {
        commitment: "confirmed",
        skipPreflight: true,
      });
      return sig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && (msg.includes("expired") || msg.includes("Blockhash") || msg.includes("blockhash"))) {
        // Refresh blockhash and retry
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Trade failed after retries");
}

// ─── BotFleet ─────────────────────────────────────────────────────────────────

// Bot display names for leaderboard
const BOT_NAMES: Record<BotType, string> = {
  trend_follower: "🔥 TrendBot",
  mean_reverter: "🔄 MeanRevBot",
  market_maker: "⚖️ MarketMaker",
};

// Supabase REST helper
function supabaseHeaders(serviceKey: string) {
  return {
    "Content-Type": "application/json",
    "apikey": serviceKey,
    "Authorization": `Bearer ${serviceKey}`,
  };
}

export class BotFleet {
  private connection: Connection;
  private adminKeypair: Keypair;
  private oracle: SimOracle;
  private bots: BotState[] = [];
  private markets: SimMarketsConfig;
  private running = false;
  private activeScenario: ActiveScenario | null = null;
  private supabaseUrl: string;
  private serviceKey: string;
  private leaderboardBuffer: Array<{
    wallet: string;
    display_name: string;
    pnl_delta: number;
    deposited_delta: number;
    is_win: boolean;
  }> = [];
  private lastLeaderboardFlush = 0;

  constructor(opts: {
    rpcUrl: string;
    adminKeypair: Keypair;
    oracle: SimOracle;
    supabaseUrl: string;
    serviceKey: string;
  }) {
    this.connection = new Connection(opts.rpcUrl, "confirmed");
    this.adminKeypair = opts.adminKeypair;
    this.oracle = opts.oracle;
    this.supabaseUrl = opts.supabaseUrl;
    this.serviceKey = opts.serviceKey;

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
        holdTarget: 0,
        entryPrice: 0,
        nextTradeAt: Date.now() + randInt(5, 30) * 1_000,
        priceHistory: [],
        tradeCount: 0,
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

      // Flush leaderboard updates
      await this.flushLeaderboard().catch((err) =>
        console.error("[bots] leaderboard flush error:", err),
      );

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

    // Initialize bot on first run — recover existing account if possible
    if (!bot.initialized) {
      try {
        // Check if bot already has an account on-chain (e.g., after service restart)
        const slabInfo = await this.connection.getAccountInfo(slabPk);
        if (slabInfo) {
          const existingIdx = findUserIdx(slabInfo.data, bot.keypair.publicKey);
          if (existingIdx >= 0) {
            // Recover existing account — skip InitUser
            const ata = await getAssociatedTokenAddress(mintPk, bot.keypair.publicKey);
            bot.userIdx = existingIdx;
            bot.ata = ata;
            bot.initialized = true;

            // Recover on-chain position state
            const onChainPos = readPositionSize(slabInfo.data, existingIdx);
            if (onChainPos !== 0n) {
              bot.positionSize = onChainPos;
              bot.holdTarget = 5_000; // close recovered positions quickly (5s)
              bot.positionOpenedAt = Date.now() - 10_000; // triggers close on next tick
              bot.entryPrice = price.adjustedPrice; // approximate
              console.log(`[bots] ${bot.wallet.botId} RECOVERED existing account (userIdx=${existingIdx}, pos=${onChainPos > 0n ? "LONG" : "SHORT"})`);
            } else {
              console.log(`[bots] ${bot.wallet.botId} recovered (userIdx=${existingIdx}, flat)`);
            }
            return; // skip trading this tick, start fresh next tick
          }
        }

        // No existing account — initialize fresh
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
        console.log(`[bots] ${bot.wallet.botId} initialized fresh (userIdx=${userIdx})`);
      } catch (err) {
        console.error(`[bots] init failed for ${bot.wallet.botId}:`, err);
        return;
      }
    }

    // Check if position should be closed (hold timer expired)
    const now = Date.now();
    if (bot.positionSize !== 0n && bot.positionOpenedAt > 0) {
      const holdTime = now - bot.positionOpenedAt;
      if (holdTime >= bot.holdTarget) {
        await this.closePosition(bot, slabPk);
        return;
      }
    }

    // Skip if already positioned — wait for hold timer to close first
    if (bot.positionSize !== 0n) return;

    // Decide trade
    const size = botDecision(bot, price, this.activeScenario);
    if (!size) return;

    try {
      const sig = await executeTrade(this.connection, this.adminKeypair, bot, slabPk, size, slabPk);
      bot.positionSize = size;
      bot.positionOpenedAt = now;
      bot.holdTarget = positionHoldMs();
      bot.entryPrice = price.adjustedPrice;
      bot.tradeCount++;
      console.log(
        `[bots] ${bot.wallet.botId} (${bot.wallet.type}) ${size > 0n ? "LONG" : "SHORT"} ${bot.wallet.market} @ ${price.adjustedPrice.toFixed(2)} sig=${sig.slice(0, 12)}...`,
      );
      // Log trade to DB for frontend display
      const absSize = Number(size > 0n ? size : -size);
      this.logTrade({
        slabAddress: slabPk.toBase58(),
        trader: bot.keypair.publicKey.toBase58(),
        side: size > 0n ? "long" : "short",
        size: absSize,
        price: price.adjustedPrice,
        fee: 0,
        txSignature: sig,
      });
    } catch (err) {
      console.error(`[bots] trade failed for ${bot.wallet.botId}:`, err);
    }
  }

  private async closePosition(bot: BotState, slabPk: PublicKey): Promise<void> {
    if (bot.positionSize === 0n || bot.userIdx === null) return;

    const exitPrice = this.oracle.latestPrices.get(bot.wallet.market)?.adjustedPrice ?? 0;
    const closeSize = -bot.positionSize;

    try {
      const sig = await executeTrade(this.connection, this.adminKeypair, bot, slabPk, closeSize, slabPk);

      // Calculate PnL
      const isLong = bot.positionSize > 0n;
      const absSize = Number(isLong ? bot.positionSize : -bot.positionSize) / 1e6;
      const priceDiff = exitPrice - bot.entryPrice;
      const pnl = isLong ? (priceDiff / bot.entryPrice) * absSize : (-priceDiff / bot.entryPrice) * absSize;
      const pnlRounded = Math.round(pnl * 1e6); // in token units (6 decimals)

      console.log(
        `[bots] ${bot.wallet.botId} CLOSED ${isLong ? "LONG" : "SHORT"} @ ${exitPrice.toFixed(2)} pnl=${pnl.toFixed(2)} sig=${sig.slice(0, 12)}...`,
      );
      // Log close trade to DB
      const closeAbsSize = Number(closeSize > 0n ? closeSize : -closeSize);
      this.logTrade({
        slabAddress: slabPk.toBase58(),
        trader: bot.keypair.publicKey.toBase58(),
        side: closeSize > 0n ? "long" : "short",
        size: closeAbsSize,
        price: exitPrice,
        fee: 0,
        txSignature: sig,
      });

      // Buffer leaderboard update
      const idx = bot.wallet.botId.split("_").pop() ?? "1";
      this.leaderboardBuffer.push({
        wallet: bot.keypair.publicKey.toBase58(),
        display_name: `${BOT_NAMES[bot.wallet.type]} #${idx}`,
        pnl_delta: pnlRounded,
        deposited_delta: Math.round(absSize * 1e6),
        is_win: pnl > 0,
      });

      bot.positionSize = 0n;
      bot.positionOpenedAt = 0;
      bot.holdTarget = 0;
      bot.entryPrice = 0;
      bot.tradeCount++;
    } catch (err) {
      console.error(`[bots] close failed for ${bot.wallet.botId}:`, err);
    }
  }

  /** Log a trade to the Supabase trades table so the frontend can display it */
  private async logTrade(opts: {
    slabAddress: string;
    trader: string;
    side: "long" | "short";
    size: number;
    price: number;
    fee: number;
    txSignature: string;
  }): Promise<void> {
    try {
      await fetch(`${this.supabaseUrl}/rest/v1/trades`, {
        method: "POST",
        headers: { ...supabaseHeaders(this.serviceKey), "Prefer": "return=minimal" },
        body: JSON.stringify({
          slab_address: opts.slabAddress,
          trader: opts.trader,
          side: opts.side,
          size: opts.size,
          price: opts.price,
          fee: opts.fee,
          tx_signature: opts.txSignature,
        }),
      });
    } catch (err) {
      console.error("[bots] trade log failed:", err);
    }
  }

  /** Flush buffered leaderboard updates to Supabase */
  private async flushLeaderboard(): Promise<void> {
    if (this.leaderboardBuffer.length === 0) return;
    const now = Date.now();
    if (now - this.lastLeaderboardFlush < 15_000 && this.leaderboardBuffer.length < 10) return;

    const batch = this.leaderboardBuffer.splice(0, 20);
    this.lastLeaderboardFlush = now;

    const weekStart = currentWeekStart();

    for (const entry of batch) {
      try {
        // Upsert: try to get existing row, then update or insert
        const url = `${this.supabaseUrl}/rest/v1/sim_leaderboard?wallet=eq.${entry.wallet}&week_start=eq.${encodeURIComponent(weekStart)}`;
        const existing = await fetch(url, {
          headers: supabaseHeaders(this.serviceKey),
        }).then((r) => r.json()) as Array<Record<string, number | string | null>>;

        if (existing && existing.length > 0) {
          const row = existing[0];
          await fetch(`${this.supabaseUrl}/rest/v1/sim_leaderboard?wallet=eq.${entry.wallet}&week_start=eq.${encodeURIComponent(weekStart)}`, {
            method: "PATCH",
            headers: { ...supabaseHeaders(this.serviceKey), "Prefer": "return=minimal" },
            body: JSON.stringify({
              total_pnl: ((row.total_pnl as number) ?? 0) + entry.pnl_delta,
              total_deposited: ((row.total_deposited as number) ?? 0) + entry.deposited_delta,
              trade_count: ((row.trade_count as number) ?? 0) + 1,
              win_count: ((row.win_count as number) ?? 0) + (entry.is_win ? 1 : 0),
              best_trade: Math.max((row.best_trade as number) ?? -Infinity, entry.pnl_delta),
              worst_trade: Math.min((row.worst_trade as number) ?? Infinity, entry.pnl_delta),
              last_trade_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
        } else {
          await fetch(`${this.supabaseUrl}/rest/v1/sim_leaderboard`, {
            method: "POST",
            headers: { ...supabaseHeaders(this.serviceKey), "Prefer": "return=minimal" },
            body: JSON.stringify({
              wallet: entry.wallet,
              display_name: entry.display_name,
              total_pnl: entry.pnl_delta,
              total_deposited: entry.deposited_delta,
              trade_count: 1,
              win_count: entry.is_win ? 1 : 0,
              liquidation_count: 0,
              best_trade: entry.pnl_delta,
              worst_trade: entry.pnl_delta,
              week_start: weekStart,
              last_trade_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
          });
        }
      } catch (err) {
        console.error(`[bots] leaderboard write failed:`, err);
      }
    }
    if (batch.length > 0) {
      console.log(`[bots] flushed ${batch.length} leaderboard entries`);
    }
  }
}

function currentWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

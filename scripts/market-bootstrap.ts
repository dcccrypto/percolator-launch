#!/usr/bin/env tsx
/**
 * PERC-355: Auto-bootstrap new markets
 *
 * Watches for new Percolator markets on devnet and automatically:
 *   1. Seeds LP collateral (configurable amount)
 *   2. Pushes oracle prices from CoinGecko/Binance
 *   3. Places 3 initial seed trades (buy → sell → buy)
 *   4. Runs a lightweight market-maker bot (continuous small trades)
 *
 * All bot wallets must be pre-funded devnet wallets with SOL + the market's
 * collateral token.  Private keys are read from environment variables.
 *
 * Usage:
 *   npx tsx scripts/market-bootstrap.ts [--once] [--dry-run]
 *
 * Env vars:
 *   RPC_URL              — Solana devnet RPC
 *   PROGRAM_ID           — Percolator program ID
 *   ALL_PROGRAM_IDS      — Comma-separated program IDs to scan
 *   ADMIN_KEYPAIR        — JSON array secret key (admin + oracle authority)
 *   BOT_KEYPAIRS         — Comma-separated JSON array secret keys (3-5 wallets)
 *   BOOTSTRAP_LP_AMOUNT  — LP seed amount in token lamports (default: 50_000_000 = 50 tokens @ 6 dec)
 *   BOOTSTRAP_INSURANCE  — Insurance seed amount (default: 10_000_000 = 10 tokens)
 *   BOOTSTRAP_TRADE_SIZE — Seed trade size in base units (default: 1_000_000 = 1 contract)
 *   MM_TRADE_SIZE        — Market maker trade size (default: 500_000 = 0.5 contract)
 *   MM_LONG_INTERVAL_MS  — Long order interval (default: 60_000)
 *   MM_SHORT_INTERVAL_MS — Short order interval (default: 75_000)
 *   ORACLE_PUSH_INTERVAL — Oracle push interval ms (default: 10_000)
 *   DISCOVERY_INTERVAL   — Market discovery interval ms (default: 30_000)
 */

import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  encodeInitUser,
  encodeInitLP,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodeKeeperCrank,
  encodePushOraclePrice,
  encodeTradeNoCpi,
} from "../packages/core/src/abi/instructions.js";
import {
  buildAccountMetas,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_TRADE_NOCPI,
} from "../packages/core/src/abi/accounts.js";
import { buildIx } from "../packages/core/src/runtime/tx.js";
import { deriveVaultAuthority, derivePythPushOraclePDA } from "../packages/core/src/solana/pda.js";
import { discoverMarkets, type DiscoveredMarket } from "../packages/core/src/solana/discovery.js";

// ============================================================================
// CONFIG
// ============================================================================

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_IDS = (
  process.env.ALL_PROGRAM_IDS ??
  process.env.PROGRAM_ID ??
  "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD"
)
  .split(",")
  .filter(Boolean);

const LP_SEED_AMOUNT = BigInt(process.env.BOOTSTRAP_LP_AMOUNT ?? "50000000");
const INSURANCE_SEED = BigInt(process.env.BOOTSTRAP_INSURANCE ?? "10000000");
const SEED_TRADE_SIZE = BigInt(process.env.BOOTSTRAP_TRADE_SIZE ?? "1000000");
const MM_TRADE_SIZE = BigInt(process.env.MM_TRADE_SIZE ?? "500000");
const MM_LONG_INTERVAL = Number(process.env.MM_LONG_INTERVAL_MS ?? "60000");
const MM_SHORT_INTERVAL = Number(process.env.MM_SHORT_INTERVAL_MS ?? "75000");
const ORACLE_PUSH_INTERVAL = Number(process.env.ORACLE_PUSH_INTERVAL ?? "10000");
const DISCOVERY_INTERVAL = Number(process.env.DISCOVERY_INTERVAL ?? "30000");
const PRIORITY_FEE = 50_000;

const DRY_RUN = process.argv.includes("--dry-run");
const ONCE = process.argv.includes("--once");

// ============================================================================
// WALLET MANAGEMENT
// ============================================================================

// Synchronous keypair loader for JSON arrays
function loadKeypairSync(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  throw new Error("Keypair must be a JSON array (base58 not supported in sync mode)");
}

function loadAdminKeypair(): Keypair {
  const raw = process.env.ADMIN_KEYPAIR ?? process.env.CRANK_KEYPAIR;
  if (!raw) throw new Error("ADMIN_KEYPAIR or CRANK_KEYPAIR must be set");
  return loadKeypairSync(raw);
}

function loadBotKeypairs(): Keypair[] {
  const raw = process.env.BOT_KEYPAIRS;
  if (!raw) {
    // Fall back to using admin keypair as single bot wallet
    console.warn("[bootstrap] BOT_KEYPAIRS not set, using ADMIN_KEYPAIR as bot wallet");
    return [loadAdminKeypair()];
  }
  // Format: base64-or-json-array,base64-or-json-array,...
  // But JSON arrays contain commas, so we split on ],[ boundaries
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  return parts.map((p, i) => {
    try {
      return loadKeypairSync(p);
    } catch {
      throw new Error(`Failed to parse BOT_KEYPAIRS entry ${i}: ${p.slice(0, 20)}...`);
    }
  });
}

// ============================================================================
// PRICE FETCHING
// ============================================================================

/** Known token mint → CoinGecko/Binance symbol mapping */
const MINT_SYMBOLS: Record<string, { coingecko?: string; binance?: string }> = {
  // SOL (wrapped)
  So11111111111111111111111111111111111111112: { coingecko: "solana", binance: "SOLUSDT" },
  // Add more mappings as needed — unknown mints use DexScreener/Jupiter fallback
};

interface PriceResult {
  priceE6: bigint;
  source: string;
}

async function fetchPriceFromBinance(symbol: string): Promise<bigint | null> {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
      { signal: controller.signal },
    );
    const json = (await res.json()) as { price?: string };
    if (!json.price) return null;
    const p = parseFloat(json.price);
    if (!isFinite(p) || p <= 0) return null;
    return BigInt(Math.round(p * 1_000_000));
  } catch {
    return null;
  }
}

async function fetchPriceFromCoinGecko(id: string): Promise<bigint | null> {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: controller.signal },
    );
    const json = (await res.json()) as Record<string, { usd?: number }>;
    const usd = json[id]?.usd;
    if (!usd || !isFinite(usd) || usd <= 0) return null;
    return BigInt(Math.round(usd * 1_000_000));
  } catch {
    return null;
  }
}

async function fetchPriceFromDexScreener(mint: string): Promise<bigint | null> {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: controller.signal },
    );
    const json = (await res.json()) as {
      pairs?: { priceUsd?: string; liquidity?: { usd?: number } }[];
    };
    if (!json.pairs?.length) return null;
    // Sort by liquidity, take best
    const sorted = [...json.pairs].sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    );
    const p = parseFloat(sorted[0].priceUsd ?? "0");
    if (!isFinite(p) || p <= 0) return null;
    return BigInt(Math.round(p * 1_000_000));
  } catch {
    return null;
  }
}

async function fetchPriceFromJupiter(mint: string): Promise<bigint | null> {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`, {
      signal: controller.signal,
    });
    const json = (await res.json()) as {
      data?: Record<string, { price?: string }>;
    };
    const priceStr = json.data?.[mint]?.price;
    if (!priceStr) return null;
    const p = parseFloat(priceStr);
    if (!isFinite(p) || p <= 0) return null;
    return BigInt(Math.round(p * 1_000_000));
  } catch {
    return null;
  }
}

/**
 * Fetch price for a token mint with multi-source fallback:
 *   Binance → CoinGecko → DexScreener → Jupiter
 * Returns null if all sources fail.
 */
async function fetchPrice(mint: string): Promise<PriceResult | null> {
  const mapping = MINT_SYMBOLS[mint];

  // Try Binance first (lowest latency)
  if (mapping?.binance) {
    const p = await fetchPriceFromBinance(mapping.binance);
    if (p !== null) return { priceE6: p, source: "binance" };
  }

  // CoinGecko
  if (mapping?.coingecko) {
    const p = await fetchPriceFromCoinGecko(mapping.coingecko);
    if (p !== null) return { priceE6: p, source: "coingecko" };
  }

  // DexScreener + Jupiter in parallel
  const [dex, jup] = await Promise.all([
    fetchPriceFromDexScreener(mint),
    fetchPriceFromJupiter(mint),
  ]);

  if (dex !== null) return { priceE6: dex, source: "dexscreener" };
  if (jup !== null) return { priceE6: jup, source: "jupiter" };

  return null;
}

// ============================================================================
// TRANSACTION HELPERS
// ============================================================================

function addPriorityFee(tx: Transaction): void {
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }),
  );
}

async function sendTx(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would send: ${label}`);
    return "dry-run";
  }
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: "confirmed",
      skipPreflight: true,
    });
    console.log(`  ✓ ${label}: ${sig}`);
    return sig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${label}: ${msg}`);
    throw err;
  }
}

// ============================================================================
// BOOTSTRAP SERVICE
// ============================================================================

interface BootstrappedMarket {
  slabAddress: string;
  programId: PublicKey;
  mint: string;
  lpSeeded: boolean;
  tradesSeeded: boolean;
  /** Index of the LP account on the slab (used for TradeNoCpi) */
  lpIdx: number;
  /** Indices of bot user accounts on the slab */
  botUserIndices: number[];
  /** Timestamp of last oracle push */
  lastOraclePush: number;
  /** Timestamp of last MM long trade */
  lastMmLong: number;
  /** Timestamp of last MM short trade */
  lastMmShort: number;
  /** Current bot wallet rotation index */
  botRotation: number;
  /** Discovered market data */
  market: DiscoveredMarket;
}

class MarketBootstrapService {
  private connection: Connection;
  private admin: Keypair;
  private bots: Keypair[];
  private knownMarkets = new Map<string, BootstrappedMarket>();
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private oracleTimer: ReturnType<typeof setInterval> | null = null;
  private mmLongTimer: ReturnType<typeof setInterval> | null = null;
  private mmShortTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(connection: Connection, admin: Keypair, bots: Keypair[]) {
    this.connection = connection;
    this.admin = admin;
    this.bots = bots;
  }

  // --------------------------------------------------------------------------
  // DISCOVERY
  // --------------------------------------------------------------------------

  async discover(): Promise<DiscoveredMarket[]> {
    const all: DiscoveredMarket[] = [];
    for (const pid of PROGRAM_IDS) {
      try {
        const found = await discoverMarkets(
          this.connection,
          new PublicKey(pid),
        );
        all.push(...found);
      } catch (err) {
        console.warn(
          `[discover] Failed for ${pid}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return all;
  }

  async checkForNewMarkets(): Promise<void> {
    console.log(`[${ts()}] Scanning for markets...`);
    const markets = await this.discover();
    console.log(`  Found ${markets.length} total markets`);

    for (const market of markets) {
      const key = market.slabAddress.toBase58();
      if (this.knownMarkets.has(key)) continue;

      console.log(`\n${"=".repeat(60)}`);
      console.log(`NEW MARKET DETECTED: ${key}`);
      console.log(`  Program: ${market.programId.toBase58()}`);
      console.log(`  Mint: ${market.config.collateralMint.toBase58()}`);
      console.log(`${"=".repeat(60)}`);

      const entry: BootstrappedMarket = {
        slabAddress: key,
        programId: market.programId,
        mint: market.config.collateralMint.toBase58(),
        lpSeeded: false,
        tradesSeeded: false,
        lpIdx: -1,
        botUserIndices: [],
        lastOraclePush: 0,
        lastMmLong: 0,
        lastMmShort: 0,
        botRotation: 0,
        market,
      };

      this.knownMarkets.set(key, entry);

      // Check if market already has liquidity (vault balance > 0)
      if (market.engine.vault > 0n) {
        console.log(
          `  Market already has vault balance (${market.engine.vault}), skipping LP seed`,
        );
        entry.lpSeeded = true;
        // Still need to set up bot accounts and seed trades
      }

      try {
        await this.bootstrapMarket(entry);
      } catch (err) {
        console.error(
          `  Bootstrap failed for ${key}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // BOOTSTRAP SEQUENCE
  // --------------------------------------------------------------------------

  async bootstrapMarket(entry: BootstrappedMarket): Promise<void> {
    const slab = new PublicKey(entry.slabAddress);
    const mint = new PublicKey(entry.mint);
    const programId = entry.programId;

    // Step 1: Seed LP (if not already seeded)
    if (!entry.lpSeeded) {
      await this.seedLP(entry, slab, mint, programId);
    }

    // Step 2: Set up bot user accounts
    await this.setupBotAccounts(entry, slab, mint, programId);

    // Step 3: Push initial oracle price
    await this.pushOraclePrice(entry);

    // Step 4: Run initial crank
    await this.crankMarket(entry, slab, programId);

    // Step 5: Place seed trades (buy → sell → buy)
    if (!entry.tradesSeeded && entry.botUserIndices.length > 0) {
      await this.seedTrades(entry, slab, programId);
    }

    console.log(`\n  ✓ Market ${entry.slabAddress.slice(0, 12)}... bootstrapped!`);
  }

  async seedLP(
    entry: BootstrappedMarket,
    slab: PublicKey,
    mint: PublicKey,
    programId: PublicKey,
  ): Promise<void> {
    console.log("\n  Step 1: Seeding LP...");

    const adminAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.admin,
      mint,
      this.admin.publicKey,
    );

    const [vaultPda] = deriveVaultAuthority(programId, slab);
    const vaultAta = getAssociatedTokenAddressSync(mint, vaultPda, true);

    // Check if LP is already initialized by looking at the engine state
    // If nextAccountId > 0, there's already at least one account (LP at idx 0)
    const hasLP = entry.market.engine.nextAccountId > 0n;

    if (!hasLP) {
      // InitLP
      const initLpData = encodeInitLP({
        matcherProgram: SystemProgram.programId,
        matcherContext: SystemProgram.programId,
        feePayment: "0",
      });
      const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
        this.admin.publicKey,
        slab,
        adminAta.address,
        vaultAta,
        TOKEN_PROGRAM_ID,
      ]);

      const tx = new Transaction();
      addPriorityFee(tx);
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
      tx.add(buildIx({ programId, keys: initLpKeys, data: initLpData }));
      await sendTx(this.connection, tx, [this.admin], "InitLP");
      entry.lpIdx = 0;
    } else {
      console.log("    LP already initialized, skipping InitLP");
      entry.lpIdx = 0; // LP is always at index 0
    }

    // Deposit collateral to LP
    const depositData = encodeDepositCollateral({
      userIdx: 0,
      amount: LP_SEED_AMOUNT.toString(),
    });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      this.admin.publicKey,
      slab,
      adminAta.address,
      vaultAta,
      TOKEN_PROGRAM_ID,
      SYSVAR_CLOCK_PUBKEY,
    ]);

    const depositTx = new Transaction();
    addPriorityFee(depositTx);
    depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    depositTx.add(
      buildIx({ programId, keys: depositKeys, data: depositData }),
    );
    await sendTx(
      this.connection,
      depositTx,
      [this.admin],
      `DepositCollateral(LP, ${LP_SEED_AMOUNT})`,
    );

    // Top up insurance
    if (INSURANCE_SEED > 0n) {
      const topupData = encodeTopUpInsurance({
        amount: INSURANCE_SEED.toString(),
      });
      const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
        this.admin.publicKey,
        slab,
        adminAta.address,
        vaultAta,
        TOKEN_PROGRAM_ID,
      ]);
      const topupTx = new Transaction();
      addPriorityFee(topupTx);
      topupTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
      topupTx.add(
        buildIx({ programId, keys: topupKeys, data: topupData }),
      );
      await sendTx(
        this.connection,
        topupTx,
        [this.admin],
        `TopUpInsurance(${INSURANCE_SEED})`,
      );
    }

    entry.lpSeeded = true;
    console.log("    LP seeded successfully");
  }

  async setupBotAccounts(
    entry: BootstrappedMarket,
    slab: PublicKey,
    mint: PublicKey,
    programId: PublicKey,
  ): Promise<void> {
    console.log("\n  Step 2: Setting up bot trader accounts...");

    const [vaultPda] = deriveVaultAuthority(programId, slab);
    const vaultAta = getAssociatedTokenAddressSync(mint, vaultPda, true);

    const botIndices: number[] = [];
    // Next account ID tells us the next available index
    let nextIdx = Number(entry.market.engine.nextAccountId);
    // If LP was just created, nextIdx might still be 0; re-query
    if (nextIdx === 0) {
      // After LP init, index 0 is taken → next is 1
      nextIdx = 1;
    }

    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      const botLabel = `Bot${i} (${bot.publicKey.toBase58().slice(0, 8)}...)`;

      try {
        // Get or create bot's ATA for this token
        const botAta = await getOrCreateAssociatedTokenAccount(
          this.connection,
          this.admin, // admin pays for ATA creation
          mint,
          bot.publicKey,
        );

        // InitUser for this bot on the market
        const initUserData = encodeInitUser({ feePayment: "0" });
        const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
          bot.publicKey,
          slab,
          botAta.address,
          vaultAta,
          TOKEN_PROGRAM_ID,
        ]);

        const tx = new Transaction();
        addPriorityFee(tx);
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
        tx.add(
          buildIx({ programId, keys: initUserKeys, data: initUserData }),
        );
        await sendTx(this.connection, tx, [bot], `InitUser(${botLabel})`);

        const userIdx = nextIdx;
        nextIdx++;

        // Deposit some collateral for the bot to trade with
        const depositAmount = LP_SEED_AMOUNT / 5n; // Each bot gets 1/5 of LP seed
        const depositData = encodeDepositCollateral({
          userIdx,
          amount: depositAmount.toString(),
        });
        const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
          bot.publicKey,
          slab,
          botAta.address,
          vaultAta,
          TOKEN_PROGRAM_ID,
          SYSVAR_CLOCK_PUBKEY,
        ]);

        const depositTx = new Transaction();
        addPriorityFee(depositTx);
        depositTx.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
        );
        depositTx.add(
          buildIx({ programId, keys: depositKeys, data: depositData }),
        );
        await sendTx(
          this.connection,
          depositTx,
          [bot],
          `DepositCollateral(${botLabel}, ${depositAmount})`,
        );

        botIndices.push(userIdx);
        console.log(`    ${botLabel} → slab index ${userIdx}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // If "already in use" or similar, the account already exists — try to continue
        if (
          msg.includes("already in use") ||
          msg.includes("Account already exists")
        ) {
          console.log(`    ${botLabel} already exists, skipping`);
          botIndices.push(nextIdx);
          nextIdx++;
        } else {
          console.error(`    Failed to set up ${botLabel}: ${msg}`);
        }
      }
    }

    entry.botUserIndices = botIndices;
    console.log(`    ${botIndices.length} bot accounts ready`);
  }

  // --------------------------------------------------------------------------
  // ORACLE
  // --------------------------------------------------------------------------

  async pushOraclePrice(entry: BootstrappedMarket): Promise<void> {
    const market = entry.market;
    const slab = market.slabAddress;
    const programId = market.programId;

    // Only push prices for admin-oracle markets (oracle authority is set)
    const isAdminOracle = !market.config.oracleAuthority.equals(
      PublicKey.default,
    );
    if (!isAdminOracle) {
      console.log("    Skipping oracle push (not admin oracle)");
      return;
    }

    // Check that we are the oracle authority
    if (!this.admin.publicKey.equals(market.config.oracleAuthority)) {
      console.log("    Skipping oracle push (not oracle authority)");
      return;
    }

    const mint = market.config.collateralMint.toBase58();
    const price = await fetchPrice(mint);

    if (!price) {
      // Fall back to on-chain price if available
      if (market.config.authorityPriceE6 > 0n) {
        console.log(
          `    Using on-chain price: ${market.config.authorityPriceE6}`,
        );
        // Price already pushed, no need to re-push the same
        entry.lastOraclePush = Date.now();
        return;
      }
      console.warn(`    No price source available for ${mint}`);
      return;
    }

    console.log(
      `    Oracle price: $${(Number(price.priceE6) / 1e6).toFixed(4)} (${price.source})`,
    );

    const pushData = encodePushOraclePrice({
      priceE6: price.priceE6,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      this.admin.publicKey,
      slab,
    ]);

    const tx = new Transaction();
    addPriorityFee(tx);
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
    tx.add(buildIx({ programId, keys: pushKeys, data: pushData }));
    await sendTx(this.connection, tx, [this.admin], "PushOraclePrice");
    entry.lastOraclePush = Date.now();
  }

  // --------------------------------------------------------------------------
  // CRANK
  // --------------------------------------------------------------------------

  async crankMarket(
    entry: BootstrappedMarket,
    slab: PublicKey,
    programId: PublicKey,
  ): Promise<void> {
    const market = entry.market;
    const isAdminOracle = !market.config.oracleAuthority.equals(
      PublicKey.default,
    );

    let oracleKey: PublicKey;
    if (isAdminOracle) {
      oracleKey = slab; // admin oracle: slab IS the oracle
    } else {
      const feedHex = Array.from(market.config.indexFeedId.toBytes())
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      oracleKey = derivePythPushOraclePDA(feedHex)[0];
    }

    const crankData = encodeKeeperCrank({
      callerIdx: 65535,
      allowPanic: false,
    });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      this.admin.publicKey,
      slab,
      SYSVAR_CLOCK_PUBKEY,
      oracleKey,
    ]);

    const tx = new Transaction();
    addPriorityFee(tx);
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
    tx.add(buildIx({ programId, keys: crankKeys, data: crankData }));
    await sendTx(this.connection, tx, [this.admin], "KeeperCrank");
  }

  // --------------------------------------------------------------------------
  // SEED TRADES
  // --------------------------------------------------------------------------

  async seedTrades(
    entry: BootstrappedMarket,
    slab: PublicKey,
    programId: PublicKey,
  ): Promise<void> {
    console.log("\n  Step 5: Placing seed trades...");

    if (entry.botUserIndices.length === 0) {
      console.log("    No bot accounts available, skipping seed trades");
      return;
    }

    const market = entry.market;
    const isAdminOracle = !market.config.oracleAuthority.equals(
      PublicKey.default,
    );
    let oracleKey: PublicKey;
    if (isAdminOracle) {
      oracleKey = slab;
    } else {
      const feedHex = Array.from(market.config.indexFeedId.toBytes())
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      oracleKey = derivePythPushOraclePDA(feedHex)[0];
    }

    // Trade pattern: BUY → SELL → BUY (creates chart history)
    const trades = [
      { size: SEED_TRADE_SIZE, label: "Seed BUY #1" },
      { size: -SEED_TRADE_SIZE, label: "Seed SELL #1" },
      { size: SEED_TRADE_SIZE / 2n, label: "Seed BUY #2" },
    ];

    for (let i = 0; i < trades.length; i++) {
      const trade = trades[i];
      const botIdx = i % entry.botUserIndices.length;
      const userIdx = entry.botUserIndices[botIdx];
      const bot = this.bots[botIdx % this.bots.length];

      try {
        const tradeData = encodeTradeNoCpi({
          lpIdx: entry.lpIdx,
          userIdx,
          size: trade.size.toString(),
        });

        // TradeNoCpi requires both user AND lp as signers
        const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
          bot.publicKey,        // user (signer)
          this.admin.publicKey, // LP owner (signer)
          slab,
          oracleKey,
        ]);

        const tx = new Transaction();
        addPriorityFee(tx);
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
        tx.add(buildIx({ programId, keys: tradeKeys, data: tradeData }));
        await sendTx(
          this.connection,
          tx,
          [bot, this.admin],
          trade.label,
        );

        // Crank between trades to update state
        await this.crankMarket(entry, slab, programId);

        // Small delay between trades
        await sleep(2_000);
      } catch (err) {
        console.error(
          `    ${trade.label} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    entry.tradesSeeded = true;
    console.log("    Seed trades complete");
  }

  // --------------------------------------------------------------------------
  // MARKET MAKER
  // --------------------------------------------------------------------------

  async runMarketMakerCycle(direction: "long" | "short"): Promise<void> {
    for (const [, entry] of this.knownMarkets) {
      if (entry.botUserIndices.length === 0) continue;

      const slab = new PublicKey(entry.slabAddress);
      const programId = entry.programId;
      const market = entry.market;

      const isAdminOracle = !market.config.oracleAuthority.equals(
        PublicKey.default,
      );
      let oracleKey: PublicKey;
      if (isAdminOracle) {
        oracleKey = slab;
      } else {
        const feedHex = Array.from(market.config.indexFeedId.toBytes())
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        oracleKey = derivePythPushOraclePDA(feedHex)[0];
      }

      // Rotate through bot wallets
      const botIdx = entry.botRotation % this.bots.length;
      const userSlabIdx =
        entry.botUserIndices[botIdx % entry.botUserIndices.length];
      const bot = this.bots[botIdx];
      entry.botRotation++;

      const size = direction === "long" ? MM_TRADE_SIZE : -MM_TRADE_SIZE;

      try {
        const tradeData = encodeTradeNoCpi({
          lpIdx: entry.lpIdx,
          userIdx: userSlabIdx,
          size: size.toString(),
        });
        const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
          bot.publicKey,
          this.admin.publicKey,
          slab,
          oracleKey,
        ]);

        const tx = new Transaction();
        addPriorityFee(tx);
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
        tx.add(buildIx({ programId, keys: tradeKeys, data: tradeData }));
        await sendTx(
          this.connection,
          tx,
          [bot, this.admin],
          `MM-${direction}(${entry.slabAddress.slice(0, 8)}...)`,
        );
      } catch (err) {
        // Silently handle position limit errors — just close and retry next cycle
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("position") || msg.includes("margin")) {
          console.log(
            `    MM ${direction}: position limit hit, will reverse next cycle`,
          );
        }
      }
    }
  }

  async runOraclePushCycle(): Promise<void> {
    for (const [, entry] of this.knownMarkets) {
      const now = Date.now();
      if (now - entry.lastOraclePush < ORACLE_PUSH_INTERVAL) continue;
      try {
        await this.pushOraclePrice(entry);
      } catch (err) {
        // Non-fatal
      }
    }
  }

  // --------------------------------------------------------------------------
  // LIFECYCLE
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    console.log("\n" + "=".repeat(70));
    console.log("PERCOLATOR MARKET BOOTSTRAP SERVICE");
    console.log("=".repeat(70));
    console.log(`  RPC: ${RPC_URL.replace(/api-key=.*/, "api-key=***")}`);
    console.log(`  Programs: ${PROGRAM_IDS.join(", ")}`);
    console.log(`  Admin: ${this.admin.publicKey.toBase58()}`);
    console.log(
      `  Bots: ${this.bots.map((b) => b.publicKey.toBase58().slice(0, 12) + "...").join(", ")}`,
    );
    console.log(`  LP Seed: ${LP_SEED_AMOUNT}`);
    console.log(`  Insurance Seed: ${INSURANCE_SEED}`);
    console.log(`  Seed Trade Size: ${SEED_TRADE_SIZE}`);
    console.log(`  MM Trade Size: ${MM_TRADE_SIZE}`);
    console.log(`  Mode: ${DRY_RUN ? "DRY-RUN" : ONCE ? "ONCE" : "CONTINUOUS"}`);
    console.log("=".repeat(70));

    // Initial discovery + bootstrap
    await this.checkForNewMarkets();

    if (ONCE) {
      console.log("\n[--once] Bootstrap complete, exiting.");
      return;
    }

    this.isRunning = true;

    // Periodic discovery
    this.discoveryTimer = setInterval(async () => {
      try {
        await this.checkForNewMarkets();
      } catch (err) {
        console.error("[discovery]", err);
      }
    }, DISCOVERY_INTERVAL);

    // Oracle price pusher
    this.oracleTimer = setInterval(async () => {
      try {
        await this.runOraclePushCycle();
      } catch (err) {
        console.error("[oracle]", err);
      }
    }, ORACLE_PUSH_INTERVAL);

    // Market maker — longs
    this.mmLongTimer = setInterval(async () => {
      try {
        await this.runMarketMakerCycle("long");
      } catch (err) {
        console.error("[mm-long]", err);
      }
    }, MM_LONG_INTERVAL);

    // Market maker — shorts
    this.mmShortTimer = setInterval(async () => {
      try {
        await this.runMarketMakerCycle("short");
      } catch (err) {
        console.error("[mm-short]", err);
      }
    }, MM_SHORT_INTERVAL);

    console.log("\nBootstrap service running. Press Ctrl+C to stop.");
  }

  stop(): void {
    this.isRunning = false;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.oracleTimer) clearInterval(this.oracleTimer);
    if (this.mmLongTimer) clearInterval(this.mmLongTimer);
    if (this.mmShortTimer) clearInterval(this.mmShortTimer);
    console.log("\nBootstrap service stopped.");
  }

  /** Returns documented public keys for all bot wallets */
  getWalletInfo(): string[] {
    return this.bots.map(
      (b, i) => `Bot${i}: ${b.publicKey.toBase58()}`,
    );
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const admin = loadAdminKeypair();
  const bots = loadBotKeypairs();
  const connection = new Connection(RPC_URL, "confirmed");

  // Verify admin has SOL
  const balance = await connection.getBalance(admin.publicKey);
  console.log(
    `Admin balance: ${(balance / 1e9).toFixed(4)} SOL`,
  );
  if (balance < 0.1e9) {
    console.error("Admin wallet needs at least 0.1 SOL. Fund it first.");
    process.exit(1);
  }

  const service = new MarketBootstrapService(connection, admin, bots);

  // Print bot wallet info for documentation
  console.log("\nBot Wallets:");
  for (const info of service.getWalletInfo()) {
    console.log(`  ${info}`);
  }

  // Graceful shutdown
  const shutdown = () => {
    service.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await service.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

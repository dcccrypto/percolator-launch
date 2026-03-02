/**
 * PERC-355: Market Bootstrap Service
 *
 * Automatically bootstraps new devnet markets with liquidity, trades, and oracle prices.
 * Run: BOOTSTRAP_KEYPAIR=/path/to/keypair.json npx tsx scripts/market-bootstrap.ts
 *
 * Components:
 * 1. Market Watcher — polls Supabase for new unbootstrapped markets
 * 2. Auto-LP Seed — deposits initial liquidity from protocol wallet
 * 3. Market Maker — places rotating buy/sell trades to generate volume
 * 4. Oracle Price Pusher — feeds prices from CoinGecko for stale oracles
 * 5. Seed Trades — places initial trades to populate chart
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
  encodeInitLP,
  encodeInitUser,
  encodeDepositCollateral,
  encodeTradeCpi,
  encodeKeeperCrank,
  encodePushOraclePrice,
  encodeSetOracleAuthority,
  encodeTopUpInsurance,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_TOPUP_INSURANCE,
  buildAccountMetas,
  buildIx,
  getAta,
  deriveVaultAuthority,
  deriveLpPda,
  WELL_KNOWN,
  parseConfig,
  parseEngine,
  parseAllAccounts,
  parseHeader,
  discoverMarkets,
  type DiscoveredMarket,
} from "../packages/core/src/index.js";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const RPC_URL = process.env.RPC_URL ?? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ""}`;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

// Protocol wallet for LP seeding and market making
const BOOTSTRAP_KP_PATH = process.env.BOOTSTRAP_KEYPAIR ?? "/tmp/bootstrap-wallet.json";
// Additional market maker wallets (optional, comma-separated paths)
const MM_WALLET_PATHS = (process.env.MM_WALLETS ?? "").split(",").filter(Boolean);

// Program IDs from environment or defaults
import { getProgramId } from "../packages/core/src/config/program-ids.js";
const PROGRAM_ID = getProgramId("devnet");

// Amounts
const LP_SEED_AMOUNT = BigInt(process.env.LP_SEED_AMOUNT ?? "50000000"); // 50 USDC (6 decimals)
const INSURANCE_SEED = BigInt(process.env.INSURANCE_SEED ?? "10000000"); // 10 USDC
const TRADE_SIZE = BigInt(process.env.TRADE_SIZE ?? "1000000");          // 1 USDC per trade
const MM_TRADE_SIZE = BigInt(process.env.MM_TRADE_SIZE ?? "500000");     // 0.5 USDC per MM trade

// Timing
const POLL_INTERVAL_MS = 30_000;        // Check for new markets every 30s
const MM_LONG_INTERVAL_MS = 60_000;     // Market maker long every 60s
const MM_SHORT_INTERVAL_MS = 75_000;    // Market maker short every 75s
const ORACLE_PUSH_INTERVAL_MS = 10_000; // Push oracle prices every 10s

// Matcher (vAMM)
const MATCHER_ID = new PublicKey(process.env.MATCHER_ID ?? "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k");

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const connection = new Connection(RPC_URL, "confirmed");
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let bootstrapWallet: Keypair;
let mmWallets: Keypair[] = [];

function log(component: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${component}] ${msg}`);
}

async function sendTx(
  ixs: any[],
  signers: Keypair[],
  computeUnits = 400_000,
): Promise<string> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  for (const ix of ixs) tx.add(ix);
  return sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
    skipPreflight: true,
  });
}

// ═══════════════════════════════════════════════════════════════
// 1. Market Watcher
// ═══════════════════════════════════════════════════════════════

interface MarketRecord {
  slab_address: string;
  mint_address: string;
  symbol: string | null;
  status: string | null;
  bootstrapped: boolean | null;
  oracle_authority: string | null;
}

async function getUnbootstrappedMarkets(): Promise<MarketRecord[]> {
  const { data, error } = await supabase
    .from("markets")
    .select("slab_address, mint_address, symbol, status, bootstrapped, oracle_authority")
    .or("bootstrapped.is.null,bootstrapped.eq.false")
    .eq("status", "active");

  if (error) {
    log("watcher", `Supabase error: ${error.message}`);
    return [];
  }
  return (data ?? []) as MarketRecord[];
}

// ═══════════════════════════════════════════════════════════════
// 2. Auto-LP Seed
// ═══════════════════════════════════════════════════════════════

async function seedLP(
  slabAddress: PublicKey,
  mint: PublicKey,
  wallet: Keypair,
): Promise<boolean> {
  try {
    const walletAta = await getAta(wallet.publicKey, mint);
    const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabAddress);
    const vaultAta = await getAta(vaultPda, mint, true);

    // Init LP account
    const initLpData = encodeInitLP({
      matcherProgram: MATCHER_ID,
      matcherContext: PublicKey.default, // Use zero key — vAMM doesn't need a context account
      feePayment: "1000000",
    });
    const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
      wallet.publicKey, slabAddress, walletAta, vaultAta, WELL_KNOWN.tokenProgram,
    ]);
    const initLpIx = buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData });

    // Deposit LP collateral
    const depositData = encodeDepositCollateral({ userIdx: 0, amount: LP_SEED_AMOUNT.toString() });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      wallet.publicKey, slabAddress, walletAta, vaultAta, WELL_KNOWN.tokenProgram, SYSVAR_CLOCK_PUBKEY,
    ]);
    const depositIx = buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData });

    // Top up insurance
    const insData = encodeTopUpInsurance({ amount: INSURANCE_SEED.toString() });
    const insKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
      wallet.publicKey, slabAddress, walletAta, vaultAta, WELL_KNOWN.tokenProgram,
    ]);
    const insIx = buildIx({ programId: PROGRAM_ID, keys: insKeys, data: insData });

    const sig = await sendTx([initLpIx, depositIx, insIx], [wallet]);
    log("lp-seed", `✅ LP seeded for ${slabAddress.toBase58().slice(0, 8)}... — sig: ${sig.slice(0, 16)}...`);
    return true;
  } catch (e: any) {
    log("lp-seed", `❌ Failed for ${slabAddress.toBase58().slice(0, 8)}...: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. Oracle Price Pusher
// ═══════════════════════════════════════════════════════════════

async function fetchCoinGeckoPrice(symbol: string): Promise<number | null> {
  // Map common symbols to CoinGecko IDs
  const symbolMap: Record<string, string> = {
    SOL: "solana",
    BTC: "bitcoin",
    ETH: "ethereum",
    BONK: "bonk",
    JUP: "jupiter-exchange-solana",
    WIF: "dogwifcoin",
    PYTH: "pyth-network",
    RNDR: "render-token",
    RAY: "raydium",
    JTO: "jito-governance-token",
  };

  const id = symbolMap[symbol.toUpperCase()];
  if (!id) return null;

  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(5000) },
    );
    const json = await resp.json();
    return json[id]?.usd ?? null;
  } catch {
    return null;
  }
}

async function pushOraclePrice(
  slabAddress: PublicKey,
  wallet: Keypair,
  priceUsd: number,
): Promise<boolean> {
  try {
    const priceE6 = BigInt(Math.round(priceUsd * 1_000_000));
    const timestamp = BigInt(Math.floor(Date.now() / 1000));

    const pushData = encodePushOraclePrice({ priceE6, timestamp });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      wallet.publicKey, slabAddress,
    ]);
    const pushIx = buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData });

    // Also crank to apply the price
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      wallet.publicKey, slabAddress, SYSVAR_CLOCK_PUBKEY, slabAddress,
    ]);
    const crankIx = buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData });

    await sendTx([pushIx, crankIx], [wallet], 200_000);
    return true;
  } catch (e: any) {
    log("oracle", `❌ Push failed for ${slabAddress.toBase58().slice(0, 8)}...: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. Seed Trades
// ═══════════════════════════════════════════════════════════════

async function placeSeedTrades(
  slabAddress: PublicKey,
  mint: PublicKey,
  wallet: Keypair,
): Promise<boolean> {
  try {
    const walletAta = await getAta(wallet.publicKey, mint);
    const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabAddress);
    const vaultAta = await getAta(vaultPda, mint, true);

    // Init user account
    const initUserData = encodeInitUser({ feePayment: "1000000" });
    const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      wallet.publicKey, slabAddress, walletAta, vaultAta, WELL_KNOWN.tokenProgram,
    ]);
    const initUserIx = buildIx({ programId: PROGRAM_ID, keys: initUserKeys, data: initUserData });

    // Deposit collateral for trading
    const tradingCollateral = (TRADE_SIZE * 10n).toString(); // 10x trade size for margin
    const depositData = encodeDepositCollateral({ userIdx: 1, amount: tradingCollateral });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      wallet.publicKey, slabAddress, walletAta, vaultAta, WELL_KNOWN.tokenProgram, SYSVAR_CLOCK_PUBKEY,
    ]);
    const depositIx = buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData });

    const sig1 = await sendTx([initUserIx, depositIx], [wallet]);
    log("seed-trades", `User init + deposit: ${sig1.slice(0, 16)}...`);

    // Read on-chain state to find LP account for trades
    const slabData = await connection.getAccountInfo(slabAddress);
    if (!slabData) throw new Error("Slab not found");
    const accounts = parseAllAccounts(slabData.data);
    const lpAccount = accounts.find((a) => a.account.kind === 1);
    if (!lpAccount) throw new Error("No LP account found");
    const userAccount = accounts.find((a) => a.account.kind !== 1 && a.account.owner.equals(wallet.publicKey));
    if (!userAccount) throw new Error("User account not found");

    const [lpPda] = deriveLpPda(PROGRAM_ID, slabAddress, lpAccount.idx);

    // Place 3 seed trades: buy, sell, buy
    const trades = [
      { size: TRADE_SIZE.toString(), label: "buy" },
      { size: (-TRADE_SIZE).toString(), label: "sell" }, // negative = short
      { size: (TRADE_SIZE / 2n).toString(), label: "buy-small" },
    ];

    for (const trade of trades) {
      // Crank first
      const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
      const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        wallet.publicKey, slabAddress, SYSVAR_CLOCK_PUBKEY, slabAddress,
      ]);
      const crankIx = buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData });

      const tradeData = encodeTradeCpi({
        lpIdx: lpAccount.idx,
        userIdx: userAccount.idx,
        size: trade.size,
      });
      const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
        wallet.publicKey,
        lpAccount.account.owner,
        slabAddress,
        slabAddress, // oracle = slab for admin oracle (Hyperp mode)
        lpAccount.account.matcherProgram,
        lpAccount.account.matcherContext,
        lpPda,
      ]);
      const tradeIx = buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData });

      const sig = await sendTx([crankIx, tradeIx], [wallet], 600_000);
      log("seed-trades", `✅ ${trade.label}: ${sig.slice(0, 16)}...`);

      // Brief pause between trades
      await new Promise((r) => setTimeout(r, 2000));
    }

    return true;
  } catch (e: any) {
    log("seed-trades", `❌ Failed: ${e.message?.slice(0, 120)}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. Market Maker Bot
// ═══════════════════════════════════════════════════════════════

interface ActiveMarket {
  slabAddress: PublicKey;
  mint: PublicKey;
  symbol: string;
  lpIdx: number;
  userIdx: number;
  lpOwner: PublicKey;
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
}

const activeMarkets: Map<string, ActiveMarket> = new Map();
let mmWalletIdx = 0;

function getNextMmWallet(): Keypair {
  const wallets = mmWallets.length > 0 ? mmWallets : [bootstrapWallet];
  const wallet = wallets[mmWalletIdx % wallets.length];
  mmWalletIdx++;
  return wallet;
}

async function mmTrade(market: ActiveMarket, isLong: boolean): Promise<void> {
  const wallet = getNextMmWallet();
  const size = isLong ? MM_TRADE_SIZE.toString() : (-MM_TRADE_SIZE).toString();

  try {
    const [lpPda] = deriveLpPda(PROGRAM_ID, market.slabAddress, market.lpIdx);

    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      wallet.publicKey, market.slabAddress, SYSVAR_CLOCK_PUBKEY, market.slabAddress,
    ]);
    const crankIx = buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData });

    const tradeData = encodeTradeCpi({
      lpIdx: market.lpIdx,
      userIdx: market.userIdx,
      size,
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      wallet.publicKey,
      market.lpOwner,
      market.slabAddress,
      market.slabAddress,
      market.matcherProgram,
      market.matcherContext,
      lpPda,
    ]);
    const tradeIx = buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData });

    await sendTx([crankIx, tradeIx], [wallet], 600_000);
    log("mm", `${isLong ? "LONG" : "SHORT"} ${market.symbol} — wallet ${wallet.publicKey.toBase58().slice(0, 8)}...`);
  } catch (e: any) {
    // Position limit or other expected errors — just skip
    log("mm", `Skip ${market.symbol} ${isLong ? "LONG" : "SHORT"}: ${e.message?.slice(0, 60)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Bootstrap Orchestrator
// ═══════════════════════════════════════════════════════════════

async function bootstrapMarket(market: MarketRecord): Promise<void> {
  const slabPk = new PublicKey(market.slab_address);
  const mintPk = new PublicKey(market.mint_address);
  const symbol = market.symbol ?? market.mint_address.slice(0, 6);

  log("bootstrap", `🚀 Bootstrapping ${symbol} (${market.slab_address.slice(0, 8)}...)`);

  // 1. Set oracle authority (if we're admin) and push initial price
  const isHyperp = !market.oracle_authority || market.oracle_authority === "";
  if (isHyperp) {
    // Try to set ourselves as oracle authority
    try {
      const setAuthData = encodeSetOracleAuthority({ newAuthority: bootstrapWallet.publicKey });
      const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
        bootstrapWallet.publicKey, slabPk,
      ]);
      const setAuthIx = buildIx({ programId: PROGRAM_ID, keys: setAuthKeys, data: setAuthData });
      await sendTx([setAuthIx], [bootstrapWallet], 200_000);
      log("oracle", `Set oracle authority for ${symbol}`);
    } catch {
      log("oracle", `Could not set oracle authority for ${symbol} (not admin?)`);
    }
  }

  // Push initial price
  const price = (await fetchCoinGeckoPrice(symbol)) ?? 1.0; // Default $1 for unknown tokens
  await pushOraclePrice(slabPk, bootstrapWallet, price);
  log("oracle", `Pushed price $${price} for ${symbol}`);

  // 2. Seed LP
  const lpOk = await seedLP(slabPk, mintPk, bootstrapWallet);

  // 3. Seed trades (only if LP succeeded)
  if (lpOk) {
    await placeSeedTrades(slabPk, mintPk, bootstrapWallet);
  }

  // 4. Mark as bootstrapped in Supabase
  const { error } = await supabase
    .from("markets")
    .update({ bootstrapped: true })
    .eq("slab_address", market.slab_address);

  if (error) {
    log("bootstrap", `Failed to mark bootstrapped: ${error.message}`);
  } else {
    log("bootstrap", `✅ ${symbol} fully bootstrapped`);
  }

  // 5. Register for market making
  if (lpOk) {
    try {
      const slabData = await connection.getAccountInfo(slabPk);
      if (slabData) {
        const accounts = parseAllAccounts(slabData.data);
        const lp = accounts.find((a) => a.account.kind === 1);
        const user = accounts.find((a) => a.account.kind !== 1 && a.account.owner.equals(bootstrapWallet.publicKey));
        if (lp && user) {
          activeMarkets.set(market.slab_address, {
            slabAddress: slabPk,
            mint: mintPk,
            symbol,
            lpIdx: lp.idx,
            userIdx: user.idx,
            lpOwner: lp.account.owner,
            matcherProgram: lp.account.matcherProgram,
            matcherContext: lp.account.matcherContext,
          });
        }
      }
    } catch (e: any) {
      log("bootstrap", `Could not register for MM: ${e.message?.slice(0, 60)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Main Loop
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  PERC-355: Market Bootstrap Service");
  console.log("═══════════════════════════════════════════════════");

  // Load wallets
  try {
    bootstrapWallet = loadKeypair(BOOTSTRAP_KP_PATH);
    log("init", `Bootstrap wallet: ${bootstrapWallet.publicKey.toBase58()}`);
  } catch {
    console.error(`❌ Cannot load bootstrap wallet from ${BOOTSTRAP_KP_PATH}`);
    console.error("Set BOOTSTRAP_KEYPAIR=/path/to/keypair.json");
    process.exit(1);
  }

  for (const path of MM_WALLET_PATHS) {
    try {
      mmWallets.push(loadKeypair(path.trim()));
    } catch (e) {
      log("init", `⚠ Could not load MM wallet: ${path}`);
    }
  }
  log("init", `Loaded ${mmWallets.length} additional MM wallets`);

  const balance = await connection.getBalance(bootstrapWallet.publicKey);
  log("init", `SOL balance: ${(balance / 1e9).toFixed(4)}`);

  // Initial scan for unbootstrapped markets
  log("watcher", "Scanning for unbootstrapped markets...");
  const markets = await getUnbootstrappedMarkets();
  log("watcher", `Found ${markets.length} unbootstrapped market(s)`);

  for (const market of markets) {
    await bootstrapMarket(market);
  }

  // Start polling loop for new markets
  log("watcher", `Polling every ${POLL_INTERVAL_MS / 1000}s for new markets...`);
  setInterval(async () => {
    try {
      const newMarkets = await getUnbootstrappedMarkets();
      for (const market of newMarkets) {
        if (!activeMarkets.has(market.slab_address)) {
          await bootstrapMarket(market);
        }
      }
    } catch (e: any) {
      log("watcher", `Poll error: ${e.message?.slice(0, 80)}`);
    }
  }, POLL_INTERVAL_MS);

  // Start market maker loops
  log("mm", "Starting market maker...");

  // Long trades every 60s
  setInterval(async () => {
    for (const market of activeMarkets.values()) {
      await mmTrade(market, true);
    }
  }, MM_LONG_INTERVAL_MS);

  // Short trades every 75s
  setInterval(async () => {
    for (const market of activeMarkets.values()) {
      await mmTrade(market, false);
    }
  }, MM_SHORT_INTERVAL_MS);

  // Oracle price pusher every 10s (for admin oracle markets)
  setInterval(async () => {
    for (const market of activeMarkets.values()) {
      const price = await fetchCoinGeckoPrice(market.symbol);
      if (price) {
        await pushOraclePrice(market.slabAddress, bootstrapWallet, price);
      }
    }
  }, ORACLE_PUSH_INTERVAL_MS);

  log("init", "✅ Bootstrap service running. Press Ctrl+C to stop.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});

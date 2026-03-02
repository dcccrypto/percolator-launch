/**
 * PERC-364: Floating Market Maker Bot
 *
 * Oracle-anchored two-sided market maker for Percolator devnet markets.
 * Inspired by Drift's FloatingMaker — quotes bid/ask around oracle price
 * with position-aware skewing and configurable risk limits.
 *
 * Usage:
 *   BOOTSTRAP_KEYPAIR=/path/to/keypair.json npx tsx scripts/floating-maker.ts
 *
 * Environment variables:
 *   BOOTSTRAP_KEYPAIR     — Path to market maker keypair JSON (required)
 *   RPC_URL               — Solana RPC URL (default: devnet via Helius)
 *   HELIUS_API_KEY        — Helius API key for devnet RPC
 *   SPREAD_BPS            — Half-spread in basis points (default: 30 = 0.30%)
 *   MAX_QUOTE_SIZE_USDC   — Max quote size in USDC (default: 500)
 *   MAX_POSITION_PCT      — Max position as % of collateral (default: 10)
 *   QUOTE_INTERVAL_MS     — Re-quote interval in ms (default: 5000)
 *   COOLDOWN_SLOTS        — Min slots between market updates (default: 30)
 *   DRY_RUN               — Set to "true" for simulation only
 *   MARKETS_FILTER        — Comma-separated market symbols to trade (default: all)
 *   SUPABASE_URL          — Supabase URL for market discovery (optional, falls back to on-chain)
 *   SUPABASE_KEY          — Supabase key (optional)
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
  encodeInitUser,
  encodeInitLP,
  encodeDepositCollateral,
  encodeTradeCpi,
  encodeKeeperCrank,
  encodePushOraclePrice,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  buildAccountMetas,
  buildIx,
  getAta,
  deriveVaultAuthority,
  deriveLpPda,
  WELL_KNOWN,
  parseHeader,
  parseConfig,
  parseAllAccounts,
  discoverMarkets,
  type DiscoveredMarket,
} from "../packages/core/src/index.js";
import { getProgramId } from "../packages/core/src/config/program-ids.js";
import * as fs from "fs";

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const RPC_URL =
  process.env.RPC_URL ??
  `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ""}`;
const PROGRAM_ID = getProgramId("devnet");
const MATCHER_ID = new PublicKey(
  process.env.MATCHER_ID ?? "GTRgyTDfrMvBubALAqtHuQwT8tbGyXid7svXZKtWfC9k",
);

// Market maker config
const SPREAD_BPS = Number(process.env.SPREAD_BPS ?? "30"); // 0.30% half-spread
const MAX_QUOTE_SIZE = BigInt(
  process.env.MAX_QUOTE_SIZE_USDC ?? "500",
) * 1_000_000n; // Convert to 6-decimal USDC
const MAX_POSITION_PCT = Number(process.env.MAX_POSITION_PCT ?? "10"); // 10% of collateral
const QUOTE_INTERVAL_MS = Number(process.env.QUOTE_INTERVAL_MS ?? "5000");
const COOLDOWN_SLOTS = Number(process.env.COOLDOWN_SLOTS ?? "30");
const DRY_RUN = process.env.DRY_RUN === "true";
const MARKETS_FILTER = process.env.MARKETS_FILTER
  ? process.env.MARKETS_FILTER.split(",").map((s) => s.trim().toUpperCase())
  : null;

// Position skewing: as position grows, skew quotes to reduce exposure
// At MAX_POSITION_PCT, the risky side spread multiplier = SKEW_MAX_MULTIPLIER
const SKEW_MAX_MULTIPLIER = 3.0;

// Collateral to deposit per market if user account has none
const INITIAL_COLLATERAL = BigInt(
  process.env.INITIAL_COLLATERAL ?? "10000000000",
); // 10,000 USDC (6 decimals)

// Keypair path
const KP_PATH = process.env.BOOTSTRAP_KEYPAIR ?? "/tmp/bootstrap-wallet.json";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface ManagedMarket {
  slabAddress: PublicKey;
  mint: PublicKey;
  symbol: string;
  /** LP account index in the slab */
  lpIdx: number;
  /** User (taker) account index in the slab */
  userIdx: number;
  /** LP account owner pubkey */
  lpOwner: PublicKey;
  /** Matcher program for TradeCpi */
  matcherProgram: PublicKey;
  /** Matcher context for TradeCpi */
  matcherContext: PublicKey;
  /** Last slot we updated quotes */
  lastQuoteSlot: number;
  /** Current position size (signed: positive = long, negative = short) */
  positionSize: bigint;
  /** Collateral deposited */
  collateral: bigint;
  /** Last oracle price (e6 format) */
  lastOraclePrice: bigint;
  /** Oracle price source (authority-push or pyth) */
  oracleMode: "authority" | "pyth";
}

interface PriceSource {
  symbol: string;
  priceUsd: number;
  source: string;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════════════

function log(component: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${component}] ${msg}`);
}

function logQuote(
  symbol: string,
  side: "BID" | "ASK",
  price: number,
  size: bigint,
  skew: number,
) {
  const sizeUsd = Number(size) / 1_000_000;
  log(
    "quote",
    `${symbol} ${side} @ $${price.toFixed(4)} | size: $${sizeUsd.toFixed(2)} | skew: ${(skew * 100).toFixed(1)}%`,
  );
}

// ═══════════════════════════════════════════════════════════════
// Wallet & Connection
// ═══════════════════════════════════════════════════════════════

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const connection = new Connection(RPC_URL, "confirmed");
let makerWallet: Keypair;

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
// Price Feeds
// ═══════════════════════════════════════════════════════════════

const COINGECKO_MAP: Record<string, string> = {
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

const BINANCE_MAP: Record<string, string> = {
  SOL: "SOLUSDT",
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  BONK: "BONKUSDT",
  WIF: "WIFUSDT",
  JUP: "JUPUSDT",
  PYTH: "PYTHUSDT",
  RAY: "RAYUSDT",
  JTO: "JTOUSDT",
};

/** Fetch price from Binance (preferred — fastest, most reliable). */
async function fetchBinancePrice(symbol: string): Promise<number | null> {
  const pair = BINANCE_MAP[symbol.toUpperCase()];
  if (!pair) return null;
  try {
    const resp = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as { price?: string };
    return json.price ? parseFloat(json.price) : null;
  } catch {
    return null;
  }
}

/** Fetch price from CoinGecko (fallback). */
async function fetchCoinGeckoPrice(symbol: string): Promise<number | null> {
  const id = COINGECKO_MAP[symbol.toUpperCase()];
  if (!id) return null;
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(5000) },
    );
    const json = (await resp.json()) as Record<string, { usd?: number }>;
    return json[id]?.usd ?? null;
  } catch {
    return null;
  }
}

/** Multi-source price fetch with fallback chain: Binance → CoinGecko. */
async function fetchPrice(symbol: string): Promise<PriceSource | null> {
  // Try Binance first
  const binPrice = await fetchBinancePrice(symbol);
  if (binPrice !== null) {
    return {
      symbol,
      priceUsd: binPrice,
      source: "binance",
      timestamp: Date.now(),
    };
  }

  // Fallback to CoinGecko
  const cgPrice = await fetchCoinGeckoPrice(symbol);
  if (cgPrice !== null) {
    return {
      symbol,
      priceUsd: cgPrice,
      source: "coingecko",
      timestamp: Date.now(),
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Market Discovery & Setup
// ═══════════════════════════════════════════════════════════════

/** Infer symbol from on-chain market config (best-effort). */
function inferSymbol(market: DiscoveredMarket): string {
  // Try to match against known Pyth feed IDs
  const feedHex = Buffer.from(market.config.indexFeedId).toString("hex");
  const KNOWN_FEEDS: Record<string, string> = {
    // Pyth SOL/USD (mainnet) — ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
    ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d: "SOL",
    // Pyth BTC/USD (mainnet) — e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
    e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43: "BTC",
    // Pyth ETH/USD (mainnet)
    ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace: "ETH",
  };

  if (KNOWN_FEEDS[feedHex]) return KNOWN_FEEDS[feedHex];

  // Zero feed ID = Hyperp mode (admin-pushed oracle)
  const isHyperp = feedHex === "0".repeat(64);
  if (isHyperp) {
    // Use mark price to guess the asset
    const markE6 = market.engine.lastOraclePrice ?? 0n;
    const markUsd = Number(markE6) / 1_000_000;
    if (markUsd > 50_000) return "BTC";
    if (markUsd > 2_000) return "ETH";
    if (markUsd > 50) return "SOL";
    return "UNKNOWN";
  }

  return "UNKNOWN";
}

/** Discover markets on-chain and set up accounts. */
async function discoverAndSetupMarkets(): Promise<ManagedMarket[]> {
  log("discovery", `Scanning for markets on program ${PROGRAM_ID.toBase58().slice(0, 8)}...`);

  const discovered = await discoverMarkets(connection, PROGRAM_ID);
  log("discovery", `Found ${discovered.length} market(s) on-chain`);

  const managedMarkets: ManagedMarket[] = [];

  for (const market of discovered) {
    const symbol = inferSymbol(market);
    if (MARKETS_FILTER && !MARKETS_FILTER.includes(symbol)) {
      log("discovery", `Skipping ${symbol} (${market.slabAddress.toBase58().slice(0, 8)}...) — not in filter`);
      continue;
    }

    // Check if market is paused or resolved
    if (market.header.resolved) {
      log("discovery", `Skipping ${symbol} — market resolved`);
      continue;
    }
    if (market.header.paused) {
      log("discovery", `Skipping ${symbol} — market paused`);
      continue;
    }

    log("discovery", `Setting up ${symbol} (${market.slabAddress.toBase58().slice(0, 8)}...)`);

    try {
      const managed = await setupMarket(market, symbol);
      if (managed) {
        managedMarkets.push(managed);
        log("discovery", `✅ ${symbol} ready — LP idx: ${managed.lpIdx}, User idx: ${managed.userIdx}`);
      }
    } catch (e: any) {
      log("discovery", `❌ Failed to setup ${symbol}: ${e.message?.slice(0, 100)}`);
    }
  }

  return managedMarkets;
}

/** Set up LP + User accounts on a market, or discover existing ones. */
async function setupMarket(
  market: DiscoveredMarket,
  symbol: string,
): Promise<ManagedMarket | null> {
  const slabAddress = market.slabAddress;
  const mint = market.config.collateralMint;

  // Fetch full slab data to find existing accounts
  const slabInfo = await connection.getAccountInfo(slabAddress);
  if (!slabInfo) throw new Error("Slab account not found");

  const data = new Uint8Array(slabInfo.data);
  const accounts = parseAllAccounts(data);

  // Find our LP account
  let lpAccount = accounts.find(
    (a) => a.account.kind === 1 && a.account.owner.equals(makerWallet.publicKey),
  );
  // Find our user account
  let userAccount = accounts.find(
    (a) => a.account.kind === 0 && a.account.owner.equals(makerWallet.publicKey),
  );

  const walletAta = await getAta(makerWallet.publicKey, mint);
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabAddress);
  const vaultAta = await getAta(vaultPda, mint, true);

  // Create LP account if needed
  if (!lpAccount) {
    if (DRY_RUN) {
      log("setup", `[DRY RUN] Would create LP account on ${symbol}`);
    } else {
      log("setup", `Creating LP account on ${symbol}...`);
      const initLpData = encodeInitLP({
        matcherProgram: MATCHER_ID,
        matcherContext: PublicKey.default,
        feePayment: "1000000",
      });
      const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
        makerWallet.publicKey,
        slabAddress,
        walletAta,
        vaultAta,
        WELL_KNOWN.tokenProgram,
      ]);
      const initLpIx = buildIx({
        programId: PROGRAM_ID,
        keys: initLpKeys,
        data: initLpData,
      });

      // Deposit LP collateral
      const depositData = encodeDepositCollateral({
        userIdx: 0,
        amount: INITIAL_COLLATERAL.toString(),
      });
      const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
        makerWallet.publicKey,
        slabAddress,
        walletAta,
        vaultAta,
        WELL_KNOWN.tokenProgram,
        SYSVAR_CLOCK_PUBKEY,
      ]);
      const depositIx = buildIx({
        programId: PROGRAM_ID,
        keys: depositKeys,
        data: depositData,
      });

      await sendTx([initLpIx, depositIx], [makerWallet]);

      // Refetch accounts
      const newSlabInfo = await connection.getAccountInfo(slabAddress);
      if (!newSlabInfo) throw new Error("Slab refetch failed");
      const newAccounts = parseAllAccounts(newSlabInfo.data);
      lpAccount = newAccounts.find(
        (a) =>
          a.account.kind === 1 &&
          a.account.owner.equals(makerWallet.publicKey),
      );
    }
  }

  // Create user (taker) account if needed
  if (!userAccount) {
    if (DRY_RUN) {
      log("setup", `[DRY RUN] Would create user account on ${symbol}`);
    } else {
      log("setup", `Creating user account on ${symbol}...`);
      const initUserData = encodeInitUser({ feePayment: "1000000" });
      const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
        makerWallet.publicKey,
        slabAddress,
        walletAta,
        vaultAta,
        WELL_KNOWN.tokenProgram,
      ]);
      const initUserIx = buildIx({
        programId: PROGRAM_ID,
        keys: initUserKeys,
        data: initUserData,
      });

      // Deposit trading collateral
      const depositData = encodeDepositCollateral({
        userIdx: 1,
        amount: INITIAL_COLLATERAL.toString(),
      });
      const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
        makerWallet.publicKey,
        slabAddress,
        walletAta,
        vaultAta,
        WELL_KNOWN.tokenProgram,
        SYSVAR_CLOCK_PUBKEY,
      ]);
      const depositIx = buildIx({
        programId: PROGRAM_ID,
        keys: depositKeys,
        data: depositData,
      });

      await sendTx([initUserIx, depositIx], [makerWallet]);

      // Refetch
      const newSlabInfo = await connection.getAccountInfo(slabAddress);
      if (!newSlabInfo) throw new Error("Slab refetch failed");
      const newAccounts = parseAllAccounts(newSlabInfo.data);
      userAccount = newAccounts.find(
        (a) =>
          a.account.kind === 0 &&
          a.account.owner.equals(makerWallet.publicKey),
      );
    }
  }

  if (DRY_RUN && (!lpAccount || !userAccount)) {
    log("setup", `[DRY RUN] ${symbol} — accounts would be created on live run`);
    return null;
  }

  if (!lpAccount || !userAccount) {
    log("setup", `❌ Could not find/create accounts for ${symbol}`);
    return null;
  }

  // Determine oracle mode
  const feedHex = Buffer.from(market.config.indexFeedId).toString("hex");
  const isHyperp = feedHex === "0".repeat(64);

  return {
    slabAddress,
    mint,
    symbol,
    lpIdx: lpAccount.idx,
    userIdx: userAccount.idx,
    lpOwner: lpAccount.account.owner,
    matcherProgram: lpAccount.account.matcherProgram ?? MATCHER_ID,
    matcherContext: lpAccount.account.matcherContext ?? PublicKey.default,
    lastQuoteSlot: 0,
    positionSize: userAccount.account.position ?? 0n,
    collateral: userAccount.account.collateral ?? INITIAL_COLLATERAL,
    lastOraclePrice: 0n,
    oracleMode: isHyperp ? "authority" : "pyth",
  };
}

// ═══════════════════════════════════════════════════════════════
// Quoting Logic (Core Market Making)
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate bid/ask prices with position-aware skewing.
 *
 * When flat: bid = oracle * (1 - spread), ask = oracle * (1 + spread)
 * When long: widen the bid (less willing to buy more), tighten the ask (want to sell)
 * When short: tighten the bid (want to buy), widen the ask (less willing to sell more)
 */
function calculateQuotes(
  oraclePrice: number,
  positionSize: bigint,
  collateral: bigint,
): { bidPrice: number; askPrice: number; bidSize: bigint; askSize: bigint; skewFactor: number } {
  const spreadFrac = SPREAD_BPS / 10_000;
  const collateralUsd = Number(collateral) / 1_000_000;
  const positionUsd = Number(positionSize) / 1_000_000;

  // Position exposure as fraction of collateral (-1 to +1 range, capped at MAX_POSITION_PCT)
  const exposure =
    collateralUsd > 0
      ? Math.max(-1, Math.min(1, positionUsd / (collateralUsd * (MAX_POSITION_PCT / 100))))
      : 0;

  // Skew factor: 0 = flat, +1 = max long, -1 = max short
  const skewFactor = exposure;

  // Widen spread on the risky side, tighten on the reducing side
  const bidSpreadMul = 1 + Math.max(0, skewFactor) * (SKEW_MAX_MULTIPLIER - 1);
  const askSpreadMul = 1 + Math.max(0, -skewFactor) * (SKEW_MAX_MULTIPLIER - 1);

  const bidPrice = oraclePrice * (1 - spreadFrac * bidSpreadMul);
  const askPrice = oraclePrice * (1 + spreadFrac * askSpreadMul);

  // Reduce quote size when approaching position limit
  const absExposure = Math.abs(exposure);
  const sizeFactor = Math.max(0.1, 1 - absExposure * 0.8);

  // If at max position, only quote on the reducing side
  let bidSize = MAX_QUOTE_SIZE;
  let askSize = MAX_QUOTE_SIZE;

  if (absExposure >= 0.95) {
    if (exposure > 0) {
      // Max long — don't bid, only ask
      bidSize = 0n;
    } else {
      // Max short — don't ask, only bid
      askSize = 0n;
    }
  } else {
    const scaledSize = BigInt(Math.floor(Number(MAX_QUOTE_SIZE) * sizeFactor));
    bidSize = scaledSize;
    askSize = scaledSize;
  }

  return { bidPrice, askPrice, bidSize, askSize, skewFactor };
}

// ═══════════════════════════════════════════════════════════════
// Trade Execution
// ═══════════════════════════════════════════════════════════════

/**
 * Execute a trade on the Percolator protocol.
 * Positive size = long/buy, negative size = short/sell.
 */
async function executeTrade(
  market: ManagedMarket,
  size: bigint,
  label: string,
): Promise<boolean> {
  if (DRY_RUN) {
    const sizeUsd = Number(size) / 1_000_000;
    log("trade", `[DRY RUN] ${market.symbol} ${label}: $${sizeUsd.toFixed(2)}`);
    return true;
  }

  try {
    const [lpPda] = deriveLpPda(PROGRAM_ID, market.slabAddress, market.lpIdx);

    // Crank first to apply latest oracle price
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      makerWallet.publicKey,
      market.slabAddress,
      SYSVAR_CLOCK_PUBKEY,
      market.slabAddress, // oracle = slab for authority-push oracle
    ]);
    const crankIx = buildIx({
      programId: PROGRAM_ID,
      keys: crankKeys,
      data: crankData,
    });

    // Place trade
    const tradeData = encodeTradeCpi({
      lpIdx: market.lpIdx,
      userIdx: market.userIdx,
      size: size.toString(),
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      makerWallet.publicKey,
      market.lpOwner,
      market.slabAddress,
      market.slabAddress, // oracle = slab for admin oracle (Hyperp mode)
      market.matcherProgram,
      market.matcherContext,
      lpPda,
    ]);
    const tradeIx = buildIx({
      programId: PROGRAM_ID,
      keys: tradeKeys,
      data: tradeData,
    });

    const sig = await sendTx([crankIx, tradeIx], [makerWallet], 600_000);
    const sizeUsd = Number(size) / 1_000_000;
    log("trade", `✅ ${market.symbol} ${label}: $${sizeUsd.toFixed(2)} — sig: ${sig.slice(0, 16)}...`);

    // Update position tracking
    market.positionSize += size;

    return true;
  } catch (e: any) {
    const msg = e.message?.slice(0, 100) ?? "unknown";
    log("trade", `❌ ${market.symbol} ${label} failed: ${msg}`);
    return false;
  }
}

/**
 * Push oracle price for Hyperp-mode markets (authority-push oracle).
 */
async function pushPrice(
  market: ManagedMarket,
  priceUsd: number,
): Promise<boolean> {
  if (market.oracleMode !== "authority") return true;

  const priceE6 = BigInt(Math.round(priceUsd * 1_000_000));
  if (priceE6 === market.lastOraclePrice) return true; // No change

  if (DRY_RUN) {
    log("oracle", `[DRY RUN] ${market.symbol}: would push $${priceUsd.toFixed(4)}`);
    market.lastOraclePrice = priceE6;
    return true;
  }

  try {
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const pushData = encodePushOraclePrice({ priceE6, timestamp });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      makerWallet.publicKey,
      market.slabAddress,
    ]);
    const pushIx = buildIx({
      programId: PROGRAM_ID,
      keys: pushKeys,
      data: pushData,
    });

    await sendTx([pushIx], [makerWallet], 200_000);
    market.lastOraclePrice = priceE6;
    return true;
  } catch (e: any) {
    log("oracle", `❌ ${market.symbol} price push failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Main Quote Loop
// ═══════════════════════════════════════════════════════════════

/**
 * Single quote cycle for one market:
 * 1. Fetch latest oracle price
 * 2. Push price if authority mode
 * 3. Calculate bid/ask with skewing
 * 4. Execute trades (alternating buy/sell)
 */
async function quoteMarket(market: ManagedMarket): Promise<void> {
  // Fetch price
  const priceData = await fetchPrice(market.symbol);
  if (!priceData) {
    log("quote", `⚠️ ${market.symbol}: no price available, skipping`);
    return;
  }

  // Push oracle price if needed
  await pushPrice(market, priceData.priceUsd);

  // Refresh position from on-chain state periodically
  try {
    const slabInfo = await connection.getAccountInfo(market.slabAddress);
    if (slabInfo) {
      const accounts = parseAllAccounts(slabInfo.data);
      const userAcc = accounts.find(
        (a) =>
          a.account.kind === 0 &&
          a.account.owner.equals(makerWallet.publicKey),
      );
      if (userAcc) {
        market.positionSize = userAcc.account.position ?? market.positionSize;
        market.collateral = userAcc.account.collateral ?? market.collateral;
      }
    }
  } catch {
    // Non-fatal — use cached position
  }

  // Calculate quotes
  const { bidPrice, askPrice, bidSize, askSize, skewFactor } = calculateQuotes(
    priceData.priceUsd,
    market.positionSize,
    market.collateral,
  );

  const posUsd = Number(market.positionSize) / 1_000_000;
  log(
    "state",
    `${market.symbol}: oracle=$${priceData.priceUsd.toFixed(2)} (${priceData.source}) | pos=$${posUsd.toFixed(2)} | skew=${(skewFactor * 100).toFixed(1)}%`,
  );

  // Execute bid (buy) if we have size
  if (bidSize > 0n) {
    logQuote(market.symbol, "BID", bidPrice, bidSize, skewFactor);
    // Convert bid to a trade size in USDC terms (the protocol handles notional sizing)
    await executeTrade(market, bidSize, `BID@${bidPrice.toFixed(2)}`);
  }

  // Small delay between bid and ask to avoid tx conflicts
  await new Promise((r) => setTimeout(r, 500));

  // Execute ask (sell) if we have size
  if (askSize > 0n) {
    logQuote(market.symbol, "ASK", askPrice, askSize, skewFactor);
    await executeTrade(market, -askSize, `ASK@${askPrice.toFixed(2)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Health Monitoring
// ═══════════════════════════════════════════════════════════════

interface BotStats {
  startedAt: number;
  quoteCycles: number;
  tradesExecuted: number;
  tradesFailed: number;
  lastCycleMs: number;
}

const stats: BotStats = {
  startedAt: Date.now(),
  quoteCycles: 0,
  tradesExecuted: 0,
  tradesFailed: 0,
  lastCycleMs: 0,
};

function printStats(markets: ManagedMarket[]) {
  const uptimeSecs = Math.floor((Date.now() - stats.startedAt) / 1000);
  const uptimeMin = Math.floor(uptimeSecs / 60);
  const uptimeSec = uptimeSecs % 60;

  log("stats", "═══════════════════════════════════════");
  log("stats", `Uptime: ${uptimeMin}m ${uptimeSec}s | Cycles: ${stats.quoteCycles} | Trades: ${stats.tradesExecuted}/${stats.tradesExecuted + stats.tradesFailed} ok`);
  for (const m of markets) {
    const posUsd = Number(m.positionSize) / 1_000_000;
    const colUsd = Number(m.collateral) / 1_000_000;
    const exposure =
      colUsd > 0
        ? ((Math.abs(posUsd) / (colUsd * (MAX_POSITION_PCT / 100))) * 100).toFixed(1)
        : "0.0";
    log("stats", `  ${m.symbol}: pos=$${posUsd.toFixed(2)} | col=$${colUsd.toFixed(0)} | exp=${exposure}%`);
  }
  log("stats", "═══════════════════════════════════════");
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

let running = true;

process.on("SIGINT", () => {
  log("main", "Shutting down gracefully...");
  running = false;
});
process.on("SIGTERM", () => {
  log("main", "Shutting down gracefully...");
  running = false;
});

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  PERC-364: Floating Market Maker Bot                 ║
║  Oracle-anchored two-sided market maker              ║
╚══════════════════════════════════════════════════════╝
`);

  // Load wallet
  try {
    makerWallet = loadKeypair(KP_PATH);
    log("main", `Wallet: ${makerWallet.publicKey.toBase58()}`);
  } catch (e: any) {
    console.error(`❌ Failed to load keypair from ${KP_PATH}: ${e.message}`);
    console.error("Set BOOTSTRAP_KEYPAIR to a valid keypair JSON file.");
    process.exit(1);
  }

  // Check wallet balance
  const balance = await connection.getBalance(makerWallet.publicKey);
  const balSol = balance / 1e9;
  log("main", `SOL balance: ${balSol.toFixed(4)} SOL`);
  if (balSol < 0.01) {
    log("main", "⚠️ Low SOL balance — transactions may fail. Use devnet faucet to top up.");
  }

  log("main", `Config: spread=${SPREAD_BPS}bps | maxQuote=$${Number(MAX_QUOTE_SIZE) / 1e6} | maxPos=${MAX_POSITION_PCT}% | interval=${QUOTE_INTERVAL_MS}ms`);
  if (DRY_RUN) log("main", "🔸 DRY RUN MODE — no transactions will be sent");
  if (MARKETS_FILTER) log("main", `🔸 Markets filter: ${MARKETS_FILTER.join(", ")}`);

  // Discover and setup markets
  let markets = await discoverAndSetupMarkets();
  if (markets.length === 0) {
    log("main", "No tradeable markets found. Will retry in 30s...");
    await new Promise((r) => setTimeout(r, 30_000));
    markets = await discoverAndSetupMarkets();
    if (markets.length === 0) {
      log("main", "Still no markets. Exiting.");
      process.exit(1);
    }
  }

  log("main", `🚀 Starting market making on ${markets.length} market(s)`);

  // Stats printer every 60s
  const statsInterval = setInterval(() => printStats(markets), 60_000);

  // Main loop
  let cycleCount = 0;
  while (running) {
    const cycleStart = Date.now();
    stats.quoteCycles++;

    for (const market of markets) {
      if (!running) break;
      try {
        await quoteMarket(market);
      } catch (e: any) {
        log("main", `❌ Quote cycle error on ${market.symbol}: ${e.message?.slice(0, 100)}`);
      }
    }

    stats.lastCycleMs = Date.now() - cycleStart;

    // Re-discover markets every 10 cycles (50s at default interval)
    cycleCount++;
    if (cycleCount % 10 === 0) {
      try {
        const newMarkets = await discoverAndSetupMarkets();
        // Add any new markets we don't already have
        for (const nm of newMarkets) {
          if (!markets.find((m) => m.slabAddress.equals(nm.slabAddress))) {
            markets.push(nm);
            log("main", `📊 New market added: ${nm.symbol}`);
          }
        }
      } catch (e: any) {
        log("main", `⚠️ Re-discovery failed: ${e.message?.slice(0, 80)}`);
      }
    }

    // Sleep until next cycle
    const elapsed = Date.now() - cycleStart;
    const sleepMs = Math.max(0, QUOTE_INTERVAL_MS - elapsed);
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  clearInterval(statsInterval);
  printStats(markets);
  log("main", "Bot stopped.");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});

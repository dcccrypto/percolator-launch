/**
 * PERC-377: Market discovery, account management, and trade helpers.
 *
 * Handles on-chain market discovery, LP/user account creation, collateral
 * deposits, and trade execution via Percolator SDK.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SYSVAR_CLOCK_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
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
  WELL_KNOWN,
  deriveVaultAuthority,
  deriveLpPda,
  discoverMarkets,
  parseAllAccounts,
  type DiscoveredMarket,
} from "@percolator/sdk";
import type { BotConfig } from "./config.js";
import { log, logError } from "./logger.js";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface ManagedMarket {
  slabAddress: PublicKey;
  programId: PublicKey;
  mint: PublicKey;
  symbol: string;
  lpIdx: number;
  userIdx: number;
  lpOwner: PublicKey;
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
  oracleMode: "authority" | "pyth";
  // State tracking
  positionSize: bigint;
  collateral: bigint;
  lastOraclePriceE6: bigint;
  lastCrankSlot: bigint;
  lastQuoteTime: number;
}

export interface TradeResult {
  success: boolean;
  signature?: string;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// Known Pyth feeds → symbol mapping
// ═══════════════════════════════════════════════════════════════

const KNOWN_FEEDS: Record<string, string> = {
  ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d: "SOL",
  e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43: "BTC",
  ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace: "ETH",
};

/**
 * Explicit slab-address → symbol overrides via MARKET_SYMBOL_OVERRIDES env var.
 *
 * Format: comma-separated `<slabAddress>:<SYMBOL>` pairs.
 * Example: MARKET_SYMBOL_OVERRIDES=AB3ZN1vx...:BTC,Fy7WiqBy...:SOL
 *
 * Required for Hyperp-mode markets on cold start (when authorityPriceE6 = 0
 * because no oracle price has been pushed yet). Without this, inferSymbol
 * returns "UNKNOWN" and both filler and maker are unable to push/use prices.
 */
const SYMBOL_OVERRIDES: Record<string, string> = Object.fromEntries(
  (process.env.MARKET_SYMBOL_OVERRIDES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [slab, sym] = entry.split(":");
      return [slab?.trim() ?? "", sym?.trim().toUpperCase() ?? ""];
    })
    .filter(([slab, sym]) => slab && sym),
);

if (Object.keys(SYMBOL_OVERRIDES).length > 0) {
  console.log(
    `[market] MARKET_SYMBOL_OVERRIDES loaded: ${JSON.stringify(SYMBOL_OVERRIDES)}`,
  );
}

/**
 * Infer a human-readable symbol from a DiscoveredMarket.
 *
 * Priority:
 *   1. MARKET_SYMBOL_OVERRIDES env var (explicit slab → symbol)
 *   2. Known Pyth feed ID lookup
 *   3. Hyperp mode: price-range heuristic using authorityPriceE6
 *   4. Hyperp mode: fallback to lastEffectivePriceE6 (may be set from trading)
 *   5. "UNKNOWN" — operator must set MARKET_SYMBOL_OVERRIDES
 */
function inferSymbol(market: DiscoveredMarket): string {
  // 1. Explicit env override (highest priority — works on cold start)
  const override = SYMBOL_OVERRIDES[market.slabAddress.toBase58()];
  if (override) return override;

  const feedId = market.config.indexFeedId;
  const feedHex = Buffer.from(
    feedId instanceof PublicKey ? feedId.toBytes() : (feedId as Uint8Array),
  ).toString("hex");

  // 2. Known Pyth feed
  if (KNOWN_FEEDS[feedHex]) return KNOWN_FEEDS[feedHex];

  // 3 & 4. Hyperp mode (admin oracle) — guess from price
  if (feedHex === "0".repeat(64)) {
    return inferSymbolFromPrice(market.config.authorityPriceE6, market.config.lastEffectivePriceE6);
  }

  return "UNKNOWN";
}

/**
 * Map a USD price (as BigInt e6) to a symbol using known price ranges.
 * Tries authorityPriceE6 first, then lastEffectivePriceE6 as fallback.
 */
function inferSymbolFromPrice(
  authorityPriceE6: bigint,
  lastEffectivePriceE6: bigint,
): string {
  for (const priceE6 of [authorityPriceE6, lastEffectivePriceE6]) {
    if (!priceE6 || priceE6 === 0n) continue;
    const markUsd = Number(priceE6) / 1_000_000;
    if (markUsd > 50_000) return "BTC";
    if (markUsd > 2_000) return "ETH";
    if (markUsd > 50) return "SOL";
  }
  return "UNKNOWN";
}

/**
 * Re-fetch on-chain slab data and attempt to resolve the symbol.
 * Used when a market is stored as "UNKNOWN" — the filler may have pushed
 * a price since initial discovery, updating authorityPriceE6 on-chain.
 *
 * Returns the resolved symbol, or "UNKNOWN" if still unresolvable.
 */
export async function resolveSymbolFromSlab(
  connection: Connection,
  slabAddress: PublicKey,
): Promise<string> {
  // Env override takes priority
  const override = SYMBOL_OVERRIDES[slabAddress.toBase58()];
  if (override) return override;

  try {
    const info = await connection.getAccountInfo(slabAddress);
    if (!info) return "UNKNOWN";
    const data = new Uint8Array(info.data);
    // Read authorityPriceE6 and lastEffectivePriceE6 from the on-chain config.
    // These are parsed by the SDK's parseConfig; here we use the public SDK instead
    // of re-parsing manually. We import from the SDK only what we need.
    const { parseConfig } = await import("@percolator/sdk");
    const config = parseConfig(data);
    return inferSymbolFromPrice(config.authorityPriceE6, config.lastEffectivePriceE6);
  } catch {
    return "UNKNOWN";
  }
}

// ═══════════════════════════════════════════════════════════════
// Transaction helpers
// ═══════════════════════════════════════════════════════════════

async function sendTx(
  connection: Connection,
  ixs: any[],
  signers: Keypair[],
  label: string,
  computeUnits = 400_000,
  dryRun = false,
): Promise<string | null> {
  if (dryRun) {
    log("tx", `[DRY RUN] ${label}`);
    return "(dry-run)";
  }
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  for (const ix of ixs) tx.add(ix);
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: "confirmed",
      skipPreflight: true,
    });
    log("tx", `✅ ${label} → ${sig.slice(0, 16)}...`);
    return sig;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Extract custom program error code if present
    const customMatch = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
    const instrMatch = msg.match(/InstructionError.*?Custom\((\d+)\)/);
    const errorDetail = customMatch
      ? `Custom error 0x${customMatch[1]} (${parseInt(customMatch[1], 16)})`
      : instrMatch
        ? `Custom error ${instrMatch[1]} (0x${Number(instrMatch[1]).toString(16)})`
        : null;
    logError("tx", label, errorDetail ? `${errorDetail} — ${msg.slice(0, 200)}` : msg.slice(0, 300));
    return null;
  }
}

/**
 * Ensure wallet has enough SOL for transactions. On devnet, attempt airdrop if low.
 * Returns true if balance is sufficient, false if critically low and airdrop failed.
 */
const MIN_SOL_FOR_TX = 0.01;
const AIRDROP_SOL = 1;

async function ensureSolBalance(
  connection: Connection,
  wallet: Keypair,
  label: string,
): Promise<boolean> {
  const balance = await connection.getBalance(wallet.publicKey);
  const balSol = balance / LAMPORTS_PER_SOL;
  if (balSol >= MIN_SOL_FOR_TX) return true;

  log("setup", `${label}: wallet ${wallet.publicKey.toBase58().slice(0, 12)}... has ${balSol.toFixed(4)} SOL — attempting devnet airdrop`);
  try {
    const sig = await connection.requestAirdrop(wallet.publicKey, AIRDROP_SOL * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    const newBal = await connection.getBalance(wallet.publicKey);
    log("setup", `${label}: airdrop OK — now ${(newBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError("setup", `${label}: airdrop failed (${msg.slice(0, 100)}) — wallet has ${balSol.toFixed(4)} SOL, InitUser/InitLP will likely fail`);
    return false;
  }
}

/**
 * Ensure a wallet's Associated Token Account (ATA) exists for the given mint.
 * Creates it on-chain if missing. The wallet pays for the ATA rent (~0.002 SOL).
 *
 * This must be called before any instruction that debits the walletAta (e.g.
 * InitUser, DepositCollateral) to avoid an InvalidTokenAccount program error.
 */
async function ensureWalletAta(
  connection: Connection,
  payer: Keypair,
  owner: PublicKey,
  mint: PublicKey,
  label: string,
  dryRun = false,
): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(mint, owner);
  try {
    await getAccount(connection, ata);
    return ata; // already exists
  } catch {
    // ATA does not exist — create it
    log("setup", `${label}: walletAta missing — creating ATA for mint ${mint.toBase58().slice(0, 12)}...`);
    if (dryRun) {
      log("setup", `${label}: [DRY RUN] would create ATA ${ata.toBase58().slice(0, 16)}...`);
      return ata;
    }
    const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    tx.add(ix);
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
        skipPreflight: false,
      });
      log("setup", `${label}: ✅ created ATA ${ata.toBase58().slice(0, 16)}... → ${sig.slice(0, 16)}...`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logError("setup", `${label}: failed to create ATA`, msg.slice(0, 150));
    }
    return ata;
  }
}

// ═══════════════════════════════════════════════════════════════
// Market Discovery
// ═══════════════════════════════════════════════════════════════

/**
 * Discover all active Percolator markets on-chain.
 */
export async function discoverAllMarkets(
  connection: Connection,
  config: BotConfig,
): Promise<DiscoveredMarket[]> {
  log("discovery", "Scanning for markets...", { program: config.programId.toBase58().slice(0, 12) });
  const discovered = await discoverMarkets(connection, config.programId);

  const filtered = discovered.filter((m) => {
    if (m.header.resolved || m.header.paused) return false;
    if (config.marketsFilter) {
      const sym = inferSymbol(m);
      return config.marketsFilter.includes(sym);
    }
    return true;
  });

  log("discovery", `Found ${discovered.length} markets, ${filtered.length} active after filters`);
  return filtered;
}

/**
 * Set up LP + User accounts on a market for a wallet.
 * Returns a ManagedMarket with all indices populated.
 */
export async function setupMarketAccounts(
  connection: Connection,
  config: BotConfig,
  market: DiscoveredMarket,
  wallet: Keypair,
  depositCollateral: bigint,
  createLp: boolean,
): Promise<ManagedMarket | null> {
  const symbol = inferSymbol(market);
  const slab = market.slabAddress;
  const mint = market.config.collateralMint;
  const programId = market.programId;

  // walletAta is let so ensureWalletAta can reassign after ATA creation
  let walletAta = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const [vaultPda] = deriveVaultAuthority(programId, slab);
  const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);

  // Fetch full slab to find existing accounts
  const slabInfo = await connection.getAccountInfo(slab);
  if (!slabInfo) {
    logError("setup", `${symbol}: slab not found`);
    return null;
  }
  const data = new Uint8Array(slabInfo.data);
  let accounts = parseAllAccounts(data);

  // Find existing LP
  let lpAccount = accounts.find(
    (a) => a.account.kind === 1 && (
      a.account.owner.equals(wallet.publicKey) || !createLp
    ),
  );

  // Find existing user
  let userAccount = accounts.find(
    (a) => a.account.kind === 0 && a.account.owner.equals(wallet.publicKey),
  );

  // Create LP if needed and requested
  if (!lpAccount && createLp) {
    await ensureSolBalance(connection, wallet, symbol);
    // Ensure walletAta exists before attempting LP init (fee is debited from it)
    walletAta = await ensureWalletAta(connection, wallet, wallet.publicKey, mint, symbol, config.dryRun);
    log("setup", `${symbol}: creating LP account...`);
    const initLpData = encodeInitLP({
      matcherProgram: config.matcherProgramId,
      matcherContext: PublicKey.default,
      feePayment: "1000000",
    });
    const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
      wallet.publicKey, slab, walletAta, vaultAta, WELL_KNOWN.tokenProgram,
    ]);
    const ix = buildIx({ programId, keys: initLpKeys, data: initLpData });
    const sig = await sendTx(connection, [ix], [wallet], `${symbol} InitLP`, 200_000, config.dryRun);
    if (!sig) return null;

    // Refetch
    await sleep(1500);
    const slabInfo2 = await connection.getAccountInfo(slab);
    if (slabInfo2) {
      accounts = parseAllAccounts(new Uint8Array(slabInfo2.data));
      lpAccount = accounts.find(
        (a) => a.account.kind === 1 && a.account.owner.equals(wallet.publicKey),
      );
    }
  }

  // Find any LP (for the filler bot, it trades against existing LPs)
  if (!lpAccount) {
    lpAccount = accounts.find((a) => a.account.kind === 1);
  }
  if (!lpAccount) {
    logError("setup", `${symbol}: no LP account available`);
    return null;
  }

  // Create user if needed
  if (!userAccount) {
    await ensureSolBalance(connection, wallet, symbol);
    // Ensure walletAta exists before attempting InitUser (1 USDC fee is debited from it)
    walletAta = await ensureWalletAta(connection, wallet, wallet.publicKey, mint, symbol, config.dryRun);
    log("setup", `${symbol}: creating user account...`);
    const initUserData = encodeInitUser({ feePayment: "1000000" });
    const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      wallet.publicKey, slab, walletAta, vaultAta, WELL_KNOWN.tokenProgram,
    ]);
    const ix = buildIx({ programId, keys: initUserKeys, data: initUserData });
    const sig = await sendTx(connection, [ix], [wallet], `${symbol} InitUser`, 200_000, config.dryRun);
    if (!sig) return null;

    await sleep(1500);
    const slabInfo2 = await connection.getAccountInfo(slab);
    if (slabInfo2) {
      accounts = parseAllAccounts(new Uint8Array(slabInfo2.data));
      userAccount = accounts.find(
        (a) => a.account.kind === 0 && a.account.owner.equals(wallet.publicKey),
      );
    }
    if (!userAccount) {
      logError("setup", `${symbol}: user not found after init`);
      return null;
    }

    // Deposit collateral
    if (depositCollateral > 0n) {
      log("setup", `${symbol}: depositing $${Number(depositCollateral) / 1e6} collateral...`);
      const depositData = encodeDepositCollateral({
        userIdx: userAccount.idx,
        amount: depositCollateral.toString(),
      });
      const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
        wallet.publicKey, slab, walletAta, vaultAta, WELL_KNOWN.tokenProgram, SYSVAR_CLOCK_PUBKEY,
      ]);
      const depositIx = buildIx({ programId, keys: depositKeys, data: depositData });
      await sendTx(connection, [depositIx], [wallet], `${symbol} Deposit`, 200_000, config.dryRun);
    }
  }

  // Determine oracle mode
  const feedId = market.config.indexFeedId;
  const feedHex = Buffer.from(
    feedId instanceof PublicKey ? feedId.toBytes() : (feedId as Uint8Array),
  ).toString("hex");
  const isHyperp = feedHex === "0".repeat(64);

  if (symbol === "UNKNOWN") {
    logError(
      "setup",
      `Market ${slab.toBase58().slice(0, 16)}... resolved as UNKNOWN symbol — oracle price not yet pushed`,
      `Fix: set MARKET_SYMBOL_OVERRIDES=${slab.toBase58()}:BTC (or ETH/SOL) in your env`,
    );
  } else {
    log("setup", `✅ ${symbol}: LP idx=${lpAccount.idx}, User idx=${userAccount.idx}`);
  }

  return {
    slabAddress: slab,
    programId,
    mint,
    symbol,
    lpIdx: lpAccount.idx,
    userIdx: userAccount.idx,
    lpOwner: lpAccount.account.owner,
    matcherProgram: lpAccount.account.matcherProgram ?? config.matcherProgramId,
    matcherContext: lpAccount.account.matcherContext ?? PublicKey.default,
    oracleMode: isHyperp ? "authority" : "pyth",
    positionSize: userAccount.account.positionSize ?? 0n,
    collateral: userAccount.account.capital ?? depositCollateral,
    lastOraclePriceE6: 0n,
    lastCrankSlot: market.engine.lastCrankSlot,
    lastQuoteTime: 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// Trade + Crank Instructions
// ═══════════════════════════════════════════════════════════════

/**
 * Crank a market (process funding, liquidations, etc).
 */
export async function crankMarket(
  connection: Connection,
  config: BotConfig,
  market: ManagedMarket,
  wallet: Keypair,
): Promise<boolean> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const oracleKey = market.oracleMode === "authority" ? market.slabAddress : market.slabAddress; // TODO: derive pyth PDA
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    wallet.publicKey,
    market.slabAddress,
    SYSVAR_CLOCK_PUBKEY,
    oracleKey,
  ]);
  const ix = buildIx({ programId: market.programId, keys: crankKeys, data: crankData });
  const sig = await sendTx(connection, [ix], [wallet], `${market.symbol} Crank`, 200_000, config.dryRun);
  return sig !== null;
}

/**
 * Push oracle price for Hyperp-mode markets.
 */
export async function pushOraclePrice(
  connection: Connection,
  config: BotConfig,
  market: ManagedMarket,
  wallet: Keypair,
  priceE6: bigint,
): Promise<boolean> {
  if (market.oracleMode !== "authority") return true;
  if (priceE6 === market.lastOraclePriceE6) return true;

  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const pushData = encodePushOraclePrice({ priceE6, timestamp });
  const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
    wallet.publicKey,
    market.slabAddress,
  ]);
  const ix = buildIx({ programId: market.programId, keys: pushKeys, data: pushData });
  const sig = await sendTx(connection, [ix], [wallet], `${market.symbol} OraclePush $${Number(priceE6) / 1e6}`, 200_000, config.dryRun);
  if (sig) market.lastOraclePriceE6 = priceE6;
  return sig !== null;
}

/**
 * Execute a trade via TradeCpi (user trades against LP via matcher).
 * Positive size = long/buy, negative size = short/sell.
 */
export async function executeTrade(
  connection: Connection,
  config: BotConfig,
  market: ManagedMarket,
  wallet: Keypair,
  size: bigint,
  label: string,
): Promise<TradeResult> {
  const [lpPda] = deriveLpPda(market.programId, market.slabAddress, market.lpIdx);

  // Crank first to apply latest oracle
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const oracleKey = market.oracleMode === "authority" ? market.slabAddress : market.slabAddress;
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    wallet.publicKey, market.slabAddress, SYSVAR_CLOCK_PUBKEY, oracleKey,
  ]);
  const crankIx = buildIx({ programId: market.programId, keys: crankKeys, data: crankData });

  // Trade instruction
  const tradeData = encodeTradeCpi({
    lpIdx: market.lpIdx,
    userIdx: market.userIdx,
    size: size.toString(),
  });
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    wallet.publicKey,
    market.lpOwner,
    market.slabAddress,
    oracleKey,
    market.matcherProgram,
    market.matcherContext,
    lpPda,
  ]);
  const tradeIx = buildIx({ programId: market.programId, keys: tradeKeys, data: tradeData });

  const sig = await sendTx(
    connection,
    [crankIx, tradeIx],
    [wallet],
    `${market.symbol} ${label}`,
    600_000,
    config.dryRun,
  );

  if (sig) {
    market.positionSize += size;
    return { success: true, signature: sig };
  }
  return { success: false, error: "Transaction failed" };
}

/**
 * Refresh on-chain position for a market.
 */
export async function refreshPosition(
  connection: Connection,
  market: ManagedMarket,
  wallet: Keypair,
): Promise<void> {
  try {
    const slabInfo = await connection.getAccountInfo(market.slabAddress);
    if (!slabInfo) return;
    const accounts = parseAllAccounts(new Uint8Array(slabInfo.data));
    const userAcc = accounts.find(
      (a) => a.account.kind === 0 && a.account.owner.equals(wallet.publicKey),
    );
    if (userAcc) {
      market.positionSize = userAcc.account.positionSize ?? market.positionSize;
      market.collateral = userAcc.account.capital ?? market.collateral;
    }
  } catch {
    // Non-fatal — use cached position
  }
}

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * PERC-366: Market Maker Fleet Orchestrator
 *
 * Runs 3 market maker profiles (1 WIDE + 2 TIGHT) per market in a single
 * process. Each profile gets its own subaccount for position isolation.
 *
 * Usage:
 *   BOOTSTRAP_KEYPAIR=/path/to/keypair.json npx tsx scripts/mm-fleet.ts
 *
 * Environment variables (all optional, sane defaults):
 *   BOOTSTRAP_KEYPAIR     — Path to fleet controller keypair JSON (fallback for all profiles)
 *   RPC_URL               — Solana RPC URL (default: devnet via Helius)
 *   HELIUS_API_KEY        — Helius API key for devnet RPC
 *   DRY_RUN               — "true" for simulation only
 *   MARKETS_FILTER        — Comma-separated market symbols (default: all)
 *   FLEET_PROFILES        — Comma-separated profiles to run (default: WIDE,TIGHT_A,TIGHT_B)
 *   MM_WIDE_SPREAD_BPS    — Override WIDE spread (see mm-profiles.ts)
 *   MM_TIGHT_A_SPREAD_BPS — Override TIGHT_A spread
 *   PROMETHEUS_PORT        — Expose /metrics on this port (default: off)
 *
 * PERC-368 — Per-profile keeper wallets:
 *   KEEPER_WALLET_WIDE    — Keypair JSON for WIDE profile
 *   KEEPER_WALLET_TIGHT_A — Keypair JSON for TIGHT_A profile
 *   KEEPER_WALLET_TIGHT_B — Keypair JSON for TIGHT_B profile
 *   KEEPER_WALLETS_DIR    — Directory containing keeper-wide.json, keeper-tight_a.json, etc.
 *
 *   When per-profile wallets are configured, each profile signs with its own
 *   keypair. This creates 3 independent on-chain identities for more realistic
 *   orderbook activity and avoids single-wallet rate limiting.
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
  parseAllAccounts,
  discoverMarkets,
  type DiscoveredMarket,
} from "../packages/core/src/index.js";
import { getProgramId } from "../packages/core/src/config/program-ids.js";
import {
  DEFAULT_PROFILES,
  applyEnvOverrides,
  calculateProfileQuotes,
  type MakerProfile,
} from "./mm-profiles.js";
import * as fs from "fs";
import * as http from "http";

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
const DRY_RUN = process.env.DRY_RUN === "true";
const MARKETS_FILTER = process.env.MARKETS_FILTER
  ? process.env.MARKETS_FILTER.split(",").map((s) => s.trim().toUpperCase())
  : null;
const PROMETHEUS_PORT = process.env.PROMETHEUS_PORT
  ? Number(process.env.PROMETHEUS_PORT)
  : null;

// Select profiles
const PROFILE_FILTER = process.env.FLEET_PROFILES
  ? process.env.FLEET_PROFILES.split(",").map((s) => s.trim().toUpperCase())
  : null;

const allProfiles = applyEnvOverrides(DEFAULT_PROFILES);
const activeProfiles = PROFILE_FILTER
  ? allProfiles.filter((p) => PROFILE_FILTER.includes(p.name))
  : allProfiles;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface FleetInstance {
  /** Profile configuration */
  profile: MakerProfile;
  /** Signing wallet for this instance (PERC-368: may differ per profile) */
  wallet: Keypair;
  /** On-chain market slab address */
  slabAddress: PublicKey;
  /** Collateral mint */
  mint: PublicKey;
  /** Market symbol (e.g., SOL, BTC) */
  symbol: string;
  /** Account index — LP subaccount for this profile */
  lpIdx: number;
  /** Account index — User (taker) subaccount for this profile */
  userIdx: number;
  /** LP owner pubkey */
  lpOwner: PublicKey;
  /** Matcher program */
  matcherProgram: PublicKey;
  /** Matcher context */
  matcherContext: PublicKey;
  /** Oracle mode */
  oracleMode: "authority" | "pyth";
  /** Current position (signed, 6 decimals) */
  positionSize: bigint;
  /** Collateral deposited (6 decimals) */
  collateral: bigint;
  /** Last oracle price pushed (e6) */
  lastOraclePrice: bigint;
  /** Stats */
  stats: InstanceStats;
  /** Timer handle for this instance's quote loop */
  timerHandle: ReturnType<typeof setTimeout> | null;
  /** Is this instance's loop currently running? */
  busy: boolean;
}

interface InstanceStats {
  quoteCycles: number;
  tradesAttempted: number;
  tradesSucceeded: number;
  tradesFailed: number;
  lastCycleMs: number;
  lastOraclePrice: number;
  lastBidPrice: number;
  lastAskPrice: number;
  lastSkewPct: number;
  startedAt: number;
}

// ═══════════════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════════════

function log(component: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${component}] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════
// Wallet & Connection
// ═══════════════════════════════════════════════════════════════

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const connection = new Connection(RPC_URL, "confirmed");
let fleetWallet: Keypair; // fallback wallet

/**
 * PERC-368: Per-profile keeper wallets.
 * Maps profile name → Keypair. Falls back to fleetWallet if not configured.
 */
const profileWallets = new Map<string, Keypair>();

function loadProfileWallets(): void {
  const walletsDir = process.env.KEEPER_WALLETS_DIR;

  for (const profile of activeProfiles) {
    // Check per-profile env var first: KEEPER_WALLET_WIDE, KEEPER_WALLET_TIGHT_A, etc.
    const envKey = `KEEPER_WALLET_${profile.name}`;
    const envPath = process.env[envKey];

    if (envPath && fs.existsSync(envPath)) {
      profileWallets.set(profile.name, loadKeypair(envPath));
      log("wallets", `${profile.name}: loaded from ${envKey}`);
      continue;
    }

    // Check directory mode: keeper-wide.json, keeper-tight_a.json
    if (walletsDir) {
      const fileName = `keeper-${profile.name.toLowerCase()}.json`;
      const dirPath = `${walletsDir}/${fileName}`;
      if (fs.existsSync(dirPath)) {
        profileWallets.set(profile.name, loadKeypair(dirPath));
        log("wallets", `${profile.name}: loaded from ${dirPath}`);
        continue;
      }
    }

    // Falls through → will use fleetWallet
  }

  const usingIndependent = profileWallets.size;
  if (usingIndependent > 0) {
    log(
      "wallets",
      `🔑 ${usingIndependent}/${activeProfiles.length} profiles using independent keeper wallets`,
    );
  }
}

/** Get the wallet for a given profile (falls back to fleetWallet) */
function getWallet(profileName: string): Keypair {
  return profileWallets.get(profileName) ?? fleetWallet;
}

/**
 * Send a transaction with retry logic.
 * Rate-limits to avoid 429s on devnet RPC.
 */
const txQueue: Array<{
  ixs: any[];
  signers: Keypair[];
  cu: number;
  resolve: (sig: string) => void;
  reject: (e: Error) => void;
}> = [];
let txProcessing = false;

async function processTxQueue() {
  if (txProcessing) return;
  txProcessing = true;

  while (txQueue.length > 0) {
    const item = txQueue.shift()!;
    try {
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: item.cu }));
      for (const ix of item.ixs) tx.add(ix);
      const sig = await sendAndConfirmTransaction(
        connection,
        tx,
        item.signers,
        { commitment: "confirmed", skipPreflight: true },
      );
      item.resolve(sig);
    } catch (e: any) {
      item.reject(e);
    }
    // Rate-limit: 200ms between txs to avoid devnet rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  txProcessing = false;
}

function sendTx(
  ixs: any[],
  signers: Keypair[],
  computeUnits = 400_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    txQueue.push({ ixs, signers, cu: computeUnits, resolve, reject });
    processTxQueue();
  });
}

// ═══════════════════════════════════════════════════════════════
// Price Feeds (shared across all instances)
// ═══════════════════════════════════════════════════════════════

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

const COINGECKO_MAP: Record<string, string> = {
  SOL: "solana",
  BTC: "bitcoin",
  ETH: "ethereum",
  BONK: "bonk",
  JUP: "jupiter-exchange-solana",
  WIF: "dogwifcoin",
  PYTH: "pyth-network",
  RAY: "raydium",
  JTO: "jito-governance-token",
};

/** Shared price cache to avoid hammering APIs from 3 instances */
const priceCache = new Map<
  string,
  { price: number; source: string; ts: number }
>();
const PRICE_CACHE_TTL_MS = 2_000; // 2s cache — all instances within same cycle share

async function fetchPrice(
  symbol: string,
): Promise<{ price: number; source: string } | null> {
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL_MS) {
    return { price: cached.price, source: cached.source };
  }

  // Binance
  const pair = BINANCE_MAP[symbol.toUpperCase()];
  if (pair) {
    try {
      const resp = await fetch(
        `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
        { signal: AbortSignal.timeout(4000) },
      );
      const json = (await resp.json()) as { price?: string };
      if (json.price) {
        const price = parseFloat(json.price);
        priceCache.set(symbol, { price, source: "binance", ts: Date.now() });
        return { price, source: "binance" };
      }
    } catch {
      /* fallthrough */
    }
  }

  // CoinGecko fallback
  const cgId = COINGECKO_MAP[symbol.toUpperCase()];
  if (cgId) {
    try {
      const resp = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(5000) },
      );
      const json = (await resp.json()) as Record<string, { usd?: number }>;
      if (json[cgId]?.usd) {
        const price = json[cgId].usd;
        priceCache.set(symbol, { price, source: "coingecko", ts: Date.now() });
        return { price, source: "coingecko" };
      }
    } catch {
      /* fallthrough */
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Market Discovery
// ═══════════════════════════════════════════════════════════════

/** Infer symbol from market data (same as PERC-364). */
function inferSymbol(market: DiscoveredMarket): string {
  const feedHex = Buffer.from(market.config.indexFeedId).toString("hex");
  const KNOWN_FEEDS: Record<string, string> = {
    ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d: "SOL",
    e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43: "BTC",
    ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace: "ETH",
  };
  if (KNOWN_FEEDS[feedHex]) return KNOWN_FEEDS[feedHex];

  const isHyperp = feedHex === "0".repeat(64);
  if (isHyperp) {
    const markE6 = market.engine.lastOraclePrice ?? 0n;
    const markUsd = Number(markE6) / 1_000_000;
    if (markUsd > 50_000) return "BTC";
    if (markUsd > 2_000) return "ETH";
    if (markUsd > 50) return "SOL";
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

/**
 * For each discovered market, create one FleetInstance per active profile.
 * Each profile gets its own subaccount (LP + User).
 */
async function discoverAndSetup(): Promise<FleetInstance[]> {
  log("discovery", `Scanning for markets on ${PROGRAM_ID.toBase58().slice(0, 8)}...`);
  const discovered = await discoverMarkets(connection, PROGRAM_ID);
  log("discovery", `Found ${discovered.length} market(s) on-chain`);

  const instances: FleetInstance[] = [];

  for (const market of discovered) {
    const symbol = inferSymbol(market);
    if (MARKETS_FILTER && !MARKETS_FILTER.includes(symbol)) continue;
    if (market.header.resolved || market.header.paused) {
      log("discovery", `Skipping ${symbol} — resolved/paused`);
      continue;
    }

    const feedHex = Buffer.from(market.config.indexFeedId).toString("hex");
    const isHyperp = feedHex === "0".repeat(64);

    for (const profile of activeProfiles) {
      try {
        const inst = await setupInstance(market, symbol, profile, isHyperp);
        if (inst) {
          instances.push(inst);
          log(
            "discovery",
            `✅ ${symbol}/${profile.name} — LP idx ${inst.lpIdx}, User idx ${inst.userIdx}`,
          );
        }
      } catch (e: any) {
        log(
          "discovery",
          `❌ ${symbol}/${profile.name}: ${e.message?.slice(0, 100)}`,
        );
      }
    }
  }

  return instances;
}

async function setupInstance(
  market: DiscoveredMarket,
  symbol: string,
  profile: MakerProfile,
  isHyperp: boolean,
): Promise<FleetInstance | null> {
  const wallet = getWallet(profile.name);
  const slabAddress = market.slabAddress;
  const mint = market.config.collateralMint;

  const slabInfo = await connection.getAccountInfo(slabAddress);
  if (!slabInfo) throw new Error("Slab account not found");

  const data = new Uint8Array(slabInfo.data);
  const accounts = parseAllAccounts(data);

  // Each profile needs its own accounts. With per-profile wallets (PERC-368),
  // each wallet owns its own accounts. With shared wallet, we use subaccount index.
  const myAccounts = accounts.filter((a) =>
    a.account.owner.equals(wallet.publicKey),
  );
  const myLPs = myAccounts.filter((a) => a.account.kind === 1);
  const myUsers = myAccounts.filter((a) => a.account.kind === 0);

  // When using independent wallets, each wallet has index 0.
  // When sharing a wallet, use profile index for subaccount isolation.
  const hasOwnWallet = profileWallets.has(profile.name);
  const profileIdx = hasOwnWallet ? 0 : activeProfiles.indexOf(profile);

  let lpAccount = myLPs[profileIdx] ?? null;
  let userAccount = myUsers[profileIdx] ?? null;

  const walletAta = await getAta(wallet.publicKey, mint);
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabAddress);
  const vaultAta = await getAta(vaultPda, mint, true);

  // Create missing LP account
  if (!lpAccount) {
    if (DRY_RUN) {
      log("setup", `[DRY] ${symbol}/${profile.name}: would create LP`);
    } else {
      log("setup", `${symbol}/${profile.name}: creating LP account...`);
      const initData = encodeInitLP({
        matcherProgram: MATCHER_ID,
        matcherContext: PublicKey.default,
        feePayment: "1000000",
      });
      const initKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
        wallet.publicKey,
        slabAddress,
        walletAta,
        vaultAta,
        WELL_KNOWN.tokenProgram,
      ]);
      const initIx = buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData });

      const depositData = encodeDepositCollateral({
        userIdx: 0,
        amount: profile.initialCollateralUsdc.toString(),
      });
      const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
        wallet.publicKey,
        slabAddress,
        walletAta,
        vaultAta,
        WELL_KNOWN.tokenProgram,
        SYSVAR_CLOCK_PUBKEY,
      ]);
      const depositIx = buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData });

      await sendTx([initIx, depositIx], [wallet]);
    }

    // Refetch
    const newInfo = await connection.getAccountInfo(slabAddress);
    if (newInfo) {
      const newAccs = parseAllAccounts(newInfo.data);
      const newLPs = newAccs
        .filter((a) => a.account.kind === 1 && a.account.owner.equals(wallet.publicKey));
      lpAccount = newLPs[profileIdx] ?? newLPs[newLPs.length - 1] ?? null;
    }
  }

  // Create missing user account
  if (!userAccount) {
    if (DRY_RUN) {
      log("setup", `[DRY] ${symbol}/${profile.name}: would create User`);
    } else {
      log("setup", `${symbol}/${profile.name}: creating User account...`);
      const initData = encodeInitUser({ feePayment: "1000000" });
      const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
        wallet.publicKey,
        slabAddress,
        walletAta,
        vaultAta,
        WELL_KNOWN.tokenProgram,
      ]);
      const initIx = buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData });

      const depositData = encodeDepositCollateral({
        userIdx: 1,
        amount: profile.initialCollateralUsdc.toString(),
      });
      const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
        wallet.publicKey,
        slabAddress,
        walletAta,
        vaultAta,
        WELL_KNOWN.tokenProgram,
        SYSVAR_CLOCK_PUBKEY,
      ]);
      const depositIx = buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData });

      await sendTx([initIx, depositIx], [wallet]);
    }

    // Refetch
    const newInfo = await connection.getAccountInfo(slabAddress);
    if (newInfo) {
      const newAccs = parseAllAccounts(newInfo.data);
      const newUsers = newAccs
        .filter((a) => a.account.kind === 0 && a.account.owner.equals(wallet.publicKey));
      userAccount = newUsers[profileIdx] ?? newUsers[newUsers.length - 1] ?? null;
    }
  }

  if (DRY_RUN && (!lpAccount || !userAccount)) {
    log("setup", `[DRY] ${symbol}/${profile.name} — would be ready on live run`);
    return null;
  }

  if (!lpAccount || !userAccount) {
    log("setup", `❌ ${symbol}/${profile.name}: missing accounts`);
    return null;
  }

  return {
    profile,
    wallet,
    slabAddress,
    mint,
    symbol,
    lpIdx: lpAccount.idx,
    userIdx: userAccount.idx,
    lpOwner: lpAccount.account.owner,
    matcherProgram: lpAccount.account.matcherProgram ?? MATCHER_ID,
    matcherContext: lpAccount.account.matcherContext ?? PublicKey.default,
    oracleMode: isHyperp ? "authority" : "pyth",
    positionSize: userAccount.account.position ?? 0n,
    collateral: userAccount.account.collateral ?? profile.initialCollateralUsdc,
    lastOraclePrice: 0n,
    stats: {
      quoteCycles: 0,
      tradesAttempted: 0,
      tradesSucceeded: 0,
      tradesFailed: 0,
      lastCycleMs: 0,
      lastOraclePrice: 0,
      lastBidPrice: 0,
      lastAskPrice: 0,
      lastSkewPct: 0,
      startedAt: Date.now(),
    },
    timerHandle: null,
    busy: false,
  };
}

// ═══════════════════════════════════════════════════════════════
// Oracle Price Push (shared — only push once per market per cycle)
// ═══════════════════════════════════════════════════════════════

const lastPushed = new Map<string, bigint>();

async function pushOracleIfNeeded(
  inst: FleetInstance,
  priceUsd: number,
): Promise<boolean> {
  if (inst.oracleMode !== "authority") return true;

  const priceE6 = BigInt(Math.round(priceUsd * 1_000_000));
  const slabKey = inst.slabAddress.toBase58();
  const prev = lastPushed.get(slabKey) ?? 0n;

  // Skip if price hasn't changed
  if (priceE6 === prev) {
    inst.lastOraclePrice = priceE6;
    return true;
  }

  if (DRY_RUN) {
    lastPushed.set(slabKey, priceE6);
    inst.lastOraclePrice = priceE6;
    return true;
  }

  try {
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const pushData = encodePushOraclePrice({ priceE6, timestamp });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      inst.wallet.publicKey,
      inst.slabAddress,
    ]);
    const pushIx = buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData });

    await sendTx([pushIx], [inst.wallet], 200_000);
    lastPushed.set(slabKey, priceE6);
    inst.lastOraclePrice = priceE6;
    return true;
  } catch (e: any) {
    log(`${inst.symbol}/${inst.profile.name}`, `⚠ Oracle push failed: ${e.message?.slice(0, 60)}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Trade Execution
// ═══════════════════════════════════════════════════════════════

async function executeTrade(
  inst: FleetInstance,
  size: bigint,
  label: string,
): Promise<boolean> {
  inst.stats.tradesAttempted++;

  if (DRY_RUN) {
    const sizeUsd = Number(size) / 1_000_000;
    log(`${inst.symbol}/${inst.profile.name}`, `[DRY] ${label}: $${sizeUsd.toFixed(2)}`);
    inst.stats.tradesSucceeded++;
    return true;
  }

  try {
    const [lpPda] = deriveLpPda(PROGRAM_ID, inst.slabAddress, inst.lpIdx);

    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      inst.wallet.publicKey,
      inst.slabAddress,
      SYSVAR_CLOCK_PUBKEY,
      inst.slabAddress,
    ]);
    const crankIx = buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData });

    const tradeData = encodeTradeCpi({
      lpIdx: inst.lpIdx,
      userIdx: inst.userIdx,
      size: size.toString(),
    });
    const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      inst.wallet.publicKey,
      inst.lpOwner,
      inst.slabAddress,
      inst.slabAddress,
      inst.matcherProgram,
      inst.matcherContext,
      lpPda,
    ]);
    const tradeIx = buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData });

    const sig = await sendTx([crankIx, tradeIx], [inst.wallet], 600_000);
    inst.positionSize += size;
    inst.stats.tradesSucceeded++;

    const sizeUsd = Number(size) / 1_000_000;
    log(
      `${inst.symbol}/${inst.profile.name}`,
      `✅ ${label}: $${sizeUsd.toFixed(2)} — ${sig.slice(0, 12)}...`,
    );
    return true;
  } catch (e: any) {
    inst.stats.tradesFailed++;
    log(
      `${inst.symbol}/${inst.profile.name}`,
      `❌ ${label}: ${e.message?.slice(0, 80)}`,
    );
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Quote Cycle (per instance)
// ═══════════════════════════════════════════════════════════════

async function runQuoteCycle(inst: FleetInstance): Promise<void> {
  if (inst.busy) return;
  inst.busy = true;
  const cycleStart = Date.now();

  try {
    inst.stats.quoteCycles++;

    // Fetch price (cached across instances)
    const priceData = await fetchPrice(inst.symbol);
    if (!priceData) {
      log(`${inst.symbol}/${inst.profile.name}`, "⚠ No price, skipping");
      return;
    }

    // Push oracle if authority mode (deduped per market)
    await pushOracleIfNeeded(inst, priceData.price);

    // Refresh position from chain (every 5th cycle to save RPC calls)
    if (inst.stats.quoteCycles % 5 === 1) {
      try {
        const slabInfo = await connection.getAccountInfo(inst.slabAddress);
        if (slabInfo) {
          const accounts = parseAllAccounts(slabInfo.data);
          const userAcc = accounts.find(
            (a) =>
              a.idx === inst.userIdx &&
              a.account.kind === 0 &&
              a.account.owner.equals(inst.wallet.publicKey),
          );
          if (userAcc) {
            inst.positionSize = userAcc.account.position ?? inst.positionSize;
            inst.collateral = userAcc.account.collateral ?? inst.collateral;
          }
        }
      } catch {
        /* non-fatal */
      }
    }

    // Calculate quotes using profile parameters
    const { bidPrice, askPrice, bidSize, askSize, skewFactor, effectiveSpreadBps } =
      calculateProfileQuotes(
        inst.profile,
        priceData.price,
        inst.positionSize,
        inst.collateral,
      );

    // Update stats
    inst.stats.lastOraclePrice = priceData.price;
    inst.stats.lastBidPrice = bidPrice;
    inst.stats.lastAskPrice = askPrice;
    inst.stats.lastSkewPct = skewFactor * 100;

    const posUsd = Number(inst.positionSize) / 1_000_000;
    log(
      `${inst.symbol}/${inst.profile.name}`,
      `$${priceData.price.toFixed(2)} | bid=$${bidPrice.toFixed(4)} ask=$${askPrice.toFixed(4)} | spread=${effectiveSpreadBps.toFixed(1)}bps | pos=$${posUsd.toFixed(0)} | skew=${(skewFactor * 100).toFixed(1)}%`,
    );

    // Execute bid
    if (bidSize > 0n) {
      await executeTrade(inst, bidSize, `BID@${bidPrice.toFixed(2)}`);
    }

    // Small stagger between bid and ask
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));

    // Execute ask
    if (askSize > 0n) {
      await executeTrade(inst, -askSize, `ASK@${askPrice.toFixed(2)}`);
    }
  } catch (e: any) {
    log(
      `${inst.symbol}/${inst.profile.name}`,
      `❌ Cycle error: ${e.message?.slice(0, 100)}`,
    );
  } finally {
    inst.stats.lastCycleMs = Date.now() - cycleStart;
    inst.busy = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Scheduling — each instance runs independently
// ═══════════════════════════════════════════════════════════════

function startInstance(inst: FleetInstance): void {
  const jitter = Math.floor(Math.random() * inst.profile.jitterMs);

  const scheduleNext = () => {
    if (!running) return;
    const interval =
      inst.profile.quoteIntervalMs +
      Math.floor(Math.random() * inst.profile.jitterMs);
    inst.timerHandle = setTimeout(async () => {
      await runQuoteCycle(inst);
      scheduleNext();
    }, interval);
  };

  // Stagger initial start so instances don't all fire at once
  setTimeout(() => {
    runQuoteCycle(inst).then(scheduleNext);
  }, jitter);
}

function stopInstance(inst: FleetInstance): void {
  if (inst.timerHandle) {
    clearTimeout(inst.timerHandle);
    inst.timerHandle = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Prometheus Metrics (optional)
// ═══════════════════════════════════════════════════════════════

function startMetricsServer(port: number, instances: FleetInstance[]) {
  const server = http.createServer((req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404);
      res.end();
      return;
    }

    const lines: string[] = [
      "# HELP mm_fleet_quote_cycles Total quote cycles per instance",
      "# TYPE mm_fleet_quote_cycles counter",
    ];

    for (const inst of instances) {
      const labels = `symbol="${inst.symbol}",profile="${inst.profile.name}"`;
      lines.push(`mm_fleet_quote_cycles{${labels}} ${inst.stats.quoteCycles}`);
    }

    lines.push("# HELP mm_fleet_trades_total Total trades attempted");
    lines.push("# TYPE mm_fleet_trades_total counter");
    for (const inst of instances) {
      const labels = `symbol="${inst.symbol}",profile="${inst.profile.name}"`;
      lines.push(`mm_fleet_trades_total{${labels},result="success"} ${inst.stats.tradesSucceeded}`);
      lines.push(`mm_fleet_trades_total{${labels},result="failed"} ${inst.stats.tradesFailed}`);
    }

    lines.push("# HELP mm_fleet_position_usd Current position in USD");
    lines.push("# TYPE mm_fleet_position_usd gauge");
    for (const inst of instances) {
      const labels = `symbol="${inst.symbol}",profile="${inst.profile.name}"`;
      const posUsd = Number(inst.positionSize) / 1_000_000;
      lines.push(`mm_fleet_position_usd{${labels}} ${posUsd.toFixed(2)}`);
    }

    lines.push("# HELP mm_fleet_last_cycle_ms Last cycle duration in ms");
    lines.push("# TYPE mm_fleet_last_cycle_ms gauge");
    for (const inst of instances) {
      const labels = `symbol="${inst.symbol}",profile="${inst.profile.name}"`;
      lines.push(`mm_fleet_last_cycle_ms{${labels}} ${inst.stats.lastCycleMs}`);
    }

    lines.push("# HELP mm_fleet_skew_pct Current skew percentage");
    lines.push("# TYPE mm_fleet_skew_pct gauge");
    for (const inst of instances) {
      const labels = `symbol="${inst.symbol}",profile="${inst.profile.name}"`;
      lines.push(`mm_fleet_skew_pct{${labels}} ${inst.stats.lastSkewPct.toFixed(2)}`);
    }

    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(lines.join("\n") + "\n");
  });

  server.listen(port, () => {
    log("metrics", `Prometheus metrics at http://localhost:${port}/metrics`);
  });
}

// ═══════════════════════════════════════════════════════════════
// Dashboard Printer
// ═══════════════════════════════════════════════════════════════

function printDashboard(instances: FleetInstance[]) {
  const elapsed = Math.floor((Date.now() - globalStartedAt) / 1000);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;

  const totalTrades = instances.reduce(
    (sum, i) => sum + i.stats.tradesSucceeded,
    0,
  );
  const totalFailed = instances.reduce(
    (sum, i) => sum + i.stats.tradesFailed,
    0,
  );

  console.log("\n" + "═".repeat(72));
  console.log(
    `  MM Fleet Dashboard | Uptime: ${min}m${sec}s | Trades: ${totalTrades}/${totalTrades + totalFailed} ok | ${instances.length} instances`,
  );
  console.log("─".repeat(72));
  console.log(
    "  Market    Profile   Oracle      Bid         Ask         Pos       Skew",
  );
  console.log("─".repeat(72));

  for (const inst of instances) {
    const posUsd = Number(inst.positionSize) / 1_000_000;
    console.log(
      `  ${inst.symbol.padEnd(8)}  ${inst.profile.name.padEnd(8)}  ` +
        `$${inst.stats.lastOraclePrice.toFixed(2).padStart(9)}  ` +
        `$${inst.stats.lastBidPrice.toFixed(2).padStart(9)}  ` +
        `$${inst.stats.lastAskPrice.toFixed(2).padStart(9)}  ` +
        `$${posUsd.toFixed(0).padStart(7)}  ` +
        `${inst.stats.lastSkewPct.toFixed(1).padStart(5)}%`,
    );
  }
  console.log("═".repeat(72) + "\n");
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

let running = true;
let globalStartedAt = Date.now();

process.on("SIGINT", () => {
  log("main", "Shutting down...");
  running = false;
});
process.on("SIGTERM", () => {
  log("main", "Shutting down...");
  running = false;
});

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  PERC-366/368: Market Maker Fleet                            ║
║  Multi-profile oracle-anchored MM with keeper wallets        ║
║  Profiles: ${activeProfiles.map((p) => p.name).join(", ").padEnd(48)}║
╚══════════════════════════════════════════════════════════════╝
`);

  globalStartedAt = Date.now();

  // Load fallback wallet
  const KP_PATH =
    process.env.BOOTSTRAP_KEYPAIR ?? "/tmp/bootstrap-wallet.json";
  try {
    fleetWallet = loadKeypair(KP_PATH);
    log("main", `Fallback wallet: ${fleetWallet.publicKey.toBase58()}`);
  } catch (e: any) {
    // If no fallback wallet and no per-profile wallets configured, fail
    if (!process.env.KEEPER_WALLETS_DIR && !activeProfiles.some(p => process.env[`KEEPER_WALLET_${p.name}`])) {
      console.error(`❌ Failed to load keypair from ${KP_PATH}: ${e.message}`);
      console.error("Set BOOTSTRAP_KEYPAIR, KEEPER_WALLETS_DIR, or KEEPER_WALLET_<PROFILE> env vars");
      process.exit(1);
    }
    log("main", "No fallback wallet — using per-profile wallets only");
    fleetWallet = Keypair.generate(); // dummy, won't be used
  }

  // PERC-368: Load per-profile keeper wallets
  loadProfileWallets();

  // Check balances for all unique wallets
  const uniqueWallets = new Map<string, { name: string; kp: Keypair }>();
  for (const profile of activeProfiles) {
    const w = getWallet(profile.name);
    const key = w.publicKey.toBase58();
    if (!uniqueWallets.has(key)) {
      uniqueWallets.set(key, { name: profile.name, kp: w });
    } else {
      const existing = uniqueWallets.get(key)!;
      existing.name += `+${profile.name}`;
    }
  }

  for (const [pubkey, { name, kp }] of uniqueWallets) {
    const balance = await connection.getBalance(kp.publicKey);
    const balSol = balance / 1e9;
    log("main", `${name} wallet ${pubkey.slice(0, 8)}...: ${balSol.toFixed(4)} SOL`);
    if (balSol < 0.05) {
      log("main", `⚠ ${name}: Low SOL — needs more for txs`);
    }
  }

  log("main", `Profiles: ${activeProfiles.map((p) => `${p.name}(${p.spreadBps}bps)`).join(", ")}`);
  if (DRY_RUN) log("main", "🔸 DRY RUN MODE");
  if (MARKETS_FILTER) log("main", `🔸 Markets: ${MARKETS_FILTER.join(", ")}`);

  // Discover markets and create instances
  let instances = await discoverAndSetup();
  if (instances.length === 0) {
    log("main", "No instances created. Retrying in 30s...");
    await new Promise((r) => setTimeout(r, 30_000));
    instances = await discoverAndSetup();
    if (instances.length === 0) {
      log("main", "Still nothing. Exiting.");
      process.exit(1);
    }
  }

  const marketCount = new Set(instances.map((i) => i.slabAddress.toBase58())).size;
  log(
    "main",
    `🚀 Starting fleet: ${instances.length} instances across ${marketCount} market(s)`,
  );

  // Start all instances
  for (const inst of instances) {
    startInstance(inst);
  }

  // Prometheus metrics
  if (PROMETHEUS_PORT) {
    startMetricsServer(PROMETHEUS_PORT, instances);
  }

  // Dashboard printer every 60s
  const dashInterval = setInterval(() => {
    if (running) printDashboard(instances);
  }, 60_000);

  // Re-discovery every 5 minutes
  const rediscoverInterval = setInterval(async () => {
    if (!running) return;
    try {
      const newInstances = await discoverAndSetup();
      for (const ni of newInstances) {
        const exists = instances.find(
          (i) =>
            i.slabAddress.equals(ni.slabAddress) &&
            i.profile.name === ni.profile.name,
        );
        if (!exists) {
          instances.push(ni);
          startInstance(ni);
          log("main", `📊 New: ${ni.symbol}/${ni.profile.name}`);
        }
      }
    } catch (e: any) {
      log("main", `⚠ Re-discovery error: ${e.message?.slice(0, 60)}`);
    }
  }, 5 * 60_000);

  // Keep process alive
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });

  // Cleanup
  clearInterval(dashInterval);
  clearInterval(rediscoverInterval);
  for (const inst of instances) {
    stopInstance(inst);
  }

  printDashboard(instances);
  log("main", "Fleet stopped.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

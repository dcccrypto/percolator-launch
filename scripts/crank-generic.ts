/**
 * Generic multi-market crank bot
 *
 * Discovers all Percolator markets on-chain, fetches prices for each,
 * and cranks them. Supports both admin oracle and Pyth oracle markets.
 *
 * Usage: npx tsx scripts/crank-generic.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SYSVAR_CLOCK_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as dotenv from "dotenv";
import {
  encodeKeeperCrank,
  encodePushOraclePrice,
} from "../packages/core/src/abi/instructions.js";
import {
  buildAccountMetas,
  buildKeeperCrankAccounts,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_PUSH_ORACLE_PRICE,
} from "../packages/core/src/abi/accounts.js";
import { buildIx } from "../packages/core/src/runtime/tx.js";
import { discoverMarkets, type DiscoveredMarket } from "../packages/core/src/solana/discovery.js";
import { derivePythPushOraclePDA } from "../packages/core/src/solana/pda.js";
import {
  detectDexType,
  parseDexPool,
  type DexType,
  type DexPoolInfo,
} from "../packages/core/src/solana/dex-oracle.js";

dotenv.config();

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24");
const CRANK_INTERVAL_MS = 5_000;
const DISCOVERY_INTERVAL_MS = 60_000;
const PRICE_FETCH_INTERVAL_MS = 10_000;
const PRIORITY_FEE = 50_000;

const ALL_ZEROS = new PublicKey("11111111111111111111111111111111");

const keypairPath = process.env.ADMIN_KEYPAIR_PATH || "./admin-keypair.json";
const raw = fs.readFileSync(keypairPath, "utf-8");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
const connection = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

// Per-market price cache
const priceCache = new Map<string, { priceE6: number; fetchedAt: number }>();

type OracleType = "admin" | "pyth" | DexType;

function isAdminOracle(market: DiscoveredMarket): boolean {
  const feedId = market.config.indexFeedId;
  return feedId.equals(ALL_ZEROS) || feedId.equals(PublicKey.default);
}

// Cache of resolved oracle types per market
const oracleTypeCache = new Map<string, { type: OracleType; poolInfo?: DexPoolInfo }>();

async function resolveOracleType(market: DiscoveredMarket): Promise<{ type: OracleType; poolInfo?: DexPoolInfo }> {
  if (isAdminOracle(market)) return { type: "admin" };

  const key = market.slabAddress.toBase58();
  const cached = oracleTypeCache.get(key);
  if (cached) return cached;

  const feedPk = market.config.indexFeedId;
  try {
    const info = await connection.getAccountInfo(feedPk);
    if (info) {
      const dex = detectDexType(new PublicKey(info.owner));
      if (dex) {
        const poolInfo = parseDexPool(dex, feedPk, new Uint8Array(info.data));
        const result = { type: dex as OracleType, poolInfo };
        oracleTypeCache.set(key, result);
        return result;
      }
    }
  } catch {
    // Fall through to Pyth
  }

  const result = { type: "pyth" as OracleType };
  oracleTypeCache.set(key, result);
  return result;
}

async function fetchDexScreenerPrice(mint: string): Promise<number> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "percolator-crank/2.0" },
    signal: AbortSignal.timeout(5000),
  });
  const json = (await resp.json()) as any;
  const pairs = json.pairs || [];
  if (pairs.length === 0) {
    throw new Error(`No pairs found on DexScreener for ${mint.slice(0, 8)}...`);
  }
  const sorted = pairs.sort(
    (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0),
  );
  return parseFloat(sorted[0].priceUsd);
}

async function getPrice(mint: string): Promise<number> {
  const now = Date.now();
  const cached = priceCache.get(mint);
  if (cached && now - cached.fetchedAt < PRICE_FETCH_INTERVAL_MS && cached.priceE6 > 0) {
    return cached.priceE6;
  }
  try {
    const price = await fetchDexScreenerPrice(mint);
    const priceE6 = Math.max(Math.round(price * 1_000_000), 1);
    priceCache.set(mint, { priceE6, fetchedAt: now });
    return priceE6;
  } catch (err: any) {
    if (cached && cached.priceE6 > 0) {
      console.warn(`  Price fetch failed for ${mint.slice(0, 8)}... (using cached ${cached.priceE6}): ${err.message}`);
      return cached.priceE6;
    }
    throw err;
  }
}

async function crankMarket(market: DiscoveredMarket): Promise<string> {
  const slab = market.slabAddress;
  const mint = market.config.collateralMint.toBase58();
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));

  const { type: oracleType, poolInfo } = await resolveOracleType(market);

  if (oracleType === "admin") {
    // Admin oracle: fetch price + push + crank
    const priceE6 = await getPrice(mint);
    const now = Math.floor(Date.now() / 1000);

    const pushData = encodePushOraclePrice({ priceE6: priceE6.toString(), timestamp: now.toString() });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, slab]);
    tx.add(buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }));

    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildKeeperCrankAccounts(
      payer.publicKey, slab, SYSVAR_CLOCK_PUBKEY, slab,
    );
    tx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  } else if (oracleType === "pyth") {
    // Pyth oracle: derive Push Oracle PDA from feed ID, then just crank.
    const feedIdHex = Buffer.from(market.config.indexFeedId.toBytes()).toString("hex");
    const [pythOraclePDA] = derivePythPushOraclePDA(feedIdHex);

    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildKeeperCrankAccounts(
      payer.publicKey, slab, SYSVAR_CLOCK_PUBKEY, pythOraclePDA,
    );
    tx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  } else {
    // DEX oracle: pass pool account directly, program reads price on-chain.
    // For PumpSwap, also pass vault accounts as remaining accounts.
    const poolAddress = market.config.indexFeedId;
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });

    const extraAccounts: PublicKey[] = [];
    if (oracleType === "pumpswap" && poolInfo?.baseVault && poolInfo?.quoteVault) {
      extraAccounts.push(poolInfo.baseVault, poolInfo.quoteVault);
    }

    const crankKeys = buildKeeperCrankAccounts(
      payer.publicKey, slab, SYSVAR_CLOCK_PUBKEY, poolAddress, extraAccounts,
    );
    tx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
    skipPreflight: true,
  });
  return sig;
}

async function main() {
  console.log("Percolator Generic Multi-Market Crank Bot\n");
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  console.log(`Crank interval: ${CRANK_INTERVAL_MS / 1000}s`);
  console.log(`Discovery interval: ${DISCOVERY_INTERVAL_MS / 1000}s\n`);

  let markets: DiscoveredMarket[] = [];
  let lastDiscovery = 0;
  let crankCount = 0;

  while (true) {
    // Re-discover markets periodically
    const now = Date.now();
    if (now - lastDiscovery >= DISCOVERY_INTERVAL_MS || markets.length === 0) {
      try {
        markets = await discoverMarkets(connection, PROGRAM_ID);
        lastDiscovery = now;
        console.log(`[${new Date().toISOString()}] Discovered ${markets.length} market(s)`);
        for (const m of markets) {
          const mint = m.config.collateralMint.toBase58();
          const resolved = await resolveOracleType(m);
          const slabLabel = m.slabAddress.toBase58().slice(0, 12);
          if (resolved.type === "admin") {
            console.log(`  ${slabLabel}... mint=${mint.slice(0, 8)}... oracle=Admin`);
          } else if (resolved.type === "pyth") {
            const feedHex = Buffer.from(m.config.indexFeedId.toBytes()).toString("hex");
            const [pda] = derivePythPushOraclePDA(feedHex);
            console.log(`  ${slabLabel}... mint=${mint.slice(0, 8)}... oracle=Pyth feed=${feedHex.slice(0, 12)}... pda=${pda.toBase58().slice(0, 12)}...`);
          } else {
            const poolAddr = m.config.indexFeedId.toBase58();
            console.log(`  ${slabLabel}... mint=${mint.slice(0, 8)}... oracle=DEX(${resolved.type}) pool=${poolAddr.slice(0, 12)}...`);
          }
        }
      } catch (err: any) {
        console.error(`[${new Date().toISOString()}] Discovery error: ${err.message}`);
        if (markets.length === 0) {
          await new Promise((r) => setTimeout(r, CRANK_INTERVAL_MS));
          continue;
        }
      }
    }

    // Crank each market independently
    for (const market of markets) {
      const label = `${market.slabAddress.toBase58().slice(0, 8)}...`;
      try {
        const sig = await crankMarket(market);
        crankCount++;
        const resolved = await resolveOracleType(market);
        const oracleLabel = resolved.type;
        const mint = market.config.collateralMint.toBase58();
        const cached = priceCache.get(mint);
        const priceStr = cached ? `$${(cached.priceE6 / 1_000_000).toFixed(6)}` : "(on-chain)";
        console.log(`[${new Date().toISOString()}] #${crankCount} ${label} [${oracleLabel}] ${priceStr} ${sig.slice(0, 16)}...`);
      } catch (err: any) {
        const msg = err.logs ? err.logs.join("\n  ") : err.message?.slice(0, 200) || String(err);
        console.error(`[${new Date().toISOString()}] ${label} Error:\n  ${msg}`);
      }
    }

    await new Promise((r) => setTimeout(r, CRANK_INTERVAL_MS));
  }
}

main().catch(console.error);

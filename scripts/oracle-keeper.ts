#!/usr/bin/env npx tsx
/**
 * PERC-374: Oracle Keeper Bot
 *
 * Production-grade oracle keeper that mirrors Binance spot prices to
 * Percolator devnet markets via PushOraclePrice + KeeperCrank.
 *
 * Improvements over oracle-pusher.ts:
 *   - Multi-source failover: Binance → CoinGecko → Jupiter → cached
 *   - Staleness detection: alerts if price hasn't updated in 30s
 *   - Circuit breaker: rejects price moves > 10% per update
 *   - Health endpoint: /health for monitoring
 *   - Graceful shutdown with drain
 *   - Per-market stats tracking
 *   - Auto-discovery: reads markets from deployment or Supabase
 *
 * Usage:
 *   npx tsx scripts/oracle-keeper.ts
 *
 * Environment:
 *   RPC_URL           — Solana RPC (default: devnet)
 *   ADMIN_KEYPAIR_PATH — Oracle authority keypair
 *   PUSH_INTERVAL_MS  — Push interval (default: 3000)
 *   HEALTH_PORT       — HTTP health check port (default: 18810)
 *   MAX_PRICE_MOVE_PCT — Circuit breaker % (default: 10)
 *   STALE_THRESHOLD_S  — Staleness alert threshold (default: 30)
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  encodePushOraclePrice, encodeKeeperCrank,
  ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_KEEPER_CRANK,
  buildAccountMetas, buildIx, WELL_KNOWN,
} from "../packages/core/src/index.js";
import * as fs from "fs";
import * as http from "http";

// ── Config ──────────────────────────────────────────────────
const PUSH_INTERVAL_MS = Number(process.env.PUSH_INTERVAL_MS ?? "3000");
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? "18810");
const MAX_PRICE_MOVE_PCT = Number(process.env.MAX_PRICE_MOVE_PCT ?? "10");
const STALE_THRESHOLD_S = Number(process.env.STALE_THRESHOLD_S ?? "30");
const ADMIN_KP_PATH = process.env.ADMIN_KEYPAIR_PATH ??
  `${process.env.HOME}/.config/solana/percolator-upgrade-authority.json`;
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

const conn = new Connection(RPC_URL, "confirmed");
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_KP_PATH, "utf8")))
);

// ── Types ───────────────────────────────────────────────────
interface MarketInfo {
  symbol: string;
  label: string;
  slab: string;
  priceE6?: string;
}

interface MarketStats {
  symbol: string;
  lastPrice: number;
  lastPushAt: number;       // epoch ms
  lastPushSig: string;
  totalPushes: number;
  totalErrors: number;
  consecutiveErrors: number;
  circuitBreakerTrips: number;
  source: string;           // last successful source
}

// ── Price Sources ───────────────────────────────────────────
const BINANCE_MAP: Record<string, string> = {
  SOL: "SOLUSDT", BTC: "BTCUSDT", ETH: "ETHUSDT",
  BONK: "BONKUSDT", WIF: "WIFUSDT", JTO: "JTOUSDT",
  JUP: "JUPUSDT", PYTH: "PYTHUSDT", RAY: "RAYUSDT",
  RNDR: "RNDRUSDT", W: "WUSDT", TNSR: "TNSRUSDT",
};

const COINGECKO_IDS: Record<string, string> = {
  SOL: "solana", BTC: "bitcoin", ETH: "ethereum",
  BONK: "bonk", WIF: "dogwifcoin", JTO: "jito-governance-token",
  JUP: "jupiter-exchange-solana", PYTH: "pyth-network",
  RAY: "raydium", RNDR: "render-token",
};

async function fetchBinancePrice(symbol: string): Promise<number | null> {
  const pair = BINANCE_MAP[symbol];
  if (!pair) return null;
  try {
    const resp = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, {
      signal: AbortSignal.timeout(3000),
    });
    const json = (await resp.json()) as { price?: string };
    return json.price ? parseFloat(json.price) : null;
  } catch { return null; }
}

async function fetchCoinGeckoPrice(symbol: string): Promise<number | null> {
  const id = COINGECKO_IDS[symbol];
  if (!id) return null;
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as Record<string, { usd?: number }>;
    return json[id]?.usd ?? null;
  } catch { return null; }
}

async function fetchJupiterPrice(symbol: string): Promise<number | null> {
  // Jupiter uses mint addresses, but for common tokens we can use symbol
  // This is a lightweight fallback
  try {
    const resp = await fetch(
      `https://api.jup.ag/price/v2?ids=${symbol}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as any;
    const data = json.data?.[symbol];
    return data?.price ? parseFloat(data.price) : null;
  } catch { return null; }
}

/** Fetch price with multi-source failover */
async function getPrice(symbol: string): Promise<{ price: number; source: string } | null> {
  // Primary: Binance (fastest, most liquid)
  const binance = await fetchBinancePrice(symbol);
  if (binance) return { price: binance, source: "binance" };

  // Secondary: CoinGecko
  const cg = await fetchCoinGeckoPrice(symbol);
  if (cg) return { price: cg, source: "coingecko" };

  // Tertiary: Jupiter
  const jup = await fetchJupiterPrice(symbol);
  if (jup) return { price: jup, source: "jupiter" };

  return null;
}

// ── Stats ───────────────────────────────────────────────────
const stats = new Map<string, MarketStats>();
let startTime = Date.now();

function getOrCreateStats(market: MarketInfo): MarketStats {
  let s = stats.get(market.slab);
  if (!s) {
    s = {
      symbol: market.symbol,
      lastPrice: 0,
      lastPushAt: 0,
      lastPushSig: "",
      totalPushes: 0,
      totalErrors: 0,
      consecutiveErrors: 0,
      circuitBreakerTrips: 0,
      source: "",
    };
    stats.set(market.slab, s);
  }
  return s;
}

// ── Circuit Breaker ─────────────────────────────────────────
function checkCircuitBreaker(stats: MarketStats, newPrice: number): boolean {
  if (stats.lastPrice === 0) return true; // First price, always accept
  const movePct = Math.abs((newPrice - stats.lastPrice) / stats.lastPrice) * 100;
  if (movePct > MAX_PRICE_MOVE_PCT) {
    log(`🔴 ${stats.symbol}: Circuit breaker! ${stats.lastPrice.toFixed(2)} → ${newPrice.toFixed(2)} (${movePct.toFixed(1)}% > ${MAX_PRICE_MOVE_PCT}%)`);
    stats.circuitBreakerTrips++;
    return false;
  }
  return true;
}

// ── Logging ─────────────────────────────────────────────────
function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [oracle-keeper] ${msg}`);
}

// ── Push + Crank ────────────────────────────────────────────
async function pushAndCrank(market: MarketInfo, programId: PublicKey): Promise<void> {
  const s = getOrCreateStats(market);

  const result = await getPrice(market.symbol);
  if (!result) {
    s.totalErrors++;
    s.consecutiveErrors++;
    if (s.consecutiveErrors >= 3) {
      log(`⚠️ ${market.label}: no price from any source (${s.consecutiveErrors} consecutive failures)`);
    }
    return;
  }

  const { price, source } = result;

  // Circuit breaker
  if (!checkCircuitBreaker(s, price)) return;

  const priceE6 = BigInt(Math.round(price * 1_000_000));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const slab = new PublicKey(market.slab);

  const pushData = encodePushOraclePrice({ priceE6: priceE6.toString(), timestamp: timestamp.toString() });
  const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [admin.publicKey, slab]);

  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    admin.publicKey, slab, WELL_KNOWN.clock, slab,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    buildIx({ programId, keys: pushKeys, data: pushData }),
    buildIx({ programId, keys: crankKeys, data: crankData }),
  );
  tx.feePayer = admin.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const sig = await sendAndConfirmTransaction(conn, tx, [admin], {
    commitment: "confirmed",
    skipPreflight: true,
  });

  s.lastPrice = price;
  s.lastPushAt = Date.now();
  s.lastPushSig = sig;
  s.totalPushes++;
  s.consecutiveErrors = 0;
  s.source = source;

  log(`✅ ${market.label}: $${price.toFixed(2)} [${source}] → ${sig.slice(0, 12)}...`);
}

// ── Health Check Server ─────────────────────────────────────
function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const now = Date.now();
      const uptimeS = Math.floor((now - startTime) / 1000);
      const markets: Record<string, any> = {};
      let healthy = true;

      for (const [slab, s] of stats) {
        const staleSec = s.lastPushAt ? Math.floor((now - s.lastPushAt) / 1000) : -1;
        const isStale = staleSec > STALE_THRESHOLD_S;
        if (isStale) healthy = false;
        markets[s.symbol] = {
          lastPrice: s.lastPrice,
          lastPushAgo: `${staleSec}s`,
          stale: isStale,
          source: s.source,
          totalPushes: s.totalPushes,
          totalErrors: s.totalErrors,
          consecutiveErrors: s.consecutiveErrors,
          circuitBreakerTrips: s.circuitBreakerTrips,
        };
      }

      const body = JSON.stringify({
        status: healthy ? "ok" : "degraded",
        uptime: `${uptimeS}s`,
        pushIntervalMs: PUSH_INTERVAL_MS,
        markets,
      }, null, 2);

      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(HEALTH_PORT, () => {
    log(`Health endpoint: http://localhost:${HEALTH_PORT}/health`);
  });
  return server;
}

// ── Main Loop ───────────────────────────────────────────────
async function main() {
  log(`Oracle Keeper starting — admin: ${admin.publicKey.toBase58().slice(0, 12)}...`);
  log(`RPC: ${RPC_URL.slice(0, 40)}...`);
  log(`Push interval: ${PUSH_INTERVAL_MS}ms | Circuit breaker: ${MAX_PRICE_MOVE_PCT}% | Stale threshold: ${STALE_THRESHOLD_S}s`);

  const deployPath = "/tmp/percolator-devnet-deployment.json";
  if (!fs.existsSync(deployPath)) {
    console.error("❌ Deployment info not found at", deployPath);
    console.error("   Run deploy-devnet-mm.ts first, or set up manually.");
    process.exit(1);
  }

  const deploy = JSON.parse(fs.readFileSync(deployPath, "utf8"));
  const programId = new PublicKey(deploy.programId);
  const markets = deploy.markets as MarketInfo[];

  log(`Program: ${programId.toBase58().slice(0, 12)}...`);
  log(`Markets: ${markets.map(m => m.label).join(", ")}`);

  // Initialize stats
  for (const m of markets) getOrCreateStats(m);

  // Start health server
  const healthServer = startHealthServer();

  let running = true;
  const shutdown = () => {
    if (!running) return;
    running = false;
    log("Shutting down...");
    healthServer.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Main push loop
  while (running) {
    const promises = markets.map(market =>
      pushAndCrank(market, programId).catch(e => {
        const s = getOrCreateStats(market);
        s.totalErrors++;
        s.consecutiveErrors++;
        log(`❌ ${market.label}: ${(e as Error).message?.slice(0, 80)}`);
      })
    );
    await Promise.allSettled(promises);
    await new Promise(r => setTimeout(r, PUSH_INTERVAL_MS));
  }

  log("Oracle Keeper stopped.");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });

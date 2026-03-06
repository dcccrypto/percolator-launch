#!/usr/bin/env npx tsx
/**
 * PERC-374: Oracle Keeper Bot
 *
 * Production-grade oracle keeper that mirrors Binance spot prices to
 * Percolator devnet markets via PushOraclePrice + KeeperCrank.
 *
 * Improvements over oracle-pusher.ts:
 *   - Multi-source failover: Pyth Hermes → Jupiter → DexScreener
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
 *   HEALTH_BIND       — Bind address for health server (default: 127.0.0.1)
 *   HEALTH_AUTH_TOKEN — Bearer token for health endpoint auth (optional but recommended)
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
  fetchSlab, parseConfig,
} from "@percolator/sdk";
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
// Support inline keypair via ADMIN_KEYPAIR env var (JSON array) for Railway/Docker deployments
const adminSecretKey = process.env.ADMIN_KEYPAIR
  ? Uint8Array.from(JSON.parse(process.env.ADMIN_KEYPAIR))
  : Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_KP_PATH, "utf8")));
const admin = Keypair.fromSecretKey(adminSecretKey);

// Security: scrub keypair material from environment to prevent leaks via
// process inspection, child processes, or crash dumps
if (process.env.ADMIN_KEYPAIR) {
  delete process.env.ADMIN_KEYPAIR;
}

// Pyth Hermes endpoint (free, no API key required)
const HERMES_URL = process.env.HERMES_URL ?? "https://hermes.pyth.network";
// Health endpoint security (from security hardening #616)
const HEALTH_BIND = process.env.HEALTH_BIND ?? "127.0.0.1";
const HEALTH_AUTH_TOKEN = process.env.HEALTH_AUTH_TOKEN ?? "";

// Track markets where we're not the oracle authority (skip future attempts)
const skippedMarkets = new Set<string>();
// Track markets where oracle authority has been successfully verified
const authorityVerified = new Set<string>();

// ── Supabase Auto-Discovery ─────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DISCOVERY_INTERVAL_MS = Number(process.env.DISCOVERY_INTERVAL_MS ?? "30000"); // 30s

const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

/** Lightweight Supabase REST query — no client library needed */
async function supabaseQuery(table: string, params: string): Promise<any[] | null> {
  if (!supabaseEnabled) return null;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?${params}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

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

// Pyth Network feed IDs (hex, without 0x prefix) — universal across all chains
const PYTH_FEED_IDS: Record<string, string> = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BONK: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
  WIF: "4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc",
  JTO: "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
  JUP: "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  PYTH: "0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff",
  RAY: "91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a",
  W: "eff7446475e218517566ea99e72a4abec2e1bd8498b43b7d8331e29dcb059389",
  TNSR: "05ecd4597cd48fe13d6cc3596c62af4f9675aee06e2e0b94c06d8bee2b659e05",
};

// Jupiter mint addresses — fallback for tokens not on Pyth
const JUPITER_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  RNDR: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",
};

/** Batch-fetch prices from Pyth Hermes REST API */
const pythCache = new Map<string, { price: number; ts: number }>();

async function fetchPythPrices(symbols: string[]): Promise<void> {
  const ids = symbols
    .map(s => PYTH_FEED_IDS[s])
    .filter(Boolean);
  if (ids.length === 0) return;

  try {
    const params = ids.map(id => `ids[]=${id}`).join("&");
    const resp = await fetch(
      `${HERMES_URL}/v2/updates/price/latest?${params}&parsed=true`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) {
      log(`⚠️ Pyth Hermes returned ${resp.status}`);
      return;
    }
    const json = (await resp.json()) as {
      parsed: Array<{
        id: string;
        price: { price: string; expo: number; publish_time: number };
      }>;
    };

    // Build reverse map: feedId → symbol
    const idToSymbol = new Map<string, string>();
    for (const [sym, id] of Object.entries(PYTH_FEED_IDS)) {
      idToSymbol.set(id, sym);
    }

    for (const entry of json.parsed) {
      const sym = idToSymbol.get(entry.id);
      if (!sym) continue;
      const rawPrice = parseInt(entry.price.price, 10);
      const expo = entry.price.expo;
      const price = rawPrice * Math.pow(10, expo);
      // Use Pyth's publish_time as the cache timestamp (not fetch time).
      // This ensures getPythPrice's 30s staleness check operates against the
      // actual Pyth oracle clock, not the moment we fetched the HTTP response.
      // Reject prices Pyth hasn't updated in 60s — they are stale at the source.
      const publishMs = entry.price.publish_time * 1000;
      const ageMs = Date.now() - publishMs;
      if (price > 0 && ageMs >= 0 && ageMs < 60_000) {
        pythCache.set(sym, { price, ts: publishMs });
      } else if (price > 0) {
        log(`⚠️ ${sym}: Pyth publish_time is ${Math.floor(ageMs / 1000)}s old — rejecting stale price`);
      }
    }
  } catch (e) {
    log(`⚠️ Pyth Hermes fetch failed: ${(e as Error).message?.slice(0, 60)}`);
  }
}

function getPythPrice(symbol: string): number | null {
  const cached = pythCache.get(symbol);
  if (!cached) return null;
  // Reject if older than 30s
  if (Date.now() - cached.ts > 30_000) return null;
  return cached.price;
}

/** Jupiter price fallback (uses mint addresses) */
async function fetchJupiterPrice(symbol: string): Promise<number | null> {
  const mint = JUPITER_MINTS[symbol];
  if (!mint) return null;
  try {
    const resp = await fetch(
      `https://api.jup.ag/price/v2?ids=${mint}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as any;
    const data = json.data?.[mint];
    return data?.price ? parseFloat(data.price) : null;
  } catch { return null; }
}

/** DexScreener fallback for custom/exotic tokens */
async function fetchDexScreenerPrice(symbol: string): Promise<number | null> {
  const mint = JUPITER_MINTS[symbol];
  if (!mint) return null;
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as any;
    const pair = json.pairs?.[0];
    return pair?.priceUsd ? parseFloat(pair.priceUsd) : null;
  } catch { return null; }
}

/** Fetch price with multi-source failover: Pyth → Jupiter → DexScreener → CA lookup */
async function getPrice(symbol: string, slab?: string): Promise<{ price: number; source: string } | null> {
  // Primary: Pyth (decentralized oracle, fastest for supported tokens)
  const pyth = getPythPrice(symbol);
  if (pyth) return { price: pyth, source: "pyth" };

  // Secondary: Jupiter (Solana DEX aggregator, uses mint addresses)
  const jup = await fetchJupiterPrice(symbol);
  if (jup) return { price: jup, source: "jupiter" };

  // Tertiary: DexScreener (broad coverage for exotic tokens)
  const dex = await fetchDexScreenerPrice(symbol);
  if (dex) return { price: dex, source: "dexscreener" };

  // Quaternary: Direct CA lookup for dynamic markets (PERC-465)
  if (slab) {
    const ca = slabToMainnetCA.get(slab);
    if (ca) {
      const caPrice = await fetchPriceByCA(ca);
      if (caPrice) return caPrice;
    }
  }

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

  // Skip markets where we've already confirmed we're not the oracle authority
  if (skippedMarkets.has(market.slab)) return;

  // Validate oracle authority on-chain: run on first attempt, or every 50 errors
  // (catches cases where fetchSlab failed transiently on the first check)
  const needsAuthorityCheck = !authorityVerified.has(market.slab) &&
    (s.totalErrors === 0 || s.totalErrors % 50 === 0);
  if (needsAuthorityCheck) {
    try {
      const slabData = await fetchSlab(conn, new PublicKey(market.slab));
      const cfg = parseConfig(slabData);
      if (!cfg.oracleAuthority.equals(admin.publicKey)) {
        log(`🚨 ${market.label}: ORACLE AUTHORITY MISMATCH — slab has ${cfg.oracleAuthority.toBase58()}, keeper is signing as ${admin.publicKey.toBase58()}. Needs reinit. Skipping.`);
        skippedMarkets.add(market.slab);
        return;
      }
      authorityVerified.add(market.slab);
      log(`✓ ${market.label}: oracle authority verified (${admin.publicKey.toBase58().slice(0, 12)}...)`);
    } catch (e) {
      log(`⚠️ ${market.label}: failed to verify oracle authority (attempt ${s.totalErrors + 1}): ${(e as Error).message?.slice(0, 80)}`);
      // Continue anyway — the tx will fail with a clear program error if authority is wrong
    }
  }

  const result = await getPrice(market.symbol, market.slab);
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
    // Auth guard: if HEALTH_AUTH_TOKEN is set, require Bearer token
    if (HEALTH_AUTH_TOKEN) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${HEALTH_AUTH_TOKEN}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

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

  server.listen(HEALTH_PORT, HEALTH_BIND, () => {
    log(`Health endpoint: http://${HEALTH_BIND}:${HEALTH_PORT}/health${HEALTH_AUTH_TOKEN ? " (auth required)" : ""}`);
  });
  return server;
}

// ── Supabase Market Discovery ───────────────────────────────
const knownSlabs = new Set<string>();

/**
 * Poll Supabase `markets` table for newly created markets with a mainnet_ca.
 * Returns new MarketInfo entries that aren't already tracked.
 */
async function discoverNewMarkets(): Promise<MarketInfo[]> {
  if (!supabaseEnabled) return [];
  try {
    const data = await supabaseQuery(
      "markets",
      "select=slab_address,mint_address,mainnet_ca,symbol,name&mainnet_ca=not.is.null",
    );

    if (!data) {
      log(`⚠️ Supabase discovery failed`);
      return [];
    }

    const newMarkets: MarketInfo[] = [];
    for (const row of data) {
      if (knownSlabs.has(row.slab_address)) continue;
      knownSlabs.add(row.slab_address);

      // Map mainnet CA to a symbol for price lookup
      // Use the stored symbol, or fall back to the DB name
      const symbol = row.symbol?.toUpperCase() ?? "UNKNOWN";
      newMarkets.push({
        symbol,
        label: `${symbol}-PERP (dynamic)`,
        slab: row.slab_address,
      });
    }
    return newMarkets;
  } catch (e) {
    log(`⚠️ Supabase discovery error: ${(e as Error).message?.slice(0, 80)}`);
    return [];
  }
}

/**
 * For dynamically discovered markets, we need to fetch prices by mainnet CA
 * since they may not be in PYTH_FEED_IDS or JUPITER_MINTS.
 * This fetches price directly using the mainnet CA via Jupiter Lite API.
 */
async function fetchPriceByCA(mainnetCA: string): Promise<{ price: number; source: string } | null> {
  try {
    const resp = await fetch(
      `https://api.jup.ag/price/v2?ids=${mainnetCA}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as any;
    const data = json.data?.[mainnetCA];
    if (data?.price) return { price: parseFloat(data.price), source: "jupiter-ca" };
  } catch {}

  // DexScreener fallback
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mainnetCA}`,
      { signal: AbortSignal.timeout(4000) },
    );
    const json = (await resp.json()) as any;
    const pair = json.pairs?.[0];
    if (pair?.priceUsd) return { price: parseFloat(pair.priceUsd), source: "dexscreener-ca" };
  } catch {}

  return null;
}

// Map slab address → mainnet CA for dynamic markets
const slabToMainnetCA = new Map<string, string>();

// ── Main Loop ───────────────────────────────────────────────
async function main() {
  log(`Oracle Keeper starting — admin: ${admin.publicKey.toBase58().slice(0, 12)}...`);
  // Redact RPC URL to prevent API key exposure in logs
  const rpcRedacted = (() => {
    try { const u = new URL(RPC_URL); return `${u.protocol}//${u.hostname}`; }
    catch { return "<invalid-url>"; }
  })();
  log(`RPC: ${rpcRedacted}`);
  log(`Push interval: ${PUSH_INTERVAL_MS}ms | Circuit breaker: ${MAX_PRICE_MOVE_PCT}% | Stale threshold: ${STALE_THRESHOLD_S}s`);

  const deployPath = "/tmp/percolator-devnet-deployment.json";
  let deployRaw: string | undefined;
  if (fs.existsSync(deployPath)) {
    deployRaw = fs.readFileSync(deployPath, "utf8");
  } else if (process.env.DEPLOYMENT_JSON) {
    log("Deployment file not found — falling back to DEPLOYMENT_JSON env var");
    deployRaw = process.env.DEPLOYMENT_JSON;
  } else if (supabaseEnabled) {
    log("No deployment file — running in Supabase-only discovery mode");
  } else {
    console.error("❌ Deployment info not found at", deployPath);
    console.error("   Run deploy-devnet-mm.ts first, set DEPLOYMENT_JSON env var, or set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const deploy = deployRaw ? JSON.parse(deployRaw) : { programId: process.env.PROGRAM_ID, markets: [] };
  const programId = new PublicKey(deploy.programId);
  const markets: MarketInfo[] = [...(deploy.markets as MarketInfo[])];

  log(`Program: ${programId.toBase58().slice(0, 12)}...`);
  log(`Markets: ${markets.map(m => m.label).join(", ")}`);

  // ── Startup oracle authority check ──────────────────────────
  // Verify all slabs before entering the main loop so mismatches are obvious in boot logs.
  log(`Verifying oracle authority for ${markets.length} market(s)...`);
  for (const m of markets) {
    try {
      const slabData = await fetchSlab(conn, new PublicKey(m.slab));
      const cfg = parseConfig(slabData);
      if (!cfg.oracleAuthority.equals(admin.publicKey)) {
        log(`🚨 STARTUP: ${m.label} (${m.slab.slice(0, 12)}...) — authority MISMATCH. Slab: ${cfg.oracleAuthority.toBase58()} | Keeper: ${admin.publicKey.toBase58()} → SLAB NEEDS REINIT`);
        skippedMarkets.add(m.slab);
      } else {
        authorityVerified.add(m.slab);
        log(`✅ STARTUP: ${m.label} — authority OK (${admin.publicKey.toBase58().slice(0, 12)}...)`);
      }
    } catch (e) {
      log(`⚠️ STARTUP: ${m.label} — authority check failed: ${(e as Error).message?.slice(0, 80)}. Will retry during push loop.`);
    }
  }
  if (skippedMarkets.size > 0) {
    log(`⛔ ${skippedMarkets.size} market(s) skipped due to authority mismatch: ${markets.filter(m => skippedMarkets.has(m.slab)).map(m => m.label).join(", ")}`);
    log(`   Action required: reinitialise slab(s) with current keeper authority, or update ADMIN_KEYPAIR to match.`);
  }

  // Initialize stats and mark existing markets as known
  for (const m of markets) {
    getOrCreateStats(m);
    knownSlabs.add(m.slab);
  }

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

  // Supabase discovery state
  let lastDiscoveryAt = 0;
  if (supabaseEnabled) {
    log(`Supabase auto-discovery enabled (interval: ${DISCOVERY_INTERVAL_MS}ms)`);
    // Load mainnet CAs for existing markets from Supabase
    const caRows = await supabaseQuery(
      "markets",
      "select=slab_address,mainnet_ca&mainnet_ca=not.is.null",
    );
    if (caRows) {
      for (const row of caRows) {
        slabToMainnetCA.set(row.slab_address, row.mainnet_ca);
      }
      log(`Loaded ${caRows.length} mainnet CA mapping(s) from Supabase`);
    }
  } else {
    log("⚠️ Supabase not configured — auto-discovery disabled (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)");
  }

  // Main push loop
  while (running) {
    // Periodic Supabase discovery — check for newly created markets
    const now = Date.now();
    if (supabaseEnabled && now - lastDiscoveryAt > DISCOVERY_INTERVAL_MS) {
      lastDiscoveryAt = now;
      try {
        // Refresh mainnet CA mappings
        const caData = await supabaseQuery(
          "markets",
          "select=slab_address,mainnet_ca&mainnet_ca=not.is.null",
        );
        if (caData) {
          for (const row of caData) {
            slabToMainnetCA.set(row.slab_address, row.mainnet_ca);
          }
        }

        const newMarkets = await discoverNewMarkets();
        if (newMarkets.length > 0) {
          log(`🔍 Discovered ${newMarkets.length} new market(s): ${newMarkets.map(m => m.label).join(", ")}`);
          for (const m of newMarkets) {
            markets.push(m);
            getOrCreateStats(m);
            // Verify oracle authority for new market
            try {
              const slabData = await fetchSlab(conn, new PublicKey(m.slab));
              const cfg = parseConfig(slabData);
              if (!cfg.oracleAuthority.equals(admin.publicKey)) {
                log(`🚨 ${m.label}: authority MISMATCH — skipping`);
                skippedMarkets.add(m.slab);
              } else {
                authorityVerified.add(m.slab);
                log(`✅ ${m.label}: authority OK`);
              }
            } catch (e) {
              log(`⚠️ ${m.label}: authority check failed: ${(e as Error).message?.slice(0, 60)}`);
            }
          }
        }
      } catch (e) {
        log(`⚠️ Discovery poll error: ${(e as Error).message?.slice(0, 60)}`);
      }
    }

    // Batch-fetch all Pyth prices in a single request
    const marketSymbols = [...new Set(markets.map(m => m.symbol))];
    await fetchPythPrices(marketSymbols);

    const promises = markets.map(market =>
      pushAndCrank(market, programId).catch(e => {
        const s = getOrCreateStats(market);
        s.totalErrors++;
        s.consecutiveErrors++;
        // Safely extract error info — SendTransactionError.message may be undefined
        // on some @solana/web3.js versions; .logs contains the on-chain program output
        const err = e as any;
        const msg: string = (typeof err?.message === "string" && err.message.length > 0)
          ? err.message.slice(0, 120)
          : (typeof err === "string" ? err.slice(0, 120) : `[${Object.prototype.toString.call(err)}]`);
        const txLogs = Array.isArray(err?.logs) ? (err.logs as string[]) : [];
        log(`❌ ${market.label}: ${msg}`);
        if (txLogs.length > 0) {
          // Print last 5 program log lines — this reveals the actual on-chain error
          log(`   TX logs: ${txLogs.slice(-5).join(" | ").slice(0, 400)}`);
        }
      })
    );
    await Promise.allSettled(promises);
    await new Promise(r => setTimeout(r, PUSH_INTERVAL_MS));
  }

  log("Oracle Keeper stopped.");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });

/**
 * PERC-360: Oracle Price Bridge
 *
 * Bridges mainnet token prices to devnet Percolator admin oracles.
 * Accepts any mainnet SPL token CA, fetches real-time price from
 * DexScreener/Jupiter, and pushes to devnet via PushOraclePrice.
 *
 * Run: CRANK_KEYPAIR=/path/to/oracle-authority.json npx tsx scripts/oracle-bridge.ts
 *
 * HTTP API:
 *   POST /oracle/register  { ca: string, marketAddress: string }
 *   GET  /oracle/markets    → list of registered markets with prices
 *   GET  /oracle/health     → service health
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  encodePushOraclePrice,
  encodeKeeperCrank,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_KEEPER_CRANK,
  SYSVAR_CLOCK_PUBKEY,
} from "../packages/core/src/index.js";
import * as fs from "fs";

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const RPC_URL = process.env.RPC_URL ?? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ""}`;
const HTTP_PORT = parseInt(process.env.ORACLE_BRIDGE_PORT ?? "18802", 10);
const PUSH_INTERVAL_MS = parseInt(process.env.PUSH_INTERVAL_MS ?? "10000", 10);
const MAX_CROSS_SOURCE_DEVIATION_PCT = 10;
const API_TIMEOUT_MS = 8_000;
const PRICE_CACHE_TTL_MS = 10_000;

import { getProgramId } from "../packages/core/src/config/program-ids.js";
const PROGRAM_ID = getProgramId("devnet");

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface RegisteredMarket {
  ca: string;              // Mainnet contract address (SPL token mint)
  marketAddress: string;   // Devnet slab address
  symbol?: string;
  lastPriceE6: bigint;
  lastPushAt: number;
  lastError?: string;
  pushCount: number;
  registeredAt: number;
}

interface PriceResult {
  priceUsd: number;
  source: string;
}

// ═══════════════════════════════════════════════════════════════
// Globals
// ═══════════════════════════════════════════════════════════════

const markets = new Map<string, RegisteredMarket>(); // key = marketAddress
const connection = new Connection(RPC_URL, "confirmed");
let oracleKeypair: Keypair;

// Price cache (per CA)
const priceCache = new Map<string, { price: number; source: string; at: number }>();

function log(component: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${component}] ${msg}`);
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

// ═══════════════════════════════════════════════════════════════
// Price Fetching — DexScreener + Jupiter + fallbacks
// ═══════════════════════════════════════════════════════════════

async function fetchDexScreenerPrice(ca: string): Promise<PriceResult | null> {
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${ca}`,
      { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const pairs = json.pairs as Array<{ priceUsd?: string; liquidity?: { usd?: number } }> | undefined;
    if (!pairs || pairs.length === 0) return null;

    // Pick highest liquidity pair
    const sorted = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const price = parseFloat(sorted[0].priceUsd ?? "0");
    if (price <= 0 || !Number.isFinite(price)) return null;
    return { priceUsd: price, source: "dexscreener" };
  } catch {
    return null;
  }
}

async function fetchJupiterPrice(ca: string): Promise<PriceResult | null> {
  try {
    const resp = await fetch(
      `https://api.jup.ag/price/v2?ids=${ca}`,
      { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const data = json.data?.[ca];
    const price = parseFloat(data?.price ?? "0");
    if (price <= 0 || !Number.isFinite(price)) return null;
    return { priceUsd: price, source: "jupiter" };
  } catch {
    return null;
  }
}

async function fetchCoinGeckoPrice(ca: string): Promise<PriceResult | null> {
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${ca}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const price = json[ca.toLowerCase()]?.usd;
    if (!price || price <= 0) return null;
    return { priceUsd: price, source: "coingecko" };
  } catch {
    return null;
  }
}

/**
 * Fetch price from multiple sources, cross-validate, return best.
 * Rejects if sources diverge by > MAX_CROSS_SOURCE_DEVIATION_PCT.
 */
async function fetchValidatedPrice(ca: string): Promise<PriceResult | null> {
  // Check cache first
  const cached = priceCache.get(ca);
  if (cached && Date.now() - cached.at < PRICE_CACHE_TTL_MS) {
    return { priceUsd: cached.price, source: `${cached.source}(cached)` };
  }

  // Fetch from all sources in parallel
  const [dex, jup, cg] = await Promise.all([
    fetchDexScreenerPrice(ca),
    fetchJupiterPrice(ca),
    fetchCoinGeckoPrice(ca),
  ]);

  const results = [dex, jup, cg].filter((r): r is PriceResult => r !== null);

  if (results.length === 0) {
    log("price", `No price sources available for ${ca.slice(0, 8)}...`);
    return null;
  }

  // If only one source, use it (can't cross-validate)
  if (results.length === 1) {
    const r = results[0];
    priceCache.set(ca, { price: r.priceUsd, source: r.source, at: Date.now() });
    return r;
  }

  // Cross-validate: check pairwise deviation
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i].priceUsd;
      const b = results[j].priceUsd;
      const deviation = Math.abs(a - b) / Math.min(a, b) * 100;
      if (deviation > MAX_CROSS_SOURCE_DEVIATION_PCT) {
        log("price", `⚠ ${ca.slice(0, 8)}... deviation ${deviation.toFixed(1)}% between ${results[i].source} ($${a}) and ${results[j].source} ($${b}) — rejecting`);
        return null;
      }
    }
  }

  // Use DexScreener as primary (highest liquidity source), fallback to Jupiter
  const best = dex ?? jup ?? cg!;
  priceCache.set(ca, { price: best.priceUsd, source: best.source, at: Date.now() });
  return best;
}

// ═══════════════════════════════════════════════════════════════
// On-chain Price Push
// ═══════════════════════════════════════════════════════════════

async function pushPriceOnChain(market: RegisteredMarket, priceUsd: number): Promise<boolean> {
  try {
    const priceE6 = BigInt(Math.round(priceUsd * 1_000_000));
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const slabPk = new PublicKey(market.marketAddress);

    // Push oracle price
    const pushData = encodePushOraclePrice({ priceE6, timestamp });
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
      oracleKeypair.publicKey,
      slabPk,
    ]);
    const pushIx = buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData });

    // Crank to apply
    const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      oracleKeypair.publicKey,
      slabPk,
      new PublicKey("SysvarC1ock11111111111111111111111111111111"),
      slabPk, // oracle account = slab for admin oracle
    ]);
    const crankIx = buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(pushIx);
    tx.add(crankIx);

    await sendAndConfirmTransaction(connection, tx, [oracleKeypair], {
      commitment: "confirmed",
      skipPreflight: true,
    });

    market.lastPriceE6 = priceE6;
    market.lastPushAt = Date.now();
    market.pushCount++;
    market.lastError = undefined;
    return true;
  } catch (e: any) {
    market.lastError = e.message?.slice(0, 100);
    log("push", `❌ ${market.symbol ?? market.ca.slice(0, 8)}: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Price Push Loop
// ═══════════════════════════════════════════════════════════════

async function pricePushLoop() {
  for (const market of markets.values()) {
    const price = await fetchValidatedPrice(market.ca);
    if (!price) continue;

    const ok = await pushPriceOnChain(market, price.priceUsd);
    if (ok) {
      log("push", `✅ ${market.symbol ?? market.ca.slice(0, 8)} → $${price.priceUsd.toPrecision(6)} (${price.source})`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// HTTP API
// ═══════════════════════════════════════════════════════════════

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: string) => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: any) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // POST /oracle/register
  if (method === "POST" && url === "/oracle/register") {
    try {
      const body = await parseBody(req);
      const { ca, marketAddress, symbol } = body;

      if (!ca || !marketAddress) {
        return json(res, 400, { error: "Missing ca or marketAddress" });
      }

      // Validate addresses
      try { new PublicKey(marketAddress); } catch {
        return json(res, 400, { error: "Invalid marketAddress" });
      }

      // Check if already registered
      if (markets.has(marketAddress)) {
        return json(res, 200, { status: "already_registered", market: serializeMarket(markets.get(marketAddress)!) });
      }

      // Fetch initial price to validate CA
      const initialPrice = await fetchValidatedPrice(ca);
      if (!initialPrice) {
        return json(res, 400, { error: "Cannot fetch price for this CA. Token may not have liquidity." });
      }

      const market: RegisteredMarket = {
        ca,
        marketAddress,
        symbol,
        lastPriceE6: 0n,
        lastPushAt: 0,
        pushCount: 0,
        registeredAt: Date.now(),
      };

      markets.set(marketAddress, market);

      // Push first price immediately
      await pushPriceOnChain(market, initialPrice.priceUsd);

      log("register", `✅ Registered ${symbol ?? ca.slice(0, 8)} → ${marketAddress.slice(0, 8)}... ($${initialPrice.priceUsd})`);
      return json(res, 201, { status: "registered", market: serializeMarket(market) });
    } catch (e: any) {
      return json(res, 500, { error: e.message });
    }
  }

  // GET /oracle/markets
  if (method === "GET" && url === "/oracle/markets") {
    const list = [...markets.values()].map(serializeMarket);
    return json(res, 200, { markets: list, count: list.length });
  }

  // GET /oracle/health
  if (method === "GET" && url === "/oracle/health") {
    return json(res, 200, {
      status: "ok",
      markets: markets.size,
      oracle: oracleKeypair.publicKey.toBase58(),
      uptime: process.uptime(),
    });
  }

  // GET /oracle/price/:ca
  if (method === "GET" && url.startsWith("/oracle/price/")) {
    const ca = url.split("/oracle/price/")[1];
    if (!ca) return json(res, 400, { error: "Missing CA" });
    const price = await fetchValidatedPrice(ca);
    if (!price) return json(res, 404, { error: "No price available" });
    return json(res, 200, { ca, priceUsd: price.priceUsd, source: price.source });
  }

  json(res, 404, { error: "Not found" });
}

function serializeMarket(m: RegisteredMarket) {
  return {
    ca: m.ca,
    marketAddress: m.marketAddress,
    symbol: m.symbol,
    lastPriceUsd: Number(m.lastPriceE6) / 1_000_000,
    lastPushAt: m.lastPushAt ? new Date(m.lastPushAt).toISOString() : null,
    pushCount: m.pushCount,
    lastError: m.lastError,
    registeredAt: new Date(m.registeredAt).toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// Persistence — save/load registered markets to disk
// ═══════════════════════════════════════════════════════════════

const MARKETS_FILE = process.env.ORACLE_MARKETS_FILE ?? "/tmp/oracle-bridge-markets.json";

function saveMarkets() {
  const data = [...markets.entries()].map(([k, v]) => ({
    ...serializeMarket(v),
    lastPriceE6: v.lastPriceE6.toString(),
  }));
  try {
    fs.writeFileSync(MARKETS_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

function loadMarkets() {
  try {
    if (!fs.existsSync(MARKETS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(MARKETS_FILE, "utf8"));
    for (const m of data) {
      markets.set(m.marketAddress, {
        ca: m.ca,
        marketAddress: m.marketAddress,
        symbol: m.symbol,
        lastPriceE6: BigInt(m.lastPriceE6 ?? "0"),
        lastPushAt: 0,
        pushCount: 0,
        registeredAt: new Date(m.registeredAt).getTime(),
      });
    }
    log("init", `Loaded ${markets.size} markets from ${MARKETS_FILE}`);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  PERC-360: Oracle Price Bridge");
  console.log("═══════════════════════════════════════════════════");

  // Load oracle authority keypair
  const kpPath = process.env.CRANK_KEYPAIR ?? process.env.BOOTSTRAP_KEYPAIR ?? "";
  if (!kpPath) {
    console.error("❌ Set CRANK_KEYPAIR=/path/to/oracle-authority.json");
    process.exit(1);
  }
  try {
    oracleKeypair = loadKeypair(kpPath);
    log("init", `Oracle authority: ${oracleKeypair.publicKey.toBase58()}`);
  } catch (e: any) {
    console.error(`❌ Cannot load keypair: ${e.message}`);
    process.exit(1);
  }

  const balance = await connection.getBalance(oracleKeypair.publicKey);
  log("init", `SOL balance: ${(balance / 1e9).toFixed(4)}`);

  // Load persisted markets
  loadMarkets();

  // Start HTTP server
  const server = createServer(handleRequest);
  server.listen(HTTP_PORT, () => {
    log("http", `API listening on http://127.0.0.1:${HTTP_PORT}`);
    log("http", `  POST /oracle/register  { ca, marketAddress, symbol? }`);
    log("http", `  GET  /oracle/markets`);
    log("http", `  GET  /oracle/health`);
    log("http", `  GET  /oracle/price/:ca`);
  });

  // Start price push loop
  log("push", `Pushing prices every ${PUSH_INTERVAL_MS / 1000}s`);
  setInterval(async () => {
    try {
      await pricePushLoop();
      saveMarkets(); // Persist after each cycle
    } catch (e: any) {
      log("push", `Loop error: ${e.message?.slice(0, 80)}`);
    }
  }, PUSH_INTERVAL_MS);

  // Initial push
  if (markets.size > 0) {
    log("push", "Running initial price push...");
    await pricePushLoop();
    saveMarkets();
  }

  log("init", "✅ Oracle bridge running. Press Ctrl+C to stop.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

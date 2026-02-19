/**
 * sim-oracle.ts — Percolator Risk Engine Simulator: Oracle Service
 *
 * - Fetches real prices from Pyth Hermes every 2s
 * - Applies active scenario multipliers
 * - Pushes prices on-chain via PushOraclePrice + cranks markets
 * - Reads active scenarios from Supabase sim_scenarios table
 *
 * Env: RPC_URL, SIM_ADMIN_KEYPAIR (base58), SUPABASE_URL, SUPABASE_SERVICE_KEY
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
  encodePushOraclePrice,
  encodeKeeperCrank,
  buildAccountMetas,
} from "../packages/core/src/abi/index.js";
import {
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_KEEPER_CRANK,
} from "../packages/core/src/abi/accounts.js";
import { buildIx } from "../packages/core/src/runtime/tx.js";
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
const TICK_MS = 5_000; // 5s between oracle pushes (devnet rate limits)
const PRIORITY_FEE = 50_000;

const PYTH_FEEDS: Record<string, string> = {
  "SOL/USD": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "BTC/USD": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH/USD": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

const HERMES_BASE = "https://hermes.pyth.network/v2/updates/price/latest";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OraclePrice {
  symbol: string;
  rawPrice: number;  // true market price
  adjustedPrice: number; // after scenario multiplier
  priceE6: bigint;
}

export interface ActiveScenario {
  id: string;
  type: string;
  activatedAt: number; // unix ms
  expiresAt: number;   // unix ms
}

interface SimMarket {
  slab: string;
  name: string;
}

interface SimMarketsConfig {
  network: string;
  markets: Record<string, SimMarket>;
}

// ─── Scenario Engine ─────────────────────────────────────────────────────────

const SCENARIO_DURATIONS_MS: Record<string, number> = {
  "flash-crash":     60_000,
  "short-squeeze":  120_000,
  "black-swan":     600_000,
  "high-vol":       300_000,
  "gentle-trend":  1_800_000,
  // Legacy underscore format (backwards compat)
  flash_crash:     60_000,
  short_squeeze:  120_000,
  black_swan:     600_000,
  high_volatility:300_000,
  gentle_trend:  1_800_000,
};

/**
 * Returns a multiplier in [0, ∞) based on scenario type and elapsed time.
 * t = elapsed fraction (0..1) through the scenario duration.
 */
/** Normalize scenario type to kebab-case (DB canonical format) */
function normalizeScenarioType(type: string): string {
  return type.replace(/_/g, "-");
}

function scenarioMultiplier(rawType: string, t: number): number {
  const type = normalizeScenarioType(rawType);
  switch (type) {
    case "flash-crash": {
      // crash 30% then recover 70% of that drop
      if (t < 0.5) return 1 - 0.30 * (t / 0.5);
      const recovery = 0.30 * 0.70;
      return (1 - 0.30) + recovery * ((t - 0.5) / 0.5);
    }
    case "short-squeeze":
      return 1 + 0.50 * t;
    case "black-swan":
      return 1 - 0.60 * Math.min(t, 1);
    case "high-vol": {
      const rand = (Math.random() * 2 - 1) * 0.20;
      return 1 + rand;
    }
    case "gentle-trend":
      return 1 + 0.15 * t;
    default:
      return 1;
  }
}

export function applyScenario(
  rawPrice: number,
  scenario: ActiveScenario | null,
): number {
  if (!scenario) return rawPrice;
  const now = Date.now();
  const duration = scenario.expiresAt - scenario.activatedAt;
  const elapsed = Math.min(now - scenario.activatedAt, duration);
  const t = duration > 0 ? elapsed / duration : 1;
  const mult = scenarioMultiplier(scenario.type, t);
  return rawPrice * mult;
}

// ─── Supabase REST helper ─────────────────────────────────────────────────────

function supabaseHeaders(serviceKey: string) {
  return {
    "Content-Type": "application/json",
    "apikey": serviceKey,
    "Authorization": `Bearer ${serviceKey}`,
  };
}

export async function fetchActiveScenario(
  supabaseUrl: string,
  serviceKey: string,
): Promise<ActiveScenario | null> {
  try {
    const url = `${supabaseUrl}/rest/v1/sim_scenarios?status=eq.active&order=activated_at.desc&limit=1`;
    const resp = await fetch(url, { headers: supabaseHeaders(serviceKey) });
    if (!resp.ok) return null;
    const rows = await resp.json() as Array<{
      id: string;
      scenario_type: string;
      activated_at: string | null;
      expires_at: string | null;
    }>;
    if (!rows.length || !rows[0].activated_at) return null;
    const row = rows[0];
    return {
      id: row.id,
      type: row.scenario_type,
      activatedAt: new Date(row.activated_at).getTime(),
      expiresAt: row.expires_at
        ? new Date(row.expires_at).getTime()
        : new Date(row.activated_at).getTime() +
          (SCENARIO_DURATIONS_MS[row.scenario_type] ?? 60_000),
    };
  } catch (err) {
    console.error("[oracle] fetchActiveScenario error:", err);
    return null;
  }
}

// ─── Pyth Hermes ─────────────────────────────────────────────────────────────

interface HermesPrice {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

interface HermesParsed {
  id: string;
  price: HermesPrice;
  ema_price: HermesPrice;
}

interface HermesResponse {
  parsed: HermesParsed[];
}

export async function fetchPythPrices(): Promise<Map<string, number>> {
  const feedIds = Object.values(PYTH_FEEDS);
  const params = feedIds.map((id) => `ids[]=${id}`).join("&");
  const url = `${HERMES_BASE}?${params}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!resp.ok) throw new Error(`Hermes HTTP ${resp.status}`);
  const data = (await resp.json()) as HermesResponse;

  const prices = new Map<string, number>();
  for (const parsed of data.parsed ?? []) {
    const symbol = Object.entries(PYTH_FEEDS).find(([, id]) => id === parsed.id)?.[0];
    if (!symbol) continue;
    const p = parsed.price;
    const price = Number(p.price) * Math.pow(10, p.expo);
    prices.set(symbol, price);
  }
  return prices;
}

// ─── Base58 decoder (no external dep) ────────────────────────────────────────

function base58Decode(encoded: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]] = i;
  let n = BigInt(0);
  for (const ch of encoded) {
    if (!(ch in map)) throw new Error(`Invalid base58 char: ${ch}`);
    n = n * 58n + BigInt(map[ch]);
  }
  const hex = n.toString(16).padStart(128, "0");
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ─── Push oracle price + crank ────────────────────────────────────────────────

export async function pushAndCrank(
  connection: Connection,
  payer: Keypair,
  slabPk: PublicKey,
  priceE6: bigint,
): Promise<string> {
  // Use Solana cluster time to avoid clock skew between local and on-chain.
  // Local Date.now() can be ahead of Solana's clock.unix_timestamp, making
  // the pushed timestamp appear "from the future" (age < 0) → stale rejection
  // → Pyth fallback → IllegalOwner. Fetching the actual slot timestamp avoids this.
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  const now = blockTime ?? Math.floor(Date.now() / 1000);

  // Step 1: Push oracle price (always succeeds if authority is valid)
  const pushData = encodePushOraclePrice({
    priceE6: priceE6.toString(),
    timestamp: now.toString(),
  });
  const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
    payer.publicKey,
    slabPk,
  ]);

  const pushTx = new Transaction();
  pushTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  pushTx.add(buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }));
  await sendAndConfirmTransaction(connection, pushTx, [payer], {
    commitment: "confirmed",
    skipPreflight: true,
  });

  // Step 2: Crank (reads freshly-pushed authority price — no Pyth fallback)
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    slabPk,
    SYSVAR_CLOCK_PUBKEY,
    slabPk, // admin oracle: oracle = slab (not read when authority price valid)
  ]);

  const crankTx = new Transaction();
  crankTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  const sig = await sendAndConfirmTransaction(connection, crankTx, [payer], {
    commitment: "confirmed",
    skipPreflight: true,
  });
  return sig;
}

// ─── Oracle Service class ─────────────────────────────────────────────────────

export class SimOracle {
  private connection: Connection;
  private payer: Keypair;
  private markets: SimMarketsConfig;
  private supabaseUrl: string;
  private serviceKey: string;
  private activeScenario: ActiveScenario | null = null;
  private scenarioRefreshAt = 0;
  private running = false;

  /** Last computed prices (for bots to read) */
  public latestPrices = new Map<string, OraclePrice>();
  private priceWriteBuffer: Array<{
    slab_address: string;
    symbol: string;
    price_e6: string;        // text column in sim_price_history
    raw_price_e6: string;    // pre-scenario price
    scenario_type: string | null;
    timestamp: number;       // bigint (unix ms)
  }> = [];
  private lastFlush = 0;
  private readonly FLUSH_INTERVAL_MS = 10_000; // flush to DB every 10s
  private readonly MAX_BUFFER = 50;

  constructor(opts: {
    rpcUrl: string;
    adminKeypairBase58: string;
    supabaseUrl: string;
    serviceKey: string;
  }) {
    this.connection = new Connection(opts.rpcUrl, "confirmed");
    this.payer = Keypair.fromSecretKey(base58Decode(opts.adminKeypairBase58));
    this.supabaseUrl = opts.supabaseUrl;
    this.serviceKey = opts.serviceKey;

    this.markets = JSON.parse(fs.readFileSync(SIM_CONFIG_PATH, "utf-8")) as SimMarketsConfig;

    console.log(`[oracle] Admin: ${this.payer.publicKey.toBase58()}`);
    console.log(`[oracle] Markets: ${Object.keys(this.markets.markets).join(", ")}`);
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("[oracle] Starting oracle tick loop...");
    while (this.running) {
      const tickStart = Date.now();
      await this.tick().catch((err) => console.error("[oracle] tick error:", err));
      const elapsed = Date.now() - tickStart;
      const wait = Math.max(0, TICK_MS - elapsed);
      await sleep(wait);
    }
    console.log("[oracle] Stopped.");
  }

  stop(): void {
    this.running = false;
  }

  private async tick(): Promise<void> {
    // Refresh scenario every 10s
    if (Date.now() >= this.scenarioRefreshAt) {
      this.activeScenario = await fetchActiveScenario(this.supabaseUrl, this.serviceKey);
      this.scenarioRefreshAt = Date.now() + 10_000;
      if (this.activeScenario) {
        console.log(`[oracle] Active scenario: ${this.activeScenario.type}`);
      }
    }

    let pythPrices: Map<string, number>;
    try {
      pythPrices = await fetchPythPrices();
    } catch (err) {
      console.error("[oracle] Pyth fetch failed:", err);
      return;
    }

    for (const [symbol, market] of Object.entries(this.markets.markets)) {
      if (!market.slab) {
        // slab not yet deployed
        continue;
      }
      const rawPrice = pythPrices.get(symbol);
      if (!rawPrice) {
        console.warn(`[oracle] No price for ${symbol}`);
        continue;
      }

      const adjustedPrice = applyScenario(rawPrice, this.activeScenario);
      const priceE6 = BigInt(Math.round(adjustedPrice * 1_000_000));
      const slabPk = new PublicKey(market.slab);

      this.latestPrices.set(symbol, { symbol, rawPrice, adjustedPrice, priceE6 });

      try {
        const sig = await pushAndCrank(this.connection, this.payer, slabPk, priceE6);
        console.log(
          `[oracle] ${symbol} raw=${rawPrice.toFixed(2)} adj=${adjustedPrice.toFixed(2)} priceE6=${priceE6} sig=${sig.slice(0, 12)}...`,
        );

        // Buffer price for DB persistence (writes to sim_price_history)
        this.priceWriteBuffer.push({
          slab_address: market.slab,
          symbol,
          price_e6: priceE6.toString(),
          raw_price_e6: BigInt(Math.round(rawPrice * 1_000_000)).toString(),
          scenario_type: this.activeScenario?.type ?? null,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error(`[oracle] push/crank failed for ${symbol}:`, err);
      }
    }

    // Flush price history to Supabase periodically
    await this.flushPriceHistory();
  }

  private async flushPriceHistory(): Promise<void> {
    const now = Date.now();
    if (
      this.priceWriteBuffer.length === 0 ||
      (now - this.lastFlush < this.FLUSH_INTERVAL_MS &&
        this.priceWriteBuffer.length < this.MAX_BUFFER)
    ) {
      return;
    }

    const batch = this.priceWriteBuffer.splice(0, this.MAX_BUFFER);
    this.lastFlush = now;

    try {
      // Bug fix: table is sim_price_history (migration 024), not simulation_price_history (migration 011)
      const url = `${this.supabaseUrl}/rest/v1/sim_price_history`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          ...supabaseHeaders(this.serviceKey),
          "Prefer": "return=minimal",
        },
        body: JSON.stringify(batch),
      });
      if (!resp.ok) {
        console.error(`[oracle] price history flush failed: ${resp.status} ${await resp.text()}`);
        // Put rows back for retry (drop if buffer too large)
        if (this.priceWriteBuffer.length < 200) {
          this.priceWriteBuffer.unshift(...batch);
        }
      } else {
        console.log(`[oracle] flushed ${batch.length} prices to DB`);
      }
    } catch (err) {
      console.error("[oracle] price history flush error:", err);
      if (this.priceWriteBuffer.length < 200) {
        this.priceWriteBuffer.unshift(...batch);
      }
    }

    // Cleanup old data: keep last 24h per slab (run every ~5 minutes)
    if (now % 300_000 < this.FLUSH_INTERVAL_MS) {
      await this.cleanupOldPrices().catch((err) =>
        console.error("[oracle] cleanup error:", err)
      );
    }
  }

  private async cleanupOldPrices(): Promise<void> {
    // Bug fix: sim_price_history.timestamp is bigint (unix ms), not timestamptz.
    // Use numeric epoch ms comparison, not ISO date string.
    // Bug fix: correct table name is sim_price_history, not simulation_price_history.
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const url = `${this.supabaseUrl}/rest/v1/sim_price_history?timestamp=lt.${cutoffMs}`;
    const resp = await fetch(url, {
      method: "DELETE",
      headers: supabaseHeaders(this.serviceKey),
    });
    if (resp.ok) {
      console.log("[oracle] cleaned up prices older than 24h");
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

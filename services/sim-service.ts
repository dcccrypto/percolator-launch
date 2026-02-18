/**
 * sim-service.ts — Percolator Risk Engine Simulator: Combined Entry Point
 *
 * Starts the Oracle service + Bot Fleet together.
 * Exposes a health check endpoint on port 3001.
 *
 * Usage:
 *   npx tsx services/sim-service.ts
 *
 * Env vars:
 *   RPC_URL                — Solana RPC endpoint
 *   SIM_ADMIN_KEYPAIR      — Base58-encoded admin secret key
 *   SUPABASE_URL           — Supabase project URL
 *   SUPABASE_SERVICE_KEY   — Supabase service role key
 *
 * Optional:
 *   HEALTH_PORT            — Health check port (default: 3001)
 *   DISABLE_BOTS           — Set to "true" to skip bot fleet
 */

import * as http from "http";
import * as dotenv from "dotenv";
import { Keypair } from "@solana/web3.js";
import { SimOracle } from "./sim-oracle.js";
import { BotFleet } from "./sim-bots.js";

dotenv.config();

// ─── Env validation ───────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

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

// ─── Health check server ──────────────────────────────────────────────────────

interface HealthStatus {
  status: "ok" | "degraded";
  uptime: number;
  oracle: {
    running: boolean;
    lastPrices: Record<string, number>;
  };
  bots: {
    running: boolean;
    count: number;
  };
  timestamp: string;
}

let oracleRef: SimOracle | null = null;
let botsRef: BotFleet | null = null;
let botsRunning = false;
let startTime = Date.now();

function buildHealthStatus(): HealthStatus {
  const lastPrices: Record<string, number> = {};
  if (oracleRef) {
    for (const [sym, p] of oracleRef.latestPrices) {
      lastPrices[sym] = p.adjustedPrice;
    }
  }

  return {
    status: oracleRef ? "ok" : "degraded",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    oracle: {
      running: !!oracleRef,
      lastPrices,
    },
    bots: {
      running: botsRunning,
      count: botsRef ? (botsRef as unknown as { bots?: unknown[] }).bots?.length ?? 0 : 0,
    },
    timestamp: new Date().toISOString(),
  };
}

function startHealthServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      const status = buildHealthStatus();
      const code = status.status === "ok" ? 200 : 503;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status, null, 2));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    console.log(`[health] Health check server listening on http://localhost:${port}/health`);
  });

  return server;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "=".repeat(65));
  console.log("PERCOLATOR RISK ENGINE SIMULATOR — Service Starting");
  console.log("=".repeat(65));

  const rpcUrl = requireEnv("RPC_URL");
  const adminKeypairBase58 = requireEnv("SIM_ADMIN_KEYPAIR");
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_KEY");
  const healthPort = parseInt(process.env.HEALTH_PORT ?? "3001", 10);
  const disableBots = process.env.DISABLE_BOTS === "true";

  const adminKeypair = Keypair.fromSecretKey(base58Decode(adminKeypairBase58));
  console.log(`[service] Admin: ${adminKeypair.publicKey.toBase58()}`);

  // Health server
  const healthServer = startHealthServer(healthPort);

  // Oracle service
  const oracle = new SimOracle({
    rpcUrl,
    adminKeypairBase58,
    supabaseUrl,
    serviceKey,
  });
  oracleRef = oracle;
  startTime = Date.now();

  // Bot fleet
  let fleet: BotFleet | null = null;
  if (!disableBots) {
    fleet = new BotFleet({
      rpcUrl,
      adminKeypair,
      oracle,
      supabaseUrl,
      serviceKey,
    });
    botsRef = fleet;
  }

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[service] Received ${signal}, shutting down...`);
    oracle.stop();
    if (fleet) fleet.stop();
    healthServer.close(() => {
      console.log("[service] Health server closed.");
    });
    // Give in-flight transactions time to settle
    await new Promise((r) => setTimeout(r, 2_000));
    console.log("[service] Goodbye.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    console.error("[service] Uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[service] Unhandled rejection:", reason);
  });

  // Start services concurrently
  const services: Promise<void>[] = [oracle.start()];

  if (fleet) {
    // Give oracle a 5s head start to populate prices before bots fire
    const botsPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        botsRunning = true;
        fleet!.start().finally(() => {
          botsRunning = false;
          resolve();
        });
      }, 5_000);
    });
    services.push(botsPromise);
  }

  console.log(`[service] Oracle + ${fleet ? "Bots" : "(bots disabled)"} running.`);
  console.log(`[service] Health: http://localhost:${healthPort}/health\n`);

  await Promise.all(services);
}

main().catch((err) => {
  console.error("[service] Fatal error:", err);
  process.exit(1);
});

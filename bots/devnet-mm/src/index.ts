#!/usr/bin/env -S npx tsx
/**
 * PERC-377: Devnet Market-Making Bots — Main Entrypoint
 *
 * Runs two bot roles in a single process:
 *   1. FILLER — cranks markets, pushes oracle prices, maintains system health
 *   2. MAKER  — posts two-sided quotes with position-aware skewing
 *
 * Inspired by Drift Protocol's keeper-bots-v2, adapted for Percolator's
 * LP-based matching model.
 *
 * Usage:
 *   BOT_MODE=both npx tsx src/index.ts            # run filler + maker
 *   BOT_MODE=filler npx tsx src/index.ts           # run filler only
 *   BOT_MODE=maker npx tsx src/index.ts            # run maker only
 *   BOT_MODE=trader npx tsx src/index.ts           # run trader fleet only
 *   BOT_MODE=all npx tsx src/index.ts              # run all three
 *
 * Environment:
 *   See config.ts for full list. Key variables:
 *   - FILLER_KEYPAIR / MAKER_KEYPAIR      — wallet keypair file paths
 *   - FILLER_KEYPAIR_JSON / MAKER_KEYPAIR_JSON — raw JSON array (Railway/K8s secrets)
 *   - BOOTSTRAP_KEYPAIR / BOOTSTRAP_KEYPAIR_JSON — shared wallet (fallback)
 *   - RPC_URL or HELIUS_API_KEY            — Solana RPC
 *   - SPREAD_BPS                            — half-spread for maker
 *   - CRANK_INTERVAL_MS                     — crank frequency for filler
 *   - DRY_RUN=true                          — simulate without sending txs
 */

import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadConfig, type BotConfig } from "./config.js";
import { FillerBot } from "./filler.js";
import { MakerBot } from "./maker.js";
import { TraderFleetBot } from "./trader-fleet.js";
import { startHealthServer } from "./health.js";
import { log, logError } from "./logger.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════
// Railway / Docker: materialize keypairs from env vars
// ═══════════════════════════════════════════════════════════════
// When running in containers, keypair files don't exist on disk.
// Support FILLER_KEYPAIR_JSON / MAKER_KEYPAIR_JSON env vars that
// contain the raw JSON array, and write them to temp files.

function materializeKeypairFromEnv(
  envVar: string,
  pathEnvVar: string,
  filename: string,
): void {
  const jsonStr = process.env[envVar];
  if (!jsonStr) return;

  // Validate it parses as a JSON array of numbers
  try {
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr) || arr.length < 32) {
      console.error(`⚠️ ${envVar} is not a valid keypair array`);
      return;
    }
  } catch {
    console.error(`⚠️ ${envVar} is not valid JSON`);
    return;
  }

  const dir = path.join(os.tmpdir(), "percolator-bots");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, jsonStr, { mode: 0o600 });

  // Set the path env var so config.ts picks it up
  if (!process.env[pathEnvVar]) {
    process.env[pathEnvVar] = filePath;
  }
  // Scrub the raw key bytes from the environment so crash reporters,
  // child processes, and /proc/<PID>/environ cannot read them.
  delete process.env[envVar];
  console.log(`✅ Materialized ${envVar} → ${filePath}`);
}

materializeKeypairFromEnv("FILLER_KEYPAIR_JSON", "FILLER_KEYPAIR", "filler.json");
materializeKeypairFromEnv("MAKER_KEYPAIR_JSON", "MAKER_KEYPAIR", "maker.json");
// Also support BOOTSTRAP_KEYPAIR_JSON for single-wallet mode
materializeKeypairFromEnv("BOOTSTRAP_KEYPAIR_JSON", "BOOTSTRAP_KEYPAIR", "bootstrap.json");

// ═══════════════════════════════════════════════════════════════
// Banner
// ═══════════════════════════════════════════════════════════════

function printBanner(config: BotConfig) {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  PERC-377: Percolator Devnet Market-Making Bots           ║
║                                                           ║
║  Filler: cranks, oracle pushes, system health             ║
║  Maker:  two-sided quotes, position-aware skewing         ║
║  Trader: simulated trader fleet (PERC-404)                ║
╚═══════════════════════════════════════════════════════════╝
`);
  log("main", `Mode: ${config.mode.toUpperCase()}`);
  log("main", `RPC: ${config.rpcUrl.replace(/api-key=.*/, "api-key=***")}`);
  log("main", `Program: ${config.programId.toBase58().slice(0, 16)}...`);
  log("main", `Matcher: ${config.matcherProgramId.toBase58().slice(0, 16)}...`);
  if (config.dryRun) log("main", "🔸 DRY RUN MODE — no transactions will be sent");
  if (config.marketsFilter) log("main", `🔸 Markets filter: ${config.marketsFilter.join(", ")}`);
}

// ═══════════════════════════════════════════════════════════════
// Startup Checks
// ═══════════════════════════════════════════════════════════════

async function checkWallet(connection: Connection, keypairPath: string, role: string): Promise<boolean> {
  if (!fs.existsSync(keypairPath)) {
    logError("main", `${role} keypair not found: ${keypairPath}`);
    log("main", `Generate wallets: npx tsx src/keygen.ts`);
    return false;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
    const { Keypair } = await import("@solana/web3.js");
    const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
    const balance = await connection.getBalance(kp.publicKey);
    const balSol = balance / LAMPORTS_PER_SOL;
    log("main", `${role} wallet: ${kp.publicKey.toBase58()} (${balSol.toFixed(4)} SOL)`);
    if (balSol < 0.01) {
      log("main", `⚠️ ${role} has low SOL — transactions may fail`);
    }
    return true;
  } catch (e) {
    logError("main", `Failed to load ${role} keypair`, e);
    return false;
  }
}

async function checkPrograms(connection: Connection, config: BotConfig): Promise<boolean> {
  try {
    const progInfo = await connection.getAccountInfo(config.programId);
    if (!progInfo?.executable) {
      logError("main", "Percolator program not found on-chain");
      return false;
    }
    const matcherInfo = await connection.getAccountInfo(config.matcherProgramId);
    if (!matcherInfo?.executable) {
      logError("main", "Matcher program not found on-chain");
      return false;
    }
    log("main", "✅ Programs verified on-chain");
    return true;
  } catch (e) {
    logError("main", "Failed to verify programs", e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const config = loadConfig();
  printBanner(config);

  const connection = new Connection(config.rpcUrl, "confirmed");

  // Verify programs exist
  const programsOk = await checkPrograms(connection, config);
  if (!programsOk) {
    log("main", "Cannot proceed without deployed programs. Exiting.");
    process.exit(1);
  }

  // Initialize bots based on mode
  let filler: FillerBot | null = null;
  let maker: MakerBot | null = null;
  let traderFleet: TraderFleetBot | null = null;

  if (config.mode === "filler" || config.mode === "both" || config.mode === "all") {
    const walletOk = await checkWallet(connection, config.fillerKeypairPath, "Filler");
    if (!walletOk) {
      log("main", "Filler wallet not available — skipping filler");
    } else {
      filler = new FillerBot(connection, config);
    }
  }

  if (config.mode === "maker" || config.mode === "both" || config.mode === "all") {
    const walletOk = await checkWallet(connection, config.makerKeypairPath, "Maker");
    if (!walletOk) {
      log("main", "Maker wallet not available — skipping maker");
    } else {
      maker = new MakerBot(connection, config);
    }
  }

  if (config.mode === "trader" || config.mode === "all") {
    traderFleet = new TraderFleetBot(connection, config);
    log("main", `Trader fleet: ${process.env.TRADER_FLEET_SIZE ?? 5} simulated wallets`);
  }

  if (!filler && !maker && !traderFleet) {
    logError("main", "No bots could be initialized. Check keypair paths and wallets.");
    process.exit(1);
  }

  // Start health server
  const healthServer = startHealthServer(config.healthPort, filler, maker, config.healthHost, traderFleet);

  // Start bots
  try {
    if (filler) await filler.start();
    if (maker) await maker.start();
    if (traderFleet) await traderFleet.start();
  } catch (e) {
    logError("main", "Failed to start bots", e);
    process.exit(1);
  }

  // Stats printer every 60s
  const statsInterval = setInterval(() => {
    log("main", "═══ Status ═══");
    if (filler) {
      const s = filler.getStatus().stats;
      log("main", `  Filler: cranks=${s.crankSuccess}/${s.crankCycles} | oracle=${s.oraclePushes} | markets=${s.marketsActive}`);
    }
    if (maker) {
      const s = maker.getStatus().stats;
      log("main", `  Maker: quotes=${s.quoteCycles} | trades=${s.tradesExecuted}/${s.tradesExecuted + s.tradesFailed} ok | markets=${s.marketsActive}`);
    }
    if (traderFleet) {
      const s = traderFleet.getStatus().stats;
      log("main", `  Fleet: cycles=${s.cycleCount} | trades=${s.totalTrades} ok / ${s.totalFailed} fail | traders=${s.activeTraders}`);
    }
    log("main", "═══════════════");
  }, 60_000);

  // Graceful shutdown
  const shutdown = () => {
    log("main", "Shutting down...");
    if (filler) filler.stop();
    if (maker) maker.stop();
    if (traderFleet) traderFleet.stop();
    clearInterval(statsInterval);
    healthServer.close();
    setTimeout(() => process.exit(0), 3000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  log("main", "🚀 Bots running. Press Ctrl+C to stop.");
  while (true) {
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

main().catch((e) => {
  console.error("💀 Fatal error:", e.message || e);
  process.exit(1);
});

#!/usr/bin/env npx tsx
/**
 * PERC-373: MM Fleet Runner — Multi-wallet floating market maker
 *
 * Runs 2+ house wallets with different MM profiles (WIDE, TIGHT_A, TIGHT_B)
 * on all devnet markets. Each wallet operates independently with its own
 * keypair, profile, and position tracking.
 *
 * This is the orchestrator that spawns floating-maker.ts instances
 * with different configs, or runs them in-process for single-node deployment.
 *
 * Usage:
 *   npx tsx scripts/mm-fleet.ts
 *
 * Environment:
 *   MM_WALLET_1  — Path to first house wallet keypair (required)
 *   MM_WALLET_2  — Path to second house wallet keypair (required)
 *   MM_WALLET_3  — Path to third house wallet keypair (optional)
 *   RPC_URL      — Solana RPC URL
 *   DRY_RUN      — Set to "true" for simulation only
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

// ── Config ──────────────────────────────────────────────────
interface WalletConfig {
  keypairPath: string;
  profile: "WIDE" | "TIGHT_A" | "TIGHT_B";
  spreadBps: number;
  maxQuoteSizeUsdc: number;
  quoteIntervalMs: number;
}

const FLEET_HEALTH_PORT = Number(process.env.FLEET_HEALTH_PORT ?? "18811");

function loadWalletConfigs(): WalletConfig[] {
  const configs: WalletConfig[] = [];

  const wallet1 = process.env.MM_WALLET_1;
  const wallet2 = process.env.MM_WALLET_2;
  const wallet3 = process.env.MM_WALLET_3;

  if (!wallet1 || !wallet2) {
    console.error("❌ MM_WALLET_1 and MM_WALLET_2 are required.");
    console.error("   Each should point to a Solana keypair JSON file.");
    process.exit(1);
  }

  // Wallet 1: WIDE profile — conservative, deep quotes
  configs.push({
    keypairPath: wallet1,
    profile: "WIDE",
    spreadBps: 40,
    maxQuoteSizeUsdc: 1000,
    quoteIntervalMs: 8000,
  });

  // Wallet 2: TIGHT_A profile — aggressive, tight top-of-book
  configs.push({
    keypairPath: wallet2,
    profile: "TIGHT_A",
    spreadBps: 12,
    maxQuoteSizeUsdc: 200,
    quoteIntervalMs: 4000,
  });

  // Wallet 3 (optional): TIGHT_B profile — staggered tight quotes
  if (wallet3 && fs.existsSync(wallet3)) {
    configs.push({
      keypairPath: wallet3,
      profile: "TIGHT_B",
      spreadBps: 18,
      maxQuoteSizeUsdc: 300,
      quoteIntervalMs: 5000,
    });
  }

  return configs;
}

// ── Process Management ──────────────────────────────────────
interface BotProcess {
  config: WalletConfig;
  process: ChildProcess;
  startedAt: number;
  restarts: number;
  lastOutput: string[];
  healthy: boolean;
}

const bots: BotProcess[] = [];
let running = true;

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [fleet] ${msg}`);
}

function spawnBot(config: WalletConfig): ChildProcess {
  const scriptPath = path.join(import.meta.dirname ?? __dirname, "floating-maker.ts");
  const env = {
    ...process.env,
    BOOTSTRAP_KEYPAIR: config.keypairPath,
    SPREAD_BPS: String(config.spreadBps),
    MAX_QUOTE_SIZE_USDC: String(config.maxQuoteSizeUsdc),
    QUOTE_INTERVAL_MS: String(config.quoteIntervalMs),
    DRY_RUN: process.env.DRY_RUN ?? "false",
  };

  const child = spawn("npx", ["tsx", scriptPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return child;
}

function startBot(config: WalletConfig, bot?: BotProcess): BotProcess {
  const child = spawnBot(config);
  const outputBuffer: string[] = [];

  const b: BotProcess = bot ?? {
    config,
    process: child,
    startedAt: Date.now(),
    restarts: 0,
    lastOutput: [],
    healthy: true,
  };

  if (bot) {
    b.process = child;
    b.restarts++;
    b.startedAt = Date.now();
  }

  child.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      outputBuffer.push(line);
      if (outputBuffer.length > 50) outputBuffer.shift();
      // Prefix with profile name
      console.log(`[${config.profile}] ${line}`);
    }
    b.lastOutput = outputBuffer.slice(-20);
    b.healthy = true;
  });

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      console.error(`[${config.profile}] ERR: ${line}`);
    }
  });

  child.on("exit", (code) => {
    if (!running) return;
    log(`⚠️ ${config.profile} bot exited with code ${code}. Restarting in 10s...`);
    b.healthy = false;
    setTimeout(() => {
      if (running) {
        log(`🔄 Restarting ${config.profile} bot (restart #${b.restarts + 1})...`);
        startBot(config, b);
      }
    }, 10_000);
  });

  log(`🚀 Started ${config.profile} bot (PID: ${child.pid})`);
  return b;
}

// ── Health Endpoint ─────────────────────────────────────────
function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const allHealthy = bots.every((b) => b.healthy);
      const body = JSON.stringify(
        {
          status: allHealthy ? "ok" : "degraded",
          bots: bots.map((b) => ({
            profile: b.config.profile,
            spreadBps: b.config.spreadBps,
            pid: b.process.pid,
            healthy: b.healthy,
            uptimeS: Math.floor((Date.now() - b.startedAt) / 1000),
            restarts: b.restarts,
            lastOutput: b.lastOutput.slice(-3),
          })),
        },
        null,
        2,
      );
      res.writeHead(allHealthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(FLEET_HEALTH_PORT, () => {
    log(`Fleet health endpoint: http://localhost:${FLEET_HEALTH_PORT}/health`);
  });
  return server;
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  PERC-373: MM Fleet Runner                           ║
║  Multi-wallet floating market maker orchestrator     ║
╚══════════════════════════════════════════════════════╝
`);

  const configs = loadWalletConfigs();
  log(`Fleet size: ${configs.length} wallet(s)`);

  for (const config of configs) {
    log(`  ${config.profile}: spread=${config.spreadBps}bps, maxQuote=$${config.maxQuoteSizeUsdc}, interval=${config.quoteIntervalMs}ms`);
    if (!fs.existsSync(config.keypairPath)) {
      console.error(`❌ Keypair not found: ${config.keypairPath}`);
      process.exit(1);
    }
  }

  // Start health server
  const healthServer = startHealthServer();

  // Start all bots
  for (const config of configs) {
    const bot = startBot(config);
    bots.push(bot);
    // Stagger starts by 2s to avoid RPC rate limits
    await new Promise((r) => setTimeout(r, 2000));
  }

  log(`✅ All ${bots.length} bots started`);

  // Graceful shutdown
  const shutdown = () => {
    if (!running) return;
    running = false;
    log("Shutting down fleet...");
    for (const bot of bots) {
      bot.process.kill("SIGTERM");
    }
    healthServer.close();
    // Force kill after 10s
    setTimeout(() => {
      for (const bot of bots) {
        try { bot.process.kill("SIGKILL"); } catch { /* ignore */ }
      }
      process.exit(0);
    }, 10_000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  while (running) {
    await new Promise((r) => setTimeout(r, 30_000));
    // Print fleet status
    const healthyCount = bots.filter((b) => b.healthy).length;
    log(`Fleet status: ${healthyCount}/${bots.length} healthy`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});

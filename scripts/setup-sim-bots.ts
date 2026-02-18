/**
 * setup-sim-bots.ts — Generate bot wallets for the Percolator Simulator
 *
 * Generates 15 Solana keypairs (5 per bot type × 3 markets) and saves them
 * to config/sim-bot-wallets.json.
 *
 * Usage:
 *   npx tsx scripts/setup-sim-bots.ts [--overwrite]
 *
 * After running, fund each bot wallet:
 *   - SOL for transaction fees
 *   - simUSDC for trading (done automatically on first trade via InitUser + admin deposit)
 */

import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────

type BotType = "trend_follower" | "mean_reverter" | "market_maker";

const MARKETS = ["SOL/USD", "BTC/USD", "ETH/USD"] as const;
const BOT_TYPES: BotType[] = ["trend_follower", "mean_reverter", "market_maker"];
const BOTS_PER_TYPE = 5;

interface BotWallet {
  botId: string;
  type: BotType;
  market: string;
  publicKey: string;
  secretKey: number[];
}

interface BotWalletsConfig {
  generatedAt: string;
  totalBots: number;
  note: string;
  bots: BotWallet[];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    overwrite: { type: "boolean", default: false },
  },
  strict: true,
});

const outPath = path.resolve(__dirname, "../config/sim-bot-wallets.json");

if (fs.existsSync(outPath) && !args.overwrite) {
  const existing = JSON.parse(fs.readFileSync(outPath, "utf-8")) as BotWalletsConfig;
  console.log(`\n⚠️  sim-bot-wallets.json already exists (${existing.totalBots} bots).`);
  console.log("   Pass --overwrite to regenerate (WARNING: old keys will be lost).\n");
  process.exit(0);
}

console.log("\n" + "=".repeat(60));
console.log("PERCOLATOR SIM — Bot Wallet Setup");
console.log("=".repeat(60));

const bots: BotWallet[] = [];

// Generate 5 bots per type, one per market (rotating), so each market gets
// at least one of each type. With 5 bots × 3 types = 15 total.
for (const botType of BOT_TYPES) {
  for (let i = 0; i < BOTS_PER_TYPE; i++) {
    const market = MARKETS[i % MARKETS.length];
    const keypair = Keypair.generate();
    const botId = `${botType}_${i + 1}`;

    bots.push({
      botId,
      type: botType,
      market,
      publicKey: keypair.publicKey.toBase58(),
      secretKey: Array.from(keypair.secretKey),
    });

    console.log(`  ${botId.padEnd(22)} ${market.padEnd(10)} ${keypair.publicKey.toBase58()}`);
  }
}

const config: BotWalletsConfig = {
  generatedAt: new Date().toISOString(),
  totalBots: bots.length,
  note: "SENSITIVE: contains private keys. Do not commit this file to git.",
  bots,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(config, null, 2));

console.log(`\n✅ Generated ${bots.length} bot wallets → ${outPath}`);
console.log("\nNext steps:");
console.log("  1. Fund each wallet with SOL for gas (~0.1 SOL each)");
console.log("  2. Bot simUSDC deposits happen automatically on first trade");
console.log("  3. Start the sim service: npx tsx services/sim-service.ts");
console.log("\nWallet addresses:");

const byType: Record<string, string[]> = {};
for (const bot of bots) {
  byType[bot.type] ??= [];
  byType[bot.type].push(`  ${bot.botId} (${bot.market}): ${bot.publicKey}`);
}

for (const [type, lines] of Object.entries(byType)) {
  console.log(`\n${type.toUpperCase()}:`);
  lines.forEach((l) => console.log(l));
}

// Generate funding script
const fundScript = [
  "#!/bin/bash",
  "# Auto-generated: fund sim bot wallets with SOL",
  "# Run from project root after setting up solana CLI",
  "",
  "AMOUNT=0.1",
  "",
  ...bots.map((bot) => `solana transfer ${bot.publicKey} $AMOUNT --allow-unfunded-recipient`),
].join("\n");

const scriptPath = path.resolve(__dirname, "../scripts/fund-sim-bots.sh");
fs.writeFileSync(scriptPath, fundScript, { mode: 0o755 });
console.log(`\nFunding script generated: ${scriptPath}`);
console.log("\n" + "=".repeat(60));

#!/usr/bin/env -S npx tsx
/**
 * PERC-377: Generate bot wallet keypairs + airdrop devnet SOL.
 *
 * Usage:
 *   npx tsx src/keygen.ts
 *   npx tsx src/keygen.ts --dir /tmp/percolator-bots
 */

import { Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const dirIdx = process.argv.indexOf("--dir");
const OUT_DIR =
  dirIdx >= 0 && dirIdx + 1 < process.argv.length && !process.argv[dirIdx + 1].startsWith("-")
    ? process.argv[dirIdx + 1]
    : "/tmp/percolator-bots";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const AIRDROP_SOL = 2;

const WALLETS = [
  { name: "filler", description: "Filler/crank bot wallet" },
  { name: "maker", description: "Two-sided quote bot wallet" },
];

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  PERC-377: Bot Wallet Generator                      ║
╚══════════════════════════════════════════════════════╝
`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Output directory: ${OUT_DIR}\n`);

  const connection = new Connection(RPC_URL, "confirmed");

  for (const wallet of WALLETS) {
    const filePath = path.join(OUT_DIR, `${wallet.name}.json`);

    // Skip if already exists
    if (fs.existsSync(filePath)) {
      const existing = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf8"))),
      );
      console.log(`✅ ${wallet.name}: ${existing.publicKey.toBase58()} (already exists)`);
      console.log(`   ${wallet.description}\n`);

      // Check balance
      const balance = await connection.getBalance(existing.publicKey);
      if (balance < 0.5 * LAMPORTS_PER_SOL) {
        console.log(`   ⚠️ Low balance: ${balance / LAMPORTS_PER_SOL} SOL — requesting airdrop...`);
        try {
          const sig = await connection.requestAirdrop(existing.publicKey, AIRDROP_SOL * LAMPORTS_PER_SOL);
          await connection.confirmTransaction(sig, "confirmed");
          console.log(`   ✅ Airdrop: +${AIRDROP_SOL} SOL`);
        } catch (e: any) {
          console.log(`   ❌ Airdrop failed: ${e.message?.slice(0, 80)}`);
        }
      }
      continue;
    }

    // Generate new keypair
    const kp = Keypair.generate();
    fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    console.log(`🔑 ${wallet.name}: ${kp.publicKey.toBase58()}`);
    console.log(`   ${wallet.description}`);
    console.log(`   Saved to: ${filePath}`);

    // Airdrop devnet SOL
    console.log(`   Requesting ${AIRDROP_SOL} SOL airdrop...`);
    try {
      const sig = await connection.requestAirdrop(kp.publicKey, AIRDROP_SOL * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      console.log(`   ✅ Airdrop: +${AIRDROP_SOL} SOL`);
    } catch (e: any) {
      console.log(`   ❌ Airdrop failed: ${e.message?.slice(0, 80)}`);
      console.log(`   Manually airdrop: solana airdrop 2 ${kp.publicKey.toBase58()} --url devnet`);
    }
    console.log();
  }

  // Print env vars for running the bot
  console.log(`\n${"═".repeat(60)}`);
  console.log("ENVIRONMENT VARIABLES FOR BOT:");
  console.log("═".repeat(60));
  console.log(`FILLER_KEYPAIR=${path.join(OUT_DIR, "filler.json")}`);
  console.log(`MAKER_KEYPAIR=${path.join(OUT_DIR, "maker.json")}`);
  console.log(`BOT_MODE=both`);
  console.log();
  console.log("Or run with a single wallet (shared):");
  console.log(`BOOTSTRAP_KEYPAIR=${path.join(OUT_DIR, "filler.json")} BOT_MODE=both npx tsx src/index.ts`);
  console.log("═".repeat(60));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

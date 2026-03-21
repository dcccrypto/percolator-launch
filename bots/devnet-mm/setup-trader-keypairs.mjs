#!/usr/bin/env node
/**
 * Generate trader2/trader3 keypairs, fund all traders from mm-bot-keypair,
 * then set TRADER_KEYPAIR_JSON_0..2 on Railway devnet-mm-bots service.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const RPC_URL = "https://devnet.helius-rpc.com/?api-key=0fbb7deb-d1c4-419d-b470-4d3ee2008bce";
const TRADER_BOTS_DIR = "/Users/khubair/.openclaw/percolator/keys/trader-bots";
const MM_BOT_KEYPAIR_PATH = "/Users/khubair/.openclaw/percolator/keys/mm-bot-keypair.json";
const FUND_SOL = 0.25; // SOL per trader

const connection = new Connection(RPC_URL, "confirmed");

function loadOrGenerate(filePath, label) {
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const kp = Keypair.fromSecretKey(Uint8Array.from(data));
    console.log(`✅ ${label}: ${kp.publicKey.toBase58()} (existing)`);
    return kp;
  }
  const kp = Keypair.generate();
  fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(`🔑 ${label}: ${kp.publicKey.toBase58()} (generated)`);
  return kp;
}

async function transferSol(from, to, sol, label) {
  const bal = await connection.getBalance(to.publicKey);
  const existing = bal / LAMPORTS_PER_SOL;
  if (existing >= 0.3) {
    console.log(`  ${label}: ${existing.toFixed(4)} SOL — already funded ✅`);
    return;
  }
  const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to.publicKey, lamports })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [from], { commitment: "confirmed" });
  console.log(`  ${label}: +${sol} SOL ✅ (${sig.slice(0,16)}...)`);
}

async function main() {
  console.log("=== Trader Keypair Setup ===\n");

  // Load mm-bot-keypair (funded, 7 SOL)
  const mmBot = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(MM_BOT_KEYPAIR_PATH, "utf8")))
  );
  const mmBal = await connection.getBalance(mmBot.publicKey);
  console.log(`MM-bot (${mmBot.publicKey.toBase58()}): ${(mmBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (mmBal / LAMPORTS_PER_SOL < 0.5) {
    console.error("❌ MM bot wallet has insufficient SOL to fund traders");
    process.exit(1);
  }
  console.log();

  // Load or generate trader keypairs
  const t1 = loadOrGenerate(path.join(TRADER_BOTS_DIR, "trader1.json"), "trader1");
  const t2 = loadOrGenerate(path.join(TRADER_BOTS_DIR, "trader2.json"), "trader2");
  const t3 = loadOrGenerate(path.join(TRADER_BOTS_DIR, "trader3.json"), "trader3");
  console.log();

  // Fund each trader
  console.log("Funding traders from mm-bot-keypair...");
  await transferSol(mmBot, t1, FUND_SOL, "trader1");
  await transferSol(mmBot, t2, FUND_SOL, "trader2");
  await transferSol(mmBot, t3, FUND_SOL, "trader3");
  console.log();

  // Print env vars for Railway
  const t1json = fs.readFileSync(path.join(TRADER_BOTS_DIR, "trader1.json"), "utf8").trim();
  const t2json = fs.readFileSync(path.join(TRADER_BOTS_DIR, "trader2.json"), "utf8").trim();
  const t3json = fs.readFileSync(path.join(TRADER_BOTS_DIR, "trader3.json"), "utf8").trim();

  console.log("=== Setting Railway env vars ===\n");

  // Set Railway vars via CLI
  const svc = "devnet-mm-bots";
  const vars = [
    ["TRADER_KEYPAIR_JSON_0", t1json],
    ["TRADER_KEYPAIR_JSON_1", t2json],
    ["TRADER_KEYPAIR_JSON_2", t3json],
    ["TRADER_FLEET_SIZE", "3"],
  ];

  for (const [k, v] of vars) {
    try {
      execSync(`railway variables --service ${svc} set ${k}='${v}'`, { stdio: "pipe" });
      console.log(`  ✅ ${k} set`);
    } catch (e) {
      // Railway CLI "set" may require different syntax — try via GraphQL as fallback
      console.log(`  ⚠️  CLI set failed for ${k}, will print for manual set`);
      console.log(`     ${k}='${v.slice(0,30)}...'`);
    }
  }

  console.log("\n✅ Done. Restart devnet-mm-bots service to pick up new trader keypairs.");
  
  // Print pubkeys for verification
  console.log("\nTrader pubkeys:");
  console.log(`  TRADER_KEYPAIR_JSON_0 → ${t1.publicKey.toBase58()}`);
  console.log(`  TRADER_KEYPAIR_JSON_1 → ${t2.publicKey.toBase58()}`);
  console.log(`  TRADER_KEYPAIR_JSON_2 → ${t3.publicKey.toBase58()}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });

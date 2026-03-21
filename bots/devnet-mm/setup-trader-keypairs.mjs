#!/usr/bin/env node
/**
 * setup-trader-keypairs.mjs
 *
 * Generate trader keypairs, fund them from mm-bot-keypair,
 * then set TRADER_KEYPAIR_JSON_0..N on Railway devnet-mm-bots service.
 *
 * All secrets loaded from environment variables — NEVER commit secrets here.
 *
 * Required env vars:
 *   HELIUS_RPC_URL        e.g. https://devnet.helius-rpc.com/?api-key=<key>
 *   MM_BOT_KEYPAIR_JSON   JSON array of the mm-bot secret key bytes
 *   TRADER_BOTS_DIR       directory to store/load trader keypair JSON files
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const RPC_URL = requireEnv("HELIUS_RPC_URL");
const TRADER_BOTS_DIR = requireEnv("TRADER_BOTS_DIR");
const FUND_SOL = 0.25;

const mmBot = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(requireEnv("MM_BOT_KEYPAIR_JSON")))
);

const connection = new Connection(RPC_URL, "confirmed");

function loadOrGenerate(filePath, label) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
  console.log(`  ${label}: +${sol} SOL ✅ (${sig.slice(0, 16)}...)`);
}

async function main() {
  console.log("=== Trader Keypair Setup ===\n");

  const mmBal = await connection.getBalance(mmBot.publicKey);
  console.log(`MM-bot (${mmBot.publicKey.toBase58()}): ${(mmBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const traders = [
    loadOrGenerate(path.join(TRADER_BOTS_DIR, "trader1.json"), "trader1"),
    loadOrGenerate(path.join(TRADER_BOTS_DIR, "trader2.json"), "trader2"),
    loadOrGenerate(path.join(TRADER_BOTS_DIR, "trader3.json"), "trader3"),
  ];
  console.log();

  // Compute actual required SOL before funding
  let requiredSol = 0;
  for (const t of traders) {
    const bal = await connection.getBalance(t.publicKey);
    const existing = bal / LAMPORTS_PER_SOL;
    if (existing < 0.3) requiredSol += FUND_SOL - existing;
  }
  const requiredWithBuffer = requiredSol + 0.01; // fee buffer
  if (mmBal / LAMPORTS_PER_SOL < requiredWithBuffer) {
    console.error(
      `❌ MM bot wallet has insufficient SOL. Has: ${(mmBal / LAMPORTS_PER_SOL).toFixed(4)}, needs: ${requiredWithBuffer.toFixed(4)}`
    );
    process.exit(1);
  }

  console.log("Funding traders from mm-bot-keypair...");
  await transferSol(mmBot, traders[0], FUND_SOL, "trader1");
  await transferSol(mmBot, traders[1], FUND_SOL, "trader2");
  await transferSol(mmBot, traders[2], FUND_SOL, "trader3");
  console.log();

  // Build Railway env vars
  const svc = "devnet-mm-bots";
  const vars = traders.map((t, i) => [
    `TRADER_KEYPAIR_JSON_${i}`,
    fs.readFileSync(path.join(TRADER_BOTS_DIR, `trader${i + 1}.json`), "utf8").trim(),
  ]);
  vars.push(["TRADER_FLEET_SIZE", String(traders.length)]);

  console.log("=== Setting Railway env vars ===\n");
  for (const [k, v] of vars) {
    try {
      execSync(`railway variables --service ${svc} set ${k}='${v}'`, { stdio: "pipe" });
      console.log(`  ✅ ${k} set`);
    } catch {
      // Never log v — it contains private key material
      console.log(`  ⚠️  CLI set failed for ${k} — set it manually in Railway dashboard`);
    }
  }

  console.log("\n✅ Done. Keypair files are in TRADER_BOTS_DIR (untracked).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

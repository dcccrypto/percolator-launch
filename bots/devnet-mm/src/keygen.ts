#!/usr/bin/env -S npx tsx
/**
 * PERC-354/377: Generate bot wallet keypairs + airdrop devnet SOL.
 *
 * Generates 5 wallets:
 *   filler   — crank/health bot (SOL for tx fees only)
 *   maker    — two-sided quote bot (needs USDC collateral)
 *   trader1  — simulated trader #1 (BTC-PERP + SOL-PERP)
 *   trader2  — simulated trader #2 (BTC-PERP + SOL-PERP)
 *   trader3  — simulated trader #3 (SOL-PERP primarily)
 *
 * After generating, run `npx tsx src/fund-devnet-bots.ts` to mint USDC.
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
const HELIUS_KEY = process.env.HELIUS_API_KEY ?? "";
const HELIUS_RPC = HELIUS_KEY ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "";
const AIRDROP_SOL = 2;

// PERC-354: 5-wallet fleet — filler + maker + 3 traders for BTC-PERP/SOL-PERP depth
const WALLETS = [
  { name: "filler",  description: "Filler/crank bot — cranks markets + pushes oracle prices",          needsUsdc: false },
  { name: "maker",   description: "Two-sided quote bot — posts bid/ask on all discovered markets",     needsUsdc: true  },
  { name: "trader1", description: "Simulated trader #1 — aggressive, BTC-PERP + SOL-PERP",             needsUsdc: true  },
  { name: "trader2", description: "Simulated trader #2 — passive/trend, BTC-PERP + SOL-PERP",          needsUsdc: true  },
  { name: "trader3", description: "Simulated trader #3 — trend-follower, SOL-PERP primary",            needsUsdc: true  },
];

async function airdropWithRetry(
  connection: Connection,
  pk: import("@solana/web3.js").PublicKey,
  label: string,
): Promise<boolean> {
  const endpoints = [
    HELIUS_RPC || null,
    RPC_URL,
    "https://api.devnet.solana.com",
  ].filter(Boolean) as string[];

  for (const ep of endpoints) {
    try {
      const conn = ep === RPC_URL ? connection : new Connection(ep, "confirmed");
      const sig = await conn.requestAirdrop(pk, AIRDROP_SOL * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
      return true;
    } catch (e: any) {
      const msg = e.message?.slice(0, 60) ?? "";
      if (!msg.includes("429") && !msg.includes("Too Many")) {
        console.log(`   ⚠️ Airdrop @ ${ep.slice(8, 30)}: ${msg}`);
      }
    }
  }
  return false;
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  PERC-354: Devnet Bot Wallet Generator (5-wallet)    ║
╚══════════════════════════════════════════════════════╝
`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Output directory: ${OUT_DIR}\n`);

  const connection = new Connection(RPC_URL, "confirmed");
  const needsFunding: string[] = [];

  for (const wallet of WALLETS) {
    const filePath = path.join(OUT_DIR, `${wallet.name}.json`);

    let kp: Keypair;
    if (fs.existsSync(filePath)) {
      kp = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf8"))),
      );
      console.log(`✅ ${wallet.name}: ${kp.publicKey.toBase58()} (existing)`);
    } else {
      kp = Keypair.generate();
      fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
      console.log(`🔑 ${wallet.name}: ${kp.publicKey.toBase58()} (generated)`);
    }
    console.log(`   ${wallet.description}`);

    // Check SOL balance and attempt airdrop if needed
    const balance = await connection.getBalance(kp.publicKey).catch(() => 0);
    const solBal = balance / LAMPORTS_PER_SOL;
    if (solBal < 0.5) {
      console.log(`   SOL: ${solBal.toFixed(4)} — requesting ${AIRDROP_SOL} SOL airdrop...`);
      const ok = await airdropWithRetry(connection, kp.publicKey, wallet.name);
      if (ok) {
        console.log(`   ✅ +${AIRDROP_SOL} SOL`);
      } else {
        console.log(`   ❌ Airdrop rate-limited — run fund-devnet-bots.ts when limits clear`);
        needsFunding.push(wallet.name);
      }
    } else {
      console.log(`   SOL: ${solBal.toFixed(4)} ✅`);
    }
    console.log();
  }

  // Print env vars for running the bot
  console.log(`${"═".repeat(60)}`);
  console.log("RAILWAY ENV VARS:");
  console.log("═".repeat(60));
  for (const wallet of WALLETS) {
    const filePath = path.join(OUT_DIR, `${wallet.name}.json`);
    if (fs.existsSync(filePath)) {
      const kpJson = fs.readFileSync(filePath, "utf8").trim();
      if (wallet.name === "filler") console.log(`FILLER_KEYPAIR_JSON='${kpJson}'`);
      if (wallet.name === "maker")  console.log(`MAKER_KEYPAIR_JSON='${kpJson}'`);
      const traderIdx = ["trader1","trader2","trader3"].indexOf(wallet.name);
      if (traderIdx >= 0) console.log(`TRADER_KEYPAIR_JSON_${traderIdx}='${kpJson}'`);
    }
  }
  console.log(`TEST_USDC_MINT=${process.env.TEST_USDC_MINT ?? "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs"}`);
  console.log(`BOT_MODE=all`);
  console.log("═".repeat(60));

  if (needsFunding.length > 0) {
    console.log(`\n⚠️  Wallets needing SOL: ${needsFunding.join(", ")}`);
    console.log("   Run: npx tsx src/fund-devnet-bots.ts");
    console.log("   (or wait for devnet faucet rate limit to reset — typically 24h per IP)");
    process.exit(1);
  } else {
    console.log("\n✅ All wallets funded! Next: npx tsx src/fund-devnet-bots.ts to mint USDC");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

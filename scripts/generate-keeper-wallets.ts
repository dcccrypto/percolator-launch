#!/usr/bin/env tsx
/**
 * PERC-368: Generate 3 keeper wallets for MM fleet.
 *
 * Creates 3 keypair files in the specified directory, airdrops devnet SOL
 * to each, and prints a summary.
 *
 * Usage:
 *   npx tsx scripts/generate-keeper-wallets.ts [--dir /path/to/keys] [--airdrop]
 */

import { Keypair, Connection } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROFILE_NAMES = ["WIDE", "TIGHT_A", "TIGHT_B"];
const AIRDROP_SOL = 2; // SOL per wallet

async function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf("--dir");
  const keyDir = dirIdx >= 0 && args[dirIdx + 1]
    ? args[dirIdx + 1]
    : "/tmp/percolator-keepers";
  const doAirdrop = args.includes("--airdrop");

  fs.mkdirSync(keyDir, { recursive: true });

  const rpcUrl =
    process.env.RPC_URL ??
    `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ""}`;
  const connection = new Connection(rpcUrl, "confirmed");

  console.log(`\n🔑 PERC-368: Generating ${PROFILE_NAMES.length} keeper wallets\n`);
  console.log(`Directory: ${keyDir}`);
  console.log(`Airdrop: ${doAirdrop ? "yes" : "no (use --airdrop)"}\n`);

  const wallets: { name: string; path: string; pubkey: string }[] = [];

  for (const name of PROFILE_NAMES) {
    const filePath = path.join(keyDir, `keeper-${name.toLowerCase()}.json`);

    let kp: Keypair;
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      kp = Keypair.fromSecretKey(Uint8Array.from(raw));
      console.log(`♻️  ${name}: reusing existing ${kp.publicKey.toBase58()}`);
    } else {
      kp = Keypair.generate();
      fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)));
      fs.chmodSync(filePath, 0o600);
      console.log(`✅ ${name}: generated ${kp.publicKey.toBase58()}`);
    }

    if (doAirdrop) {
      try {
        const bal = await connection.getBalance(kp.publicKey);
        if (bal < AIRDROP_SOL * 1e9 * 0.5) {
          console.log(`   💰 Airdropping ${AIRDROP_SOL} SOL...`);
          const sig = await connection.requestAirdrop(
            kp.publicKey,
            AIRDROP_SOL * 1e9,
          );
          await connection.confirmTransaction(sig, "confirmed");
          console.log(`   ✅ Airdrop confirmed: ${sig.slice(0, 16)}...`);
        } else {
          console.log(`   💰 Already has ${(bal / 1e9).toFixed(4)} SOL`);
        }
      } catch (e: any) {
        console.log(`   ⚠️  Airdrop failed: ${e.message?.slice(0, 60)}`);
      }
    }

    wallets.push({ name, path: filePath, pubkey: kp.publicKey.toBase58() });
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log("Environment variables for mm-fleet.ts:\n");
  for (const w of wallets) {
    console.log(`KEEPER_WALLET_${w.name}=${w.path}`);
  }
  console.log(`\n# Or use the directory mode:`);
  console.log(`KEEPER_WALLETS_DIR=${keyDir}`);
  console.log(`${"─".repeat(60)}\n`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * fund-mm-wallets.mjs
 *
 * Funds MAKER and FILLER wallets from the MM bot keypair.
 * All secrets loaded from environment variables — NEVER commit secrets here.
 *
 * Required env vars:
 *   HELIUS_RPC_URL       e.g. https://devnet.helius-rpc.com/?api-key=<key>
 *   MM_BOT_KEYPAIR_JSON  JSON array of the mm-bot secret key bytes
 *   MAKER_KEYPAIR_JSON   JSON array of the maker secret key bytes
 *   FILLER_KEYPAIR_JSON  JSON array of the filler secret key bytes
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const RPC_URL = requireEnv("HELIUS_RPC_URL");
const mmBot = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(requireEnv("MM_BOT_KEYPAIR_JSON")))
);
const makerKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(requireEnv("MAKER_KEYPAIR_JSON")))
);
const fillerKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(requireEnv("FILLER_KEYPAIR_JSON")))
);

const connection = new Connection(RPC_URL, "confirmed");

async function fundIfNeeded(from, to, sol, label) {
  const bal = await connection.getBalance(to.publicKey);
  const existing = bal / LAMPORTS_PER_SOL;
  if (existing >= 0.3) {
    console.log(`  ${label}: ${existing.toFixed(4)} SOL — ok ✅`);
    return;
  }
  const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to.publicKey, lamports })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [from], { commitment: "confirmed" });
  console.log(`  ${label}: +${sol} SOL ✅ (${sig.slice(0, 16)}...)`);
}

const mmBal = await connection.getBalance(mmBot.publicKey);
console.log(`MM-bot (${mmBot.publicKey.toBase58()}): ${(mmBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
console.log(`MAKER:  ${makerKp.publicKey.toBase58()}`);
console.log(`FILLER: ${fillerKp.publicKey.toBase58()}`);

await fundIfNeeded(mmBot, makerKp, 0.1, "maker");
await fundIfNeeded(mmBot, fillerKp, 0.1, "filler");

const mmBal2 = await connection.getBalance(mmBot.publicKey);
console.log(`\nMM-bot remaining: ${(mmBal2 / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

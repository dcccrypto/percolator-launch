import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey } from "@solana/web3.js";
import fs from "fs";

const RPC_URL = "https://devnet.helius-rpc.com/?api-key=0fbb7deb-d1c4-419d-b470-4d3ee2008bce";
const MM_BOT_KEYPAIR_PATH = "/Users/khubair/.openclaw/percolator/keys/mm-bot-keypair.json";

const connection = new Connection(RPC_URL, "confirmed");
const mmBot = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(MM_BOT_KEYPAIR_PATH, "utf8"))));

const mmBal = await connection.getBalance(mmBot.publicKey);
console.log(`MM-bot (${mmBot.publicKey.toBase58()}): ${(mmBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

// MAKER wallet from env (last 32 bytes = pubkey)
const makerArr = [137,31,132,147,121,127,168,129,167,77,197,30,70,226,188,12,26,105,83,45,207,232,47,5,253,59,250,226,145,195,82,236,83,102,98,63,114,132,183,64,38,13,94,170,188,115,220,38,43,49,7,100,215,18,208,125,169,146,97,240,76,134,136,65];
const makerKp = Keypair.fromSecretKey(Uint8Array.from(makerArr));
console.log(`MAKER: ${makerKp.publicKey.toBase58()}`);

// FILLER wallet
const fillerArr = [16,185,95,120,64,66,128,230,56,187,128,85,25,64,232,36,145,17,73,112,142,167,188,20,69,27,5,225,239,89,177,127,213,193,11,201,114,182,2,51,116,9,240,27,187,249,28,105,194,211,39,229,228,172,208,80,231,138,227,47,125,123,22,176];
const fillerKp = Keypair.fromSecretKey(Uint8Array.from(fillerArr));
console.log(`FILLER: ${fillerKp.publicKey.toBase58()}`);

async function fundIfNeeded(from, to, sol, label) {
  const bal = await connection.getBalance(to.publicKey);
  const existing = bal / LAMPORTS_PER_SOL;
  if (existing >= 0.3) {
    console.log(`  ${label}: ${existing.toFixed(4)} SOL — ok ✅`);
    return;
  }
  const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to.publicKey, lamports }));
  const sig = await sendAndConfirmTransaction(connection, tx, [from], { commitment: "confirmed" });
  console.log(`  ${label}: +${sol} SOL ✅ (${sig.slice(0,16)}...)`);
}

await fundIfNeeded(mmBot, makerKp, 0.1, "maker");
await fundIfNeeded(mmBot, fillerKp, 0.1, "filler");

const mmBal2 = await connection.getBalance(mmBot.publicKey);
console.log(`\nMM-bot remaining: ${(mmBal2 / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

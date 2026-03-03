#!/usr/bin/env npx tsx
/**
 * Mint devnet collateral tokens to MM bot wallets.
 * Uses mint authority from deploy + admin keypair as fee payer.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";

const DEPLOYMENT = JSON.parse(fs.readFileSync("/tmp/percolator-devnet-deployment.json", "utf8"));
const MINT_INFO = JSON.parse(fs.readFileSync("/tmp/percolator-test-usdc.json", "utf8"));

const MINT = new PublicKey(DEPLOYMENT.mint);
const mintAuthKp = Keypair.fromSecretKey(Uint8Array.from(MINT_INFO.secretKey));

// Admin keypair (fee payer + original mint authority)
const ADMIN_PATH = `${process.env.HOME}/.config/solana/percolator-upgrade-authority.json`;
let adminKp: Keypair;
try {
  adminKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_PATH, "utf8"))));
} catch {
  console.log("Admin keypair not found at", ADMIN_PATH);
  process.exit(1);
}

const HELIUS_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC_URL = HELIUS_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : "https://api.devnet.solana.com";

const connection = new Connection(RPC_URL, "confirmed");

const fillerKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/percolator-bots/filler.json", "utf8"))));
const makerKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/percolator-bots/maker.json", "utf8"))));

const MINT_AMOUNT = 100_000_000_000n; // 100,000 tokens (6 decimals)

console.log(`Mint: ${MINT.toBase58()}`);
console.log(`Mint authority (from file): ${mintAuthKp.publicKey.toBase58()}`);
console.log(`Admin (fee payer): ${adminKp.publicKey.toBase58()}`);
console.log(`Filler: ${fillerKp.publicKey.toBase58()}`);
console.log(`Maker: ${makerKp.publicKey.toBase58()}`);

// Check balances
const adminBal = await connection.getBalance(adminKp.publicKey);
const mintAuthBal = await connection.getBalance(mintAuthKp.publicKey);
console.log(`\nAdmin SOL: ${adminBal / 1e9}`);
console.log(`MintAuth SOL: ${mintAuthBal / 1e9}`);

// The deploy script set admin as mint authority (createInitializeMintInstruction uses admin.publicKey)
// So admin is the actual mint authority, not the mint keypair
console.log(`\nUsing admin as mint authority (set during createInitializeMintInstruction)...\n`);

async function mintToWallet(walletPk: PublicKey, label: string) {
  const ata = await getAssociatedTokenAddress(MINT, walletPk);
  
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  
  let ataExists = false;
  try {
    const info = await connection.getTokenAccountBalance(ata);
    ataExists = true;
    console.log(`${label}: ATA exists, balance = ${info.value.uiAmount}`);
  } catch {
    console.log(`${label}: Creating ATA...`);
    tx.add(createAssociatedTokenAccountInstruction(adminKp.publicKey, ata, walletPk, MINT));
  }
  
  // Admin is the mint authority
  tx.add(createMintToInstruction(MINT, ata, adminKp.publicKey, MINT_AMOUNT));
  
  const sig = await sendAndConfirmTransaction(connection, tx, [adminKp], {
    commitment: "confirmed",
  });
  console.log(`${label}: ✅ Minted ${Number(MINT_AMOUNT) / 1e6} tokens → ${sig.slice(0, 20)}...`);
  
  const balance = await connection.getTokenAccountBalance(ata);
  console.log(`${label}: Final balance = ${balance.value.uiAmount}\n`);
}

try {
  await mintToWallet(fillerKp.publicKey, "Filler");
  await mintToWallet(makerKp.publicKey, "Maker");
  console.log("✅ Both wallets funded with collateral tokens!");
} catch (e: any) {
  console.error("Error:", e.message);
  // If admin isn't the authority, try with mintAuthKp
  if (e.message?.includes("owner does not match") || e.message?.includes("mint authority")) {
    console.log("\nAdmin is not mint authority — retrying with mint keypair as authority...");
    // Would need to restructure - but let's see the error first
  }
  process.exit(1);
}

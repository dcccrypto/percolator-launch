#!/usr/bin/env npx tsx
/**
 * Fund MM bot wallets with collateral tokens.
 *
 * Creates ATAs and mints devnet collateral tokens to the filler and maker
 * bot wallets so they can InitUser + deposit on Percolator markets.
 *
 * Uses the program upgrade authority as the mint authority (it created
 * the collateral mints during deploy-devnet-mm.ts).
 *
 * Usage:
 *   npx tsx scripts/fund-mm-bots.ts
 *
 * Env:
 *   ADMIN_KEYPAIR_PATH — path to upgrade authority (default: ~/.config/solana/percolator-upgrade-authority.json)
 *   RPC_URL or HELIUS_API_KEY — Solana RPC
 *   MINT_AMOUNT — amount to mint per wallet (default: 50000000000 = 50,000 tokens)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  discoverMarkets,
  deriveVaultAuthority,
} from "../packages/core/src/index.js";
import * as fs from "fs";

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const HELIUS_KEY = process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY ?? "";
const RPC_URL = process.env.RPC_URL ??
  (HELIUS_KEY ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "https://api.devnet.solana.com");

const ADMIN_KP_PATH = process.env.ADMIN_KEYPAIR_PATH ??
  `${process.env.HOME}/.config/solana/percolator-upgrade-authority.json`;

const PROGRAM_ID = new PublicKey("FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn");

const FILLER_WALLET = new PublicKey("FPQa6EfDYwc35TDnfbMBojdTmcB9EPhzEQc27oEcRb2X");
const MAKER_WALLET = new PublicKey("6cZPV3w2ySoiKgCUn5b3SbXrarPfaf72d9veTgRic7tL");

// 50,000 tokens (6 decimals) per wallet — enough for InitUser fee + collateral deposits
const MINT_AMOUNT = BigInt(process.env.MINT_AMOUNT ?? "50000000000");

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log("═══ Fund MM Bot Wallets ═══");
  console.log(`RPC: ${RPC_URL.replace(/api-key=.*/, "api-key=***")}`);

  const conn = new Connection(RPC_URL, "confirmed");

  // Load admin/mint authority
  if (!fs.existsSync(ADMIN_KP_PATH)) {
    console.error(`❌ Admin keypair not found: ${ADMIN_KP_PATH}`);
    process.exit(1);
  }
  const admin = loadKeypair(ADMIN_KP_PATH);
  console.log(`Admin/Mint authority: ${admin.publicKey.toBase58()}`);

  const adminBal = await conn.getBalance(admin.publicKey);
  console.log(`Admin SOL balance: ${(adminBal / LAMPORTS_PER_SOL).toFixed(4)}`);
  if (adminBal < 0.01 * LAMPORTS_PER_SOL) {
    console.error("❌ Admin has insufficient SOL for transaction fees");
    process.exit(1);
  }

  // Discover markets to find collateral mints
  console.log("\nDiscovering markets...");
  const markets = await discoverMarkets(conn, PROGRAM_ID);
  const activeMarkets = markets.filter(m => !m.header.paused && !m.header.resolved);
  console.log(`Found ${markets.length} markets, ${activeMarkets.length} active`);

  // Collect unique collateral mints we can fund (where admin is mint authority)
  const mintsToFund = new Map<string, PublicKey>();

  for (const m of activeMarkets) {
    const mint = m.config.collateralMint;
    const mintStr = mint.toBase58();
    if (!mintsToFund.has(mintStr)) {
      mintsToFund.set(mintStr, mint);
    }
  }

  console.log(`\nUnique collateral mints: ${mintsToFund.size}`);

  const wallets = [
    { name: "Filler", pubkey: FILLER_WALLET },
    { name: "Maker", pubkey: MAKER_WALLET },
  ];

  let totalFunded = 0;

  for (const [mintStr, mint] of mintsToFund) {
    console.log(`\n═══ Mint: ${mintStr.slice(0, 16)}... ═══`);

    // Check if admin is the mint authority
    const { getMint } = await import("@solana/spl-token");
    let mintInfo;
    try {
      mintInfo = await getMint(conn, mint);
    } catch (e) {
      console.log(`  ⚠️ Could not fetch mint info — skipping`);
      continue;
    }

    if (!mintInfo.mintAuthority?.equals(admin.publicKey)) {
      console.log(`  ⚠️ Admin is NOT mint authority (authority: ${mintInfo.mintAuthority?.toBase58() ?? "NONE"}) — skipping`);
      continue;
    }

    console.log(`  ✅ Admin is mint authority`);
    console.log(`  Decimals: ${mintInfo.decimals}`);

    for (const wallet of wallets) {
      const ata = await getAssociatedTokenAddress(mint, wallet.pubkey);
      console.log(`\n  ${wallet.name} (${wallet.pubkey.toBase58().slice(0, 16)}...)`);
      console.log(`    ATA: ${ata.toBase58()}`);

      // Check if ATA exists
      let ataExists = false;
      let currentBalance = 0n;
      try {
        const accInfo = await getAccount(conn, ata);
        ataExists = true;
        currentBalance = accInfo.amount;
        console.log(`    Existing balance: ${Number(currentBalance) / 1e6} tokens`);
      } catch {
        console.log(`    ATA does not exist — will create`);
      }

      // Skip if already has enough
      if (currentBalance >= MINT_AMOUNT) {
        console.log(`    Already has sufficient balance — skipping`);
        continue;
      }

      const mintAmount = MINT_AMOUNT - currentBalance;

      // Build transaction
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));

      if (!ataExists) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            admin.publicKey,  // payer
            ata,              // ATA address
            wallet.pubkey,    // owner
            mint,             // mint
          )
        );
        console.log(`    + CreateATA instruction`);
      }

      tx.add(
        createMintToInstruction(
          mint,             // mint
          ata,              // destination
          admin.publicKey,  // authority
          mintAmount,       // amount
        )
      );
      console.log(`    + MintTo ${Number(mintAmount) / 1e6} tokens`);

      try {
        const sig = await sendAndConfirmTransaction(conn, tx, [admin], {
          commitment: "confirmed",
          skipPreflight: false,
        });
        console.log(`    ✅ Success: ${sig.slice(0, 24)}...`);
        totalFunded++;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`    ❌ Failed: ${msg.slice(0, 200)}`);
      }

      // Small delay between transactions
      await sleep(500);
    }
  }

  // Also ensure vault ATAs exist for each active market
  console.log("\n═══ Verify Vault ATAs ═══");
  for (const m of activeMarkets) {
    const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, m.slabAddress);
    const vaultAta = await getAssociatedTokenAddress(m.config.collateralMint, vaultPda, true);
    try {
      await getAccount(conn, vaultAta);
      console.log(`  ${m.slabAddress.toBase58().slice(0, 16)}... vault ATA: ✅ exists`);
    } catch {
      console.log(`  ${m.slabAddress.toBase58().slice(0, 16)}... vault ATA: ❌ MISSING`);
    }
  }

  // Final verification
  console.log("\n═══ VERIFICATION ═══");
  for (const wallet of wallets) {
    console.log(`\n  ${wallet.name}:`);
    for (const [mintStr, mint] of mintsToFund) {
      const ata = await getAssociatedTokenAddress(mint, wallet.pubkey);
      try {
        const accInfo = await getAccount(conn, ata);
        console.log(`    ${mintStr.slice(0, 12)}...: ${Number(accInfo.amount) / 1e6} tokens ✅`);
      } catch {
        console.log(`    ${mintStr.slice(0, 12)}...: NO ATA ❌`);
      }
    }
  }

  console.log(`\n═══ Done — funded ${totalFunded} wallet/mint pairs ═══`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});

#!/usr/bin/env npx tsx
/**
 * Diagnostic script: Investigate MM bot InitUser failures
 *
 * Checks:
 * 1. What markets exist and their collateral mints
 * 2. Bot wallet SOL + token balances
 * 3. Whether bot ATAs exist for the collateral mints
 * 4. Simulates InitUser to get the exact error
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import {
  discoverMarkets,
  parseAllAccounts,
  encodeInitUser,
  ACCOUNTS_INIT_USER,
  buildAccountMetas,
  buildIx,
  deriveVaultAuthority,
} from "../packages/core/src/index.js";
import * as fs from "fs";

const HELIUS_KEY = process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY ?? "";
const RPC_URL = process.env.RPC_URL ??
  (HELIUS_KEY ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "https://api.devnet.solana.com");

const PROGRAM_ID = new PublicKey("FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn");

const FILLER_WALLET = new PublicKey("FPQa6EfDYwc35TDnfbMBojdTmcB9EPhzEQc27oEcRb2X");
const MAKER_WALLET = new PublicKey("6cZPV3w2ySoiKgCUn5b3SbXrarPfaf72d9veTgRic7tL");
const TEST_USDC_MINT = new PublicKey("DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs");

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  console.log("RPC:", RPC_URL.replace(/api-key=.*/, "api-key=***"));
  console.log("");

  // 1. Discover markets
  console.log("═══ MARKET DISCOVERY ═══");
  const markets = await discoverMarkets(conn, PROGRAM_ID);
  console.log(`Found ${markets.length} markets`);

  const mintSet = new Set<string>();
  for (const m of markets) {
    const feedId = m.config.indexFeedId;
    const feedHex = Buffer.from(
      feedId instanceof PublicKey ? feedId.toBytes() : (feedId as Uint8Array),
    ).toString("hex");

    const isHyperp = feedHex === "0".repeat(64);
    let symbol = "UNKNOWN";
    if (isHyperp) {
      const markUsd = Number(m.config.authorityPriceE6 ?? 0n) / 1_000_000;
      if (markUsd > 50_000) symbol = "BTC";
      else if (markUsd > 2_000) symbol = "ETH";
      else if (markUsd > 50) symbol = "SOL";
    }

    const mint = m.config.collateralMint.toBase58();
    mintSet.add(mint);

    // Parse accounts to see existing users/LPs
    const slabInfo = await conn.getAccountInfo(m.slabAddress);
    const slabData = slabInfo ? new Uint8Array(slabInfo.data) : null;
    const accounts = slabData ? parseAllAccounts(slabData) : [];
    const users = accounts.filter(a => a.account.kind === 0);
    const lps = accounts.filter(a => a.account.kind === 1);

    const fillerUser = users.find(u => u.account.owner.equals(FILLER_WALLET));
    const makerUser = users.find(u => u.account.owner.equals(MAKER_WALLET));
    const fillerLp = lps.find(u => u.account.owner.equals(FILLER_WALLET));
    const makerLp = lps.find(u => u.account.owner.equals(MAKER_WALLET));

    console.log(`\n  Market: ${symbol} | Slab: ${m.slabAddress.toBase58().slice(0,16)}...`);
    console.log(`    Collateral mint: ${mint}`);
    console.log(`    Paused: ${m.header.paused} | Resolved: ${m.header.resolved}`);
    console.log(`    Oracle mode: ${isHyperp ? "authority" : "pyth"}`);
    console.log(`    Price: $${(Number(m.config.authorityPriceE6 ?? 0n) / 1e6).toFixed(2)}`);
    console.log(`    Total accounts: ${accounts.length} (${users.length} users, ${lps.length} LPs)`);
    console.log(`    Filler user: ${fillerUser ? `idx=${fillerUser.idx}` : "NOT FOUND"}`);
    console.log(`    Filler LP:   ${fillerLp ? `idx=${fillerLp.idx}` : "NOT FOUND"}`);
    console.log(`    Maker user:  ${makerUser ? `idx=${makerUser.idx}` : "NOT FOUND"}`);
    console.log(`    Maker LP:    ${makerLp ? `idx=${makerLp.idx}` : "NOT FOUND"}`);
  }

  // 2. Check wallet balances
  console.log("\n═══ WALLET BALANCES ═══");
  for (const [name, wallet] of [["Filler", FILLER_WALLET], ["Maker", MAKER_WALLET]] as const) {
    const solBal = await conn.getBalance(wallet);
    console.log(`\n  ${name}: ${wallet.toBase58()}`);
    console.log(`    SOL: ${(solBal / LAMPORTS_PER_SOL).toFixed(4)}`);

    // Check token balances for each unique mint
    for (const mintStr of mintSet) {
      const mint = new PublicKey(mintStr);
      const ata = await getAssociatedTokenAddress(mint, wallet);
      try {
        const accInfo = await getAccount(conn, ata);
        console.log(`    Token (${mintStr.slice(0,12)}...): ${Number(accInfo.amount) / 1e6} (ATA exists: ${ata.toBase58().slice(0,12)}...)`);
      } catch {
        console.log(`    Token (${mintStr.slice(0,12)}...): NO ATA (${ata.toBase58().slice(0,12)}...)`);
      }
    }

    // Also check test USDC specifically
    if (!mintSet.has(TEST_USDC_MINT.toBase58())) {
      const ata = await getAssociatedTokenAddress(TEST_USDC_MINT, wallet);
      try {
        const accInfo = await getAccount(conn, ata);
        console.log(`    Test USDC: ${Number(accInfo.amount) / 1e6} (ATA: ${ata.toBase58().slice(0,12)}...)`);
      } catch {
        console.log(`    Test USDC: NO ATA`);
      }
    }
  }

  // 3. Simulate InitUser for first active market with filler wallet
  console.log("\n═══ SIMULATE InitUser ═══");
  const activeMarkets = markets.filter(m => !m.header.paused && !m.header.resolved);
  if (activeMarkets.length > 0) {
    const m = activeMarkets[0];
    const mint = m.config.collateralMint;
    const slab = m.slabAddress;

    console.log(`  Simulating on market: ${slab.toBase58().slice(0,16)}...`);

    const fillerAta = await getAssociatedTokenAddress(mint, FILLER_WALLET);
    const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slab);
    const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);

    console.log(`  Filler ATA: ${fillerAta.toBase58()}`);
    console.log(`  Vault PDA: ${vaultPda.toBase58()}`);
    console.log(`  Vault ATA: ${vaultAta.toBase58()}`);

    // Check if vault ATA exists
    try {
      const vaultAccInfo = await getAccount(conn, vaultAta);
      console.log(`  Vault ATA balance: ${Number(vaultAccInfo.amount) / 1e6}`);
    } catch {
      console.log(`  Vault ATA: DOES NOT EXIST`);
    }

    // Build and simulate the InitUser tx
    const initUserData = encodeInitUser({ feePayment: "1000000" });
    const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      FILLER_WALLET, slab, fillerAta, vaultAta,
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    ]);
    const ix = buildIx({ programId: PROGRAM_ID, keys: initUserKeys, data: initUserData });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(ix);
    tx.feePayer = FILLER_WALLET;

    try {
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      const sim = await conn.simulateTransaction(tx);
      console.log(`\n  Simulation result:`);
      console.log(`    Error: ${JSON.stringify(sim.value.err)}`);
      if (sim.value.logs) {
        console.log(`    Logs:`);
        for (const l of sim.value.logs) {
          console.log(`      ${l}`);
        }
      }
    } catch (e) {
      console.log(`  Simulation error: ${e}`);
    }
  }

  console.log("\n═══ DONE ═══");
}

main().catch(e => { console.error("Error:", e); process.exit(1); });

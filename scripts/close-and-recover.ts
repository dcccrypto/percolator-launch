#!/usr/bin/env npx tsx
/**
 * Close market, recover all funds (vault USDC + slab rent SOL).
 * Uses raw byte offsets for SBF v12.15 small layout — no SDK parser dependency.
 */
import { Connection, PublicKey, Keypair, TransactionInstruction, SYSVAR_CLOCK_PUBKEY, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import fs from "fs";

const RPC = process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
if (!RPC) throw new Error("Set RPC_URL or HELIUS_API_KEY before running this script");
const SLAB = new PublicKey("DSz7UykKuHLWAJjEEREAZAoLeYdoKQ9GL5rhA2BU6irH");
const PROGRAM = new PublicKey("ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv");

// SBF v12.15 small layout constants
const ENGINE_OFF = 616;
const BITMAP_OFF = ENGINE_OFF + 640; // absolute
const ACCOUNTS_OFF = ENGINE_OFF + 1208; // absolute
const ACCOUNT_SIZE = 920;
const ACCT_OWNER_OFF = 192;
const ACCT_CAPITAL_OFF = 8;

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.percolator-mainnet/keys/deploy-authority.json`, "utf8"))));

  const info = await conn.getAccountInfo(SLAB);
  if (!info) throw new Error("Slab not found");
  const d = info.data;

  const mint = new PublicKey(d.subarray(72, 104));
  const vaultAta = new PublicKey(d.subarray(104, 136));
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), SLAB.toBuffer()], PROGRAM);
  const adminAta = getAssociatedTokenAddressSync(mint, admin.publicKey);

  const vault_lo = d.readBigUInt64LE(ENGINE_OFF);
  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Mint:", mint.toBase58());
  console.log("Vault ATA:", vaultAta.toBase58());
  console.log("Vault balance:", (Number(vault_lo) / 1e6).toFixed(2), "USDC");

  // Find used accounts from bitmap
  const usedIdxs: number[] = [];
  for (let word = 0; word < 4; word++) {
    const bits = d.readBigUInt64LE(BITMAP_OFF + word * 8);
    for (let bit = 0; bit < 64; bit++) {
      if ((bits >> BigInt(bit)) & 1n) usedIdxs.push(word * 64 + bit);
    }
  }
  console.log("Used accounts:", usedIdxs);

  for (const idx of usedIdxs) {
    const off = ACCOUNTS_OFF + idx * ACCOUNT_SIZE;
    const owner = new PublicKey(d.subarray(off + ACCT_OWNER_OFF, off + ACCT_OWNER_OFF + 32));
    const cap = Number(d.readBigUInt64LE(off + ACCT_CAPITAL_OFF)) / 1e6;
    console.log(`  #${idx}: owner=${owner.toBase58().slice(0, 12)}... capital=${cap.toFixed(2)} USDC`);
  }

  // Step 1: ResolveMarket
  console.log("\n--- ResolveMarket (tag 19) ---");
  const resolveTx = new Transaction();
  // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
  // requests the full heap frame. Must be the FIRST instruction. (issue #176)
  resolveTx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
  resolveTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  resolveTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  resolveTx.add(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: SLAB, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SLAB, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([19]),
  }));

  try {
    const sig = await sendAndConfirmTransaction(conn, resolveTx, [admin]);
    console.log("ResolveMarket OK:", sig);
  } catch (e: any) {
    console.log("ResolveMarket:", e.message?.slice(0, 300));
  }

  // Step 2: ForceClose each used account
  for (const idx of usedIdxs) {
    const off = ACCOUNTS_OFF + idx * ACCOUNT_SIZE;
    const owner = new PublicKey(d.subarray(off + ACCT_OWNER_OFF, off + ACCT_OWNER_OFF + 32));
    const ownerAta = getAssociatedTokenAddressSync(mint, owner);

    console.log(`\n--- ForceClose #${idx} ---`);
    const closeData = Buffer.alloc(3);
    closeData[0] = 21;
    closeData.writeUInt16LE(idx, 1);

    const closeTx = new Transaction();
    // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
    // requests the full heap frame. Must be the FIRST instruction. (issue #176)
    closeTx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    closeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    closeTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));

    const ownerAtaInfo = await conn.getAccountInfo(ownerAta);
    if (!ownerAtaInfo) {
      closeTx.add(createAssociatedTokenAccountInstruction(admin.publicKey, ownerAta, owner, mint));
    }

    closeTx.add(new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: SLAB, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: ownerAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuth, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SLAB, isSigner: false, isWritable: false },
      ],
      data: closeData,
    }));

    try {
      const sig = await sendAndConfirmTransaction(conn, closeTx, [admin]);
      console.log(`  ForceClose #${idx} OK:`, sig);
    } catch (e: any) {
      console.log(`  ForceClose #${idx}:`, e.message?.slice(0, 300));
    }
  }

  // Step 3: Close slab to recover rent
  console.log("\n--- CloseOrphanSlab (tag 29) ---");
  const closeSlab = new Transaction();
  // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
  // requests the full heap frame. Must be the FIRST instruction. (issue #176)
  closeSlab.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
  closeSlab.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  closeSlab.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  closeSlab.add(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: SLAB, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([29]),
  }));

  try {
    const sig = await sendAndConfirmTransaction(conn, closeSlab, [admin]);
    console.log("CloseOrphanSlab OK:", sig);
  } catch (e: any) {
    console.log("CloseOrphanSlab:", e.message?.slice(0, 300));
  }

  // Final balances
  const bal = await conn.getBalance(admin.publicKey);
  const usdcBal = await conn.getTokenAccountBalance(adminAta).catch(() => null);
  console.log("\n=== Final Balances ===");
  console.log("SOL:", (bal / 1e9).toFixed(4));
  console.log("USDC:", usdcBal?.value?.uiAmountString ?? "?");
}

main().catch(console.error);

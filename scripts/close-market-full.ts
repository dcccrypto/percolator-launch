#!/usr/bin/env npx tsx
/**
 * Full market close:
 * 0. AdminReclaimAdmin (stake tag 17) — transfer admin back to human wallet
 * 1. AdminForceCloseAccount (wrapper tag 21) — close each account
 * 2. WithdrawInsurance (wrapper tag 20) — get insurance back
 * 3. CloseOrphanSlab (wrapper tag 29) — recover rent SOL
 *
 * Note: Market was already resolved via AdminResolveMarket (stake tag 9).
 */
import { Connection, PublicKey, Keypair, TransactionInstruction, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import fs from "fs";

const RPC = process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
if (!RPC) throw new Error("Set RPC_URL or HELIUS_API_KEY before running this script");
const SLAB = new PublicKey("5RfUzS1kpdhVb2CNGvE9UGdthsGbd354LoXSYjCFHv3R");
const PROGRAM = new PublicKey("ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv");       // wrapper
const STAKE_PROGRAM = new PublicKey("DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F");  // stake
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const VAULT_ATA = new PublicKey("EqyHR7JCVshYv7fD8j8rZNa5xAEr5gW8wcukzkKbQjGp");

const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("stake_pool"), SLAB.toBuffer()], STAKE_PROGRAM);
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), SLAB.toBuffer()], PROGRAM);

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.percolator-mainnet/keys/deploy-authority.json`, "utf8")
  )));

  console.log("Admin wallet:", admin.publicKey.toBase58());
  console.log("Pool PDA:", poolPda.toBase58());

  const adminBal = await conn.getBalance(admin.publicKey);
  const vaultBal = await conn.getTokenAccountBalance(VAULT_ATA);
  console.log(`Admin SOL: ${(adminBal / 1e9).toFixed(4)}`);
  console.log(`Vault USDC: ${vaultBal.value.uiAmountString}`);

  // ===== STEP 0: AdminReclaimAdmin (stake tag 17) =====
  console.log("\n--- Step 0: AdminReclaimAdmin (stake tag 17) ---");
  {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
    tx.add(new TransactionInstruction({
      programId: STAKE_PROGRAM,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: SLAB, isSigner: false, isWritable: true },
        { pubkey: PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([17]),
    }));

    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
      console.log("  ReclaimAdmin OK:", sig);
    } catch (e: any) {
      console.log("  ReclaimAdmin error:", e.message?.slice(0, 400));
    }
  }

  await new Promise(r => setTimeout(r, 2000));

  // ===== STEP 1: AdminForceCloseAccount (wrapper tag 21) for each account =====
  console.log("\n--- Step 1: AdminForceCloseAccount (wrapper tag 21) ---");
  {
    const info = await conn.getAccountInfo(SLAB);
    if (!info) throw new Error("Slab gone!");
    const d = info.data;

    // Verify admin is now our wallet
    const currentAdmin = new PublicKey(d.subarray(16, 48));
    console.log(`  Current admin: ${currentAdmin.toBase58()}`);

    // Read bitmap
    const bitmapBase = 616 + 648;
    const usedIdxs: number[] = [];
    for (let word = 0; word < 4; word++) {
      let bits = 0n;
      for (let i = 0; i < 8; i++) bits |= BigInt(d[bitmapBase + word * 8 + i]) << BigInt(i * 8);
      for (let bit = 0; bit < 64; bit++) {
        if ((bits >> BigInt(bit)) & 1n) usedIdxs.push(word * 64 + bit);
      }
    }
    console.log(`  Used accounts: [${usedIdxs.join(", ")}]`);

    for (const idx of usedIdxs) {
      const off = 1832 + idx * 920;
      const owner = new PublicKey(d.subarray(off + 192, off + 224));
      const ownerAta = getAssociatedTokenAddressSync(USDC_MINT, owner);

      const isOurs = owner.equals(admin.publicKey);
      console.log(`  Closing #${idx} (owner=${owner.toBase58().slice(0,12)}...) ${isOurs ? '[OUR ACCOUNT - CloseAccount tag 4]' : '[AdminForceClose tag 21]'}`);

      const closeData = Buffer.alloc(3);
      closeData[0] = 21; // AdminForceCloseAccount (tag 21) — market is resolved
      closeData.writeUInt16LE(idx, 1);

      const tx = new Transaction();
      // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
      // requests the full heap frame. Must be the FIRST instruction. (issue #176)
      tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));

      const ownerAtaInfo = await conn.getAccountInfo(ownerAta);
      if (!ownerAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(admin.publicKey, ownerAta, owner, USDC_MINT));
      }

      // CloseAccount (tag 4): user(signer), slab(w), vault(w), user_ata(w), vault_auth, token, clock, oracle
      // AdminForceClose (tag 21): admin(signer), slab(w), vault(w), owner_ata(w), vault_auth, token, clock, oracle
      tx.add(new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },  // user/admin (signer)
          { pubkey: SLAB, isSigner: false, isWritable: true },             // slab
          { pubkey: VAULT_ATA, isSigner: false, isWritable: true },        // vault
          { pubkey: ownerAta, isSigner: false, isWritable: true },         // owner ATA
          { pubkey: vaultAuth, isSigner: false, isWritable: false },       // vault auth PDA
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },// token program
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // clock
          { pubkey: SLAB, isSigner: false, isWritable: false },            // oracle (dummy)
        ],
        data: closeData,
      }));

      try {
        const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
        console.log(`  ForceClose #${idx} OK:`, sig);
      } catch (e: any) {
        console.log(`  ForceClose #${idx} error:`, e.message?.slice(0, 400));
      }
    }
  }

  // ===== STEP 2: WithdrawInsurance (wrapper tag 20) =====
  console.log("\n--- Step 2: WithdrawInsurance (wrapper tag 20) ---");
  {
    const vaultBal2 = await conn.getTokenAccountBalance(VAULT_ATA);
    const remaining = Number(vaultBal2.value.amount);
    console.log(`  Remaining vault USDC: ${vaultBal2.value.uiAmountString}`);

    if (remaining > 0) {
      const adminAta = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey);

      const tx = new Transaction();
      // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
      // requests the full heap frame. Must be the FIRST instruction. (issue #176)
      tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
      tx.add(new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },  // admin
          { pubkey: SLAB, isSigner: false, isWritable: true },             // slab
          { pubkey: adminAta, isSigner: false, isWritable: true },         // admin ATA (receives insurance)
          { pubkey: VAULT_ATA, isSigner: false, isWritable: true },        // vault
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: vaultAuth, isSigner: false, isWritable: false },       // vault authority PDA
        ],
        data: Buffer.from([20]),
      }));

      try {
        const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
        console.log("  WithdrawInsurance OK:", sig);
      } catch (e: any) {
        console.log("  WithdrawInsurance error:", e.message?.slice(0, 400));
      }
    }
  }

  // ===== STEP 3: CloseOrphanSlab (wrapper tag 29) =====
  console.log("\n--- Step 3: CloseOrphanSlab (wrapper tag 29) ---");
  {
    const slabInfo = await conn.getAccountInfo(SLAB);
    if (!slabInfo) {
      console.log("  Slab already closed");
    } else {
      const tx = new Transaction();
      // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
      // requests the full heap frame. Must be the FIRST instruction. (issue #176)
      tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
      tx.add(new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: SLAB, isSigner: false, isWritable: true },
          { pubkey: VAULT_ATA, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([73]), // CloseOrphanSlab
      }));

      try {
        const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
        console.log("  CloseOrphanSlab OK:", sig);
      } catch (e: any) {
        console.log("  CloseOrphanSlab error:", e.message?.slice(0, 400));
      }
    }
  }

  // ===== Final balances =====
  console.log("\n=== Final Balances ===");
  const finalSol = await conn.getBalance(admin.publicKey);
  console.log(`Admin SOL: ${(finalSol / 1e9).toFixed(4)}`);

  const adminAta = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey);
  try {
    const adminUsdc = await conn.getTokenAccountBalance(adminAta);
    console.log(`Admin USDC: ${adminUsdc.value.uiAmountString}`);
  } catch { console.log("Admin USDC ATA: not found"); }

  try {
    const vaultBal3 = await conn.getTokenAccountBalance(VAULT_ATA);
    console.log(`Vault USDC remaining: ${vaultBal3.value.uiAmountString}`);
  } catch { console.log("Vault ATA: closed or empty"); }

  const slabFinal = await conn.getAccountInfo(SLAB);
  console.log(`Slab: ${slabFinal ? `still exists (${(slabFinal.lamports / 1e9).toFixed(4)} SOL rent)` : 'CLOSED ✅'}`);
}

main().catch(console.error);

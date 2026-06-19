import { Connection, PublicKey, Keypair, TransactionInstruction, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";

const RPC = process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
if (!RPC) throw new Error("Set RPC_URL or HELIUS_API_KEY before running this script");
const SLAB = new PublicKey("5RfUzS1kpdhVb2CNGvE9UGdthsGbd354LoXSYjCFHv3R");
const PROGRAM = new PublicKey("ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const VAULT_ATA = new PublicKey("EqyHR7JCVshYv7fD8j8rZNa5xAEr5gW8wcukzkKbQjGp");
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), SLAB.toBuffer()], PROGRAM);

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.percolator-mainnet/keys/deploy-authority.json`, "utf8")
  )));
  const adminAta = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey);

  // Step 1: RescueOrphanVault (tag 72) — drain dust
  console.log("--- RescueOrphanVault (tag 72) ---");
  {
    const tx = new Transaction();
    // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
    // requests the full heap frame. Must be the FIRST instruction. (issue #176)
    tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
    tx.add(new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: SLAB, isSigner: false, isWritable: false },
        { pubkey: adminAta, isSigner: false, isWritable: true },
        { pubkey: VAULT_ATA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: vaultAuth, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([72]),
    }));
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
      console.log("  OK:", sig);
    } catch (e: any) { console.log("  Error:", e.message?.slice(0, 300)); }
  }

  // Step 2: CloseOrphanSlab (tag 73)
  console.log("\n--- CloseOrphanSlab (tag 73) ---");
  {
    const tx = new Transaction();
    // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
    // requests the full heap frame. Must be the FIRST instruction. (issue #176)
    tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
    tx.add(new TransactionInstruction({
      programId: PROGRAM,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: SLAB, isSigner: false, isWritable: true },
        { pubkey: VAULT_ATA, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([73]),
    }));
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
      console.log("  OK:", sig);
    } catch (e: any) { console.log("  Error:", e.message?.slice(0, 300)); }
  }

  // Final
  const bal = await conn.getBalance(admin.publicKey);
  const usdc = await conn.getTokenAccountBalance(adminAta).catch(() => null);
  const slabInfo = await conn.getAccountInfo(SLAB);
  console.log(`\nAdmin SOL: ${(bal/1e9).toFixed(4)}`);
  console.log(`Admin USDC: ${usdc?.value?.uiAmountString ?? '?'}`);
  console.log(`Slab: ${slabInfo ? `still exists (${(slabInfo.lamports/1e9).toFixed(4)} SOL)` : 'CLOSED'}`);
}
main().catch(console.error);

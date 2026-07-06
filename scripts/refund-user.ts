import { Connection, PublicKey, Keypair, TransactionInstruction, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";

const RPC = process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
if (!RPC) throw new Error("Set RPC_URL or HELIUS_API_KEY before running this script");
const SLAB = new PublicKey("6akNPYQLyg2nGLDtGAoykB8ZtuoAEwGhxreXaDWncya2");
const PROGRAM = new PublicKey("ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const VAULT_ATA = new PublicKey("AUFNkcigt1xChDfc1GnWWAcRVjuUtnbLzn5wVFoXKoaX");
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), SLAB.toBuffer()], PROGRAM);

// Your wallet
const REFUND_TO = new PublicKey("EzuosBXLtHMVumpQQZfqDuDzLqRCkLP3ZnUo8kWNqAqy");
const AMOUNT = 10_000_000; // 10 USDC

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.percolator-mainnet/keys/deploy-authority.json`, "utf8")
  )));
  const adminAta = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey);
  const refundAta = getAssociatedTokenAddressSync(USDC_MINT, REFUND_TO);

  // Step 1: WithdrawInsurance from wrapper (tag 20) — admin gets USDC from vault
  console.log("Step 1: WithdrawInsurance (10 USDC from vault → admin ATA)...");
  const tx1 = new Transaction();
  // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
  // requests the full heap frame. Must be the FIRST instruction. (issue #176)
  tx1.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
  tx1.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx1.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  tx1.add(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: SLAB, isSigner: false, isWritable: true },
      { pubkey: adminAta, isSigner: false, isWritable: true },
      { pubkey: VAULT_ATA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([20]), // WithdrawInsurance
  }));

  try {
    const sig1 = await sendAndConfirmTransaction(conn, tx1, [admin]);
    console.log("  OK:", sig1);
  } catch (e: any) {
    console.log("  Error:", e.message?.slice(0, 300));
  }

  // Step 2: Transfer 10 USDC from admin ATA to user ATA
  console.log(`\nStep 2: Transfer 10 USDC to ${REFUND_TO.toBase58()}...`);
  const { createTransferInstruction } = await import("@solana/spl-token");
  const tx2 = new Transaction();
  tx2.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  tx2.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  tx2.add(createTransferInstruction(adminAta, refundAta, admin.publicKey, AMOUNT));

  try {
    const sig2 = await sendAndConfirmTransaction(conn, tx2, [admin]);
    console.log("  OK:", sig2);
  } catch (e: any) {
    console.log("  Error:", e.message?.slice(0, 300));
  }

  // Verify
  const userBal = await conn.getTokenAccountBalance(refundAta);
  console.log(`\nUser USDC balance: ${userBal.value.uiAmountString}`);
}
main().catch(console.error);

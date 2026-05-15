import { Connection, PublicKey, Keypair, TransactionInstruction, Transaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
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

  // Try AdminForceCloseAccount (tag 21)
  console.log("Testing AdminForceCloseAccount (tag 21) for idx 0...");
  const closeData = Buffer.alloc(3);
  closeData[0] = 21;
  closeData.writeUInt16LE(0, 1);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  tx.add(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: SLAB, isSigner: false, isWritable: true },
      { pubkey: VAULT_ATA, isSigner: false, isWritable: true },
      { pubkey: adminAta, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SLAB, isSigner: false, isWritable: false },
    ],
    data: closeData,
  }));

  try {
    const result = await conn.simulateTransaction(tx, [admin]);
    console.log("Logs:", JSON.stringify(result.value.logs, null, 2));
    console.log("Error:", result.value.err);
  } catch (e: any) {
    console.log("Error:", e.message?.slice(0, 500));
  }
}

main().catch(console.error);

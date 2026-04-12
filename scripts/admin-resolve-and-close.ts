/**
 * Admin: Resolve market + Force-close remaining accounts.
 * 
 * Step 1: ResolveMarket (tag 19) — sets RESOLVED flag, freezes at current price
 * Step 2: AdminForceCloseAccount (tag 21) — closes each remaining user/LP, sends capital to owner ATA
 *
 * Accounts for ResolveMarket (4):
 *   0: admin (signer, writable)
 *   1: slab (writable)
 *   2: clock sysvar
 *   3: oracle (read-only)
 *
 * Accounts for AdminForceCloseAccount (8):
 *   0: admin (signer)
 *   1: slab (writable)
 *   2: vault ATA (writable)
 *   3: owner ATA (writable) — user's token account
 *   4: vault authority PDA
 *   5: token program
 *   6: clock sysvar
 *   7: oracle
 */

import { Connection, PublicKey, Keypair, TransactionInstruction, SYSVAR_CLOCK_PUBKEY, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseAllAccounts, parseConfig, parseHeader } from "@percolator/sdk";
import fs from "fs";

const RPC = "https://mainnet.helius-rpc.com/?api-key=ecfc91c7-b704-4c37-b10e-a277392830aa";
const SLAB_ADDRESS = "FLF9ghf6H4sfSexcQzDwse4gcGZKPb6qYCqo5Btat98";
const PROGRAM_ID = "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const slabPk = new PublicKey(SLAB_ADDRESS);
  const programId = new PublicKey(PROGRAM_ID);

  // Load admin keypair
  const adminKeyPath = `${process.env.HOME}/.percolator-mainnet/keys/deploy-authority.json`;
  const adminKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(adminKeyPath, "utf8"))));
  console.log("Admin:", adminKey.publicKey.toBase58());

  // Fetch slab state
  const data = await fetchSlab(conn, slabPk);
  const config = parseConfig(data);
  const header = parseHeader(data);
  const accounts = parseAllAccounts(data);

  console.log("Market admin:", header.admin?.toBase58());
  console.log("Paused:", header.paused);
  
  const collateralMint = config.collateralMint;
  const vaultPk = new PublicKey(config.vaultPubkey ?? []);
  console.log("Collateral mint:", collateralMint.toBase58());
  console.log("Vault:", vaultPk.toBase58());
  
  // Derive vault authority PDA
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), slabPk.toBuffer()],
    programId
  );
  console.log("Vault authority PDA:", vaultAuthority.toBase58());

  // Oracle — for Hyperp mode, oracle = slab itself
  const oraclePk = slabPk; // Hyperp: oracle authority is system program → slab is oracle

  console.log("\n=== Current Accounts ===");
  for (const { idx, account } of accounts) {
    const hasPos = account.positionSize !== 0n;
    const hasCap = account.capital > 0n;
    console.log(`  #${idx} ${account.kind === 1 ? 'LP' : 'User'} | pos=${account.positionSize} | cap=${account.capital} | owner=${account.owner?.toBase58().slice(0,12)}...`);
  }

  // Step 1: Resolve Market
  console.log("\n--- Step 1: ResolveMarket (tag 19) ---");
  const resolveData = Buffer.from([19]); // tag only
  const resolveIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: adminKey.publicKey, isSigner: true, isWritable: false },
      { pubkey: slabPk, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: oraclePk, isSigner: false, isWritable: false },
    ],
    data: resolveData,
  });

  try {
    const resolveTx = new Transaction().add(resolveIx);
    const resolveSig = await sendAndConfirmTransaction(conn, resolveTx, [adminKey]);
    console.log("ResolveMarket OK:", resolveSig);
  } catch (e) {
    console.error("ResolveMarket failed:", (e as Error).message);
    // If already resolved, continue
    if (!(e as Error).message.includes("already")) {
      console.log("Checking if already resolved...");
    }
  }

  // Step 2: AdminForceClose each account with position or capital
  const accountsToClose = accounts.filter(({ account }) => 
    account.capital > 0n || account.positionSize !== 0n
  );

  for (const { idx, account } of accountsToClose) {
    console.log(`\n--- Step 2: AdminForceClose account #${idx} (${account.kind === 1 ? 'LP' : 'User'}) ---`);
    
    const ownerPk = account.owner!;
    const ownerAta = getAssociatedTokenAddressSync(collateralMint, ownerPk);
    console.log(`  Owner: ${ownerPk.toBase58()}`);
    console.log(`  Owner ATA: ${ownerAta.toBase58()}`);
    console.log(`  Capital: ${(Number(account.capital) / 1e6).toFixed(6)} USDC`);

    const closeData = Buffer.alloc(3);
    closeData[0] = 21; // tag AdminForceCloseAccount
    closeData.writeUInt16LE(idx, 1);

    const closeIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: adminKey.publicKey, isSigner: true, isWritable: false },
        { pubkey: slabPk, isSigner: false, isWritable: true },
        { pubkey: vaultPk, isSigner: false, isWritable: true },
        { pubkey: ownerAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: oraclePk, isSigner: false, isWritable: false },
      ],
      data: closeData,
    });

    try {
      const closeTx = new Transaction().add(closeIx);
      const closeSig = await sendAndConfirmTransaction(conn, closeTx, [adminKey]);
      console.log(`  ForceClose #${idx} OK:`, closeSig);
    } catch (e) {
      console.error(`  ForceClose #${idx} failed:`, (e as Error).message);
    }
  }

  // Final state check
  console.log("\n=== Final State ===");
  const finalData = await fetchSlab(conn, slabPk);
  const finalAccounts = parseAllAccounts(finalData);
  for (const { idx, account } of finalAccounts) {
    console.log(`  #${idx} cap=${account.capital} pos=${account.positionSize}`);
  }
}

main().catch(console.error);

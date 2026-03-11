/**
 * PERC-509 smoke test: verify InitUser works on Small + Medium programs after redeploy.
 * Usage: npx tsx scripts/smoke-init-user.ts
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { encodeInitUser, ACCOUNTS_INIT_USER, buildAccountMetas, buildIx, deriveVaultAuthority } from "../packages/core/src/index.js";
import * as fs from "fs";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");

const SMALL_PROGRAM_ID = new PublicKey("FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn");
const MEDIUM_PROGRAM_ID = new PublicKey("g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in");

// Small slab to test against
const TEST_SMALL_SLAB = new PublicKey("5jbHBoLiLE6AqxMhZYLy4Xt76JLfer5V4jYDYxmRb2BV");

async function getMintFromSlab(slabPubkey: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(slabPubkey);
  if (!info) throw new Error(`Slab not found: ${slabPubkey.toBase58()}`);
  // Parse collateral_mint from slab header
  // Header: discriminator(8) + admin(32) + collateral_mint(32) starts at offset 8+32=40
  // But actual offset depends on struct. Let's try 40.
  const data = Buffer.from(info.data);
  console.log(`  Slab ${slabPubkey.toBase58().slice(0,8)}: ${data.length} bytes (expected 65352 for small)`);
  // Try to find a recognizable pubkey at common offsets
  for (const off of [8, 40, 72]) {
    const candidate = new PublicKey(data.slice(off, off + 32));
    const str = candidate.toBase58();
    // Filter out system program / zero addresses
    if (str !== "11111111111111111111111111111111" && str !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
      console.log(`  Candidate pubkey at offset ${off}: ${str}`);
    }
  }
  // V0 slab header layout: discriminator(8) + admin(32) + config_or_padding(32) + collateral_mint(32) starting at offset 72
  // V0_HEADER_LEN = 72 bytes before collateral_mint
  return new PublicKey(data.slice(72, 104));
}

async function testInitUser(programId: PublicKey, slab: PublicKey, wallet: Keypair) {
  console.log(`\nTesting InitUser on ${programId.toBase58().slice(0,8)}... slab ${slab.toBase58().slice(0,8)}...`);

  const slabInfo = await conn.getAccountInfo(slab);
  if (!slabInfo) { console.error("  ❌ Slab not found"); return; }
  console.log(`  Slab size: ${slabInfo.data.length} bytes`);

  // Derive vault authority PDA
  const [vaultPda] = deriveVaultAuthority(programId, slab);
  console.log(`  Vault PDA: ${vaultPda.toBase58()}`);

  // Get collateral mint from slab data
  // V0_HEADER_LEN = 72: discriminator(8) + admin(32) + config_or_padding(32); collateral_mint at 72..104
  const data = Buffer.from(slabInfo.data);
  const mint = new PublicKey(data.slice(72, 104));
  console.log(`  Collateral mint (offset 72): ${mint.toBase58()}`);

  // Get ATAs
  const walletAta = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);
  console.log(`  Wallet ATA: ${walletAta.toBase58()}`);

  // Check if user already exists in slab
  // (Don't actually send if we can't parse user accounts easily)

  try {
    const initUserData = encodeInitUser({ feePayment: "1000000" });
    const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      wallet.publicKey, slab, walletAta, vaultAta, TOKEN_PROGRAM_ID,
    ]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      buildIx({ programId, keys: initUserKeys, data: initUserData })
    );
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

    const sig = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
    console.log(`  ✅ InitUser SUCCESS — sig: ${sig.slice(0, 20)}...`);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (msg.includes("already in use") || msg.includes("already exists") || msg.includes("0x0")) {
      console.log(`  ✅ InitUser SKIPPED (user account already exists) — ${msg.slice(0, 80)}`);
    } else {
      console.error(`  ❌ InitUser FAILED: ${msg.slice(0, 200)}`);
    }
  }
}

async function main() {
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/percolator-upgrade-authority.json", "utf8")))
  );
  console.log("Wallet:", wallet.publicKey.toBase58());

  const bal = await conn.getBalance(wallet.publicKey);
  console.log("Balance:", (bal / 1e9).toFixed(4), "SOL");

  // Test Small program
  await testInitUser(SMALL_PROGRAM_ID, TEST_SMALL_SLAB, wallet);

  // Find a Medium slab too
  console.log("\nFinding medium slabs...");
  const medSlabs = await conn.getProgramAccounts(MEDIUM_PROGRAM_ID, {
    filters: [{ dataSize: 258368 }], // medium slab size after PERC-509 fix (approx)
    dataSlice: { offset: 0, length: 0 }
  });
  // Try multiple sizes since we're not sure of exact size
  const medSlabs2 = await conn.getProgramAccounts(MEDIUM_PROGRAM_ID, {
    filters: [{ dataSize: 257448 }],
    dataSlice: { offset: 0, length: 0 }
  });
  const medSlabs3 = await conn.getProgramAccounts(MEDIUM_PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 }
  });
  console.log(`Medium slabs (257448): ${medSlabs2.length}, total: ${medSlabs3.length}`);
  if (medSlabs3.length > 0) {
    await testInitUser(MEDIUM_PROGRAM_ID, medSlabs3[0].pubkey, wallet);
  } else {
    console.log("  No medium slabs found to test");
  }
}

main().catch(e => { console.error(e); process.exit(1); });

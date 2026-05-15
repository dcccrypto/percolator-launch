#!/usr/bin/env npx tsx
/**
 * Create a Stake Pool for a Percolator market (mainnet).
 *
 * Usage:
 *   npx tsx scripts/create-stake-pool.ts \
 *     --slab FLF9ghf6H4sfSexcQzDwse4gcGZKPb6qYCqo5Btat98 \
 *     --cooldown 300 \
 *     --cap 0
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, MINT_SIZE, ACCOUNT_SIZE as TOKEN_ACCOUNT_SIZE } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ── Config ──────────────────────────────────────────────────────
const STAKE_PROGRAM_ID = new PublicKey("DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F");
const PERCOLATOR_PROGRAM_ID = new PublicKey("ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv");
const RPC_URL = process.env.RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "");
if (!RPC_URL) throw new Error("Set RPC_URL or HELIUS_API_KEY before running this script");
const ADMIN_KEYPAIR_PATH = path.join(process.env.HOME!, ".percolator-mainnet/keys/deploy-authority.json");

// ── Parse args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string, fallback?: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required arg: --${name}`);
  }
  return args[idx + 1];
}

const slabAddress = getArg("slab");
const cooldownSlots = BigInt(getArg("cooldown", "300"));
const depositCap = BigInt(getArg("cap", "0")); // 0 = uncapped

// ── Helpers ─────────────────────────────────────────────────────
function u64Le(v: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(v);
  return buf;
}

function deriveStakePool(slab: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stake_pool"), slab.toBytes()],
    STAKE_PROGRAM_ID,
  );
}

function deriveVaultAuth(pool: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_auth"), pool.toBytes()],
    STAKE_PROGRAM_ID,
  );
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_KEYPAIR_PATH, "utf8"))),
  );
  const slab = new PublicKey(slabAddress);

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Slab:", slab.toBase58());
  console.log("Stake Program:", STAKE_PROGRAM_ID.toBase58());

  // Read collateral mint from slab config
  const slabInfo = await connection.getAccountInfo(slab);
  if (!slabInfo) throw new Error("Slab not found on-chain");
  // Collateral mint is at header(72) + 0 in config = offset 72, 32 bytes
  const collateralMint = new PublicKey(slabInfo.data.subarray(72, 104));
  console.log("Collateral mint:", collateralMint.toBase58());

  // Derive PDAs
  const [pool, poolBump] = deriveStakePool(slab);
  const [vaultAuth, vaultAuthBump] = deriveVaultAuth(pool);
  console.log("Pool PDA:", pool.toBase58(), "bump:", poolBump);
  console.log("Vault Auth PDA:", vaultAuth.toBase58(), "bump:", vaultAuthBump);

  // Check if pool already exists
  const poolInfo = await connection.getAccountInfo(pool);
  if (poolInfo) {
    console.log("Pool already exists! Size:", poolInfo.data.length);
    process.exit(1);
  }

  // Generate keypairs for LP mint and vault token account
  const lpMint = Keypair.generate();
  const vault = Keypair.generate();
  console.log("LP Mint (new):", lpMint.publicKey.toBase58());
  console.log("Vault (new):", vault.publicKey.toBase58());

  // Get rent exemptions
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tokenRent = await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);

  // Build instructions
  const instructions: TransactionInstruction[] = [];

  // 1. Create LP mint account (82 bytes, owned by Token Program)
  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: lpMint.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
  );

  // 2. Create vault token account (165 bytes, owned by Token Program)
  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: vault.publicKey,
      lamports: tokenRent,
      space: TOKEN_ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
  );

  // 3. InitPool instruction (tag=0, cooldown_slots, deposit_cap)
  const initPoolData = Buffer.concat([
    Buffer.from([0]), // tag = InitPool
    u64Le(cooldownSlots),
    u64Le(depositCap),
  ]);

  instructions.push(
    new TransactionInstruction({
      programId: STAKE_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: slab, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: lpMint.publicKey, isSigner: false, isWritable: true },
        { pubkey: vault.publicKey, isSigner: false, isWritable: true },
        { pubkey: vaultAuth, isSigner: false, isWritable: false },
        { pubkey: collateralMint, isSigner: false, isWritable: false },
        { pubkey: PERCOLATOR_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: initPoolData,
    }),
  );

  // Build and sign transaction
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: admin.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([admin, lpMint, vault]);

  console.log("\nCooldown:", cooldownSlots.toString(), "slots");
  console.log("Deposit cap:", depositCap === 0n ? "uncapped" : depositCap.toString());
  console.log("\nSending transaction...");

  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  console.log("Signature:", sig);

  await connection.confirmTransaction(sig, "confirmed");
  console.log("Confirmed!");
  console.log("\nStake pool created successfully:");
  console.log("  Pool:", pool.toBase58());
  console.log("  LP Mint:", lpMint.publicKey.toBase58());
  console.log("  Vault:", vault.publicKey.toBase58());
  console.log("  Vault Auth:", vaultAuth.toBase58());

  // Save keypairs
  const keysDir = path.join(process.env.HOME!, ".percolator-mainnet/keys");
  fs.writeFileSync(
    path.join(keysDir, `stake-lp-mint-${lpMint.publicKey.toBase58().slice(0, 8)}.json`),
    JSON.stringify(Array.from(lpMint.secretKey)),
  );
  fs.writeFileSync(
    path.join(keysDir, `stake-vault-${vault.publicKey.toBase58().slice(0, 8)}.json`),
    JSON.stringify(Array.from(vault.secretKey)),
  );
  console.log("  LP Mint keypair saved to:", `stake-lp-mint-${lpMint.publicKey.toBase58().slice(0, 8)}.json`);
  console.log("  Vault keypair saved to:", `stake-vault-${vault.publicKey.toBase58().slice(0, 8)}.json`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});

#!/usr/bin/env -S npx tsx
/**
 * PERC-354: Fund devnet bot wallets with test USDC.
 *
 * Prerequisites:
 *   - MINT_AUTHORITY_KEYPAIR_JSON env var OR file at default path
 *   - All 5 bot wallets generated (run keygen.ts first)
 *   - Mint authority wallet has enough SOL for tx fees
 *
 * Usage:
 *   npx tsx src/fund-devnet-bots.ts
 *   MINT_AUTHORITY_KEYPAIR_JSON='[...]' npx tsx src/fund-devnet-bots.ts
 *   WALLETS_DIR=/tmp/percolator-bots npx tsx src/fund-devnet-bots.ts
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const HELIUS_KEY = process.env.HELIUS_API_KEY ?? "";
const RPC_URL =
  process.env.RPC_URL ??
  (HELIUS_KEY ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "https://api.devnet.solana.com");

const WALLETS_DIR = process.env.WALLETS_DIR ?? "/tmp/percolator-bots";

/** 10,000 USDC per wallet (6 decimals) */
const USDC_AMOUNT = 10_000_000_000n;

const USDC_MINT = new PublicKey(
  process.env.TEST_USDC_MINT ?? "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs",
);

const MINT_AUTHORITY_DEFAULT_PATH = path.join(
  os.homedir(),
  ".config/solana/percolator-devnet-mint-authority.json",
);

/** Wallets that need USDC (maker + all traders). Filler only needs SOL. */
const USDC_WALLETS = ["maker", "trader1", "trader2", "trader3"];

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function loadMintAuthority(): Keypair {
  const envJson = process.env.MINT_AUTHORITY_KEYPAIR_JSON;
  if (envJson) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(envJson)));
    } catch {
      throw new Error("MINT_AUTHORITY_KEYPAIR_JSON is not valid JSON");
    }
  }
  if (fs.existsSync(MINT_AUTHORITY_DEFAULT_PATH)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(MINT_AUTHORITY_DEFAULT_PATH, "utf8"))),
    );
  }
  throw new Error(
    `Mint authority keypair not found.\n` +
    `Set MINT_AUTHORITY_KEYPAIR_JSON env var or place keypair at:\n` +
    `  ${MINT_AUTHORITY_DEFAULT_PATH}`,
  );
}

async function ensureSol(
  connection: Connection,
  mintAuth: Keypair,
): Promise<void> {
  const bal = await connection.getBalance(mintAuth.publicKey);
  const solBal = bal / LAMPORTS_PER_SOL;
  console.log(`Mint authority: ${mintAuth.publicKey.toBase58()}`);
  console.log(`  SOL balance: ${solBal.toFixed(4)}`);
  if (solBal < 0.1) {
    console.log(`  ⚠️  Low SOL — attempting airdrop...`);
    try {
      const sig = await connection.requestAirdrop(mintAuth.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      console.log(`  ✅ +2 SOL airdropped`);
    } catch (e: any) {
      throw new Error(
        `Mint authority has ${solBal.toFixed(4)} SOL — not enough for tx fees.\n` +
        `Airdrop failed: ${e.message?.slice(0, 100)}\n` +
        `Please fund manually: https://faucet.solana.com → ${mintAuth.publicKey.toBase58()}`,
      );
    }
  }
}

async function mintUsdc(
  connection: Connection,
  mintAuth: Keypair,
  walletPk: PublicKey,
  label: string,
): Promise<void> {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, walletPk);
  const tx = new Transaction();

  // Create ATA if it doesn't exist
  let ataExists = false;
  try {
    await connection.getTokenAccountBalance(ata);
    ataExists = true;
  } catch {
    // ATA doesn't exist — create it
  }

  if (!ataExists) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        mintAuth.publicKey,
        ata,
        walletPk,
        USDC_MINT,
      ),
    );
  } else {
    // Check existing balance
    try {
      const b = await connection.getTokenAccountBalance(ata);
      const existing = BigInt(b.value.amount);
      if (existing >= USDC_AMOUNT) {
        console.log(`  ${label}: ${Number(existing) / 1e6} USDC already ✅`);
        return;
      }
      const toMint = USDC_AMOUNT - existing;
      console.log(`  ${label}: ${Number(existing) / 1e6} USDC (minting delta +${Number(toMint) / 1e6} to reach ${Number(USDC_AMOUNT) / 1e6})`);
      tx.add(
        createMintToInstruction(
          USDC_MINT,
          ata,
          mintAuth.publicKey,
          toMint,
        ),
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [mintAuth], {
        commitment: "confirmed",
      });
      console.log(`  ${label}: +${Number(toMint) / 1e6} USDC ✅ (${sig.slice(0, 16)}...)`);
      return;
    } catch {}
  }

  tx.add(
    createMintToInstruction(
      USDC_MINT,
      ata,
      mintAuth.publicKey,
      USDC_AMOUNT,
    ),
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [mintAuth], {
    commitment: "confirmed",
  });
  console.log(`  ${label}: +${Number(USDC_AMOUNT) / 1e6} USDC ✅ (${sig.slice(0, 16)}...)`);
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  PERC-354: Fund Devnet Bot Wallets                   ║
╚══════════════════════════════════════════════════════╝
`);

  console.log(`RPC:         ${new URL(RPC_URL).hostname}`);
  console.log(`USDC mint:   ${USDC_MINT.toBase58()}`);
  console.log(`Wallets dir: ${WALLETS_DIR}\n`);

  const connection = new Connection(RPC_URL, "confirmed");

  // Load mint authority
  let mintAuth: Keypair;
  try {
    mintAuth = loadMintAuthority();
  } catch (e: any) {
    console.error("❌", e.message);
    process.exit(1);
  }

  // Ensure mint authority has enough SOL for tx fees
  await ensureSol(connection, mintAuth);
  console.log();

  // Mint USDC to all wallets that need it
  console.log("Minting USDC to bot wallets...");
  const failed: string[] = [];

  for (const name of USDC_WALLETS) {
    const filePath = path.join(WALLETS_DIR, `${name}.json`);
    if (!fs.existsSync(filePath)) {
      console.log(`  ${name}: ⚠️  keypair not found at ${filePath} — run keygen.ts first`);
      failed.push(name);
      continue;
    }

    const kp = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf8"))),
    );

    try {
      await mintUsdc(connection, mintAuth, kp.publicKey, name);
    } catch (e: any) {
      console.log(`  ${name}: ❌ ${e.message?.slice(0, 80)}`);
      failed.push(name);
    }

    // Small delay between mints to avoid RPC overload
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log();
  if (failed.length === 0) {
    console.log("✅ All wallets funded! Bot is ready to run with BOT_MODE=all");
    console.log();
    console.log("Start the bot:");
    console.log("  BOT_MODE=all npx tsx src/index.ts");
    console.log("  (or pnpm start:all from bots/devnet-mm/)");
  } else {
    console.log(`⚠️  ${failed.length} wallet(s) failed: ${failed.join(", ")}`);
    console.log("   Retry after fixing the errors above.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

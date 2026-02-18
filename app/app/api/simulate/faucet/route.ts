/**
 * POST /api/simulate/faucet
 *
 * Mints 10,000 simUSDC to a wallet for the Percolator Risk Engine Simulator.
 * Rate limited to 10,000 simUSDC per wallet per 24 hours via Supabase.
 *
 * Request:  { wallet: string }
 * Response: { success: true, amount: 10000, txSignature: string }
 *           | { error: string }
 *
 * Env:
 *   SIM_MINT_AUTHORITY — base58 secret key for the simUSDC mint authority
 *   RPC_URL or NEXT_PUBLIC_HELIUS_RPC_URL — Solana RPC endpoint
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Supabase
 */

import { NextRequest, NextResponse } from "next/server";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// ─── Config ────────────────────────────────────────────────────────────────

const FAUCET_AMOUNT = 10_000;                        // human-readable
const FAUCET_AMOUNT_RAW = BigInt(10_000_000_000);    // 10,000 with 6 decimals (wait: 10000 * 1e6 = 10_000_000_000)... but task says 10_000_000_000 raw. That's 10,000 with 6 decimals. ✓
const DAILY_LIMIT_RAW = BigInt(10_000_000_000);      // 10,000 simUSDC per 24h
const WINDOW_HOURS = 24;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Decode a base58-encoded secret key without requiring @types/bs58. */
function base58Decode(encoded: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]] = i;

  let n = BigInt(0);
  for (const ch of encoded) {
    if (!(ch in map)) throw new Error(`Invalid base58 char: ${ch}`);
    n = n * BigInt(58) + BigInt(map[ch]);
  }

  // Convert BigInt → bytes
  const hex = n.toString(16).padStart(128, "0");
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function loadMintAuthority(): Keypair {
  const raw = process.env.SIM_MINT_AUTHORITY;
  if (!raw) {
    throw new Error("SIM_MINT_AUTHORITY env var not set");
  }
  return Keypair.fromSecretKey(base58Decode(raw));
}

function getRpcUrl(): string {
  return (
    process.env.RPC_URL ||
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
    `https://api.devnet.solana.com`
  );
}

function getSimMint(): PublicKey {
  // Read from config — falls back gracefully if not set yet
  const addr = process.env.SIM_USDC_MINT;
  if (!addr) {
    throw new Error(
      "SIM_USDC_MINT env var not set — run scripts/deploy-sim.ts first",
    );
  }
  return new PublicKey(addr);
}

// ─── Rate limit check via Supabase ─────────────────────────────────────────

async function checkRateLimit(wallet: string): Promise<{
  allowed: boolean;
  alreadyClaimed: bigint;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = getServiceClient() as any;
  const windowStart = new Date(
    Date.now() - WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await db
    .from("sim_faucet_claims")
    .select("amount")
    .eq("wallet", wallet)
    .gte("claimed_at", windowStart);

  if (error) {
    throw new Error(`Supabase rate limit check failed: ${error.message}`);
  }

  const alreadyClaimed = (data ?? []).reduce(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sum: bigint, row: any) => sum + BigInt(row.amount),
    BigInt(0),
  );

  const allowed = alreadyClaimed + FAUCET_AMOUNT_RAW <= DAILY_LIMIT_RAW;

  return { allowed, alreadyClaimed };
}

async function recordClaim(
  wallet: string,
  txSignature: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = getServiceClient() as any;
  const { error } = await db.from("sim_faucet_claims").insert({
    wallet,
    amount: FAUCET_AMOUNT_RAW.toString(),
    tx_signature: txSignature,
  });

  if (error) {
    // Non-fatal — mint already succeeded; log and move on
    console.error("Failed to record faucet claim:", error.message);
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // ── Parse + validate ──
    const body = await req.json().catch(() => ({}));
    const { wallet } = body as { wallet?: string };

    if (!wallet || typeof wallet !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid wallet address" },
        { status: 400 },
      );
    }

    let walletPk: PublicKey;
    try {
      walletPk = new PublicKey(wallet);
    } catch {
      return NextResponse.json(
        { error: "Invalid wallet address" },
        { status: 400 },
      );
    }

    // ── Rate limit ──
    const { allowed, alreadyClaimed } = await checkRateLimit(wallet);
    if (!allowed) {
      const remaining = DAILY_LIMIT_RAW - alreadyClaimed;
      return NextResponse.json(
        {
          error: `Rate limit exceeded. You can claim ${Number(remaining) / 1e6} more simUSDC in the next 24 hours.`,
          alreadyClaimed: Number(alreadyClaimed) / 1e6,
          dailyLimit: FAUCET_AMOUNT,
        },
        { status: 429 },
      );
    }

    // ── Mint ──
    const mintAuthority = loadMintAuthority();
    const simMint = getSimMint();
    const connection = new Connection(getRpcUrl(), "confirmed");

    // Create ATA for recipient if it doesn't exist
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      connection,
      mintAuthority, // payer for ATA creation
      simMint,
      walletPk,
    );

    const txSignature = await mintTo(
      connection,
      mintAuthority,   // payer
      simMint,         // mint
      recipientAta.address, // destination ATA
      mintAuthority,   // mint authority
      FAUCET_AMOUNT_RAW,
    );

    // ── Record claim ──
    await recordClaim(wallet, txSignature);

    return NextResponse.json({
      success: true,
      amount: FAUCET_AMOUNT,
      txSignature,
      ata: recipientAta.address.toBase58(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[faucet] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

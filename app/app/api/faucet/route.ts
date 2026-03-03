/**
 * PERC-376: Devnet USDC faucet endpoint
 *
 * POST /api/faucet { wallet: string }
 *
 * Mints 10,000 test USDC to the requesting wallet on devnet.
 * Rate-limited: 1 claim per wallet per 24h (tracked in Supabase auto_fund_log).
 *
 * This is the dedicated faucet endpoint called by the in-UI faucet modal.
 * Unlike /api/auto-fund (which also handles SOL), this only handles USDC
 * and returns structured status for the step-by-step UI.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";
const USDC_MINT_AMOUNT = 10_000_000_000; // 10,000 USDC (6 decimals)
const RATE_LIMIT_HOURS = 24;

export async function POST(req: NextRequest) {
  try {
    if (NETWORK !== "devnet") {
      return NextResponse.json(
        { error: "Faucet only available on devnet" },
        { status: 403 },
      );
    }

    const body = await req.json();
    const walletAddress = body?.wallet;

    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json(
        { error: "Missing wallet address" },
        { status: 400 },
      );
    }

    let walletPk: PublicKey;
    try {
      walletPk = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json(
        { error: "Invalid wallet address" },
        { status: 400 },
      );
    }

    // Rate limit check via Supabase
    const supabase = getServiceClient();
    const cutoff = new Date(
      Date.now() - RATE_LIMIT_HOURS * 60 * 60 * 1000,
    ).toISOString();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: recent } = await (supabase as any)
      .from("auto_fund_log")
      .select("id, created_at")
      .eq("wallet", walletAddress)
      .eq("usdc_minted", true)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);

    if (recent && recent.length > 0) {
      const lastClaim = new Date(recent[0].created_at);
      const nextClaimAt = new Date(
        lastClaim.getTime() + RATE_LIMIT_HOURS * 60 * 60 * 1000,
      ).toISOString();

      return NextResponse.json(
        {
          error: "Already claimed in the last 24 hours",
          funded: false,
          nextClaimAt,
        },
        { status: 429 },
      );
    }

    // Load configuration
    const cfg = getConfig();
    const usdcMintAddr = (cfg as Record<string, unknown>).testUsdcMint as
      | string
      | undefined;

    if (!usdcMintAddr) {
      return NextResponse.json(
        { error: "Test USDC mint not configured" },
        { status: 500 },
      );
    }

    const usdcMint = new PublicKey(usdcMintAddr);

    // Load mint authority
    const mintAuthKeyJson = process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
    if (!mintAuthKeyJson) {
      return NextResponse.json(
        { error: "Server not configured for minting" },
        { status: 500 },
      );
    }

    const mintAuthority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(mintAuthKeyJson)),
    );

    const connection = new Connection(cfg.rpcUrl, "confirmed");

    // Build mint transaction
    const ata = await getAssociatedTokenAddress(usdcMint, walletPk);
    const tx = new Transaction();

    // Create ATA if it doesn't exist
    try {
      await connection.getTokenAccountBalance(ata);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(
          mintAuthority.publicKey,
          ata,
          walletPk,
          usdcMint,
        ),
      );
    }

    // Mint USDC
    tx.add(
      createMintToInstruction(
        usdcMint,
        ata,
        mintAuthority.publicKey,
        USDC_MINT_AMOUNT,
      ),
    );

    const sig = await sendAndConfirmTransaction(
      connection,
      tx,
      [mintAuthority],
      { commitment: "confirmed" },
    );

    // Log the funding event
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("auto_fund_log").insert({
      wallet: walletAddress,
      sol_airdropped: false,
      usdc_minted: true,
    });

    const nextClaimAt = new Date(
      Date.now() + RATE_LIMIT_HOURS * 60 * 60 * 1000,
    ).toISOString();

    return NextResponse.json({
      funded: true,
      usdc_minted: true,
      usdc_amount: USDC_MINT_AMOUNT / 1_000_000,
      signature: sig,
      nextClaimAt,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/faucet", method: "POST" },
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}

/**
 * PERC-356: Auto-fund API route
 *
 * POST /api/auto-fund
 * Body: { wallet: string }
 *
 * When a devnet wallet has < 0.1 SOL, airdrops 2 SOL.
 * When the wallet has no test USDC, mints 1,000 USDC.
 *
 * Rate-limited: one fund per wallet per 24h (tracked in Supabase).
 */

import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

// Only enable on devnet
const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";
const MIN_SOL_BALANCE = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL threshold
const AIRDROP_AMOUNT = 2 * LAMPORTS_PER_SOL; // 2 SOL
const USDC_MINT_AMOUNT = 1_000_000_000; // 1,000 USDC (6 decimals) — PERC-372
const RATE_LIMIT_HOURS = 24;

// Public devnet RPC for airdrop (Helius may not forward airdrop requests)
const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";

export async function POST(req: NextRequest) {
  try {
    // Only works on devnet
    if (NETWORK !== "devnet") {
      return NextResponse.json(
        { error: "Auto-fund only available on devnet" },
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
    const cutoff = new Date(Date.now() - RATE_LIMIT_HOURS * 60 * 60 * 1000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: recent } = await (supabase as any)
      .from("auto_fund_log")
      .select("id")
      .eq("wallet", walletAddress)
      .gte("created_at", cutoff)
      .limit(1);

    if (recent && recent.length > 0) {
      return NextResponse.json(
        { error: "Already funded in the last 24 hours", funded: false },
        { status: 429 },
      );
    }

    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, "confirmed");
    const publicConnection = new Connection(PUBLIC_DEVNET_RPC, "confirmed");

    const results: { sol_airdropped: boolean; usdc_minted: boolean; sol_amount?: number; usdc_amount?: number } = {
      sol_airdropped: false,
      usdc_minted: false,
    };

    // 1. Check SOL balance and airdrop if needed
    const balance = await connection.getBalance(walletPk);
    if (balance < MIN_SOL_BALANCE) {
      try {
        const sig = await publicConnection.requestAirdrop(walletPk, AIRDROP_AMOUNT);
        await publicConnection.confirmTransaction(sig, "confirmed");
        results.sol_airdropped = true;
        results.sol_amount = AIRDROP_AMOUNT / LAMPORTS_PER_SOL;
      } catch (e: any) {
        // Airdrop can fail on devnet (rate limits) — non-fatal
        console.warn(`SOL airdrop failed for ${walletAddress}: ${e.message}`);
      }
    }

    // 2. Check USDC balance and mint if needed
    // We need the test USDC mint address from config
    const usdcMintAddr = (cfg as Record<string, unknown>).testUsdcMint as string | undefined;
    const usdcMint = usdcMintAddr ? new PublicKey(usdcMintAddr) : null;
    if (usdcMint) {
      try {
        const ata = await getAssociatedTokenAddress(usdcMint, walletPk);
        let needsMint = false;

        try {
          const tokenBalance = await connection.getTokenAccountBalance(ata);
          needsMint = !tokenBalance.value.uiAmount || tokenBalance.value.uiAmount < 1;
        } catch {
          // ATA doesn't exist — need to create and mint
          needsMint = true;
        }

        if (needsMint) {
          // For minting, we need the mint authority keypair (server-side only)
          // This is configured via DEVNET_MINT_AUTHORITY_KEYPAIR env var
          const mintAuthKey = process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
          if (mintAuthKey) {
            const { Keypair, Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
            const mintAuthority = Keypair.fromSecretKey(
              Uint8Array.from(JSON.parse(mintAuthKey)),
            );

            const tx = new Transaction();

            // Create ATA if needed
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

            await sendAndConfirmTransaction(connection, tx, [mintAuthority], {
              commitment: "confirmed",
            });

            results.usdc_minted = true;
            results.usdc_amount = USDC_MINT_AMOUNT / 1_000_000;
          }
        }
      } catch (e: any) {
        console.warn(`USDC mint failed for ${walletAddress}: ${e.message}`);
      }
    }

    // Log the funding event
    if (results.sol_airdropped || results.usdc_minted) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from("auto_fund_log").insert({
        wallet: walletAddress,
        sol_airdropped: results.sol_airdropped,
        usdc_minted: results.usdc_minted,
      });
    }

    return NextResponse.json({
      funded: results.sol_airdropped || results.usdc_minted,
      ...results,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/auto-fund", method: "POST" },
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

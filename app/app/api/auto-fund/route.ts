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
import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import { getDevnetMintSigner } from "@/lib/devnet-signer";
import { tryFaucetGate, releaseFaucetClaim } from "@/lib/faucet-rate-gate";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

// Only enable on devnet — checks both env vars (GH#1375):
//   NEXT_PUBLIC_DEFAULT_NETWORK — canonical network env var used by config.ts (trim for Vercel copy-paste)
//   NEXT_PUBLIC_SOLANA_NETWORK  — legacy name; kept for backward compat
// Missing / non-devnet is treated as non-devnet (fail-closed).
const NETWORK =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
  process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
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

    // GH#1595: INSERT-as-gate rate limit — eliminates SELECT→INSERT TOCTOU window.
    const supabase = getServiceClient();
    const gate = await tryFaucetGate(supabase, walletAddress, "auto-fund");

    if (!gate.allowed) {
      return NextResponse.json(
        { error: "Already funded in the last 24 hours", funded: false, nextClaimAt: gate.nextClaimAt },
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
        const airdropResult = await publicConnection.confirmTransaction(sig, "confirmed");
        if (airdropResult.value.err) {
          throw new Error(`Airdrop confirmed but failed on-chain: ${JSON.stringify(airdropResult.value.err)}`);
        }
        results.sol_airdropped = true;
        results.sol_amount = AIRDROP_AMOUNT / LAMPORTS_PER_SOL;
      } catch (e: unknown) {
        // Airdrop can fail on devnet (rate limits) — non-fatal
        console.warn(`SOL airdrop failed for ${walletAddress}: ${e instanceof Error ? e.message : String(e)}`);
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
          // For minting, use the sealed devnet mint authority signer (server-side only)
          const mintSigner = getDevnetMintSigner();
          if (mintSigner) {
            const tx = new Transaction();
            const mintAuthPk = new PublicKey(mintSigner.publicKey());

            // Create ATA if needed
            try {
              await connection.getTokenAccountBalance(ata);
            } catch {
              tx.add(
                createAssociatedTokenAccountInstruction(
                  mintAuthPk,
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
                mintAuthPk,
                USDC_MINT_AMOUNT,
              ),
            );

            // Set recentBlockhash + feePayer before signing (required for sendRawTransaction)
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = mintAuthPk;

            // Sign and send transaction using sealed signer
            const signed = mintSigner.signTransaction(tx);
            const sig = await connection.sendRawTransaction((signed as Transaction).serialize());
            await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

            results.usdc_minted = true;
            results.usdc_amount = USDC_MINT_AMOUNT / 1_000_000;
          }
        }
      } catch (e: unknown) {
        console.warn(`USDC mint failed for ${walletAddress}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Log the funding event (analytics — gate handles rate limiting). Best-effort:
    // do not 500 after successful on-chain funding if logging fails (same as /api/faucet USDC path).
    if (results.sol_airdropped || results.usdc_minted) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await supabase.from("auto_fund_log").insert({
          wallet: walletAddress,
          sol_airdropped: results.sol_airdropped,
          usdc_minted: results.usdc_minted,
        });
      } catch (logErr) {
        Sentry.captureException(logErr, {
          tags: { endpoint: "/api/auto-fund", step: "auto_fund_log" },
          extra: { wallet: walletAddress },
        });
      }
    } else {
      // Nothing funded (already had sufficient balance) — release gate so user can retry
      if (gate.claimId) await releaseFaucetClaim(supabase, gate.claimId);
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

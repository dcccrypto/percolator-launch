/**
 * Playground Faucet API — POST /api/playground/faucet
 *
 * Mints 10,000 Sim-USDC (DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC, 6dp)
 * to the caller's ATA. The mint authority acts as fee payer so the user needs
 * zero SOL to receive their first tokens.
 *
 * Also attempts a small SOL airdrop (0.05 SOL) via the public devnet faucet so
 * the user can pay for their own subsequent transactions.
 *
 * Rate limit: 1 claim per wallet per hour — tracked in an in-memory Map.
 * NOTE: The map is process-local; a serverless cold-start resets it. This is
 * acceptable for a devnet playground (not a Sybil-proof production faucet).
 *
 * Required env vars:
 *   DEVNET_MINT_AUTHORITY_KEYPAIR — JSON array or base58 string of the 64-byte
 *     keypair that is the mint authority of the Sim-USDC mint. Also used as
 *     fee payer for the mint transaction.
 *   NEXT_PUBLIC_TEST_USDC_MINT — Sim-USDC mint address (falls back to the
 *     constant below if not set).
 *
 * Body: { wallet: string }
 * Response (200): { funded: true, usdc_amount: number, usdc_sig: string,
 *                   sol_airdropped: boolean, sol_sig?: string, nextClaimAt: string }
 * Response (400): { error: string }
 * Response (429): { error: string, nextClaimAt: string }
 * Response (503): { error: string, retryable: true }
 */

import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/get-client-ip";
import { checkFundRateLimit } from "@/lib/fund-ip-rate-limit";
import {
  Connection,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getDevnetMintSigner } from "@/lib/devnet-signer";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Canonical Sim-USDC mint for the playground (6 decimals).
 * Overridable via NEXT_PUBLIC_TEST_USDC_MINT env var.
 */
const SIM_USDC_MINT =
  process.env.NEXT_PUBLIC_TEST_USDC_MINT?.trim() ||
  "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

const USDC_MINT_AMOUNT = 10_000 * 1_000_000; // 10,000 USDC (6 decimals)
const SOL_AIRDROP_AMOUNT = 0.05 * LAMPORTS_PER_SOL;
const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

const DEVNET_RPC_POOL = [
  "https://api.devnet.solana.com",
  "https://rpc.ankr.com/solana_devnet",
];

const NETWORK =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
  process.env.NEXT_PUBLIC_SOLANA_NETWORK;

// ── In-memory rate-limit store ────────────────────────────────────────────────
// Maps wallet address → timestamp of last successful claim.
// Process-local; resets on cold start — acceptable for devnet playground.
const claimStore = new Map<string, number>();

function isRateLimited(wallet: string): { limited: boolean; nextClaimAt: string } {
  const last = claimStore.get(wallet);
  if (last === undefined) return { limited: false, nextClaimAt: "" };
  const elapsed = Date.now() - last;
  if (elapsed < RATE_LIMIT_MS) {
    const nextClaimAt = new Date(last + RATE_LIMIT_MS).toISOString();
    return { limited: true, nextClaimAt };
  }
  return { limited: false, nextClaimAt: "" };
}

function recordClaim(wallet: string): string {
  const now = Date.now();
  claimStore.set(wallet, now);
  return new Date(now + RATE_LIMIT_MS).toISOString();
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    if (NETWORK !== "devnet") {
      return NextResponse.json(
        { error: "Playground faucet only available on devnet" },
        { status: 403 },
      );
    }

    // SEC: per-IP rate limit. The per-wallet gate below is trivially bypassed
    // with fresh keypairs, and every mint/airdrop spends the shared
    // DEVNET_MINT_AUTHORITY_KEYPAIR — bound the drain per IP (shared across the
    // fund endpoints), mirroring /api/devnet-mirror-mint.
    const fundRl = await checkFundRateLimit(getClientIp(req));
    if (!fundRl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please slow down and try again shortly." },
        { status: 429, headers: { "Retry-After": String(fundRl.retryAfter) } },
      );
    }

    // Parse body
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be valid JSON: { wallet: string }" },
        { status: 400 },
      );
    }

    const walletAddress = body?.wallet;
    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json({ error: "Missing wallet address" }, { status: 400 });
    }

    let walletPk: PublicKey;
    try {
      walletPk = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    // Rate limit check
    const { limited, nextClaimAt: limitNext } = isRateLimited(walletAddress);
    if (limited) {
      return NextResponse.json(
        { error: "Already claimed in the last hour. Come back later.", nextClaimAt: limitNext },
        { status: 429 },
      );
    }

    // Load mint signer — required for USDC mint
    const mintSigner = getDevnetMintSigner();
    if (!mintSigner) {
      return NextResponse.json(
        {
          error:
            "Faucet not configured: DEVNET_MINT_AUTHORITY_KEYPAIR is missing. " +
            "Add the base64/JSON keypair to your .env.local to enable live minting.",
          hint: "missing_keypair",
        },
        { status: 503 },
      );
    }

    const mintAuthPk = new PublicKey(mintSigner.publicKey());
    const usdcMint = new PublicKey(SIM_USDC_MINT);

    // Use the server-side RPC proxy so we don't expose the Helius key
    const rpcUrl =
      typeof process !== "undefined"
        ? (process.env.HELIUS_DEVNET_API_KEY
            ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_DEVNET_API_KEY}`
            : "https://api.devnet.solana.com")
        : "https://api.devnet.solana.com";

    const connection = new Connection(rpcUrl, "confirmed");

    // ── Mint Sim-USDC ───────────────────────────────────────────────────────
    let usdcSig: string;
    try {
      const ata = await getAssociatedTokenAddress(usdcMint, walletPk);
      const tx = new Transaction();

      // Create ATA if it doesn't exist
      let ataExists = false;
      try {
        await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
        ataExists = true;
      } catch {
        // ATA not found — create it
      }

      if (!ataExists) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            mintAuthPk, // payer
            ata,
            walletPk,
            usdcMint,
          ),
        );
      }

      tx.add(createMintToInstruction(usdcMint, ata, mintAuthPk, BigInt(USDC_MINT_AMOUNT)));

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = mintAuthPk; // playground sponsors this transaction's fee

      const signedTx = mintSigner.signTransaction(tx);
      usdcSig = await connection.sendRawTransaction(
        (signedTx as Transaction).serialize(),
        { skipPreflight: false },
      );
      await connection.confirmTransaction(
        { signature: usdcSig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
    } catch (mintErr) {
      Sentry.captureException(mintErr, {
        tags: { endpoint: "/api/playground/faucet", step: "mint_usdc" },
        extra: { walletAddress },
      });
      const msg = mintErr instanceof Error ? mintErr.message : String(mintErr);
      return NextResponse.json(
        { error: `USDC mint failed: ${msg}`, retryable: true },
        { status: 503 },
      );
    }

    // Record claim AFTER on-chain success — don't lock wallet on partial failure
    const nextClaimAt = recordClaim(walletAddress);

    // ── Small SOL airdrop (best-effort, 3 s timeout per attempt) ──────────
    // Tries public devnet faucet for ~0.05 SOL so the user can pay for their
    // own subsequent transactions. Non-blocking — failure is acceptable.
    let solAirdropped = false;
    let solSig: string | undefined;
    for (const rpcEndpoint of DEVNET_RPC_POOL) {
      try {
        const pubConn = new Connection(rpcEndpoint, "confirmed");
        // Wrap the airdrop + confirm in a 3 s timeout so a slow/dead RPC
        // endpoint doesn't block the entire response past 4 s.
        const airdropSig: string = await Promise.race([
          (async () => {
            const s = await pubConn.requestAirdrop(walletPk, SOL_AIRDROP_AMOUNT);
            await pubConn.confirmTransaction(s, "confirmed");
            return s;
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("airdrop timeout")), 3_000)
          ),
        ]);
        solAirdropped = true;
        solSig = airdropSig;
        break;
      } catch {
        // Try next endpoint or give up gracefully
      }
    }

    return NextResponse.json({
      funded: true,
      usdc_amount: USDC_MINT_AMOUNT / 1_000_000,
      usdc_sig: usdcSig,
      sol_airdropped: solAirdropped,
      ...(solSig ? { sol_sig: solSig } : {}),
      sim_usdc_mint: SIM_USDC_MINT,
      nextClaimAt,
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { endpoint: "/api/playground/faucet", method: "POST" },
    });
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg || "Internal server error" }, { status: 500 });
  }
}

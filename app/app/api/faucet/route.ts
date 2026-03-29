/**
 * PERC-376: Devnet faucet endpoint
 *
 * POST /api/faucet { wallet: string, type?: "sol" | "usdc" }
 *
 * GH#1399: Unknown type values now return 400 instead of silently routing to USDC.
 *
 * type="sol"  → airdrops 2 SOL via requestAirdrop on devnet public RPC
 * type="usdc" → mints 10,000 test USDC (default when type omitted)
 *
 * Rate-limited: 1 claim per wallet per type per 24h (tracked in Supabase auto_fund_log).
 *
 * GH#1382 (PERC-1233): switched from raw Keypair + sendAndConfirmTransaction to
 * getDevnetMintSigner() + sendRawTransaction (sealed signer, same as auto-fund / devnet-airdrop).
 * Added on-chain mint authority check → 400 (not 500) on mismatch.
 *
 * GH#1803: DB rate-limit check (tryFaucetGate) now runs a SELECT pre-check BEFORE
 * any INSERT or RPC call, so rate-limited wallets get 429 consistently on first call.
 * Previously, a transient DB connection error on first call could cause fail-open,
 * letting the RPC path run and returning a confusing "devnet unavailable" 503.
 */

import { NextRequest, NextResponse } from "next/server";
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
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import { getDevnetMintSigner } from "@/lib/devnet-signer";
import { tryFaucetGate, releaseFaucetClaim } from "@/lib/faucet-rate-gate";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

// Use NEXT_PUBLIC_DEFAULT_NETWORK — canonical network env var (GH#1380, aligned with auto-fund fix in PR #1379)
const NETWORK =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
  process.env.NEXT_PUBLIC_SOLANA_NETWORK;

const USDC_MINT_AMOUNT = 10_000_000_000; // 10,000 USDC (6 decimals)
const SOL_AIRDROP_AMOUNT = 2 * LAMPORTS_PER_SOL; // 2 SOL
const RATE_LIMIT_HOURS = 24;

// Public devnet RPCs for requestAirdrop (private RPC may reject airdrop requests).
// GH#1764: two endpoints — if primary fails with a transient/retryable error, try fallback.
const DEVNET_RPC_POOL = [
  "https://api.devnet.solana.com",
  "https://rpc.ankr.com/solana_devnet",
];

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

    // GH#1399: Validate type before coercing — unknown types must return 400,
    // not silently fall through to the USDC mint path.
    // GH#1815: type is now required — missing type must also return 400 (not
    // silently default to "usdc" and crash with TokenOwnerOffCurveError).
    // Normalize type parameter: trim whitespace and lowercase before validation
    const rawType = body?.type;
    const normalizedType =
      typeof rawType === "string" ? rawType.trim().toLowerCase() : undefined;
    if (normalizedType === undefined) {
      return NextResponse.json(
        { error: "Missing required field: type. Must be \"sol\" or \"usdc\"" },
        { status: 400 },
      );
    }
    if (normalizedType !== "sol" && normalizedType !== "usdc") {
      return NextResponse.json(
        { error: "Invalid type. Use 'sol' or 'usdc'" },
        { status: 400 },
      );
    }
    const type: "sol" | "usdc" = normalizedType;

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
    // Uses faucet_claims table with UNIQUE(wallet, fund_type).
    const supabase = getServiceClient();
    const gate = await tryFaucetGate(supabase, walletAddress, type);

    if (!gate.allowed) {
      return NextResponse.json(
        {
          error: "Already claimed in the last 24 hours",
          funded: false,
          nextClaimAt: gate.nextClaimAt,
        },
        { status: 429 },
      );
    }

    // ── SOL airdrop path ──────────────────────────────────────────────────────
    if (type === "sol") {
      // GH#1764: try each RPC in DEVNET_RPC_POOL. If a request hits a transient/
      // retryable error, fall through to the next endpoint. If all RPCs are
      // exhausted, release the gate and return 503. Rate-limit responses (429)
      // abort immediately — trying another endpoint won't help for per-wallet limits.
      let sig: string | null = null;
      let lastRateLimitMsg: string | null = null;
      let lastTransientMsg: string | null = null;
      let fatalErr: unknown = null;

      for (const rpcUrl of DEVNET_RPC_POOL) {
        const pubConn = new Connection(rpcUrl, "confirmed");
        try {
          sig = await pubConn.requestAirdrop(walletPk, SOL_AIRDROP_AMOUNT);
          await pubConn.confirmTransaction(sig, "confirmed");
          break; // success — exit loop
        } catch (airdropErr) {
          // GH#1474: fall back to toString() when .message is empty
          const msg =
            airdropErr instanceof Error
              ? airdropErr.message || airdropErr.toString() || "Airdrop failed"
              : String(airdropErr) || "Airdrop failed";

          // Detect Solana devnet RPC rate-limit responses.
          // The public devnet faucet returns "429 Too Many Requests", "airdrop request limit",
          // or similar strings when the wallet or IP has exceeded the daily drip.
          const isRateLimit =
            /429|too many requests|rate.?limit|airdrop.*limit|limit.*airdrop/i.test(msg);
          if (isRateLimit) {
            // Per-wallet rate limits apply across all public RPCs — bail out immediately.
            lastRateLimitMsg = msg;
            break;
          }

          // GH#1392 / GH#1764: transient failures — try next RPC.
          // Extended pattern covers ETIMEDOUT, ENOTFOUND, ECONNRESET, EHOSTUNREACH,
          // "network changed", "fetch failed", and other Node.js socket-level errors.
          // GH#1776: superstruct "satisfy a union" errors indicate the RPC returned an
          // unexpected response format — treat as transient so we try the next endpoint.
          const isTransient =
            /internal error|service unavailable|timeout|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH|network.*changed|fetch failed|socket hang up|satisfy a union|superstruct/i.test(
              msg,
            );
          if (isTransient) {
            lastTransientMsg = msg;
            sig = null; // ensure we don't use a partial sig
            continue; // try next RPC
          }

          // Non-transient, non-rate-limit error — record and stop trying
          fatalErr = airdropErr;
          sig = null;
          break;
        }
      }

      // ── Post-loop: evaluate outcome ──────────────────────────────────────
      if (lastRateLimitMsg !== null) {
        // GH#1595: release gate so user can retry after RPC rate limit clears
        // GH#1798: return a user-friendly rate-limit message (not "temporarily unavailable").
        // RPC devnet rate limits are per-wallet and typically reset in ~24h.
        if (gate.claimId) await releaseFaucetClaim(supabase, gate.claimId);
        const rpcRateLimitNextClaimAt = new Date(
          Date.now() + 24 * 60 * 60 * 1000,
        ).toISOString();
        return NextResponse.json(
          {
            error:
              "SOL airdrop rate limit reached — Solana devnet limits 1 airdrop per wallet per day. Try again tomorrow or use https://faucet.solana.com.",
            retryable: false,
            nextClaimAt: rpcRateLimitNextClaimAt,
            rpcRateLimited: true,
          },
          { status: 429 },
        );
      }

      if (sig === null && (lastTransientMsg !== null || fatalErr !== null)) {
        if (fatalErr !== null) {
          const errMsg =
            fatalErr instanceof Error
              ? fatalErr.message || fatalErr.toString() || "Airdrop failed"
              : String(fatalErr) || "Airdrop failed";
          if (gate.claimId) await releaseFaucetClaim(supabase, gate.claimId);
          Sentry.captureException(fatalErr, {
            tags: { endpoint: "/api/faucet", type: "sol" },
            extra: { walletAddress },
          });
          return NextResponse.json({ error: errMsg }, { status: 500 });
        }
        // All RPCs returned transient errors
        if (gate.claimId) await releaseFaucetClaim(supabase, gate.claimId);
        return NextResponse.json(
          {
            error: "Solana devnet temporarily unavailable. Please retry in a few minutes.",
            retryable: true,
          },
          { status: 503 },
        );
      }

      // At this point sig is guaranteed non-null (all null paths return early above)
      // GH#1595: claim already recorded by gate INSERT — also log to auto_fund_log for analytics
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from("auto_fund_log").insert({
        wallet: walletAddress,
        sol_airdropped: true,
        usdc_minted: false,
      });

      return NextResponse.json({
        funded: true,
        sol_airdropped: true,
        sol_amount: SOL_AIRDROP_AMOUNT / LAMPORTS_PER_SOL,
        signature: sig!,
        nextClaimAt: new Date(
          Date.now() + RATE_LIMIT_HOURS * 60 * 60 * 1000,
        ).toISOString(),
      });
    }

    // ── USDC mint path ────────────────────────────────────────────────────────

    // Load configuration
    const cfg = getConfig();
    const usdcMintAddr = (cfg as Record<string, unknown>).testUsdcMint as
      | string
      | undefined;

    if (!usdcMintAddr) {
      if (gate.claimId) await releaseFaucetClaim(supabase, gate.claimId);
      return NextResponse.json(
        { error: "Test USDC mint not configured" },
        { status: 500 },
      );
    }

    const usdcMint = new PublicKey(usdcMintAddr);

    // Load sealed mint authority signer (GH#1382: replaces raw Keypair.fromSecretKey)
    const mintSigner = getDevnetMintSigner();
    if (!mintSigner) {
      if (gate.claimId) await releaseFaucetClaim(supabase, gate.claimId);
      return NextResponse.json(
        { error: "Server not configured for minting (DEVNET_MINT_AUTHORITY_KEYPAIR missing)" },
        { status: 500 },
      );
    }

    const mintAuthPk = new PublicKey(mintSigner.publicKey());
    const connection = new Connection(cfg.rpcUrl, "confirmed");

    // On-chain authority check: verify our signer matches the mint's authority
    // before attempting MintTo. Returns 400 (not 500) on mismatch so callers
    // can distinguish a config error from a transient failure.
    try {
      const mintInfo = await connection.getAccountInfo(usdcMint);
      if (!mintInfo) {
        if (gate.claimId) await releaseFaucetClaim(supabase, gate.claimId);
        return NextResponse.json(
          { error: `Test USDC mint ${usdcMintAddr} does not exist on devnet` },
          { status: 500 },
        );
      }
      // SPL Token mint layout: bytes 0-3 coption(u32), bytes 4-35 mint_authority (32 bytes)
      const mintData = new Uint8Array(mintInfo.data);
      if (mintData.length >= 36) {
        const hasAuthority =
          new DataView(mintData.buffer, mintData.byteOffset).getUint32(0, true) === 1;
        if (!hasAuthority) {
          if (gate.claimId) await releaseFaucetClaim(supabase, gate.claimId);
          return NextResponse.json(
            { error: "Test USDC mint has no mint authority (fixed supply)" },
            { status: 500 },
          );
        }
        const onChainAuthority = new PublicKey(mintData.slice(4, 36));
        if (!onChainAuthority.equals(mintAuthPk)) {
          Sentry.captureException(
            new Error(
              `faucet: mint authority mismatch — on-chain ${onChainAuthority.toBase58()}, signer ${mintAuthPk.toBase58()}`,
            ),
            { tags: { endpoint: "/api/faucet", step: "authority_check" } },
          );
          if (gate.claimId) await releaseFaucetClaim(supabase, gate.claimId);
          return NextResponse.json(
            {
              error:
                "Cannot mint tokens: DEVNET_MINT_AUTHORITY_KEYPAIR does not match the on-chain " +
                "mint authority for testUsdcMint. The mint needs to be re-keyed or the env var updated.",
              mintAuthority: onChainAuthority.toBase58(),
              hint: "authority_mismatch",
            },
            { status: 400 },
          );
        }
      }
    } catch (authErr) {
      // RPC error during check — surface as 503 (retryable)
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      console.warn("[faucet] mint authority check failed:", msg);
      Sentry.captureException(authErr, {
        tags: { endpoint: "/api/faucet", step: "authority_check" },
        extra: { walletAddress },
      });
      if (gate.claimId) await releaseFaucetClaim(supabase, gate.claimId);
      return NextResponse.json(
        { error: "Could not verify mint authority due to RPC error. Please retry.", retryable: true },
        { status: 503 },
      );
    }

    // Build mint transaction
    const ata = await getAssociatedTokenAddress(usdcMint, walletPk);
    const tx = new Transaction();

    // Create ATA if it doesn't exist
    let ataExists = false;
    try {
      await getAccount(connection, ata);
      ataExists = true;
    } catch {
      // ATA not found — will be created in tx
    }

    if (!ataExists) {
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
      createMintToInstruction(usdcMint, ata, mintAuthPk, USDC_MINT_AMOUNT),
    );

    // Set blockhash + feePayer before signing (required for sendRawTransaction)
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = mintAuthPk;

    // Sign with sealed signer and send raw (GH#1382: replaces sendAndConfirmTransaction
    // which internally calls tx.sign() wiping existing partial signatures)
    const signedTx = mintSigner.signTransaction(tx);
    const sig = await connection.sendRawTransaction(
      (signedTx as Transaction).serialize(),
    );
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
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
    const errorMsg =
      error instanceof Error
        ? error.message || error.toString() || "Internal server error"
        : String(error) || "Internal server error";
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}

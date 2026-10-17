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
import { getClientIp } from "@/lib/get-client-ip";
import { checkFundRateLimit } from "@/lib/fund-ip-rate-limit";
import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { getDevnetMintSigner } from "@/lib/devnet-signer";
import { assertSuccessfulConfirmation } from "@/lib/transaction-confirmation";
import * as Sentry from "@sentry/nextjs";

// ── In-memory rate limiter (fallback when Supabase unavailable) ───────────────
const _autoFundClaims = new Map<string, number>();
const _AUTO_FUND_RATE_MS = 24 * 60 * 60 * 1000;

function _autoFundIsLimited(wallet: string): { limited: boolean; nextClaimAt: string | null } {
  const last = _autoFundClaims.get(wallet);
  if (last === undefined) return { limited: false, nextClaimAt: null };
  const elapsed = Date.now() - last;
  if (elapsed < _AUTO_FUND_RATE_MS) {
    return { limited: true, nextClaimAt: new Date(last + _AUTO_FUND_RATE_MS).toISOString() };
  }
  return { limited: false, nextClaimAt: null };
}

function _autoFundRecord(wallet: string): void {
  _autoFundClaims.set(wallet, Date.now());
}

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

/** Wrap a promise with a timeout; rejects after `ms` milliseconds. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export async function POST(req: NextRequest) {
  /**
   * GH#2600: gives back the Supabase faucet claim reserved by tryFaucetGate when
   * this request funds nothing.
   *
   * Before this, the ONLY release site was the "nothing funded" branch below, so
   * any THROW between the gate succeeding and that branch — connection.getBalance()
   * (RPC), getServerConnection(), or `new PublicKey(usdcMintAddr)` on a malformed
   * env value — fell straight to this function's outer catch and left the claim
   * reserved. The caller got a 500, no funds, and a 24h lockout from a server-side
   * problem they cannot see or fix. Same defect class as #2597 (devnet-pre-fund)
   * and the very shape #2521 fixed on this route's RETURN paths — this closes the
   * THROW gap #2521 missed, which is what #2600 reported.
   *
   * Armed once the gate reserves, self-disarming (safe to call more than once —
   * from the "nothing funded" branch AND the outer catch), and disarmed for good
   * the instant funding is confirmed, so a later throw (e.g. in response
   * construction) can never claw back a claim that was legitimately spent.
   * Releasing an already-spent claim would let a wallet immediately re-request and
   * double-fund from the shared DEVNET_MINT_AUTHORITY_KEYPAIR — worse than the leak
   * this fixes, so that disarm is not optional.
   */
  let releaseGateClaimOnExit: (() => Promise<void>) | null = null;
  let usdcMintOutcomeUnknown = false;

  try {
    // Only works on devnet
    if (NETWORK !== "devnet") {
      return NextResponse.json(
        { error: "Auto-fund only available on devnet" },
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

    // Rate limit: DB-backed when Supabase available, in-memory fallback otherwise.
    let supabase: ReturnType<typeof import("@/lib/supabase").getServiceClient> | null = null;
    let gate: { allowed: boolean; nextClaimAt: string | null; claimId?: number } = { allowed: true, nextClaimAt: null };
    try {
      const { getServiceClient, tryFaucetGate: _tryGate } = await Promise.resolve(
        { getServiceClient: (await import("@/lib/supabase")).getServiceClient,
          tryFaucetGate: (await import("@/lib/faucet-rate-gate")).tryFaucetGate }
      );
      supabase = getServiceClient();
      gate = await _tryGate(supabase, walletAddress, "auto-fund");
    } catch {
      // Supabase unavailable — use in-memory limiter
      const { limited, nextClaimAt } = _autoFundIsLimited(walletAddress);
      gate = { allowed: !limited, nextClaimAt };
    }

    if (!gate.allowed) {
      return NextResponse.json(
        { error: "Already funded in the last 24 hours", funded: false, nextClaimAt: gate.nextClaimAt },
        { status: 429 },
      );
    }

    // `gate.claimId` is only set when the Supabase path actually reserved a slot —
    // NOT whenever `supabase` is non-null. The catch above can leave a stale
    // truthy `supabase` (assigned before the throwing tryFaucetGate call) while
    // `gate` was reassigned from the in-memory fallback, which reserves nothing
    // and carries no claimId. Arming on `supabase` alone would build a closure
    // that deletes by `id = undefined`.
    if (supabase && gate.claimId != null) {
      const claimId = gate.claimId;
      const sb = supabase;
      // Self-disarming: at most one delete per request however many exits reach it.
      let outstanding = true;
      releaseGateClaimOnExit = async () => {
        if (!outstanding) return;
        outstanding = false;
        try {
          const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate");
          // Bounded: supabase-js uses fetch with no default timeout, and the
          // try/catch below catches rejections, not hangs.
          await withTimeout(releaseFaucetClaim(sb, claimId), 3_000);
        } catch (releaseErr) {
          console.warn("[auto-fund] failed to release faucet claim:", releaseErr);
        }
      };
    }

    const cfg = getConfig();
    const connection = getServerConnection("confirmed");
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
            const sig = await connection.sendRawTransaction(
              (signed as Transaction).serialize(),
            );

            // S3 audit 2026-10-17 (sibling of #2599/#2629 on faucet): once the
            // mint is SENT, a confirmTransaction throw ("block height exceeded"
            // on slow devnet RPC) does not prove it failed. Re-check the status;
            // if that is inconclusive, keep the claim rather than release it,
            // so a retry cannot mint a second 1,000 USDC.
            usdcMintOutcomeUnknown = true;
            // Resolves null ONLY when the mint landed but confirmTransaction threw.
            const confirmation = await connection.confirmTransaction(
              { signature: sig, blockhash, lastValidBlockHeight },
              "confirmed",
            ).catch(async (confirmErr: unknown) => {
              const status = await connection.getSignatureStatus(sig, {
                searchTransactionHistory: true,
              });
              const st = status.value;
              if (st && st.err) {
                usdcMintOutcomeUnknown = false; // landed and failed: nothing minted
                throw confirmErr;
              }
              const landed =
                !!st &&
                (st.confirmationStatus === "confirmed" ||
                  st.confirmationStatus === "finalized");
              if (!landed) {
                // Not found AND the blockhash expired: it can never land, so
                // nothing was minted. Any other throw (RPC/network error) leaves
                // the outcome unknown and the claim kept.
                const expired =
                  confirmErr instanceof Error &&
                  confirmErr.name === "TransactionExpiredBlockheightExceededError";
                if (!st && expired) usdcMintOutcomeUnknown = false;
                throw confirmErr;
              }
              return null;
            });
            if (confirmation) {
              // A definitive confirmation result: an on-chain error means
              // nothing was minted (claim may be released).
              usdcMintOutcomeUnknown = false;
              assertSuccessfulConfirmation(
                confirmation,
                "Auto-fund USDC mint",
              );
            }
            usdcMintOutcomeUnknown = false;

            results.usdc_minted = true;
            results.usdc_amount = USDC_MINT_AMOUNT / 1_000_000;
          }
        }
      } catch (e: unknown) {
        console.warn(`USDC mint failed for ${walletAddress}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Record in-memory claim on success
    if (results.sol_airdropped || results.usdc_minted) {
      // GH#2600: the claim was SPENT on funding that actually happened, so it must
      // not be given back. Disarm before anything else that could throw — the
      // outer catch below calls releaseGateClaimOnExit() on ANY thrown error, and
      // without this a throw during the analytics insert or response construction
      // would wrongly release a real claim, letting the wallet immediately re-fund.
      releaseGateClaimOnExit = null;
      _autoFundRecord(walletAddress);
      // Analytics-only DB insert — best-effort, skip when supabase unavailable
      if (supabase) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase as any).from("auto_fund_log").insert({
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
      }
    } else if (usdcMintOutcomeUnknown) {
      // A mint was sent and may have landed: keep the claim (no double mint).
      releaseGateClaimOnExit = null;
    } else {
      // Nothing funded — release gate so user can retry.
      await releaseGateClaimOnExit?.();
    }

    return NextResponse.json({
      funded: results.sol_airdropped || results.usdc_minted,
      ...results,
    });
  } catch (error) {
    // GH#2600: any throw between the gate reserving and a confirmed fund also
    // gives the claim back. Self-disarming, so this is a no-op when the
    // "nothing funded" branch above already released it, and it never fires once
    // funding succeeded (disarmed above).
    try {
      await releaseGateClaimOnExit?.();
    } catch {
      /* best-effort */
    }
    Sentry.captureException(error, {
      tags: { endpoint: "/api/auto-fund", method: "POST" },
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

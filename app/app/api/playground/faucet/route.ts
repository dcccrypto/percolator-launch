/**
 * Playground Faucet API — POST /api/playground/faucet
 *
 * Mints 10,000 Sim-USDC (DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC, 6dp)
 * to the caller's ATA. The mint authority acts as fee payer so the user needs
 * zero SOL to receive their first tokens.
 *
 * Also tops the wallet up to 1 SOL so the user can pay for their own subsequent transactions: from the
 * server wallet when PLAYGROUND_SOL_FAUCET_KEYPAIR is set (UX WP-10, FA-1: the public devnet
 * airdrop is usually rate-limited), else best-effort via the public devnet faucet.
 *
 * Rate limit: 1 Sim-USDC claim per wallet per day, the SAME faucet_claims slot ("usdc", 24h) the
 * Fund-your-account modal's /api/faucet uses (lib/sim-usdc-claim.ts; Council GO1106-UX: the two
 * routes had separate slots, so one wallet claimed twice in a minute). Falls back to a shared
 * process-local Map when Supabase is unavailable, and then ALSO refuses a wallet whose Sim-USDC ATA shows a
 * faucet-paid tx in the last 24h (lib/sim-usdc-onchain-claim.ts; R3 M8), failing closed if the chain is unreadable.
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
 *                   sol_airdropped: boolean, sol_sig?: string, sol_source?: "server" | "public",
 *                   sol_amount: number, sol_pending?: true, sol_has_enough?: true, nextClaimAt: string }
 *   sol_has_enough: nothing was sent because the wallet already holds fee SOL (sol_airdropped is false).
 *   sol_pending: the server SOL top-up was broadcast but not confirmed (sol_airdropped is false).
 * No response ever names an env var or echoes raw internal error text (WP-10 AC3).
 * Response (400): { error: string }
 * Response (429): { error: string, nextClaimAt: string }

 * Response (503, definite failure): { error: string, retryable: true }
 * Response (503, broadcast outcome unresolved):
 *   { error: string, detail: string, pending: true, retryable: false,
 *     usdc_sig: string, nextClaimAt: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/get-client-ip";
import { checkFundRateLimit } from "@/lib/fund-ip-rate-limit";
import {
  Connection,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  SendTransactionError,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getDevnetMintSigner } from "@/lib/devnet-signer";
import {
  confirmServerSignature,
  getServerConnection,
  ServerSignatureExecutionError,
  ServerSignatureTimeoutError,
} from "@/lib/server-rpc";
import * as Sentry from "@sentry/nextjs";
import { assertSuccessfulConfirmation } from "@/lib/transaction-confirmation";
import { grantServerSol } from "@/lib/server-sol-faucet";
import { findRecentOnchainClaim, onchainClaimCheckFailure } from "@/lib/sim-usdc-onchain-claim";
import {
  SIM_USDC_ALREADY_CLAIMED,
  SIM_USDC_CLAIM_FUND_TYPE,
  SIM_USDC_CLAIM_WINDOW_MS,
  recordSimUsdcClaimInMemory,
  simUsdcClaimInMemory,
} from "@/lib/sim-usdc-claim";
import {
  SIM_USDC_CLAIM_IN_PROGRESS,
  buildClaimMarkerInstructions,
  isClaimMarkerCollision,
  tryAcquireClaimLock,
} from "@/lib/sim-usdc-claim-guard";

export const dynamic = "force-dynamic";

/** Shown when the faucet is not configured; never names the env var (WP-10 AC3). */
const FAUCET_UNAVAILABLE = "The faucet isn't available right now. Try again later.";

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
const RATE_LIMIT_MS = SIM_USDC_CLAIM_WINDOW_MS; // 1 day, shared with /api/faucet type=usdc

const DEVNET_RPC_POOL = [
  "https://api.devnet.solana.com",
  "https://rpc.ankr.com/solana_devnet",
];

const NETWORK =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
  process.env.NEXT_PUBLIC_SOLANA_NETWORK;

// ── In-memory rate-limit fallback ─────────────────────────────────────────────
// The shared Sim-USDC map (lib/sim-usdc-claim.ts): a modal claim through /api/faucet counts here too.
function isRateLimited(wallet: string): { limited: boolean; nextClaimAt: string } {
  const { limited, nextClaimAt } = simUsdcClaimInMemory(wallet);
  return { limited, nextClaimAt: nextClaimAt ?? "" };
}

function recordClaim(wallet: string): string {
  return recordSimUsdcClaimInMemory(wallet);
}

// ── Handler ───────────────────────────────────────────────────────────────────

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
   * The mint section below already releases on its own failure (see the
   * `catch (mintErr)` block) — that stays untouched here. But getDevnetMintSigner(),
   * `new PublicKey(mintSigner.publicKey())`, `new PublicKey(SIM_USDC_MINT)`, and
   * getServerConnection() run BETWEEN the gate succeeding and that mint try/catch,
   * unwrapped — a THROW from any of them (a malformed env value, for instance)
   * fell straight to this function's outer catch, which never released. Same
   * defect class as #2597.
   *
   * Armed once the gate reserves, self-disarming (safe to call redundantly with
   * the mint section's own release), and disarmed for good the instant the mint
   * confirms, so a later throw can never claw back a claim that was legitimately
   * spent. Releasing an already-spent claim would let a wallet immediately
   * re-request and double-fund from the shared DEVNET_MINT_AUTHORITY_KEYPAIR —
   * worse than the leak this fixes.
   */
  let releaseGateClaimOnExit: (() => Promise<void>) | null = null;
  // N4: per-wallet in-flight lock (layer 1), held for the whole request.
  let releaseClaimLock: (() => void) | null = null;

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
    // fund endpoints).
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

    // N4 layer 1: a second claim for this wallet while one is running on this instance is refused up front.
    releaseClaimLock = tryAcquireClaimLock(walletAddress);
    if (!releaseClaimLock) {
      return NextResponse.json({ error: SIM_USDC_CLAIM_IN_PROGRESS, nextClaimAt: null }, { status: 429 });
    }

    // Rate limit: durable Supabase gate (insert-as-gate) when available, the
    // process-local in-memory Map as fallback — mirrors /api/faucet and
    // /api/auto-fund so the per-wallet limit survives a serverless cold start
    // (the in-memory Map resets on cold start / a different warm instance). It
    // takes the SAME "usdc" slot and 24h window as /api/faucet type=usdc, so the
    // modal and this page share one daily claim (it used to be a separate
    // "playground-faucet" slot with a 1h window: two claims in a minute).
    let supabase: ReturnType<typeof import("@/lib/supabase").getServiceClient> | null = null;
    let gate: { allowed: boolean; nextClaimAt: string | null; claimId?: number } = { allowed: true, nextClaimAt: null };
    // R3 M8: true when no durable gate answered, so the limit must come from the in-memory map AND chain history.
    let durableGateUnavailable = false;
    try {
      const sbMod = await import("@/lib/supabase");
      const gateMod = await import("@/lib/faucet-rate-gate");
      supabase = sbMod.getServiceClient();
      gate = await gateMod.tryFaucetGate(supabase, walletAddress, SIM_USDC_CLAIM_FUND_TYPE, RATE_LIMIT_MS);
    } catch {
      // Supabase unavailable — fall back to the in-memory limiter.
      durableGateUnavailable = true;
      const { limited, nextClaimAt } = isRateLimited(walletAddress);
      gate = { allowed: !limited, nextClaimAt: nextClaimAt || null };
    }
    if (!gate.allowed) {
      return NextResponse.json(
        { error: SIM_USDC_ALREADY_CLAIMED, nextClaimAt: gate.nextClaimAt },
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
          console.warn("[playground/faucet] failed to release faucet claim:", releaseErr);
        }
      };
    }

    // Load mint signer — required for USDC mint
    const mintSigner = getDevnetMintSigner();
    if (!mintSigner) {
      // Release the durable claim slot so a config error doesn't lock the wallet.
      if (supabase && gate.claimId) {
        try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ }
      }
      return NextResponse.json(
        {
          error: FAUCET_UNAVAILABLE,
          hint: "missing_keypair",
        },
        { status: 503 },
      );
    }

    const mintAuthPk = new PublicKey(mintSigner.publicKey());
    const usdcMint = new PublicKey(SIM_USDC_MINT);

    // ROOT CAUSE FIX: this used to hand-build a URL straight from
    // HELIUS_DEVNET_API_KEY, which is the exhausted key (HTTP 429 "max usage
    // reached") — see lib/server-rpc.ts. getServerConnection() prefers the
    // working DEVNET_RPC_URL override (with the required Origin header) and
    // falls back to the public devnet RPC instead.
    const connection = getServerConnection("confirmed");

    // R3 M8: no durable gate (no DB configured, or its table missing). The process-local map above resets on every
    // cold start and per instance, so also read the wallet's Sim-USDC ATA history: a recent faucet-paid tx there is
    // a claim. If the chain cannot be read, refuse rather than risk a second mint. Nothing is reserved yet.
    if (durableGateUnavailable) {
      try {
        const claimedUntil = await findRecentOnchainClaim(
          connection,
          await getAssociatedTokenAddress(usdcMint, walletPk),
          mintAuthPk.toBase58(),
        );
        if (claimedUntil) {
          return NextResponse.json(
            { error: SIM_USDC_ALREADY_CLAIMED, nextClaimAt: claimedUntil },
            { status: 429 },
          );
        }
      } catch (verifyErr) {
        Sentry.captureException(verifyErr, {
          tags: { endpoint: "/api/playground/faucet", step: "onchain_claim_check" },
        });
        return NextResponse.json(onchainClaimCheckFailure(verifyErr), { status: 503 },
        );
      }
    }

    // ── Mint Sim-USDC ───────────────────────────────────────────────────────
    let usdcSig: string | undefined;
    // N4 layer 2: with no durable gate, the tx starts with a per-(wallet, UTC day) marker account create, so a
    // concurrent or later claim fails atomically on chain, whatever the instance or blockhash.
    let markerCount = 0;
    try {
      const ata = await getAssociatedTokenAddress(usdcMint, walletPk);
      const tx = new Transaction();
      if (durableGateUnavailable) {
        const markerIxs = await buildClaimMarkerInstructions(mintAuthPk, walletAddress);
        markerCount = markerIxs.length;
        for (const ix of markerIxs) tx.add(ix);
      }

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

      // A finalized blockhash is already visible across the load-balanced RPC
      // before this server-signed transaction is broadcast.
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      tx.recentBlockhash = blockhash;
      tx.feePayer = mintAuthPk; // playground sponsors this transaction's fee

      const signedTx = mintSigner.signTransaction(tx) as Transaction;
      // The fee-payer signature IS the transaction id, and it exists before the
      // send. Keep it so a send that throws ambiguously can still be resolved.
      const preSendSig = signedTx.signature ? bs58.encode(signedTx.signature) : undefined;
      try {
        usdcSig = await connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
        });
      } catch (sendErr) {
        // A JSON-RPC error response (SendTransactionError — preflight/simulation
        // rejection, bad blockhash) means the node refused it: nothing was
        // broadcast. Anything else (dropped connection, timeout, 5xx) may have
        // been forwarded to the leader before the response was lost, so treat
        // it as broadcast-with-unknown-outcome rather than a safe retry.
        if (!(sendErr instanceof SendTransactionError)) usdcSig = preSendSig;
        throw sendErr;
      }

      // Resolve the original signature after broadcast. Do not rebuild/re-mint
      // merely because its blockhash lifetime elapsed: a slow RPC may still be
      // catching up to a transaction that already landed.
      await confirmServerSignature(connection, usdcSig, { timeoutMs: 45_000 });
    } catch (mintErr) {
      if (markerCount > 0 && isClaimMarkerCollision(mintErr, markerCount)) {
        // The marker exists: another claim for this wallet and UTC day already landed. Nothing was minted by us.
        return NextResponse.json(
          { error: SIM_USDC_ALREADY_CLAIMED, nextClaimAt: new Date((Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000).toISOString() },
          { status: 429 },
        );
      }
      const wasBroadcast = typeof usdcSig === "string" && usdcSig.length > 0;
      const definiteFailure = mintErr instanceof ServerSignatureExecutionError;

      // Once a signature exists, release the claim ONLY when on-chain failure
      // is explicitly established. Timeout, RPC/library errors, and any other
      // unexpected post-broadcast exception remain UNKNOWN/fail-closed.
      const unresolved = wasBroadcast && !definiteFailure;

      // A confirmation timeout after sendRawTransaction returned a signature is
      // an UNKNOWN outcome, not a proven mint failure. Keep the durable claim
      // reservation in place so a retry cannot broadcast a second mint while
      // the original transaction may already have landed. Also record the
      // process-local fallback claim for Supabase-unavailable deployments.
      //
      // Pre-broadcast failures and explicit on-chain execution failures are
      // definite enough to release the durable claim and become retryable.
      // Any other post-broadcast error keeps the reservation fail-closed.
      let pendingNextClaimAt: string | undefined;
      if (unresolved) {
        pendingNextClaimAt = recordClaim(walletAddress);
      } else if (supabase && gate.claimId) {
        try {
          const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate");
          await releaseFaucetClaim(supabase, gate.claimId);
        } catch {
          /* best-effort */
        }
      }

      Sentry.captureException(mintErr, {
        tags: { endpoint: "/api/playground/faucet", step: "mint_usdc" },
        extra: {
          walletAddress,
          ...(unresolved ? { usdcSig, outcome: "unknown" } : {}),
        },
      });

      const msg = mintErr instanceof Error ? mintErr.message : String(mintErr);

      if (unresolved) {
        return NextResponse.json(
          {
            error:
              "Your test USDC is on its way but not confirmed yet. Check your balance in a minute before trying again.",
            detail: "confirmation pending",
            pending: true,
            retryable: false,
            usdc_sig: usdcSig,
            nextClaimAt: pendingNextClaimAt,
          },
          { status: 503 },
        );
      }

      console.error("[playground/faucet] USDC mint failed:", msg);
      return NextResponse.json(
        { error: "The faucet couldn't send test USDC right now. Try again in a moment.", retryable: true },
        { status: 503 },
      );
    }
    if (!usdcSig) {
      throw new Error("USDC mint completed without a transaction signature");
    }

    // GH#2600: the claim was SPENT on a mint that landed, so it must not be given
    // back — disarm before the SOL-airdrop loop or response construction below
    // could otherwise let an unrelated throw claw it back.
    releaseGateClaimOnExit = null;

    // Confirmed mint: record the process-local claim timestamp. Unknown
    // post-broadcast outcomes are retained in the catch path above instead.
    const nextClaimAt = recordClaim(walletAddress);

    // ── Small SOL airdrop (best-effort, 3 s timeout per attempt) ──────────
    // Tries public devnet faucet for ~0.05 SOL so the user can pay for their
    // own subsequent transactions. Non-blocking — failure is acceptable.
    let solAirdropped = false;
    let solSig: string | undefined;
    let solSource: "server" | "public" | undefined;
    // UX WP-10 (FA-1): the server wallet first, within its limits (lib/server-sol-faucet.ts:
    // balance-aware top-up, one per wallet per day, a global daily budget, 3 per IP per hour);
    // otherwise the public airdrop below, as before.
    let solPending = false;
    let solLamports = 0;
    const grant = await grantServerSol({ connection, db: supabase, to: walletPk, ip: getClientIp(req) });
    if (grant.status === "sent") {
      solAirdropped = true;
      solSig = grant.signature;
      solSource = "server";
      solLamports = grant.lamports;
    } else if (grant.status === "funded") {
      solAirdropped = true;
      solSource = "server";
    } else if (grant.status === "pending") {
      // L-1: broadcast with an unknown outcome counts as spent; never send again on top of it.
      solPending = true;
      solSig = grant.signature;
      solSource = "server";
    }
    // Council GO1106-UX (First-timer): a wallet holding 1.9 SOL was told "SOL airdrop skipped (public faucet busy).
    // Try faucet.solana.com". When nothing was sent and the wallet already has fee SOL, say that instead and skip the
    // public airdrop. A failed balance read changes nothing (the airdrop is still tried).
    let solHasEnough = false;
    if (!solAirdropped && !solPending) {
      try {
        const balance = await withTimeout(connection.getBalance(walletPk), 2_000);
        solHasEnough = typeof balance === "number" && balance >= SOL_AIRDROP_AMOUNT;
      } catch {
        /* unknown balance: fall through to the airdrop */
      }
    }
    for (const rpcEndpoint of solAirdropped || solPending || solHasEnough ? [] : DEVNET_RPC_POOL) {
      try {
        const pubConn = new Connection(rpcEndpoint, "confirmed");
        // Wrap the airdrop + confirm in a 3 s timeout so a slow/dead RPC
        // endpoint doesn't block the entire response past 4 s.
        const airdropSig: string = await Promise.race([
          (async () => {
            const s = await pubConn.requestAirdrop(walletPk, SOL_AIRDROP_AMOUNT);
            // GH#2517: an unchecked result advertises SOL success and stops the
            // RPC fallback loop from trying the next endpoint.
            assertSuccessfulConfirmation(
              await pubConn.confirmTransaction(s, "confirmed"),
              "Playground SOL airdrop",
            );
            return s;
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("airdrop timeout")), 3_000)
          ),
        ]);
        solAirdropped = true;
        solSig = airdropSig;
        solSource = "public";
        solLamports = SOL_AIRDROP_AMOUNT;
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
      ...(solSource ? { sol_source: solSource } : {}),
      // I-3: the amount actually sent (0 when the wallet already had enough).
      sol_amount: solLamports / LAMPORTS_PER_SOL,
      ...(solPending ? { sol_pending: true } : {}),
      ...(solHasEnough ? { sol_has_enough: true } : {}),
      sim_usdc_mint: SIM_USDC_MINT,
      nextClaimAt,
    });
  } catch (err) {
    // GH#2600: any throw between the gate reserving and a landed mint also gives
    // the claim back. Self-disarming, so this is a no-op when the mint section's
    // own release above already fired (a redundant delete-by-id is a harmless
    // no-op), and it never fires once the mint confirmed (disarmed above).
    try {
      await releaseGateClaimOnExit?.();
    } catch {
      /* best-effort */
    }
    Sentry.captureException(err, {
      tags: { endpoint: "/api/playground/faucet", method: "POST" },
    });
    console.error("[playground/faucet] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Something went wrong and nothing was sent. Try again in a moment." }, { status: 500 });
  } finally {
    releaseClaimLock?.();
  }
}

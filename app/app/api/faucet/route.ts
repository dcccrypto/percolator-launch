/**
 * PERC-376: Devnet faucet endpoint
 *
 * POST /api/faucet { wallet: string, type: "sol" | "usdc" }
 *
 * GH#1399: Unknown type values now return 400 instead of silently routing to USDC.
 * GH#1815: type is required; a missing type returns 400.
 *
 * type="sol"  → airdrops 2 SOL via requestAirdrop on devnet public RPC
 * type="usdc" → mints 10,000 test USDC
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
import { getSolFaucetSigner, grantServerSol, type ServerSolGrant } from "@/lib/server-sol-faucet";
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
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { getDevnetMintSigner } from "@/lib/devnet-signer";
import { assertSuccessfulConfirmation } from "@/lib/transaction-confirmation";
import * as Sentry from "@sentry/nextjs";

// ── In-memory rate-limit fallback (when Supabase unavailable) ─────────────────
const _faucetClaims = new Map<string, number>();
const _FAUCET_RATE_MS = 24 * 60 * 60 * 1000;

function _faucetIsLimited(key: string): { limited: boolean; nextClaimAt: string | null } {
  const last = _faucetClaims.get(key);
  if (last === undefined) return { limited: false, nextClaimAt: null };
  const elapsed = Date.now() - last;
  if (elapsed < _FAUCET_RATE_MS) {
    return { limited: true, nextClaimAt: new Date(last + _FAUCET_RATE_MS).toISOString() };
  }
  return { limited: false, nextClaimAt: null };
}

function _faucetRecord(key: string): void {
  _faucetClaims.set(key, Date.now());
}

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
   * Every RETURN after the gate already releases (the manual `if (supabase &&
   * gate.claimId) { ... }` blocks below), and the mint tx's own catch releases
   * then rethrows. But four USDC-path statements between the gate and that tx
   * try/catch are unwrapped: getConfig(), `new PublicKey(usdcMintAddr)`,
   * `new PublicKey(mintSigner.publicKey())`, and getServerConnection() — a THROW
   * from any of them (a malformed env value, for instance) fell straight to this
   * function's outer catch, which never released. Same defect class as #2597.
   *
   * Armed once the gate reserves, self-disarming (safe to call from more than one
   * place — an existing manual release AND the outer catch, redundantly), and
   * disarmed for good the instant a claim is legitimately spent, so a later throw
   * can never claw back a claim that funded the wallet. Releasing an
   * already-spent claim would let a wallet immediately re-request and double-fund
   * from the shared DEVNET_MINT_AUTHORITY_KEYPAIR — worse than the leak this fixes.
   */
  let releaseGateClaimOnExit: (() => Promise<void>) | null = null;

  try {
    if (NETWORK !== "devnet") {
      return NextResponse.json(
        { error: "Faucet only available on devnet" },
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

    // GH#1820: wrap req.json() so empty/non-JSON bodies return 400 instead of 500.
    // Next.js throws a SyntaxError (or similar) when the body is absent or malformed.
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be valid JSON with fields: wallet (string), type ('sol' | 'usdc')" },
        { status: 400 },
      );
    }
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

    // Rate limit: DB-backed when Supabase available, in-memory fallback otherwise.
    let supabase: ReturnType<typeof import("@/lib/supabase").getServiceClient> | null = null;
    let gate: { allowed: boolean; nextClaimAt: string | null; claimId?: number } = { allowed: true, nextClaimAt: null };
    const rateKey = `${walletAddress}:${type}`;
    try {
      const sbMod = await import("@/lib/supabase");
      const gateMod = await import("@/lib/faucet-rate-gate");
      supabase = sbMod.getServiceClient();
      gate = await gateMod.tryFaucetGate(supabase, walletAddress, type);
    } catch {
      // Supabase unavailable — use in-memory limiter
      const { limited, nextClaimAt } = _faucetIsLimited(rateKey);
      gate = { allowed: !limited, nextClaimAt };
    }

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
          console.warn("[faucet] failed to release faucet claim:", releaseErr);
        }
      };
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

      // UX WP-10 (FA-1): the server wallet first, within its limits (lib/server-sol-faucet.ts:
      // balance-aware top-up to 0.05 SOL, one per wallet per day, a global daily budget, 3 per IP
      // per hour); the public airdrop below is the fallback, as before.
      // Env check first: without the key, no server connection is even built.
      const grant: ServerSolGrant = getSolFaucetSigner()
        ? await grantServerSol({ connection: getServerConnection("confirmed"), db: supabase, to: walletPk, ip: getClientIp(req) })
        : { status: "skipped", reason: "disabled" };
      if (grant.status === "sent" || grant.status === "funded") {
        if (grant.status === "funded") {
          // Re-review I-C: nothing was sent, so the wallet's claim is not spent: give it back
          // and record nothing.
          await releaseGateClaimOnExit?.();
        } else {
          _faucetRecord(rateKey);
        }
        releaseGateClaimOnExit = null;
        return NextResponse.json({
          funded: true,
          sol_airdropped: grant.status === "sent",
          sol_source: "server",
          // I-3: the true amount (0 when the wallet already had enough).
          sol_amount: grant.lamports / LAMPORTS_PER_SOL,
          ...(grant.status === "sent" ? { signature: grant.signature } : {}),
          nextClaimAt: new Date(Date.now() + RATE_LIMIT_HOURS * 60 * 60 * 1000).toISOString(),
        });
      }
      if (grant.status === "pending") {
        // L-1: broadcast with an unknown outcome counts as SPENT: keep the claim, never re-send.
        releaseGateClaimOnExit = null;
        _faucetRecord(rateKey);
        return NextResponse.json(
          {
            error: "Your test SOL is on its way but not confirmed yet. Check your balance in a minute before trying again.",
            pending: true,
            retryable: false,
            signature: grant.signature,
          },
          { status: 503 },
        );
      }

      for (const rpcUrl of DEVNET_RPC_POOL) {
        const pubConn = new Connection(rpcUrl, "confirmed");
        try {
          sig = await pubConn.requestAirdrop(walletPk, SOL_AIRDROP_AMOUNT);
          const confirmation =
            await pubConn.confirmTransaction(sig, "confirmed");

          assertSuccessfulConfirmation(
            confirmation,
            "SOL airdrop",
          );

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
        // Release gate so user can retry after RPC rate limit clears
        if (supabase && gate.claimId) {
          try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ }
        }
        const rpcRateLimitNextClaimAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        return NextResponse.json(
          {
            error: "SOL airdrop rate limit reached — Solana devnet limits 1 airdrop per wallet per day. Try again tomorrow or use https://faucet.solana.com.",
            retryable: false,
            nextClaimAt: rpcRateLimitNextClaimAt,
            rpcRateLimited: true,
          },
          { status: 429 },
        );
      }

      if (sig === null && (lastTransientMsg !== null || fatalErr !== null)) {
        if (fatalErr !== null) {
          if (supabase && gate.claimId) {
            try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ }
          }
          Sentry.captureException(fatalErr, { tags: { endpoint: "/api/faucet", type: "sol" }, extra: { walletAddress } });
          return NextResponse.json({ error: "SOL airdrop failed. Please try again later." }, { status: 500 });
        }
        if (supabase && gate.claimId) {
          try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ }
        }
        return NextResponse.json(
          { error: "Solana devnet temporarily unavailable. Please retry in a few minutes.", retryable: true },
          { status: 503 },
        );
      }

      // GH#2600: the claim was SPENT on an airdrop that landed, so it must not be
      // given back — disarm before anything else here can throw.
      releaseGateClaimOnExit = null;

      // Record in-memory + analytics (analytics-only, best-effort)
      _faucetRecord(rateKey);
      if (supabase) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase as any).from("auto_fund_log").insert({ wallet: walletAddress, sol_airdropped: true, usdc_minted: false });
        } catch { /* analytics-only, skip */ }
      }

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
      if (supabase && gate.claimId) { try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ } }
      return NextResponse.json(
        { error: "Test USDC mint not configured" },
        { status: 500 },
      );
    }

    const usdcMint = new PublicKey(usdcMintAddr);

    // Load sealed mint authority signer (GH#1382: replaces raw Keypair.fromSecretKey)
    const mintSigner = getDevnetMintSigner();
    if (!mintSigner) {
      if (supabase && gate.claimId) { try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ } }
      return NextResponse.json(
        { error: "Server not configured for token minting. Please contact support." },
        { status: 500 },
      );
    }

    const mintAuthPk = new PublicKey(mintSigner.publicKey());
    const connection = getServerConnection("confirmed");

    // On-chain authority check: verify our signer matches the mint's authority
    // before attempting MintTo. Returns 400 (not 500) on mismatch so callers
    // can distinguish a config error from a transient failure.
    try {
      const mintInfo = await connection.getAccountInfo(usdcMint);
      if (!mintInfo) {
        if (supabase && gate.claimId) { try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ } }
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
          if (supabase && gate.claimId) { try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ } }
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
          if (supabase && gate.claimId) { try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ } }
          return NextResponse.json(
            {
              error: "Cannot mint tokens: server signing key does not match the on-chain mint authority.",
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
      if (supabase && gate.claimId) { try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ } }
      return NextResponse.json(
        { error: "Could not verify mint authority due to RPC error. Please retry.", retryable: true },
        { status: 503 },
      );
    }

    // Build, send, confirm on-chain first. If anything fails before confirmation,
    // release the faucet gate so the user is not locked out for 24h with no tokens.
    let sig: string;
    try {
      const ata = await getAssociatedTokenAddress(usdcMint, walletPk);
      const tx = new Transaction();

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

      tx.add(
        createMintToInstruction(usdcMint, ata, mintAuthPk, USDC_MINT_AMOUNT),
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = mintAuthPk;

      const signedTx = mintSigner.signTransaction(tx);
      sig = await connection.sendRawTransaction(
        (signedTx as Transaction).serialize(),
      );
      try {
        const confirmation =
          await connection.confirmTransaction(
            { signature: sig, blockhash, lastValidBlockHeight },
            "confirmed",
          );

        assertSuccessfulConfirmation(
          confirmation,
          "USDC faucet mint",
        );
      } catch (confirmErr) {
        // The devnet RPC can be slow to reflect confirmation, so
        // confirmTransaction may throw "block height exceeded" even though the
        // mint actually landed — a false negative that would show the user an
        // error and burn their 24h rate-limit claim despite receiving tokens.
        // Re-check the signature status directly before declaring failure.
        const status = await connection.getSignatureStatus(sig, {
          searchTransactionHistory: true,
        });
        const s = status.value;
        const landed =
          !!s &&
          !s.err &&
          (s.confirmationStatus === "confirmed" ||
            s.confirmationStatus === "finalized");
        if (!landed) throw confirmErr;
        // else: the mint confirmed on re-check — fall through to success.
      }
    } catch (chainErr) {
      if (supabase && gate.claimId) { try { const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate"); await releaseFaucetClaim(supabase, gate.claimId); } catch { /* best-effort */ } }
      throw chainErr;
    }

    // GH#2600: the claim was SPENT on a mint that landed, so it must not be given
    // back — disarm before anything else here can throw.
    releaseGateClaimOnExit = null;

    // Record in-memory + analytics (best-effort)
    _faucetRecord(rateKey);
    if (supabase) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from("auto_fund_log").insert({ wallet: walletAddress, sol_airdropped: false, usdc_minted: true });
      } catch (logErr) {
        Sentry.captureException(logErr, { tags: { endpoint: "/api/faucet", type: "usdc", step: "auto_fund_log" }, extra: { walletAddress } });
      }
    }

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
    // GH#2600: any throw between the gate reserving and a landed fund also gives
    // the claim back. Self-disarming, so this is a no-op when an existing manual
    // release above already fired (a redundant delete-by-id is a harmless no-op —
    // Postgres never reuses a BIGSERIAL id), and it never fires once funding
    // succeeded (disarmed above).
    try {
      await releaseGateClaimOnExit?.();
    } catch {
      /* best-effort */
    }
    Sentry.captureException(error, {
      tags: { endpoint: "/api/faucet", method: "POST" },
    });
    // UX WP-10 AC3: raw internal text (which can name env vars) stays in the server log.
    console.error("[faucet] failed:", error instanceof Error ? error.message || String(error) : String(error));
    return NextResponse.json({ error: "Something went wrong and nothing was sent. Try again in a moment." }, { status: 500 });
  }
}

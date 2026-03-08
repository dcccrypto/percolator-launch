/**
 * PERC-475: Devnet Airdrop API
 *
 * POST /api/devnet-airdrop
 * Body: { mintAddress: string, walletAddress: string }
 *
 * Airdrops $500 USD worth of a devnet mirror token to a wallet.
 * The mintAddress must exist in the devnet_mints table (a mirror market mint).
 *
 * Flow:
 * 1. Validate mintAddress is in devnet_mints table → get mainnet_ca, symbol, decimals
 * 2. INSERT-as-gate: atomically reserve the claim slot (eliminates TOCTOU race)
 * 3. Fetch current mainnet price from DexScreener for mainnet_ca
 * 4. Calculate amount = $500 USD at current price
 *    (min: 1_000 raw, max: 3_200_000_000 raw at 6 decimals = 3,200 tokens)
 * 5. Mint to walletAddress using DEVNET_MINT_AUTHORITY_KEYPAIR
 *    On mint failure: release the reserved slot so user can retry.
 * 6. Return { signature, amount, symbol }
 *
 * Rate limit: 1 request per wallet per mint per 24h (Supabase-backed, TOCTOU-safe).
 * Only callable on devnet.
 *
 * Requires: DEVNET_MINT_AUTHORITY_KEYPAIR env var (JSON secret key bytes)
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
  getAccount,
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim() ?? "mainnet";

/** Target USD value to airdrop per claim */
const AIRDROP_USD_VALUE = 500;

/** Min/max raw token amounts at 6 decimals */
const MIN_RAW = 1_000n;        // 0.001 tokens — floor for high-priced assets
const MAX_RAW = 3_200_000_000n; // 3,200 tokens — cap prevents draining low-price mints

/** Rate limit: 1 claim per wallet per mint per 24h (Supabase-backed) */
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Atomically try to reserve a claim slot for wallet+mint (INSERT-as-gate).
 *
 * This eliminates the SELECT→INSERT TOCTOU race present in the previous
 * checkRateLimit + recordClaim two-step approach. Because the
 * devnet_airdrop_claims table has a UNIQUE INDEX on (wallet, mint), the DB
 * serialises concurrent INSERTs — exactly one will succeed; the rest get a
 * unique-violation and are denied without any window for a double-spend.
 *
 * Re-claim after 24h: before the gate INSERT we delete any expired row for
 * this wallet+mint so the unique slot is free for a new window.
 *
 * Returns:
 *   { allowed: true,  claimId }  — slot reserved, proceed with mint
 *   { allowed: false, retryAfterSecs } — already claimed within 24h
 */
async function tryClaimGate(
  supabase: ReturnType<typeof getServiceClient>,
  walletAddress: string,
  mintAddress: string,
): Promise<{ allowed: boolean; retryAfterSecs: number; claimId?: number }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

  try {
    // Step 1: Clear any expired claim so the unique slot is free for re-claiming.
    // This is safe even under concurrency: two concurrent DELETEs on the same
    // expired row are idempotent; the second finds nothing and succeeds silently.
    await (supabase as any)
      .from("devnet_airdrop_claims")
      .delete()
      .eq("wallet", walletAddress)
      .eq("mint", mintAddress)
      .lt("claimed_at", windowStart);

    // Step 2: INSERT-as-gate.
    // Only one concurrent request can win the unique constraint; all others get
    // a postgres error code 23505 and are denied — atomically, with no gap.
    const { data, error } = await (supabase as any)
      .from("devnet_airdrop_claims")
      .insert({ wallet: walletAddress, mint: mintAddress, claimed_at: new Date().toISOString() })
      .select("id, claimed_at")
      .maybeSingle();

    if (error) {
      if (error.code === "23505") {
        // Unique violation = active claim within 24h. Fetch it to compute retry time.
        const { data: existing } = await (supabase as any)
          .from("devnet_airdrop_claims")
          .select("claimed_at")
          .eq("wallet", walletAddress)
          .eq("mint", mintAddress)
          .maybeSingle();

        if (existing) {
          const age = Date.now() - new Date(existing.claimed_at as string).getTime();
          const retryAfterSecs = Math.ceil((RATE_LIMIT_WINDOW_MS - age) / 1000);
          return { allowed: false, retryAfterSecs: Math.max(0, retryAfterSecs) };
        }
        // Row vanished between the conflict and the read (highly unlikely) — deny conservatively.
        return { allowed: false, retryAfterSecs: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) };
      }

      // Unexpected DB error — fail open to avoid blocking users; capture for alerting.
      const dbErr = new Error(`[devnet-airdrop] gate INSERT failed: ${error.message}`);
      console.warn(dbErr.message);
      Sentry.captureException(dbErr, {
        tags: { endpoint: "/api/devnet-airdrop", step: "try_claim_gate" },
        extra: { supabase_code: error.code, walletAddress, mintAddress },
      });
      return { allowed: true, retryAfterSecs: 0 };
    }

    return { allowed: true, retryAfterSecs: 0, claimId: (data as any)?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[devnet-airdrop] tryClaimGate threw:", msg);
    Sentry.captureException(err, {
      tags: { endpoint: "/api/devnet-airdrop", step: "try_claim_gate" },
      extra: { walletAddress, mintAddress },
    });
    return { allowed: true, retryAfterSecs: 0 };
  }
}

/**
 * Release a reserved claim slot identified by its row id.
 *
 * Called only when the on-chain mint fails AFTER tryClaimGate succeeded,
 * so the user isn't locked out for 24h due to a transient network/RPC error.
 */
async function releaseClaim(
  supabase: ReturnType<typeof getServiceClient>,
  claimId: number,
): Promise<void> {
  const { error } = await (supabase as any)
    .from("devnet_airdrop_claims")
    .delete()
    .eq("id", claimId);

  if (error) {
    console.warn("[devnet-airdrop] failed to release claim slot:", error.message);
  }
}

/** Fetch token price from DexScreener for the mainnet CA */
async function fetchTokenPriceUsd(mainnetCa: string): Promise<{ priceUsd: number } | null> {
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mainnetCa}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const pairs = Array.isArray(json.pairs) ? json.pairs : [];
    if (pairs.length === 0) return null;

    // Pick the pair with the most liquidity
    const sorted = [...pairs].sort(
      (a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    );
    const price = parseFloat((sorted[0] as any).priceUsd ?? "0");
    if (price <= 0) return null;
    return { priceUsd: price };
  } catch {
    return null;
  }
}

/** Wrap a promise with a timeout (ms). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export async function POST(req: NextRequest) {
  try {
    if (NETWORK !== "devnet") {
      return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
    }

    const body = await req.json();
    const { mintAddress, walletAddress } = body as {
      mintAddress?: string;
      walletAddress?: string;
    };

    if (!mintAddress || !walletAddress) {
      return NextResponse.json(
        { error: "Missing mintAddress or walletAddress" },
        { status: 400 },
      );
    }

    // Validate public keys
    let mintPk: PublicKey;
    let walletPk: PublicKey;
    try {
      mintPk = new PublicKey(mintAddress);
    } catch {
      return NextResponse.json({ error: "Invalid mintAddress" }, { status: 400 });
    }
    try {
      walletPk = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json({ error: "Invalid walletAddress" }, { status: 400 });
    }

    // Guard: SPL token accounts require an on-curve (Ed25519) owner.
    // Passing a PDA (off-curve) as the destination wallet causes
    // TokenOwnerOffCurveError during createAssociatedTokenAccountInstruction.
    // Reject early with a clear 400 before touching the DB or chain.
    if (!PublicKey.isOnCurve(walletPk.toBytes())) {
      return NextResponse.json(
        { error: "walletAddress must be a regular wallet, not a program-derived address (PDA)" },
        { status: 400 },
      );
    }

    // 1. Validate mintAddress exists in devnet_mints table → get mainnet_ca + metadata
    const supabase = getServiceClient();
    const { data: mintRow, error: dbErr } = await (supabase as any)
      .from("devnet_mints")
      .select("mainnet_ca, symbol, decimals")
      .eq("devnet_mint", mintAddress)
      .maybeSingle();

    if (dbErr || !mintRow) {
      return NextResponse.json(
        { error: "mintAddress is not a known devnet mirror mint" },
        { status: 400 },
      );
    }

    const { mainnet_ca: mainnetCa, symbol, decimals: rawDecimals } = mintRow;
    const decimals: number = rawDecimals ?? 6;

    // 2. INSERT-as-gate: atomically reserve the claim slot BEFORE minting.
    //    This eliminates the TOCTOU race in the previous SELECT→UPSERT flow.
    const { allowed, retryAfterSecs, claimId } = await tryClaimGate(supabase, walletAddress, mintAddress);
    if (!allowed) {
      const h = Math.floor(retryAfterSecs / 3600);
      const m = Math.floor((retryAfterSecs % 3600) / 60);
      return NextResponse.json(
        {
          error: `Already claimed — try again in ${h}h ${m}m`,
          retryAfterSecs,
          nextClaimAt: new Date(Date.now() + retryAfterSecs * 1000).toISOString(),
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSecs) },
        },
      );
    }

    // Steps 3–5 are wrapped so that ANY failure after the gate INSERT
    // releases the claim slot. Previously, exceptions between the gate and
    // the mint try-catch (e.g. DexScreener fetch, ATA derivation) would
    // skip releaseClaim, locking the user out for 24h on a transient error.
    let mintSucceeded = false;
    let sig: string;
    let rawAmount: bigint;
    try {
      // 3. Fetch mainnet price from DexScreener
      const priceResult = await fetchTokenPriceUsd(mainnetCa);

      if (priceResult && priceResult.priceUsd > 0) {
        // $500 / price = tokens; scale by decimals
        const tokensFloat = AIRDROP_USD_VALUE / priceResult.priceUsd;
        rawAmount = BigInt(Math.floor(tokensFloat * 10 ** decimals));
      } else {
        // Price unavailable — fall back to a fixed generous amount (1000 tokens)
        rawAmount = BigInt(1000 * 10 ** decimals);
      }

      // Clamp to [MIN_RAW, MAX_RAW]
      if (rawAmount < MIN_RAW) rawAmount = MIN_RAW;
      if (rawAmount > MAX_RAW) rawAmount = MAX_RAW;

      // 4. Load mint authority
      const mintAuthKeyJson = process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
      if (!mintAuthKeyJson) {
        return NextResponse.json(
          { error: "Server not configured for devnet minting (DEVNET_MINT_AUTHORITY_KEYPAIR missing)" },
          { status: 500 },
        );
      }
      let mintAuthority: Keypair;
      try {
        mintAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(mintAuthKeyJson)));
      } catch {
        return NextResponse.json({ error: "Server keypair configuration is invalid" }, { status: 500 });
      }

      const cfg = getConfig();
      const connection = new Connection(cfg.rpcUrl, "confirmed");

      // Derive user's ATA
      const ata = await getAssociatedTokenAddress(mintPk, walletPk);
      let ataExists = false;
      try {
        await getAccount(connection, ata);
        ataExists = true;
      } catch {
        // ATA doesn't exist yet — will be created in tx
      }

      // 5. Build and send mint transaction.
      const tx = new Transaction();
      if (!ataExists) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            mintAuthority.publicKey, // payer
            ata,
            walletPk,
            mintPk,
          ),
        );
      }
      tx.add(createMintToInstruction(mintPk, ata, mintAuthority.publicKey, rawAmount));

      sig = await withTimeout(
        sendAndConfirmTransaction(connection, tx, [mintAuthority], { commitment: "confirmed" }),
        30_000,
      );
      mintSucceeded = true;
    } finally {
      // Release the claim slot on ANY failure so user isn't locked out 24h.
      // Wrapped in try/catch so a releaseClaim() throw doesn't mask the original
      // mint error and lose its stack trace from Sentry.
      if (!mintSucceeded && claimId !== undefined) {
        try {
          await releaseClaim(supabase, claimId);
        } catch (releaseErr) {
          Sentry.captureException(releaseErr, {
            tags: { endpoint: "/api/devnet-airdrop", step: "release_claim_finally" },
          });
        }
      }
    }

    // Claim slot is already recorded from step 2 — no separate recordClaim needed.
    const humanAmount = Number(rawAmount!) / 10 ** decimals;

    return NextResponse.json({
      signature: sig,
      amount: humanAmount,
      rawAmount: rawAmount.toString(),
      symbol: symbol ?? "TOKEN",
      decimals,
      nextClaimAt: new Date(Date.now() + RATE_LIMIT_WINDOW_MS).toISOString(),
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/devnet-airdrop", method: "POST" },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

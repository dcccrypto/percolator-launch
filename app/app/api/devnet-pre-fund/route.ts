/**
 * PERC-744: Devnet Pre-Fund API
 *
 * POST /api/devnet-pre-fund
 * Body: { mintAddress: string, walletAddress: string }
 *
 * Mints enough tokens of a given devnet mint to a wallet so it can
 * cover the vault seed deposit (MIN_INIT_MARKET_SEED = 500_000_000 raw)
 * plus a reasonable buffer.
 *
 * Only callable on devnet. Global rate limiting (120 req/min/IP) is handled
 * by middleware.ts. mintAddress must be in DEVNET_ALLOWED_MINTS env var.
 *
 * Requires: DEVNET_MINT_AUTHORITY_KEYPAIR env var (JSON secret key bytes)
 * — the keypair must be the mint authority for the given mint.
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
  getMint,
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import { tryFaucetGate, releaseFaucetClaim } from "@/lib/faucet-rate-gate";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

// PERC-482 fix: NETWORK env var is always "mainnet" on Vercel prod (build-time).
// The real devnet guard is the devnet_mints DB lookup below — only mirror mints
// (created by our /api/devnet-mirror-mint endpoint) can be funded. This is the
// true security boundary, not the NETWORK string. We keep the env var check as
// a secondary guard for non-mirror-mint requests (DEVNET_ALLOWED_MINTS list).
const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim() ?? "mainnet";
const ALLOW_MIRROR_MINTS = true; // Always allow devnet_mints table entries regardless of NETWORK

/**
 * Allowlist of devnet mint addresses this endpoint may fund.
 * Set DEVNET_ALLOWED_MINTS as a comma-separated list in your env.
 * Requests for mints not on this list are rejected with 400.
 */
const DEVNET_ALLOWED_MINTS: Set<string> = new Set(
  (process.env.DEVNET_ALLOWED_MINTS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean),
);

/**
 * Emergency hardcoded allowlist of known-safe devnet mints.
 * Used as a fallback when the database is unavailable and no static allowlist is configured.
 * Only includes mints that are confirmed to be under our control on devnet.
 * Update this list as new confirmed safe devnet mints are created.
 */
const EMERGENCY_DEVNET_MINTS: Set<string> = new Set([
  // Mirror mints — mainnet tokens mirrored to devnet via /api/devnet-mirror-mint
  // Last synced: 2026-03-28 from devnet_mints table
  "DJKjmSbWjhx925kuk1fS1BENCBnqXCfwUJjb9EKwSEnV", // Percolator (PERC)
  "J5XdjMKTboG6VE9VJjMDknqsZ7QfSxbS8PUzqt2rN48c", // USDC
  "8LiZdZjkgAee7528xwpLsFYDPzn2Dm828WsdwuhrHS2Q", // Wrapped SOL (SOL)
  "H526MxEigL5a4TFVShK8pDwYyeuciwbcnRq7M99X1KDx", // dogwifhat (WIF)
  "3xv6Xrx3Qt4AmT9yGrikEsCtYKaiet7eXXAiCmA24dks", // Jupiter (JUP)
  "CCPHprPU6RsT4KbwVRC5Gk21L3B7VFsPUZFxEjZS4SeC", // Bonk / BONK
  "VV43EZsULua48p5zbX25Eyd3LCNQK8E5XcHuGc4dN9H", // POPCAT
  "FXVgdySNqLD8YQxf5inGPLc6XLKNWbxazQaMPUm2zDGR", // Raydium (RAY)
  "CJUyV594JzJpK2BUakNpm6NbmCkhQoPJWkKjfKTvxJ3C", // BTC
  "JCuusH5o92KkZ9APSFx9W99k4afj4iEHFLu6S5Qx194c", // hey.lol (HEY)
  "CEaNDrt7GwBwpU8L6bFeYvJaDFUU3sqUQnBDcxLMSSVZ", // TXDex (TXD)
  "Eiti4oTMGw4aogh5BCiBk8a5Cy3ahz2QntJbFu71X1as", // 360noscope420blazeit (MLG)
  "651z3GyGhLXb2HGaovQcmNmyAnXfqaZh8FjXPbZM1C9L", // TAX
  "Ft57uS9bHXEXGFiLkaMkiTwJC7EjW2x4dAmqocWBPcot", // PumpLiquid
  "ECFLdZUjefn9wiD9QuRau7m23YgVfbZRBMxtNuKLXMEr", // Wendy's (WENDYS)
  "4YHaH1JjnNGQuEj7TXYxSyMQxze84FngTVbBD4tDfLnC", // FUEL
  "4Y2jDc5SLsmMoEcRJwM9F3T5sUBp8cxZm3vXZo6BsjBG", // $WIF
  "4dbDeRgHk6JPNJZaLLRZHHAWN7Sw1xwFK4cPdNivqHHx", // PEEP
  "EfaNUwzt6w2yXZPUDyfViZhVJpUDupvu3VUXtqHU9Ey8", // Downald
  "J2oQxrjVGj3mFPhYF32USbWh4B3vWqMMD6RWoUkQRP8S", // Fartcoin
  "Bqvnq5M8PmEBYLkH2yUVLe3FhzeimQuEh4CGgnxvnDG4", // MON
  "bT3YAz8kqgXDdPAoLhXjSLcsrxEQxvWDCM7oD2VhzZo", // FREEDOM
  "C1fiahWDErUeVpS8orrxHa1S8mHzsBk8oKUtbH4yWAfn", // PERP
  "cvicXbKJfL16W8ACKHcDtTKfoRZXWRLV9pwzq8YJqBs", // pedgy penguns
  "3kHuwDB8Gng7TuT2pxicWE9xfZgi1dL6Rofh9wsFmkqF", // The Black Ops
  "5BYf1gz3Hc9z27omvXijbXr9ihVV9RwHt1EAC94T7P6t", // COLLECTIBLE
  "E6Ndq3Fh6TXhgD5KMJphzVswRUKk7gxiQTvXqrNJmqfm", // PIXEL
  "4h7dM19A58876Q3aMUNugs6JkGHiGTWFHGbTUEifv8qN", // CL1
  "HUKrHYH8KYwpPz8DatHg6PJkikWDNCFDZQ5YpqEvntWj", // SMITH
  "FV7RUwUQYNeK4oL8g6HacUBaeqURJzUfmWNt4QsTpCn2", // SMORT
  "4ViuSYeVuU2ULikhZHKfBRYCbfzBrAGWBYthKZ4xZkUf", // RIGGED
  "4RvZT6qNGihXGiu9L4ZDyGK4AJxqzmRnmEoN8URTUtHe", // GROKIUS
  "6yEiTM4XYRLr2WsrsHegMXfp8w4EK3Hdw4HEi2mmZgjt", // shitcoin
]);

/**
 * Minimum seed the program requires.
 * Kept local to avoid importing a "use client" module into a server route.
 * Source of truth: hooks/useCreateMarket.ts → MIN_INIT_MARKET_SEED.
 * Must also match percolator.rs constants::MIN_INIT_MARKET_SEED.
 */
const MIN_INIT_MARKET_SEED = 500_000_000n;

/**
 * Total tokens needed for full market creation (Small slab):
 *   Vault seed:      500 tokens (MIN_INIT_MARKET_SEED)
 *   LP collateral: 1,000 tokens
 *   Insurance fund:  100 tokens
 *   Total:         1,600 tokens
 *
 * Fund 2× the total requirement so user has headroom for retries
 * and Medium/Large slabs which may need more. Fixes #757.
 */
const FULL_MARKET_TOKEN_REQUIREMENT = 1_600_000_000n;
const FUND_AMOUNT = FULL_MARKET_TOKEN_REQUIREMENT * 2n;

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
  try {
    // Allow if: explicitly on devnet network OR the mint is a mirror mint (DB-gated)
    // Mirror mints are always safe to fund — their authority is our keypair and they
    // only exist on devnet. The DB lookup below is the real security gate.
    const isDevnetNetwork = NETWORK === "devnet";
    // Non-devnet requests proceed but will be rejected at the DB lookup if not a mirror mint
    if (!isDevnetNetwork && !ALLOW_MIRROR_MINTS) {
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

    // Validate mintAddress: check static allowlist OR dynamic devnet_mints table.
    // #873 fix: ALWAYS check DB when no static allowlist is configured.
    // Previously, DEVNET_ALLOWED_MINTS.size === 0 short-circuited to mintPermitted=true,
    // skipping the DB lookup entirely. The DB is the real security gate — only mirror mints
    // (created by our /api/devnet-mirror-mint endpoint) should be fundable.
    // On-chain getMint authority check remains the final gate; on-chain checks below
    // also catch any DB-level bypass (our keypair can only mint its own authority mints).
    let finallyPermitted: boolean;
    if (DEVNET_ALLOWED_MINTS.size > 0) {
      // Static allowlist present: approve immediately if matched, then fall through to DB
      if (DEVNET_ALLOWED_MINTS.has(mintAddress)) {
        finallyPermitted = true;
      } else {
        // Not in static list — check dynamic mirror-mint table as fallback
        try {
          const supabase = getServiceClient();
          const { data: mirrorRows, error: mirrorErr } = await (supabase as any)
            .from("devnet_mints")
            .select("devnet_mint")
            .eq("devnet_mint", mintAddress)
            .order("created_at", { ascending: false })
            .limit(1);
          if (mirrorErr) {
            Sentry.captureException(mirrorErr, {
              tags: { endpoint: "/api/devnet-pre-fund", phase: "dynamic-mint-check" },
            });
          }
          const mirrorRow = mirrorRows?.[0];
          finallyPermitted = !!mirrorRow?.devnet_mint;
        } catch (e) {
          Sentry.captureException(e, {
            tags: { endpoint: "/api/devnet-pre-fund", phase: "dynamic-mint-check" },
          });
          // DB unavailable and not in static list: fail-closed (on-chain check would catch anyway)
          finallyPermitted = false;
        }
      }
    } else {
      // #873: No static allowlist — ALWAYS query DB (never default to permitted=true)
      try {
        const supabase = getServiceClient();
        const { data: mirrorRows, error: mirrorErr } = await (supabase as any)
          .from("devnet_mints")
          .select("devnet_mint")
          .eq("devnet_mint", mintAddress)
          .order("created_at", { ascending: false })
          .limit(1);
        if (mirrorErr) {
          Sentry.captureException(mirrorErr, {
            tags: { endpoint: "/api/devnet-pre-fund", phase: "dynamic-mint-check" },
          });
        }
        const mirrorRow = mirrorRows?.[0];
        finallyPermitted = !!mirrorRow?.devnet_mint;
      } catch (e) {
        Sentry.captureException(e, {
          tags: { endpoint: "/api/devnet-pre-fund", phase: "dynamic-mint-check" },
        });
        // DB unavailable and no static allowlist: check emergency mints list as fallback
        // If no emergency mints are configured, deny by default (fail-closed security)
        finallyPermitted = EMERGENCY_DEVNET_MINTS.has(mintAddress);
        if (!finallyPermitted && EMERGENCY_DEVNET_MINTS.size === 0) {
          Sentry.captureMessage(
            "devnet-pre-fund: DB unavailable, no emergency mints configured, and mint not in emergency allowlist",
            "warning"
          );
        }
      }
    }
    if (!finallyPermitted) {
      return NextResponse.json({ error: "mintAddress not permitted" }, { status: 400 });
    }

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

    // GH#1601: per-wallet rate limit using INSERT-as-gate on faucet_claims.
    // fund_type = `devnet-pre-fund:<mintAddress>` so each mint is gated independently.
    // Concurrent requests for the same wallet+mint race on INSERT — loser gets 23505.
    const supabaseForGate = getServiceClient();
    const fundType = `devnet-pre-fund:${mintAddress}`;
    const gate = await tryFaucetGate(supabaseForGate, walletAddress, fundType);
    if (!gate.allowed) {
      return NextResponse.json(
        {
          error: "Already pre-funded recently",
          nextClaimAt: gate.nextClaimAt,
        },
        { status: 429 },
      );
    }

    // Load mint authority
    const mintAuthKeyJson = process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
    if (!mintAuthKeyJson) {
      return NextResponse.json(
        { error: "Server not configured for devnet minting (DEVNET_MINT_AUTHORITY_KEYPAIR missing)" },
        { status: 500 },
      );
    }
    let mintAuthority: Keypair;
    try {
      mintAuthority = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(mintAuthKeyJson)),
      );
    } catch {
      return NextResponse.json(
        { error: "Server keypair configuration is invalid" },
        { status: 500 },
      );
    }

    const cfg = getConfig();

    // #873 defense-in-depth: verify RPC endpoint is devnet before any on-chain operation.
    // getRpcEndpoint() returns the actual Helius URL server-side (not the /api/rpc proxy).
    // Mainnet Helius URL contains "mainnet"; devnet contains "devnet".
    // Public devnet RPC (api.devnet.solana.com) and localhost are also allowed.
    try {
      const rpcHostname = new URL(cfg.rpcUrl).hostname;
      const isDevnetRpc =
        rpcHostname.includes("devnet") ||
        rpcHostname === "localhost" ||
        rpcHostname === "127.0.0.1";
      if (!isDevnetRpc) {
        Sentry.captureMessage(
          `devnet-pre-fund called with non-devnet RPC: ${rpcHostname}`,
          { level: "warning", tags: { endpoint: "/api/devnet-pre-fund" } },
        );
        return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
      }
    } catch {
      // Malformed RPC URL — getConfig() validated it, so this should never happen
    }

    const connection = new Connection(cfg.rpcUrl, "confirmed");

    // Pre-flight: verify the configured keypair is actually the mint authority
    // This catches env misconfigurations early with a clear error instead of
    // a generic "Internal server error" from a failed mintTo instruction.
    try {
      const mintInfo = await getMint(connection, mintPk);
      if (
        !mintInfo.mintAuthority ||
        !mintInfo.mintAuthority.equals(mintAuthority.publicKey)
      ) {
        const configuredAuth = mintAuthority.publicKey.toBase58().slice(0, 8);
        const onChainAuth = mintInfo.mintAuthority
          ? mintInfo.mintAuthority.toBase58().slice(0, 8)
          : "none";
        Sentry.captureMessage(
          `Mint authority mismatch for ${mintAddress}: configured=${configuredAuth}… on-chain=${onChainAuth}…`,
          { level: "error", tags: { endpoint: "/api/devnet-pre-fund" } },
        );
        return NextResponse.json(
          {
            error: "Mint authority mismatch — server keypair is not the authority for this mint. Contact team.",
            detail: `configured=${configuredAuth}… on-chain=${onChainAuth}…`,
          },
          { status: 500 },
        );
      }
    } catch (e) {
      // If we can't fetch mint info, proceed and let the tx fail naturally
      Sentry.captureException(e, {
        tags: { endpoint: "/api/devnet-pre-fund", phase: "authority-check" },
      });
    }

    // Derive user's ATA
    const ata = await getAssociatedTokenAddress(mintPk, walletPk);

    // Check current balance — if already sufficient, skip minting
    let currentBalance = 0n;
    let ataExists = false;
    try {
      const acct = await getAccount(connection, ata);
      currentBalance = acct.amount;
      ataExists = true;
    } catch {
      // ATA doesn't exist yet
    }

    if (currentBalance >= FULL_MARKET_TOKEN_REQUIREMENT) {
      // Release gate so concurrent requests (and future calls) aren't locked out
      if (gate.claimId != null) await releaseFaucetClaim(supabaseForGate, gate.claimId);
      return NextResponse.json({
        status: "sufficient",
        balance: currentBalance.toString(),
        message: "Wallet already has sufficient tokens",
      });
    }

    // Need to fund: amount = FUND_AMOUNT - currentBalance (top up to 2× minimum)
    const toMint = FUND_AMOUNT - currentBalance;

    const tx = new Transaction();

    // Create ATA if it doesn't exist
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

    // Mint tokens to ATA
    tx.add(
      createMintToInstruction(
        mintPk,
        ata,
        mintAuthority.publicKey,
        toMint,
      ),
    );

    let sig: string;
    try {
      sig = await withTimeout(
        sendAndConfirmTransaction(connection, tx, [mintAuthority], { commitment: "confirmed" }),
        30_000, // 30s — devnet RPC should confirm well within this
      );
    } catch (txErr) {
      // TX failed — release gate so user can retry
      if (gate.claimId != null) await releaseFaucetClaim(supabaseForGate, gate.claimId);
      throw txErr; // re-throw to outer catch for Sentry + 500 response
    }

    return NextResponse.json({
      status: "funded",
      minted: toMint.toString(),
      newBalance: (currentBalance + toMint).toString(),
      signature: sig,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/devnet-pre-fund", method: "POST" },
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

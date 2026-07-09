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
 * H3: balance is checked BEFORE the 24h per-wallet-per-mint rate gate is consulted.
 * A single wizard launch calls this endpoint up to 3× (vault seed, LP collateral,
 * insurance top-up) for the SAME wallet + SAME shared sim-USDC mint, so they'd
 * otherwise collide on one gate claim. Sufficient-balance is a 200 no-op that never
 * touches the gate; the gate is only consulted/consumed right before an actual mint.
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
import * as Sentry from "@sentry/nextjs";
// GH#2335: the fallback limiter used when Supabase is unavailable must itself be
// cross-instance safe — a module-level Map is per-lambda-instance on Vercel and lets
// concurrent requests on different instances all pass the "not limited" check. This
// store is Vercel Blob-backed (same pattern as playground-nonce-store.ts), so all
// instances share one durable view of outstanding claims.
import { reserveClaim, releaseClaim, peekClaim, PREFUND_CLAIM_TTL_MS } from "@/lib/prefund-claim-store";

export const dynamic = "force-dynamic";

// Canonical env var first, legacy fallback; undefined = non-devnet (fail-closed).
// The real devnet guard is the devnet_mints DB lookup below — only mirror mints
// (created by our /api/devnet-mirror-mint endpoint) can be funded.
const NETWORK =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
  process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
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
  // Sim-USDC — the canonical playground collateral mint (app/lib/config.ts testUsdcMint).
  // Every seeded market, the faucet, and the trade flow already collateralize in this mint;
  // the create-market wizard now does too (the old per-market "mirror mint" collateral model
  // is removed). Must always be permitted here regardless of Supabase/devnet_mints
  // availability — this is the one mint every new market's vault seed / LP deposit /
  // insurance top-up needs pre-funded.
  "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC", // Sim-USDC (testUsdcMint)
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
  let releaseFallbackClaimOnError: (() => Promise<void>) | null = null;

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
          const { getServiceClient: _gsc } = await import("@/lib/supabase");
          const supabase = _gsc();
          const { data: mirrorRows, error: mirrorErr } = await supabase
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
          // GH#1816: Explicit type guard — verify mirrorRow structure
          finallyPermitted = !!(
            mirrorRow &&
            typeof mirrorRow === "object" &&
            "devnet_mint" in mirrorRow &&
            typeof (mirrorRow as Record<string, unknown>).devnet_mint === "string"
          );
        } catch (e) {
          Sentry.captureException(e, {
            tags: { endpoint: "/api/devnet-pre-fund", phase: "dynamic-mint-check" },
          });
          // DB unavailable and not in static list: fall back to the emergency allowlist
          // (mirrors the `else` branch below) so Sim-USDC and other known-safe mints stay
          // fundable even when Supabase is down — otherwise every market creation on a
          // Supabase-less deployment hard-fails at "mintAddress not permitted".
          finallyPermitted = EMERGENCY_DEVNET_MINTS.has(mintAddress);
        }
      }
    } else {
      // #873: No static allowlist — ALWAYS query DB (never default to permitted=true)
      try {
        const { getServiceClient: _gsc } = await import("@/lib/supabase");
        const supabase = _gsc();
        const { data: mirrorRows, error: mirrorErr } = await supabase
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
        // GH#1816: Explicit type guard — verify mirrorRow has required devnet_mint property.
        // Previously !!mirrorRow?.devnet_mint would correctly fail-closed (undefined → false),
        // but being explicit about structure validation is clearer and prevents subtle bugs
        // if the schema changes or malformed data is returned from DB.
        finallyPermitted = !!(
          mirrorRow &&
          typeof mirrorRow === "object" &&
          "devnet_mint" in mirrorRow &&
          typeof (mirrorRow as Record<string, unknown>).devnet_mint === "string"
        );
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

    // H3: read the on-chain balance FIRST — before touching the 24h rate gate.
    // All three devnet-pre-fund calls inside a single wizard launch (vault seed,
    // LP collateral, insurance top-up — see hooks/useCreateMarket.ts) target the
    // SAME shared sim-USDC collateral mint for the SAME wallet, so they all hash to
    // one gate key (`rateKey` below). Checking the gate before the balance meant the
    // 2nd/3rd call in one flow always hit the 1st call's still-open 24h claim and
    // 429'd, throwing mid-launch. FUND_AMOUNT already tops up to 2× the full
    // three-step requirement, so once the first call funds the wallet the remaining
    // calls in the same flow see a sufficient balance here and return a 200 no-op —
    // the gate is never touched again for the rest of that launch.
    const ata = await getAssociatedTokenAddress(mintPk, walletPk);
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
      return NextResponse.json({
        status: "sufficient",
        balance: currentBalance.toString(),
        message: "Wallet already has sufficient tokens",
      });
    }

    // Rate limit: DB-backed (Supabase) primary gate, durable Blob-backed fallback
    // (prefund-claim-store.ts) when Supabase is unavailable. Only consumed here —
    // once we know a real mint is about to happen.
    const fundType = `devnet-pre-fund:${mintAddress}`;
    const rateKey = `${walletAddress}:${fundType}`;

    let usingFallbackGate = false;
    let reservedFallbackClaim = false;

    const releaseFallbackClaim = async () => {
      if (reservedFallbackClaim) {
        reservedFallbackClaim = false;
        await releaseClaim(rateKey);
      }
    };

    releaseFallbackClaimOnError = releaseFallbackClaim;
    let supabaseForGate: ReturnType<typeof import("@/lib/supabase").getServiceClient> | null = null;
    let gate: { allowed: boolean; nextClaimAt: string | null; claimId?: number } = { allowed: true, nextClaimAt: null };
    try {
      const sbMod = await import("@/lib/supabase");
      const gateMod = await import("@/lib/faucet-rate-gate");
      supabaseForGate = sbMod.getServiceClient();
      gate = await gateMod.tryFaucetGate(supabaseForGate, walletAddress, fundType);
    } catch {
      usingFallbackGate = true;
      // Read-only pre-check (mirrors the Supabase pre-check SELECT in
      // faucet-rate-gate.ts): does NOT reserve. A cheap early-exit 429 before doing
      // any mint-adjacent work below. The authoritative check-and-reserve happens via
      // reserveClaim() immediately before the mint transaction is built — that's what
      // actually closes the check-before-record race, not this pre-check.
      const { limited, nextClaimAt } = await peekClaim(rateKey);
      gate = { allowed: !limited, nextClaimAt };
    }
    if (!gate.allowed) {
      return NextResponse.json(
        { error: "Already pre-funded recently", nextClaimAt: gate.nextClaimAt },
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

    // Need to fund: amount = FUND_AMOUNT - currentBalance (top up to 2× minimum)
    const toMint = FUND_AMOUNT - currentBalance;

    // Reserve the durable fallback claim immediately before mint work.
    // reserveClaim() atomically-enough (see prefund-claim-store.ts) re-checks AND
    // records in one Blob read-modify-write, closing the check-before-record race
    // across concurrent requests/instances in degraded/fallback mode.
    if (usingFallbackGate) {
      const { reserved, nextClaimAt } = await reserveClaim(rateKey, PREFUND_CLAIM_TTL_MS);

      if (!reserved) {
        return NextResponse.json(
          { error: "Already pre-funded recently", nextClaimAt },
          { status: 429 },
        );
      }

      reservedFallbackClaim = true;
    }

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
        30_000,
      );
    } catch (txErr) {
      // TX failed — release DB gate if available.
      if (supabaseForGate && gate.claimId != null) {
        try {
          const { releaseFaucetClaim } = await import("@/lib/faucet-rate-gate");
          await releaseFaucetClaim(supabaseForGate, gate.claimId);
        } catch {
          /* best-effort */
        }
      }

      // TX failed after reserving the durable fallback claim.
      // Release it so a failed mint does not lock the wallet/mint pair for 24h.
      await releaseFallbackClaim();

      throw txErr;
    }

    // Mint confirmed. If we reserved a fallback claim, COMMIT it now by clearing the
    // "reserved" flag — this is the fix for the release-after-success edge case: the
    // outer catch below calls releaseFallbackClaimOnError() on ANY thrown error, but
    // until this line the reserved flag stayed true even after a successful mint. A
    // throw between a confirmed mint (e.g. response serialization) and the `return`
    // would otherwise wrongly release a real mint's claim, letting the wallet
    // immediately re-claim and over-mint. Flipping the flag off here makes
    // releaseFallbackClaim() (and the outer-catch call to it) a no-op from this point
    // on — the claim stays recorded in the durable store for its full TTL, which is
    // exactly what a genuine successful mint should do. Nothing further to write:
    // reserveClaim() above already durably persisted the claim.
    reservedFallbackClaim = false;

    return NextResponse.json({
      status: "funded",
      minted: toMint.toString(),
      newBalance: (currentBalance + toMint).toString(),
      signature: sig,
    });
  } catch (error) {
    try {
      await releaseFallbackClaimOnError?.();
    } catch {
      /* best-effort */
    }

    Sentry.captureException(error, {
      tags: { endpoint: "/api/devnet-pre-fund", method: "POST" },
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

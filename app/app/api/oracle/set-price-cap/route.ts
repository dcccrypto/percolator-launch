/**
 * GH#1691: SetOraclePriceCap — apply oracle price circuit-breaker to admin-oracle markets
 *
 * POST /api/oracle/set-price-cap
 * Body: { slabAddress?: string, maxChangeE2bps?: number }
 *
 * If slabAddress is omitted, applies to ALL admin-oracle markets where CRANK_KEYPAIR
 * is the oracle authority. This is the recommended "panic" invocation to protect
 * all open markets from price manipulation.
 *
 * maxChangeE2bps: max allowed price change per oracle update, in 0.01 bps units.
 *   Default: 1_000 (= 10 bps = 0.1% per update — tight circuit breaker)
 *   Larger values are less restrictive. 0 = disabled.
 *
 * Authentication: requires x-admin-secret header matching ADMIN_API_SECRET env var.
 * If ADMIN_API_SECRET is unset or whitespace-only, all requests are rejected (401).
 *
 * CONFIG-001 (Defense-in-Depth — Secret Rotation):
 * The ADMIN_API_SECRET is stored as a Vercel environment variable for simplicity.
 * While the endpoint is secure (timing-safe comparison, generic error messages),
 * consider these best practices for production:
 *
 * 1. REGULAR ROTATION: Rotate ADMIN_API_SECRET every 30-90 days via Vercel console
 *    - Go to Settings → Environment Variables
 *    - Update ADMIN_API_SECRET with a new random value
 *    - Vercel will redeploy automatically
 *
 * 2. USING SECRETS MANAGER (Optional): For higher security, use a secrets vault:
 *    - AWS Secrets Manager, Vault, or similar
 *    - Fetch secret at runtime instead of from env var
 *    - Reduces time window of exposure if system is compromised
 *
 * 3. AUDIT LOGGING: Log all price-cap changes (slabAddress, oldValue, newValue)
 *    in the markets table for audit trail
 *
 * 4. LEAST PRIVILEGE: Only expose this endpoint to authorized admin systems
 *    (e.g., rate-limit or IP-allow-list clients)
 *
 * Requires:
 *   - CRANK_KEYPAIR — JSON or base58 secret key (oracle authority keypair)
 *   - ADMIN_API_SECRET — shared secret for this endpoint (rotate periodically)
 *   - NEXT_PUBLIC_SOLANA_RPC_URL or HELIUS_API_KEY for RPC
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  encodeSetOraclePriceCap,
  buildIx,
  buildAccountMetas,
  ACCOUNTS_SET_ORACLE_PRICE_CAP,
} from "@percolatorct/sdk";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Default circuit-breaker: 1_000 e2bps = 10 bps = 0.1% max change per oracle update.
// Tight enough to stop price manipulation while allowing normal market moves.
const DEFAULT_MAX_CHANGE_E2BPS = 1_000n;

/** Load crank keypair from CRANK_KEYPAIR (JSON array format only — same as advance-phase). */
function loadCrankKeypair(): Keypair | null {
  const raw = process.env.CRANK_KEYPAIR;
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    return null;
  }
}

/** Timing-safe auth check. Empty ADMIN_API_SECRET must deny (GH#1692 follow-up). */
function isAuthorized(req: NextRequest): boolean {
  const secret = (process.env.ADMIN_API_SECRET ?? "").trim();
  if (!secret) return false;
  const provided = req.headers.get("x-admin-secret") ?? "";
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  // GH#1692: timing-safe auth
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const keypair = loadCrankKeypair();
  if (!keypair) {
    return NextResponse.json(
      { error: "CRANK_KEYPAIR not configured" },
      { status: 503 },
    );
  }

  let body: { slabAddress?: string; maxChangeE2bps?: number } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is valid — means "all admin-oracle markets"
  }

  let maxChangeE2bps: bigint;
  if (body.maxChangeE2bps != null) {
    const raw = body.maxChangeE2bps;
    if (typeof raw === "number") {
      if (!Number.isInteger(raw) || raw < 0) {
        return NextResponse.json(
          { error: "maxChangeE2bps must be a non-negative integer" },
          { status: 400 },
        );
      }
      maxChangeE2bps = BigInt(raw);
    } else if (typeof raw === "string" && /^\d+$/.test(raw)) {
      const parsed = BigInt(raw);
      if (parsed > 0xffff_ffff_ffff_ffffn) {
        return NextResponse.json(
          { error: "maxChangeE2bps exceeds u64 max" },
          { status: 400 },
        );
      }
      maxChangeE2bps = parsed;
    } else {
      return NextResponse.json(
        { error: "maxChangeE2bps must be a non-negative integer" },
        { status: 400 },
      );
    }
  } else {
    maxChangeE2bps = DEFAULT_MAX_CHANGE_E2BPS;
  }

  const config = getConfig();
  const programId = new PublicKey(config.programId);
  const connection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? config.rpcUrl,
    "confirmed",
  );

  // Determine which slabs to apply the cap to
  let slabAddresses: string[] = [];

  if (body.slabAddress) {
    slabAddresses = [body.slabAddress];
  } else {
    // Fetch all admin-oracle markets from DB where oracle_authority == our crank pubkey
    try {
      const supabase = getServiceClient();
      const { data, error } = await supabase
        .from("markets")
        .select("slab_address, oracle_authority, symbol")
        .not("oracle_authority", "is", null);

      if (error) {
        console.error("[set-price-cap] Supabase query failed:", error);
        return NextResponse.json({ error: "DB error" }, { status: 500 });
      }

      const ourPubkey = keypair.publicKey.toBase58();
      slabAddresses = (data ?? [])
        .filter((m: { oracle_authority: string | null }) =>
          m.oracle_authority === ourPubkey,
        )
        .map((m: { slab_address: string }) => m.slab_address);

      console.info(`[set-price-cap] Found ${slabAddresses.length} admin-oracle markets to cap`);
    } catch (err) {
      console.error("[set-price-cap] Error fetching markets:", err);
      return NextResponse.json({ error: "Failed to fetch markets" }, { status: 500 });
    }
  }

  if (slabAddresses.length === 0) {
    return NextResponse.json({
      ok: true,
      applied: 0,
      message: "No admin-oracle markets found for this crank keypair",
    });
  }

  const results: Array<{ slabAddress: string; status: "ok" | "error"; signature?: string; error?: string }> = [];

  for (const slabAddress of slabAddresses) {
    try {
      const slabPubkey = new PublicKey(slabAddress);

      const data = encodeSetOraclePriceCap({ maxChangeE2bps });
      const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_PRICE_CAP, [
        keypair.publicKey,
        slabPubkey,
      ]);
      const ix = buildIx({ programId, keys, data });

      const tx = new Transaction();
      tx.add(
        // v17 wrapper installs a custom 128KB heap allocator and aborts unless the
        // tx requests the full heap frame. Must be the FIRST instruction. (issue #176)
        ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
        ix,
      );

      const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
        commitment: "confirmed",
        maxRetries: 3,
      });

      console.info(`[set-price-cap] Applied to ${slabAddress}: ${sig}`);
      results.push({ slabAddress, status: "ok", signature: sig });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[set-price-cap] Failed for ${slabAddress}:`, msg);
      results.push({ slabAddress, status: "error", error: "Price cap update failed." });
    }
  }

  const applied = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "error").length;

  return NextResponse.json({
    ok: failed === 0,
    applied,
    failed,
    maxChangeE2bps: maxChangeE2bps.toString(),
    results,
  });
}

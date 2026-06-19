/**
 * GH#1120: Server-side AdvanceOraclePhase crank
 *
 * POST /api/oracle/advance-phase
 * Body: { slabAddress: string }
 *
 * Sends an AdvanceOraclePhase transaction signed by the server-side crank
 * keypair (CRANK_KEYPAIR) — NOT the user's wallet. This removes the Privy
 * "Confirm transaction" modal that was firing on every trade page load.
 *
 * AdvanceOraclePhase is a permissionless instruction (any fee payer works).
 * Only runs on devnet; silently no-ops when network is not devnet (see env vars below).
 *
 * PERC-799 / GH#1124: Rate limited to 60 req/IP/min (Upstash or in-memory).
 * PERC-799 / GH#1125: CRANK_KEYPAIR is required — no fallback to mint authority.
 *
 * Requires:
 *   - CRANK_KEYPAIR — JSON secret key bytes array (dedicated low-privilege keypair)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  encodeAdvanceOraclePhase,
  buildIx,
  buildAccountMetas,
  ACCOUNTS_ADVANCE_ORACLE_PHASE,
} from "@percolatorct/sdk";
import { getConfig } from "@/lib/config";
import {
  checkAdvancePhaseRateLimit,
  ADVANCE_PHASE_RATE_LIMIT,
} from "@/lib/advance-phase-rate-limit";
import { getClientIp } from "@/lib/get-client-ip";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

/**
 * GH#1125: Load the dedicated crank keypair from CRANK_KEYPAIR only.
 * The DEVNET_MINT_AUTHORITY_KEYPAIR fallback has been removed — the mint
 * authority key must not double as a crank key. If CRANK_KEYPAIR is not set,
 * return null so the caller can skip gracefully (the endpoint is non-critical).
 */
function loadCrankKeypair(): Keypair | null {
  const raw = process.env.CRANK_KEYPAIR;
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    return null;
  }
}

function isValidBase58(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

export async function POST(req: NextRequest) {
  // Only active on devnet — align with NEXT_PUBLIC_DEFAULT_NETWORK first (GH#1375 / auto-fund).
  const network =
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
    process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
  if (network !== "devnet") {
    return NextResponse.json({ skipped: true, reason: "not devnet" });
  }

  // ── GH#1124: Rate limit — 60 req/IP/min ───────────────────────────────
  const clientIp = getClientIp(req);
  const rl = await checkAdvancePhaseRateLimit(clientIp);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded — max 60 advance-phase requests per minute" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.retryAfterSecs),
          "X-RateLimit-Limit": String(ADVANCE_PHASE_RATE_LIMIT),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.max(0, rl.retryAfterSecs)),
        },
      },
    );
  }

  let slabAddress: string;
  try {
    const body = await req.json();
    slabAddress = body?.slabAddress ?? "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!slabAddress || !isValidBase58(slabAddress)) {
    return NextResponse.json({ error: "slabAddress required (valid base58)" }, { status: 400 });
  }

  const crankKp = loadCrankKeypair();
  if (!crankKp) {
    // CRANK_KEYPAIR not configured on this deployment — skip gracefully.
    // This is not an error state; the keeper bot handles cranking when the
    // env var is absent (e.g. preview deployments).
    return NextResponse.json({ skipped: true, reason: "no crank keypair configured" });
  }

  try {
    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, "confirmed");
    const slab = new PublicKey(slabAddress);

    // Determine program ID — try NEXT_PUBLIC_PROGRAM_ID, fall back to known large-tier program
    const programIdStr =
      process.env.NEXT_PUBLIC_PROGRAM_ID ??
      "FxfD37s1NC7CDPMPzqgSfLsiJxjYRjfQDsV1CRuW9dBH"; // large-tier devnet default
    const programId = new PublicKey(programIdStr);

    const data = encodeAdvanceOraclePhase();
    const keys = buildAccountMetas(ACCOUNTS_ADVANCE_ORACLE_PHASE, [slab]);
    const ix = buildIx({ programId, keys, data });

    const tx = new Transaction().add(
      // AdvanceOraclePhase is a wrapper-program instruction. The v17 wrapper installs
      // a custom 128KB heap allocator and aborts unless the tx requests the full heap
      // frame. Must be the FIRST instruction. (issue #176)
      ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      ix,
    );
    tx.feePayer = crankKp.publicKey;

    const sig = await sendAndConfirmTransaction(connection, tx, [crankKp], {
      commitment: "confirmed",
      skipPreflight: true,
    });

    return NextResponse.json({ success: true, signature: sig });
  } catch (err) {
    // Expected failure: market not ready for phase advance — on-chain program returns error
    // Treat as non-critical; do not spam Sentry for expected no-ops
    const msg = err instanceof Error ? err.message : String(err);
    const isExpected =
      msg.includes("custom program error") ||
      msg.includes("0x") ||
      msg.includes("Transaction simulation failed");

    if (!isExpected) {
      Sentry.captureException(err, {
        extra: { slabAddress, context: "advance-phase-crank" },
      });
    }

    return NextResponse.json({ success: false, skipped: true, reason: "Oracle phase advance failed." });
  }
}

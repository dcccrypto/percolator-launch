/**
 * PERC-465: Oracle Keeper Market Registration
 *
 * POST /api/oracle-keeper/register
 * Body: { slabAddress: string, mainnetCA: string, devnetMint?: string, symbol?: string }
 *
 * Two-step registration:
 *   1. Write mainnet_ca to Supabase markets table so future queries can look up price by CA
 *   2. Hot-register with the keeper service (/register) so price push starts within ~30s
 *      without waiting for the next discovery cycle
 *
 * The keeper service URL is read from KEEPER_INTERNAL_URL env (default: http://localhost:8081).
 * Non-fatal if keeper is unreachable — market will be auto-discovered on next cycle.
 *
 * KEEPER_REGISTER_SECRET is trimmed; empty or whitespace-only disables the route (503).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { PublicKey } from "@solana/web3.js";
import { signKeeperRequest, verifyKeeperSignature } from "@/lib/keeper-hmac";

export const dynamic = "force-dynamic";

const _rawKeeperUrl = process.env.KEEPER_INTERNAL_URL ?? "http://localhost:8081";
// LAUNCH-16: Allow http:// only for loopback (localhost / 127.0.0.1); remote targets must use https://.
// Checked at module load so a misconfigured deployment surfaces at startup rather than at request time.
const _isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?($|\/)/.test(_rawKeeperUrl);
if (!_isLoopback && !_rawKeeperUrl.startsWith("https://")) {
  throw new Error(
    `KEEPER_INTERNAL_URL must be https:// or a loopback address — plaintext remote URL would expose KEEPER_REGISTER_SECRET: "${_rawKeeperUrl}"`,
  );
}
const KEEPER_URL = _rawKeeperUrl;
/** Trimmed — whitespace-only env counts as unset (same idea as set-price-cap / ADMIN_API_SECRET). */
const REGISTER_SECRET = (process.env.KEEPER_REGISTER_SECRET ?? "").trim();

export async function POST(req: NextRequest) {
  // Auth: require shared secret to prevent unauthorized oracle source manipulation (#780)
  if (!REGISTER_SECRET) {
    console.error("[oracle-keeper/register] KEEPER_REGISTER_SECRET not configured — endpoint disabled");
    return NextResponse.json({ error: "Endpoint not configured" }, { status: 503 });
  }

  // Read the raw body once — the HMAC signature (LAUNCH-16) is computed over the exact
  // bytes the caller sent, so it must be verified before (and independently of) JSON.parse.
  const rawBody = await req.text();

  // LAUNCH-16: HMAC-SHA256(REGISTER_SECRET, "<timestamp>.<rawBody>") replaces the raw
  // x-keeper-secret header — the credential itself never appears on the wire. Verification
  // is timing-safe and rejects stale/replayed signatures (see verifyKeeperSignature).
  // #2476: the signature is bound to THIS method and path, so one issued for
  // another route sharing the secret no longer verifies here.
  const signed = verifyKeeperSignature(
    REGISTER_SECRET,
    req.headers.get("x-keeper-timestamp"),
    rawBody,
    req.headers.get("x-keeper-signature"),
    { method: "POST", path: "/api/oracle-keeper/register" },
  );
  if (!signed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { slabAddress, mainnetCA, devnetMint, symbol } = body as {
      slabAddress?: string;
      mainnetCA?: string;
      devnetMint?: string;
      symbol?: string;
    };

    if (!slabAddress || typeof slabAddress !== "string") {
      return NextResponse.json({ error: "slabAddress is required" }, { status: 400 });
    }
    if (!mainnetCA || typeof mainnetCA !== "string") {
      return NextResponse.json({ error: "mainnetCA is required" }, { status: 400 });
    }

    // Validate Solana addresses
    try { new PublicKey(slabAddress); } catch {
      return NextResponse.json({ error: "Invalid slabAddress" }, { status: 400 });
    }
    try { new PublicKey(mainnetCA); } catch {
      return NextResponse.json({ error: "Invalid mainnetCA" }, { status: 400 });
    }
    if (devnetMint) {
      try { new PublicKey(devnetMint); } catch {
        return NextResponse.json({ error: "Invalid devnetMint" }, { status: 400 });
      }
    }

    // Step 1: Write mainnet_ca to Supabase so oracle service can look up the token price
    let dbResult: { slab_address: string; mainnet_ca: string | null; symbol?: string } | null = null;
    try {
      const supabase = getServiceClient();
      const { data, error } = await supabase
        .from("markets")
        .update({
          mainnet_ca: mainnetCA,
        })
        .eq("slab_address", slabAddress)
        .select("slab_address, mainnet_ca, symbol")
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          return NextResponse.json(
            { error: "Market not found in DB. Ensure /api/markets was called first." },
            { status: 404 },
          );
        }
        console.error("[oracle-keeper/register] Supabase update error:", error);
        return NextResponse.json({ error: "Failed to update market in DB" }, { status: 500 });
      }
      dbResult = data;
    } catch (dbErr) {
      console.error("[oracle-keeper/register] DB error:", dbErr);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    // Step 2: Hot-register with the keeper service so it starts cranking immediately.
    // Non-fatal — market will be picked up on next discovery cycle if keeper is unreachable.
    let keeperRegistered = false;
    let keeperMessage = "Keeper unreachable — market will auto-discover on next cycle";
    try {
      // LAUNCH-16: Sign the request with HMAC-SHA256 instead of forwarding the raw secret.
      // The keeper verifies: HMAC-SHA256(REGISTER_SECRET, "<timestamp>.<body>") == x-keeper-signature.
      // This means the raw credential is never sent on the wire regardless of URL scheme.
      const keeperPayload = JSON.stringify({ slabAddress, mainnetCA });
      const { timestamp: keeperTimestamp, signature: keeperSig } = signKeeperRequest(REGISTER_SECRET, keeperPayload, {
          // #2533: the keeper now VERIFIES this HMAC (percolator-keeper#447,
          // src/lib/register-auth.ts), so this binding is live rather than
          // aspirational. The keeper computes the same signed string —
          // [timestamp, METHOD, path, rawBody].join("\n") — and still accepts
          // x-shared-secret for operators. Keep the method/path below in lockstep
          // with that module: a mismatch fails closed, but it fails closed at
          // market-creation time, which is how #2533 hid for as long as it did.
          method: "POST",
          path: "/register",
        });

      const keeperResp = await fetch(`${KEEPER_URL}/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-keeper-timestamp": keeperTimestamp,
          "x-keeper-signature": keeperSig,
        },
        body: keeperPayload,
        signal: AbortSignal.timeout(8_000),
      });
      const keeperData = (await keeperResp.json()) as { success: boolean; message: string };
      keeperRegistered = keeperData.success;
      keeperMessage = keeperData.message;
      if (!keeperRegistered) {
        console.warn("[oracle-keeper/register] Keeper registration failed:", keeperMessage);
      }
    } catch (keeperErr) {
      // Non-fatal — log and continue
      console.warn(
        "[oracle-keeper/register] Keeper unreachable:",
        keeperErr instanceof Error ? keeperErr.message : String(keeperErr),
      );
    }

    return NextResponse.json({
      status: "registered",
      slabAddress: dbResult?.slab_address ?? slabAddress,
      mainnetCA: dbResult?.mainnet_ca ?? mainnetCA,
      symbol: dbResult?.symbol ?? symbol,
      keeper: { registered: keeperRegistered, message: keeperMessage },
    });
  } catch (error) {
    console.error("[oracle-keeper/register] Unhandled error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

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
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";

const KEEPER_URL = process.env.KEEPER_INTERNAL_URL ?? "http://localhost:8081";
const REGISTER_SECRET = process.env.KEEPER_REGISTER_SECRET ?? "";

export async function POST(req: NextRequest) {
  // Auth: require shared secret to prevent unauthorized oracle source manipulation (#780)
  if (!REGISTER_SECRET) {
    console.error("[oracle-keeper/register] KEEPER_REGISTER_SECRET not configured — endpoint disabled");
    return NextResponse.json({ error: "Endpoint not configured" }, { status: 503 });
  }
  const authHeader = req.headers.get("x-keeper-secret") ?? "";
  if (authHeader !== REGISTER_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
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
    let dbResult: { slab_address: string; mainnet_ca: string; symbol?: string } | null = null;
    try {
      const supabase = getServiceClient();
      const { data, error } = await (supabase as any)
        .from("markets")
        .update({
          mainnet_ca: mainnetCA,
          ...(devnetMint ? { devnet_mint: devnetMint } : {}),
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
      const keeperResp = await fetch(`${KEEPER_URL}/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Forward shared secret so keeper's defense-in-depth auth passes (#780)
          "x-shared-secret": REGISTER_SECRET,
        },
        body: JSON.stringify({ slabAddress, mainnetCA }),
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

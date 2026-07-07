/**
 * POST /api/playground/keeper-register
 *
 * Register a newly-created playground market so the oracle keeper starts pricing it.
 *
 * The keeper (dcccrypto/percolator-oracle-keeper feat/cross-cluster-keeper) runs on a
 * NAT'd Mac mini — it can only make OUTBOUND calls, so this Vercel app can't POST to it
 * directly. Instead this route persists the registration to a Vercel Blob JSON store
 * (see lib/playground-registered-markets.ts); the keeper polls
 * GET /api/playground/registered-markets outbound on its own interval and adds any
 * market it doesn't already know about. v17 has no on-chain feed_id, so this payload
 * is the only place the market↔pool binding is recorded.
 *
 * This route:
 *   1. Validates the request (devnet-only, pubkey shapes, dexType allow-list).
 *   2. Upserts { slabAddress, marketAddress, poolAddress, dexType, symbol, label,
 *      mainnetCA, collateral, registeredAt } into the blob, keyed by slabAddress.
 *   3. Returns { ok: true, registered: true, ... } on success, or a 502 with a clear
 *      message if the Blob write fails (never throws uncaught — market creation
 *      itself already landed on-chain regardless of this route's outcome).
 *
 * Body: {
 *   slabAddress:    string  — devnet market account
 *   mainnetCA:      string  — mainnet token CA (for keeper labelling)
 *   dexPoolAddress: string  — mainnet DEX pool address
 *   dexType:        string  — "raydium-clmm" | "meteora-dlmm" | "pumpswap"
 *   symbol?:        string  — token symbol (e.g. "SOL")
 *   label?:         string  — human label (e.g. "SOL/USDC — Raydium CLMM")
 * }
 *
 * Environment:
 *   BLOB_READ_WRITE_TOKEN — read automatically by the @vercel/blob SDK (Vercel-managed).
 */

import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import type { RegisteredMarket } from "@/lib/playground-registered-markets";
import { upsertRegisteredMarket } from "@/lib/playground-registered-markets";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();

const VALID_DEX_TYPES = new Set(["raydium-clmm", "meteora-dlmm", "pumpswap"]);

/** sim-USDC — the single collateral mint shared by every playground market. */
const PLAYGROUND_COLLATERAL_MINT = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

export async function POST(req: NextRequest) {
  if (NETWORK !== "devnet") {
    return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { slabAddress, mainnetCA, dexPoolAddress, dexType, symbol, label } = body as {
    slabAddress?: string;
    mainnetCA?: string;
    dexPoolAddress?: string;
    dexType?: string;
    symbol?: string;
    label?: string;
  };

  if (!slabAddress) return NextResponse.json({ error: "slabAddress required" }, { status: 400 });
  if (!dexPoolAddress) return NextResponse.json({ error: "dexPoolAddress required" }, { status: 400 });
  if (!dexType || !VALID_DEX_TYPES.has(dexType)) {
    return NextResponse.json(
      { error: `dexType must be one of: ${[...VALID_DEX_TYPES].join(", ")}` },
      { status: 400 },
    );
  }

  // Validate addresses
  try { new PublicKey(slabAddress); } catch {
    return NextResponse.json({ error: "Invalid slabAddress" }, { status: 400 });
  }
  try { new PublicKey(dexPoolAddress); } catch {
    return NextResponse.json({ error: "Invalid dexPoolAddress" }, { status: 400 });
  }
  if (mainnetCA) {
    try { new PublicKey(mainnetCA); } catch {
      return NextResponse.json({ error: "Invalid mainnetCA" }, { status: 400 });
    }
  }

  const resolvedLabel = label ?? (symbol ? `${symbol}/USDC — ${dexType}` : `${slabAddress.slice(0, 8)}… — ${dexType}`);

  const entry: RegisteredMarket = {
    slabAddress,
    marketAddress: slabAddress,
    poolAddress: dexPoolAddress,
    dexType,
    symbol: symbol ?? null,
    label: resolvedLabel,
    mainnetCA: mainnetCA ?? null,
    collateral: PLAYGROUND_COLLATERAL_MINT,
    registeredAt: Date.now(),
  };

  try {
    await upsertRegisteredMarket(entry);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[playground/keeper-register] Blob write failed:", detail);
    return NextResponse.json(
      {
        ok: false,
        registered: false,
        error: "Failed to persist market registration to Blob store",
        detail,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    // Kept alongside `ok` for backward compatibility with the existing
    // hooks/useCreateMarket.ts caller (registered/message drive its UI copy).
    registered: true,
    message: "Registered — the keeper will pick this up on its next poll (~30s)",
    slabAddress,
    dexPoolAddress,
    dexType,
    label: resolvedLabel,
  });
}

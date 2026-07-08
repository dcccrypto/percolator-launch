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
 *   1. Validates the request (devnet-only, pubkey shapes).
 *   2. Resolves the dexType AUTHORITATIVELY by classifying the pool account's
 *      mainnet owner program (CLMM/DLMM/PumpSwap program ids) — the client
 *      string is only a fallback when mainnet RPC is unreachable. This also
 *      verifies the pool actually exists on mainnet before the keeper is
 *      pointed at it.
 *   3. Upserts { slabAddress, marketAddress, poolAddress, dexType, symbol, label,
 *      mainnetCA, collateral, registeredAt } into the blob, keyed by slabAddress.
 *   4. Returns { ok: true, registered: true, ... } on success, or a 502 with a clear
 *      message if the Blob write fails (never throws uncaught — market creation
 *      itself already landed on-chain regardless of this route's outcome).
 *
 * Body: {
 *   slabAddress:    string  — devnet market account
 *   mainnetCA:      string  — mainnet token CA (for keeper labelling)
 *   dexPoolAddress: string  — mainnet DEX pool address
 *   dexType:        string  — hint; DexScreener dexIds accepted ("meteora",
 *                             "raydium", …) — see lib/dex-type.ts
 *   symbol?:        string  — token symbol (e.g. "SOL")
 *   label?:         string  — human label (e.g. "SOL/USDC — Raydium CLMM")
 * }
 *
 * Environment:
 *   BLOB_READ_WRITE_TOKEN — read automatically by the @vercel/blob SDK (Vercel-managed).
 */

import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import type { RegisteredMarket } from "@/lib/playground-registered-markets";
import { upsertRegisteredMarket } from "@/lib/playground-registered-markets";
import { normalizeDexType, KEEPER_DEX_TYPES, type KeeperDexType } from "@/lib/dex-type";

export const dynamic = "force-dynamic";

/** Mainnet DEX program → keeper dexType. The AUTHORITATIVE classification:
 *  the keeper parses the pool with the layout this type names, so the binding
 *  must come from the pool account's owner program, not from a client string.
 *  (DexScreener reports "meteora" for both DLMM and DAMM pools and "raydium"
 *  for CLMM and CPMM — trusting it risks handing the keeper a pool whose byte
 *  layout doesn't match its parser.) Verified against the curated playground
 *  pools: SOL→CAMM (CLMM), JUP/TRUMP/PENGU→LBUZ (DLMM).
 */
const DEX_PROGRAM_TO_TYPE: Record<string, KeeperDexType> = {
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium-clmm", // Raydium Concentrated Liquidity
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora-dlmm", // Meteora DLMM
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap", // PumpSwap AMM
};

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";

/** Classify a mainnet pool by its owner program.
 *  Returns a dexType, "unsupported" (account exists under an unknown program),
 *  "missing" (no such account on mainnet), or "rpc-failed" (couldn't check —
 *  callers fall back to the client-supplied string). One getAccountInfo call. */
async function classifyPoolByOwner(
  poolAddress: string,
): Promise<KeeperDexType | "unsupported" | "missing" | "rpc-failed"> {
  try {
    const conn = new Connection(MAINNET_RPC_URL, "confirmed");
    const info = await Promise.race([
      conn.getAccountInfo(new PublicKey(poolAddress)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("mainnet RPC timeout")), 8_000)),
    ]);
    if (!info) return "missing";
    return DEX_PROGRAM_TO_TYPE[info.owner.toBase58()] ?? "unsupported";
  } catch {
    return "rpc-failed";
  }
}

const NETWORK = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();

// Alias-tolerant: the wizard passes DexScreener dexIds ("meteora", "raydium")
// which normalizeDexType maps into the keeper vocabulary. Rejecting raw ids
// here silently orphaned every Meteora/Raydium-pool market (no keeper price,
// no name, invisible on /markets) because the wizard treats registration
// failures as non-fatal.

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

  // Resolve the dexType. Authoritative: classify the pool by its mainnet owner
  // program. Fallback (mainnet RPC unreachable): normalize the client string —
  // alias-tolerant, since the wizard passes DexScreener dexIds ("meteora",
  // "raydium") that previously 400'd here and silently orphaned the market
  // (wizard treats registration as non-fatal → market live on-chain, but no
  // keeper price, no name, invisible on /markets).
  let normalizedDexType: KeeperDexType;
  const classified = await classifyPoolByOwner(dexPoolAddress);
  if (classified === "missing") {
    return NextResponse.json(
      { error: `dexPoolAddress ${dexPoolAddress} does not exist on mainnet` },
      { status: 400 },
    );
  }
  if (classified === "unsupported") {
    return NextResponse.json(
      { error: `dexPoolAddress is owned by an unsupported DEX program — the keeper can only price ${KEEPER_DEX_TYPES.join(", ")} pools` },
      { status: 400 },
    );
  }
  if (classified === "rpc-failed") {
    const fromString = normalizeDexType(dexType);
    if (!fromString) {
      return NextResponse.json(
        { error: `Could not verify the pool on mainnet, and dexType "${dexType ?? ""}" does not map to any of: ${KEEPER_DEX_TYPES.join(", ")}` },
        { status: 502 },
      );
    }
    normalizedDexType = fromString;
  } else {
    normalizedDexType = classified;
  }

  const resolvedLabel = label ?? (symbol ? `${symbol}/USDC — ${normalizedDexType}` : `${slabAddress.slice(0, 8)}… — ${normalizedDexType}`);

  const entry: RegisteredMarket = {
    slabAddress,
    marketAddress: slabAddress,
    poolAddress: dexPoolAddress,
    dexType: normalizedDexType,
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
    dexType: normalizedDexType,
    label: resolvedLabel,
  });
}

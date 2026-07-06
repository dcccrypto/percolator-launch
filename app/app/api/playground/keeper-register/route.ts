/**
 * POST /api/playground/keeper-register
 *
 * Register a newly-created playground market with the oracle keeper service
 * so price-push starts immediately.
 *
 * The keeper service (dcccrypto/percolator-oracle-keeper feat/cross-cluster-keeper)
 * stores market→pool mappings in registry.json and reads mainnet DEX prices every
 * cycle, pushing them as PushAuthMark to each registered devnet market.
 *
 * This route:
 *   1. POSTs { marketAddress, poolAddress, dexType, label, assetIndex } to the
 *      keeper service's /playground/register endpoint.
 *   2. If the keeper is unreachable, returns { registered: false } — non-fatal.
 *      The caller should notify the user that prices will start on next keeper cycle.
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
 * Keeper service contract (POST KEEPER_INTERNAL_URL/playground/register):
 * {
 *   marketAddress: string,
 *   poolAddress:   string,
 *   dexType:       string,
 *   assetIndex:    number (0),
 *   label:         string,
 * }
 * Expected response: { success: boolean, message: string }
 *
 * Environment:
 *   KEEPER_INTERNAL_URL     — keeper service base URL (default: http://localhost:8081)
 *   KEEPER_REGISTER_SECRET  — shared secret for keeper auth (same as oracle-keeper/register)
 */

import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { signKeeperRequest } from "@/lib/keeper-hmac";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
const KEEPER_URL = (process.env.KEEPER_INTERNAL_URL ?? "http://localhost:8081").replace(/\/$/, "");
const KEEPER_SECRET = (process.env.KEEPER_REGISTER_SECRET ?? "").trim();

const VALID_DEX_TYPES = new Set(["raydium-clmm", "meteora-dlmm", "pumpswap"]);

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

  // POST to keeper service
  let registered = false;
  let message = "Keeper unreachable — market will appear after next keeper restart (check KEEPER_INTERNAL_URL)";

  try {
    const keeperBody = JSON.stringify({
      marketAddress: slabAddress,
      poolAddress: dexPoolAddress,
      dexType,
      assetIndex: 0,
      label: resolvedLabel,
      mainnetCA: mainnetCA ?? null,
    });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (KEEPER_SECRET) {
      // LAUNCH-16: sign instead of forwarding the raw shared secret (same HMAC-SHA256
      // scheme as /api/oracle-keeper/register) — the credential never appears on the wire.
      const { timestamp, signature } = signKeeperRequest(KEEPER_SECRET, keeperBody);
      headers["x-keeper-timestamp"] = timestamp;
      headers["x-keeper-signature"] = signature;
    }

    const keeperResp = await fetch(`${KEEPER_URL}/playground/register`, {
      method: "POST",
      headers,
      body: keeperBody,
      signal: AbortSignal.timeout(8_000),
    });

    if (keeperResp.ok) {
      const data = (await keeperResp.json()) as { success?: boolean; message?: string };
      registered = data.success ?? false;
      message = data.message ?? "Registered";
    } else {
      const errText = await keeperResp.text().catch(() => keeperResp.statusText);
      message = `Keeper returned ${keeperResp.status}: ${errText.slice(0, 200)}`;
      console.warn("[playground/keeper-register] Keeper error:", message);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn("[playground/keeper-register] Keeper unreachable:", detail);
    // Non-fatal — leave registered=false
  }

  return NextResponse.json({
    registered,
    message,
    slabAddress,
    dexPoolAddress,
    dexType,
    label: resolvedLabel,
  });
}

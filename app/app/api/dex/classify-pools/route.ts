/**
 * POST /api/dex/classify-pools  { addresses: string[] (<= 20) }
 *   -> 200 { classes: { [address]: "meteora-dlmm" | "pumpswap" | "raydium-clmm" | "unsupported" | "missing"
 *                          | "non-usd-quote" | "below-liquidity-floor" } }
 *   ("below-liquidity-floor": PumpSwap pool under the keeper's MIN_POOL_LIQUIDITY_USD, lib/pool-liquidity)
 *   -> 503 when mainnet could not be reached (the wizard must not offer unverified pools)
 *
 * The wizard's pool search (hooks/useDexPoolSearch) calls this so it only OFFERS pools
 * the keeper can price, labelled by their real type. Classification is by the pool
 * account's mainnet owner program (lib/dex-pool-owner.ts), the same check
 * keeper-register enforces. E2E B21: DexScreener's "meteora" covers DLMM and DAMM v1.
 */
import { NextRequest, NextResponse } from "next/server";
import { classifyPoolsByOwner, MAX_CLASSIFY_POOLS } from "@/lib/dex-pool-owner";
import { createMemoryRateLimiter } from "@/lib/memory-rate-limit";
import { getClientIp } from "@/lib/get-client-ip";

export const dynamic = "force-dynamic";

const limiter = createMemoryRateLimiter({ limit: 30, windowMs: 60_000 });
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(req: NextRequest) {
  if (limiter.isLimited(getClientIp(req))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": "10" } });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const addresses = (body as { addresses?: unknown }).addresses;
  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.length > MAX_CLASSIFY_POOLS ||
    !addresses.every((a): a is string => typeof a === "string" && BASE58.test(a))
  ) {
    return NextResponse.json({ error: `addresses must be 1-${MAX_CLASSIFY_POOLS} base58 pool addresses` }, { status: 400 });
  }
  const classes = await classifyPoolsByOwner(Array.from(new Set(addresses)));
  if (!classes) {
    return NextResponse.json(
      { error: "Couldn't verify pools on mainnet right now" },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
  return NextResponse.json({ classes });
}

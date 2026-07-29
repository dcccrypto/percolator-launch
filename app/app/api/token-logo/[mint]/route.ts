import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { resolveTokenLogo } from "@/lib/token-logo";

/**
 * GET /api/token-logo/[mint]
 *
 * Resolves a real token logo from the DEX by **mainnet contract address**, so
 * markets whose `logo_url` was never explicitly uploaded still show the
 * coin's actual image instead of the symbol-initials placeholder.
 *
 * Resolution order:
 *   1. GeckoTerminal `networks/solana/tokens/{mint}` → attributes.image_url
 *      (best coverage for established tokens — SOL, JUP, TRUMP, PENGU, etc.)
 *   2. DexScreener `latest/dex/tokens/{mint}` → the base-token pair's
 *      `info.imageUrl` (covers pump.fun and other community-launched tokens
 *      GeckoTerminal doesn't have yet — mirrors the DexScreener fallback
 *      already used for symbol/name resolution in lib/tokenMeta.ts).
 *   3. `{ logoUrl: null }` — caller falls back to the initials placeholder.
 *
 * Cached at the edge for 24h (`s-maxage=86400`) — logos change rarely and
 * this keeps us well under both APIs' free-tier rate limits.
 */

export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600",
} as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ mint: string }> },
) {
  const { mint } = await params;

  let canonicalMint: string;
  try {
    canonicalMint = new PublicKey(mint).toBase58();
  } catch {
    return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
  }

  // Single implementation, shared with market registration — see lib/token-logo.ts.
  const logoUrl = await resolveTokenLogo(canonicalMint);
  return NextResponse.json({ logoUrl }, { headers: CACHE_HEADERS });
}

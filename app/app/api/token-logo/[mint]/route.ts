import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

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

/** GeckoTerminal's placeholder for tokens with no known logo. Treat as null. */
function isPlaceholderImage(url: string | null | undefined): boolean {
  if (!url) return true;
  return /missing[_-]?(large|small|thumb)?\.png/i.test(url);
}

/** Try GeckoTerminal — best coverage for established/listed tokens. */
async function fetchViaGeckoTerminal(mint: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`,
      { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const imageUrl = json?.data?.attributes?.image_url as string | null | undefined;
    if (isPlaceholderImage(imageUrl)) return null;
    return imageUrl as string;
  } catch {
    return null;
  }
}

/** Fall back to DexScreener — covers pump.fun and other community tokens. */
async function fetchViaDexScreener(mint: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const pairs: Array<{
      baseToken?: { address?: string };
      info?: { imageUrl?: string };
      liquidity?: { usd?: number };
    }> = Array.isArray(json?.pairs) ? json.pairs : [];
    if (pairs.length === 0) return null;

    // Prefer pairs where the queried mint is the base token (the searched
    // token's own image, not a paired quote token's), then pick the
    // highest-liquidity pair with an image.
    const candidates = pairs
      .filter((p) => !p.baseToken?.address || p.baseToken.address === mint)
      .filter((p) => !isPlaceholderImage(p.info?.imageUrl));
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    return candidates[0].info?.imageUrl ?? null;
  } catch {
    return null;
  }
}

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

  const geckoLogo = await fetchViaGeckoTerminal(canonicalMint);
  if (geckoLogo) {
    return NextResponse.json({ logoUrl: geckoLogo }, { headers: CACHE_HEADERS });
  }

  const dexLogo = await fetchViaDexScreener(canonicalMint);
  return NextResponse.json({ logoUrl: dexLogo ?? null }, { headers: CACHE_HEADERS });
}

/**
 * resolveTokenLogo — find a token's real image by mainnet contract address.
 *
 * Extracted from app/api/token-logo/[mint]/route.ts so market REGISTRATION can
 * resolve a logo inline instead of leaving it null.
 *
 * Why that matters: the wizard never sends logo_url, so a freshly launched
 * market used to appear with the initials placeholder and only gain its real
 * image when the indexer's metadata pass next ran — up to 10 minutes later.
 * Resolving here makes the logo present on the very first render of the
 * markets page.
 *
 * Resolution order:
 *   1. GeckoTerminal networks/solana/tokens/{mint} → attributes.image_url
 *      (best coverage for established tokens — SOL, JUP, TRUMP, PENGU…)
 *   2. DexScreener latest/dex/tokens/{mint} → the base-token pair's
 *      info.imageUrl (covers pump.fun and other community-launched tokens
 *      GeckoTerminal does not have yet)
 *   3. null — caller falls back to the initials placeholder.
 *
 * Never throws: a logo is cosmetic and must never fail a market launch.
 */

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

/**
 * Resolve a logo for `mint`, or null. Tries GeckoTerminal then DexScreener.
 */
export async function resolveTokenLogo(mint: string): Promise<string | null> {
  return (await fetchViaGeckoTerminal(mint)) ?? (await fetchViaDexScreener(mint));
}

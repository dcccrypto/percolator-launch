import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/oracle/resolve/[ca]
 *
 * Given a token contract address, attempt to resolve an oracle configuration:
 * 1. Look up token symbol via Jupiter token list
 * 2. Search Pyth Hermes for a matching price feed
 * 3. If found, return feedId + current price
 * 4. If not found, return { found: false }
 */

const JUPITER_TOKEN_LIST = "https://token.jup.ag/strict";
const PYTH_HERMES_FEEDS = "https://hermes.pyth.network/v2/price_feeds";
const PYTH_HERMES_LATEST = "https://hermes.pyth.network/v2/updates/price/latest";

// Simple base58 validation
function isBase58(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

interface JupiterToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

interface PythFeed {
  id: string;
  attributes: {
    symbol?: string;
    base?: string;
    quote_currency?: string;
    asset_type?: string;
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ca: string }> }
) {
  const { ca } = await params;

  if (!ca || !isBase58(ca)) {
    return NextResponse.json(
      { found: false, error: "Invalid token address" },
      { status: 400 }
    );
  }

  try {
    // Step 1: Resolve symbol from Jupiter token list
    let symbol: string | null = null;
    let tokenName: string | null = null;

    try {
      const jupResp = await fetch(JUPITER_TOKEN_LIST, {
        signal: AbortSignal.timeout(5000),
      });
      if (jupResp.ok) {
        const tokens: JupiterToken[] = await jupResp.json();
        const match = tokens.find(
          (t) => t.address.toLowerCase() === ca.toLowerCase()
        );
        if (match) {
          symbol = match.symbol;
          tokenName = match.name;
        }
      }
    } catch {
      // Jupiter lookup failed — continue without symbol
    }

    // Also try well-known symbols for common tokens
    if (!symbol) {
      // Try DexScreener as fallback for symbol resolution
      try {
        const dexResp = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${ca}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (dexResp.ok) {
          const dexData = await dexResp.json();
          const pair = dexData?.pairs?.[0];
          if (pair?.baseToken?.symbol) {
            symbol = pair.baseToken.symbol;
            tokenName = pair.baseToken.name ?? null;
          }
        }
      } catch {
        // DexScreener fallback failed
      }
    }

    if (!symbol) {
      return NextResponse.json({
        found: false,
        source: null,
        message: "Could not resolve token symbol — token not found on Jupiter or DexScreener",
      });
    }

    // Step 2: Search Pyth Hermes for a matching feed
    let feedId: string | null = null;
    let priceUsd: number | null = null;
    let pythSymbol: string | null = null;

    try {
      const pythResp = await fetch(
        `${PYTH_HERMES_FEEDS}?query=${encodeURIComponent(symbol)}&asset_type=crypto`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (pythResp.ok) {
        const feeds: PythFeed[] = await pythResp.json();

        // Find the best match — prefer exact base match with USD quote
        const exactMatch = feeds.find(
          (f) =>
            f.attributes.base?.toUpperCase() === symbol!.toUpperCase() &&
            f.attributes.quote_currency?.toUpperCase() === "USD"
        );
        const anyMatch = feeds.find(
          (f) => f.attributes.base?.toUpperCase() === symbol!.toUpperCase()
        );
        const bestFeed = exactMatch ?? anyMatch;

        if (bestFeed) {
          feedId = bestFeed.id;
          pythSymbol = bestFeed.attributes.symbol ?? `${symbol}/USD`;

          // Fetch current price
          try {
            const priceResp = await fetch(
              `${PYTH_HERMES_LATEST}?ids[]=${feedId}`,
              { signal: AbortSignal.timeout(5000) }
            );
            if (priceResp.ok) {
              const priceData = await priceResp.json();
              const parsed = priceData?.parsed?.[0];
              if (parsed?.price?.price && parsed?.price?.expo !== undefined) {
                priceUsd =
                  Number(parsed.price.price) *
                  Math.pow(10, parsed.price.expo);
              }
            }
          } catch {
            // Price fetch failed — feedId is still valid
          }
        }
      }
    } catch {
      // Pyth lookup failed
    }

    if (feedId) {
      return NextResponse.json({
        found: true,
        feedId,
        symbol: pythSymbol ?? symbol,
        tokenSymbol: symbol,
        tokenName,
        priceUsd,
        source: "pyth",
      });
    }

    // No Pyth feed found — return not found with token info
    return NextResponse.json({
      found: false,
      tokenSymbol: symbol,
      tokenName,
      source: null,
      message: `No Pyth price feed found for ${symbol}`,
    });
  } catch (e) {
    console.error("Oracle resolve error:", e);
    return NextResponse.json(
      { found: false, error: "Internal error resolving oracle" },
      { status: 500 }
    );
  }
}

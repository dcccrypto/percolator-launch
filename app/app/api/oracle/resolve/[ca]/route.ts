import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/oracle/resolve/[ca]
 *
 * Given a Solana token mint (base58), resolves oracle config using a
 * Pyth Hermes → Jupiter → DexScreener fallback chain.
 *
 * Returns: { feedId, symbol, price, source }
 *   feedId — Pyth feed ID (hex64) if found, else null
 *   symbol — token ticker
 *   price  — USD price (number)
 *   source — "pyth" | "jupiter" | "dexscreener"
 *
 * Bug: PERC-oracle-resolve — route was missing, causing 404 on Create Market flow.
 */

// ---------------------------------------------------------------------------
// Static Pyth feed map: mint → { feedId, symbol }
// ---------------------------------------------------------------------------

const MINT_TO_PYTH: Record<string, { feedId: string; symbol: string }> = {
  // SOL
  So11111111111111111111111111111111111111112: {
    feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    symbol: "SOL",
  },
  // BTC
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E": {
    feedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    symbol: "BTC",
  },
  // ETH
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": {
    feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    symbol: "ETH",
  },
  // USDC
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    feedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    symbol: "USDC",
  },
  // USDT
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    feedId: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
    symbol: "USDT",
  },
  // BONK
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: {
    feedId: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
    symbol: "BONK",
  },
  // JTO
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: {
    feedId: "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
    symbol: "JTO",
  },
  // JUP
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: {
    feedId: "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
    symbol: "JUP",
  },
  // WIF
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: {
    feedId: "4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54e6c5c4b03",
    symbol: "WIF",
  },
  // RAY
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": {
    feedId: "91568bae053f70f0c3fbf32eb55df25ec609fb8a21cfb1a0e3b34fc3caa1eab0",
    symbol: "RAY",
  },
};

// ---------------------------------------------------------------------------
// Simple in-memory cache (TTL 5 minutes)
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: OracleResolveResult;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

interface OracleResolveResult {
  feedId: string | null;
  symbol: string;
  price: number;
  source: "pyth" | "jupiter" | "dexscreener" | "unknown";
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidBase58Pubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

function isUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://") || s.includes("://");
}

// ---------------------------------------------------------------------------
// Price fetchers
// ---------------------------------------------------------------------------

async function fetchJupiterPrice(
  ca: string,
): Promise<{ price: number; symbol: string | null } | null> {
  try {
    const resp = await fetch(`https://api.jup.ag/price/v2?ids=${ca}`, {
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": "percolator/1.0" },
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const data = json.data?.[ca];
    if (!data?.price) return null;
    const price = parseFloat(data.price);
    if (!isFinite(price) || price <= 0) return null;
    return { price, symbol: data.mintSymbol ?? null };
  } catch {
    return null;
  }
}

async function fetchDexScreenerInfo(
  ca: string,
): Promise<{ price: number; symbol: string | null } | null> {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, {
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": "percolator/1.0" },
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const pairs = json.pairs as Array<{
      priceUsd?: string;
      baseToken?: { symbol?: string };
      liquidity?: { usd?: number };
      chainId?: string;
    }>;
    if (!pairs?.length) return null;

    // Sort by liquidity, pick best Solana pair
    const solPairs = pairs
      .filter((p) => p.chainId === "solana" && p.priceUsd)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    if (!solPairs.length) return null;

    const best = solPairs[0];
    const price = parseFloat(best.priceUsd ?? "0");
    if (!isFinite(price) || price <= 0) return null;

    return { price, symbol: best.baseToken?.symbol ?? null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ca: string }> },
): Promise<NextResponse> {
  const { ca } = await params;

  // Reject URLs immediately — clear, actionable error
  if (isUrl(ca)) {
    return NextResponse.json(
      { error: "Paste a valid Solana token address, not a URL" },
      { status: 400 },
    );
  }

  // Validate base58 format
  if (!ca || ca.length < 32 || ca.length > 44 || !isValidBase58Pubkey(ca)) {
    return NextResponse.json(
      { error: "Invalid Solana mint address" },
      { status: 400 },
    );
  }

  // Cache hit
  const cached = cache.get(ca);
  if (cached && Date.now() < cached.expiresAt) {
    return NextResponse.json({ ...cached.data, cached: true });
  }

  // --- 1. Check static Pyth feed map ---
  const pythEntry = MINT_TO_PYTH[ca];

  // Fetch price in parallel from both Jupiter and DexScreener
  const [jupResult, dexResult] = await Promise.all([
    fetchJupiterPrice(ca),
    fetchDexScreenerInfo(ca),
  ]);

  // Best price: prefer DexScreener for memecoins, Jupiter as fallback
  const priceSource = dexResult ?? jupResult;
  const price = priceSource?.price ?? 0;
  const symbolFromPrice = priceSource?.symbol ?? null;

  let result: OracleResolveResult;

  if (pythEntry) {
    result = {
      feedId: pythEntry.feedId,
      symbol: pythEntry.symbol,
      price,
      source: "pyth",
    };
  } else if (jupResult) {
    result = {
      feedId: null,
      symbol: symbolFromPrice ?? ca.slice(0, 6),
      price: jupResult.price,
      source: "jupiter",
    };
  } else if (dexResult) {
    result = {
      feedId: null,
      symbol: symbolFromPrice ?? ca.slice(0, 6),
      price: dexResult.price,
      source: "dexscreener",
    };
  } else {
    // No price found anywhere
    return NextResponse.json(
      { error: "No price feed found for this token" },
      { status: 404 },
    );
  }

  // Cache and return
  cache.set(ca, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return NextResponse.json({ ...result, cached: false });
}

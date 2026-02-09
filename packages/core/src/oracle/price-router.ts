/**
 * Smart Price Router — automatic oracle selection for any token.
 *
 * Given a token mint, discovers all available price sources (DexScreener, Pyth, Jupiter),
 * ranks them by liquidity/reliability, and returns the best oracle config.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PriceSourceType = "pyth" | "dex" | "jupiter";

export interface PriceSource {
  type: PriceSourceType;
  /** Pool address (dex), Pyth feed ID (pyth), or mint (jupiter) */
  address: string;
  /** DEX id for dex sources */
  dexId?: string;
  /** Pair label e.g. "SOL / USDC" */
  pairLabel?: string;
  /** USD liquidity depth — higher is better */
  liquidity: number;
  /** Latest spot price in USD */
  price: number;
  /** Confidence score 0-100 (composite of liquidity, staleness, reliability) */
  confidence: number;
}

export interface PriceRouterResult {
  mint: string;
  bestSource: PriceSource | null;
  allSources: PriceSource[];
  /** ISO timestamp of resolution */
  resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Top Solana tokens with known Pyth feeds (feed ID → symbol)
// ---------------------------------------------------------------------------

export const PYTH_SOLANA_FEEDS: Record<string, { symbol: string; mint: string }> = {
  // SOL
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d": { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  // BTC
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43": { symbol: "BTC", mint: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E" },
  // ETH
  "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace": { symbol: "ETH", mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" },
  // USDC
  "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a": { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  // USDT
  "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b": { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  // BONK
  "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419": { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  // JTO
  "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2": { symbol: "JTO", mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL" },
  // JUP
  "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996": { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  // PYTH
  "0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff": { symbol: "PYTH", mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" },
  // RAY
  "91568bae053f70f0c3fbf32eb55df25ec609fb8a21cfb1a0e3b34fc3caa1eab0": { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" },
  // ORCA
  "37505261e557e251f40c2c721e52c4c8bfb2e54a12f450d0e24078276ad51b95": { symbol: "ORCA", mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE" },
  // MNGO
  "f9abf5eb70a2e68e21b72b68cc6e0a4d25e1d77e1ec16eae5b93068a2cb81f90": { symbol: "MNGO", mint: "MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac" },
  // MSOL
  "c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4": { symbol: "MSOL", mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So" },
  // JITOSOL
  "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb": { symbol: "JITOSOL", mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn" },
  // WIF
  "4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54e6c5c4b03": { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  // RENDER
  "3573eb14b04aa0e4f7cf1e7ae1c2a0e3bc6100b2e476876ca079e10e2c42d7c6": { symbol: "RENDER", mint: "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof" },
  // W
  "eff7446475e218517566ea99e72a4abec2e1bd8498b43b7d8331e29dcb059389": { symbol: "W", mint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ" },
  // TNSR
  "05ecd4597cd48fe13d6cc3596c62af4f9675aee06e2e0ca164a73be4b0813f3b": { symbol: "TNSR", mint: "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6" },
  // HNT
  "649fdd7ec08e8e2a20f425729854e90293dcbe2376abc47197a14da6ff339756": { symbol: "HNT", mint: "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux" },
  // MOBILE
  "ff4c53361e36a9b1caa490f1e46e07e3c472d54d2a4856a1e4609bd4db36bff0": { symbol: "MOBILE", mint: "mb1eu7TzEc71KxDpsmsKoucSSuuoGLv1drys1oP2jh6" },
  // IOT
  "8bdd20f0c68bf7370a19389bbb3d17c1db7956c38efa08b2f3dd0e5db9b8c1ef": { symbol: "IOT", mint: "iotEVVZLEywoTn1QdwNPddxPWszn3zFhEot3MfL9fns" },
};

// Reverse lookup: mint → feed ID
const MINT_TO_PYTH_FEED = new Map<string, { feedId: string; symbol: string }>();
for (const [feedId, info] of Object.entries(PYTH_SOLANA_FEEDS)) {
  MINT_TO_PYTH_FEED.set(info.mint, { feedId, symbol: info.symbol });
}

// ---------------------------------------------------------------------------
// DexScreener fetcher
// ---------------------------------------------------------------------------

const SUPPORTED_DEX_IDS = new Set(["pumpswap", "raydium", "meteora"]);

async function fetchDexSources(mint: string, signal?: AbortSignal): Promise<PriceSource[]> {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal,
      headers: { "User-Agent": "percolator/1.0" },
    });
    const json = (await resp.json()) as any;
    const pairs = json.pairs || [];
    const sources: PriceSource[] = [];

    for (const pair of pairs) {
      if (pair.chainId !== "solana") continue;
      const dexId = (pair.dexId || "").toLowerCase();
      if (!SUPPORTED_DEX_IDS.has(dexId)) continue;
      const liquidity = pair.liquidity?.usd || 0;
      if (liquidity < 100) continue;

      // Confidence: based on liquidity tiers
      let confidence = 30;
      if (liquidity > 1_000_000) confidence = 90;
      else if (liquidity > 100_000) confidence = 75;
      else if (liquidity > 10_000) confidence = 60;
      else if (liquidity > 1_000) confidence = 45;

      sources.push({
        type: "dex",
        address: pair.pairAddress,
        dexId,
        pairLabel: `${pair.baseToken?.symbol || "?"} / ${pair.quoteToken?.symbol || "?"}`,
        liquidity,
        price: parseFloat(pair.priceUsd) || 0,
        confidence,
      });
    }

    sources.sort((a, b) => b.liquidity - a.liquidity);
    return sources.slice(0, 10);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pyth lookup
// ---------------------------------------------------------------------------

function lookupPythSource(mint: string): PriceSource | null {
  const entry = MINT_TO_PYTH_FEED.get(mint);
  if (!entry) return null;
  return {
    type: "pyth",
    address: entry.feedId,
    pairLabel: `${entry.symbol} / USD (Pyth)`,
    liquidity: Infinity, // Pyth is considered deep liquidity
    price: 0, // We don't fetch live price here; caller can enrich
    confidence: 95, // Pyth is highest reliability for supported tokens
  };
}

// ---------------------------------------------------------------------------
// Jupiter price fallback
// ---------------------------------------------------------------------------

async function fetchJupiterSource(mint: string, signal?: AbortSignal): Promise<PriceSource | null> {
  try {
    const resp = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`, {
      signal,
      headers: { "User-Agent": "percolator/1.0" },
    });
    const json = (await resp.json()) as any;
    const data = json.data?.[mint];
    if (!data || !data.price) return null;

    return {
      type: "jupiter",
      address: mint,
      pairLabel: `${data.mintSymbol || "?"} / USD (Jupiter)`,
      liquidity: 0, // Jupiter aggregator — no single pool liquidity
      price: parseFloat(data.price) || 0,
      confidence: 40, // Fallback — lower confidence
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

export async function resolvePrice(mint: string, signal?: AbortSignal): Promise<PriceRouterResult> {
  // Run all lookups in parallel
  const [dexSources, jupiterSource] = await Promise.all([
    fetchDexSources(mint, signal),
    fetchJupiterSource(mint, signal),
  ]);

  const pythSource = lookupPythSource(mint);

  const allSources: PriceSource[] = [];

  // Add Pyth if available (highest priority for supported tokens)
  if (pythSource) {
    // Enrich Pyth price from Jupiter or DEX if available
    const refPrice = dexSources[0]?.price || jupiterSource?.price || 0;
    pythSource.price = refPrice;
    allSources.push(pythSource);
  }

  // Add DEX sources
  allSources.push(...dexSources);

  // Add Jupiter as fallback
  if (jupiterSource) {
    allSources.push(jupiterSource);
  }

  // Sort by confidence descending (already accounts for liquidity/reliability)
  allSources.sort((a, b) => b.confidence - a.confidence);

  return {
    mint,
    bestSource: allSources[0] || null,
    allSources,
    resolvedAt: new Date().toISOString(),
  };
}

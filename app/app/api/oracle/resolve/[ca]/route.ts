import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { registeredPoolForMint } from "@/lib/registered-pool";
import { SUPPORTED_DEX_IDS } from "@/lib/dex-constants";
import { classifyPoolsByOwner, isOfferable, MAX_CLASSIFY_POOLS } from "@/lib/dex-pool-owner";
import type { KeeperDexType } from "@/lib/dex-type";
import { BoundedTtlCache } from "@/lib/bounded-ttl-cache";
import { fetchJupiterUsdPrice } from "@/lib/jupiter-price";
import { belowLiquidityFloorReason } from "@/lib/pool-liquidity";

export const dynamic = "force-dynamic";

/**
 * GET /api/oracle/resolve/[ca]
 *
 * Given a Solana token mint (base58), resolves oracle config from DexScreener (price, symbol and
 * the keeper-priceable pool) with Jupiter as the price fallback. No Pyth (2026-10-01): the
 * playground prices every market from its mainnet DEX pool through the keeper.
 *
 * Returns: { feedId, symbol, price, source }
 *   feedId — always null (kept for response-shape compatibility)
 *   symbol — token ticker
 *   price  — USD price (number)
 *   source — "dexscreener" | "jupiter"
 *
 * Bug: PERC-oracle-resolve — route was missing, causing 404 on Create Market flow.
 */

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Bounded resolver cache and in-flight request state
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
const MAX_IN_FLIGHT_REQUESTS = 64;

const cache = new BoundedTtlCache<string, OracleResolveResult>({
  maxEntries: MAX_CACHE_ENTRIES,
  ttlMs: CACHE_TTL_MS,
});

const inFlight = new Map<
  string,
  ReturnType<typeof fetchOracleSources>
>();

interface OracleResolveResult {
  feedId: string | null;
  symbol: string;
  price: number;
  source: "jupiter" | "dexscreener" | "unknown";
  /** PERC-470: DEX pool address the keeper prices the market from */
  dexPoolAddress?: string | null;
  /** Keeper dexType of `dexPoolAddress`, classified by mainnet owner ("meteora-dlmm" | "pumpswap"). */
  dexType?: string | null;
  /** Set when no pool was offered because every candidate was under the keeper's liquidity floor. */
  poolBlockedReason?: string;
  /** PERC-470: Recommended oracle mode */
  oracleMode?: "hyperp" | "admin";
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
  // Jupiter Price API v3 (lib/jupiter-price.ts). v3 carries no symbol; DexScreener supplies it.
  const price = await fetchJupiterUsdPrice(ca);
  return price === null ? null : { price, symbol: null };
}

async function fetchDexScreenerInfo(
  ca: string,
): Promise<{ price: number; symbol: string | null; candidates: string[]; priceByPair: Record<string, number> } | null> {
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
      dexId?: string;
      pairAddress?: string;
    }>;
    if (!pairs?.length) return null;

    // Sort by liquidity, pick best Solana pair (for price/symbol — most liquid wins)
    const solPairs = pairs
      .filter((p) => p.chainId === "solana" && p.priceUsd)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    if (!solPairs.length) return null;

    const best = solPairs[0];
    const price = parseFloat(best.priceUsd ?? "0");
    if (!isFinite(price) || price <= 0) return null;

    // PERC-470/#811 + E2E B21: every supported-dexId pair, most liquid first, is a
    // CANDIDATE. DexScreener's dexId cannot tell Meteora DLMM from DAMM v1, so the
    // GET handler classifies the candidates by their mainnet owner program and
    // picks the first one the keeper can price.
    const candidates: string[] = [];
    for (const p of solPairs) {
      if (!SUPPORTED_DEX_IDS.has(p.dexId?.toLowerCase() ?? "") || !p.pairAddress) continue;
      // Security: validate pool address is a valid Solana pubkey before returning
      try { new PublicKey(p.pairAddress); } catch { continue; }
      if (!candidates.includes(p.pairAddress)) candidates.push(p.pairAddress);
      if (candidates.length >= MAX_CLASSIFY_POOLS) break;
    }
    const priceByPair: Record<string, number> = {};
    for (const p of solPairs) {
      const v = parseFloat(p.priceUsd ?? "");
      if (p.pairAddress && isFinite(v) && v > 0) priceByPair[p.pairAddress] = v;
    }
    return { price, symbol: best.baseToken?.symbol ?? null, candidates, priceByPair };
  } catch {
    return null;
  }
}

function fetchOracleSources(ca: string) {
  return Promise.all([
    fetchJupiterPrice(ca),
    fetchDexScreenerInfo(ca),
  ] as const);
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

  // Return a fresh value from the bounded TTL/LRU cache.
  const cached = cache.get(ca);

  if (cached) {
    return NextResponse.json({
      ...cached,
      cached: true,
    });
  }

  /*
   * Reuse one upstream operation for concurrent requests targeting
   * the same mint. New unique operations are rejected once the hard
   * in-flight capacity is reached.
   */
  let sourceLookup = inFlight.get(ca);

  if (!sourceLookup) {
    if (inFlight.size >= MAX_IN_FLIGHT_REQUESTS) {
      return NextResponse.json(
        { error: "Oracle resolver is busy. Retry shortly." },
        {
          status: 503,
          headers: { "Retry-After": "1" },
        },
      );
    }

    sourceLookup = fetchOracleSources(ca).finally(() => {
      inFlight.delete(ca);
    });

    inFlight.set(ca, sourceLookup);
  }

  const [jupResult, dexResult] = await sourceLookup;
  // A token that already has a live market resolves to THAT market's registered pool (the venue
  // the keeper prices it from), never a re-ranked "best" pair (lib/registered-pool.ts).
  // A failed lookup is not "unregistered": answer from the pairs for THIS request, uncached.
  let registered: Awaited<ReturnType<typeof registeredPoolForMint>> = null;
  let cacheable = true;
  try {
    registered = await registeredPoolForMint(ca);
  } catch {
    cacheable = false;
  }

  // Best price: prefer DexScreener for memecoins, Jupiter as fallback
  const priceSource = dexResult ?? jupResult;
  const registeredPrice = registered ? dexResult?.priceByPair[registered.pool] : undefined;
  const price = registeredPrice ?? priceSource?.price ?? 0;
  const symbolFromPrice = priceSource?.symbol ?? null;

  let result: OracleResolveResult;

  // PERC-470: Determine best DEX pool for hyperp mode
  // E2E B21: the pool must be one the keeper can price, by mainnet OWNER.
  let bestPool: string | null = null;
  let bestDexType: string | null = null;
  let poolBlockedReason: string | undefined;
  const candidates = dexResult?.candidates ?? [];
  if (registered) {
    bestPool = registered.pool;
    bestDexType = registered.dexType;
    if (!bestDexType) {
      const classes = await classifyPoolsByOwner([registered.pool]);
      bestDexType = classes && isOfferable(classes[registered.pool]) ? (classes[registered.pool] as KeeperDexType) : null;
      if (!classes) cacheable = false; // transient RPC failure: don't pin a null dexType
    }
  } else if (candidates.length > 0) {
    const classes = await classifyPoolsByOwner(candidates);
    if (!classes) {
      // Not cached: a transient RPC failure must not pin "no pool" for the TTL.
      return NextResponse.json(
        { error: "Couldn't verify this token's DEX pools right now. Try again in a moment." },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    const pick = candidates.find((c) => isOfferable(classes[c]));
    if (pick) {
      bestPool = pick;
      bestDexType = classes[pick] as KeeperDexType;
    } else if (candidates.some((c) => classes[c] === "below-liquidity-floor")) {
      poolBlockedReason = belowLiquidityFloorReason();
    }
  }

  if (jupResult || dexResult) {
    // PERC-470: hyperp (keeper-priced on devnet) when the keeper can price a DEX pool
    const hasPool = !!bestPool;
    // Align price + source with priceSource above (DexScreener preferred over Jupiter).
    result = {
      feedId: null,
      symbol: symbolFromPrice ?? ca.slice(0, 6),
      price,
      source: dexResult ? "dexscreener" : "jupiter",
      dexPoolAddress: bestPool,
      dexType: bestDexType,
      ...(poolBlockedReason ? { poolBlockedReason } : {}),
      oracleMode: hasPool ? "hyperp" : "admin",
    };
  } else {
    // No price found anywhere
    return NextResponse.json(
      { error: "No price feed found for this token" },
      { status: 404 },
    );
  }

  // Cache and return (never a result built on a failed lookup)
  if (cacheable) cache.set(ca, result);
  return NextResponse.json({ ...result, cached: false });
}

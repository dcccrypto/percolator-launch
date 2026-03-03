/**
 * PERC-377: Multi-source price feeds with caching.
 *
 * Fetches oracle prices from Binance (primary) and CoinGecko (fallback).
 * Includes a TTL cache to avoid hammering external APIs.
 */

export interface PriceData {
  priceUsd: number;
  source: string;
  timestamp: number;
}

// ── Feed mappings ───────────────────────────────────────

const BINANCE_MAP: Record<string, string> = {
  SOL: "SOLUSDT",
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  BONK: "BONKUSDT",
  WIF: "WIFUSDT",
  JUP: "JUPUSDT",
  PYTH: "PYTHUSDT",
  RAY: "RAYUSDT",
  JTO: "JTOUSDT",
  RNDR: "RNDRUSDT",
};

const COINGECKO_MAP: Record<string, string> = {
  SOL: "solana",
  BTC: "bitcoin",
  ETH: "ethereum",
  BONK: "bonk",
  WIF: "dogwifcoin",
  JUP: "jupiter-exchange-solana",
  PYTH: "pyth-network",
  RAY: "raydium",
  JTO: "jito-governance-token",
  RNDR: "render-token",
};

// ── Cache ───────────────────────────────────────────────

const cache = new Map<string, PriceData>();
const CACHE_TTL_MS = 2_000;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function getCached(symbol: string): PriceData | null {
  const entry = cache.get(normalizeSymbol(symbol));
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    return entry;
  }
  return null;
}

function setCache(symbol: string, data: PriceData): void {
  cache.set(normalizeSymbol(symbol), data);
}

// ── Fetchers ────────────────────────────────────────────

async function fetchBinance(symbol: string): Promise<number | null> {
  const pair = BINANCE_MAP[symbol.toUpperCase()];
  if (!pair) return null;
  try {
    const resp = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { price?: string };
    if (!json.price) return null;
    const parsed = parseFloat(json.price);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchCoinGecko(symbol: string): Promise<number | null> {
  const id = COINGECKO_MAP[symbol.toUpperCase()];
  if (!id) return null;
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as Record<string, { usd?: number }>;
    return json[id]?.usd ?? null;
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────

/**
 * Fetch price with cache + multi-source fallback.
 * Returns null only if all sources fail.
 */
export async function fetchPrice(symbol: string): Promise<PriceData | null> {
  // Check cache first
  const cached = getCached(symbol);
  if (cached) return cached;

  // Try Binance
  const binPrice = await fetchBinance(symbol);
  if (binPrice !== null) {
    const data: PriceData = { priceUsd: binPrice, source: "binance", timestamp: Date.now() };
    setCache(symbol, data);
    return data;
  }

  // Fallback: CoinGecko
  const cgPrice = await fetchCoinGecko(symbol);
  if (cgPrice !== null) {
    const data: PriceData = { priceUsd: cgPrice, source: "coingecko", timestamp: Date.now() };
    setCache(symbol, data);
    return data;
  }

  return null;
}

/**
 * Batch-fetch prices for multiple symbols (parallel, cache-aware).
 */
export async function fetchPrices(symbols: string[]): Promise<Map<string, PriceData>> {
  const results = new Map<string, PriceData>();
  const uncached = symbols.filter((s) => {
    const c = getCached(s);
    if (c) { results.set(s, c); return false; }
    return true;
  });

  if (uncached.length > 0) {
    const promises = uncached.map(async (sym) => {
      const data = await fetchPrice(sym);
      if (data) results.set(sym, data);
    });
    await Promise.allSettled(promises);
  }

  return results;
}

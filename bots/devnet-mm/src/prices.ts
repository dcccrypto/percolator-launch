/**
 * PERC-377: Multi-source price feeds with caching.
 *
 * Fetches oracle prices from Binance (primary), CoinGecko (secondary),
 * and Pyth Hermes REST API (tertiary fallback, free + no key required).
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

/**
 * Pyth Hermes feed IDs (mainnet) — free REST API, no key required.
 * https://hermes.pyth.network/v2/updates/price/latest?ids[]=<id>
 */
const PYTH_FEED_IDS: Record<string, string> = {
  SOL:  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC:  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH:  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BONK: "0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
  WIF:  "0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc",
  JUP:  "0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  PYTH: "0x0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff",
  RAY:  "0x91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a",
  JTO:  "0xb43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
  RNDR: "0xab7347771135fc733f8f38db462ba085ed3309955f42554a14a982b67b8f781a",
};

// ── Cache ───────────────────────────────────────────────

const cache = new Map<string, PriceData>();
const CACHE_TTL_MS = 2_000;

/** Clear the in-memory price cache. Exposed for unit testing only. */
export function clearCacheForTesting(): void {
  cache.clear();
}

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

/**
 * Pyth Hermes REST fallback (free, no API key).
 * Returns the USD price or null on any failure.
 */
async function fetchPyth(symbol: string): Promise<number | null> {
  const feedId = PYTH_FEED_IDS[symbol.toUpperCase()];
  if (!feedId) return null;
  try {
    const resp = await fetch(
      `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      parsed?: Array<{ price?: { price: string; expo: number } }>;
    };
    const parsed = json.parsed?.[0]?.price;
    if (!parsed) return null;
    const price = Number(parsed.price) * Math.pow(10, parsed.expo);
    return Number.isFinite(price) && price > 0 ? price : null;
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

  // Final fallback: Pyth Hermes REST (free, no key, mainnet prices)
  const pythPrice = await fetchPyth(symbol);
  if (pythPrice !== null) {
    const data: PriceData = { priceUsd: pythPrice, source: "pyth-hermes", timestamp: Date.now() };
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

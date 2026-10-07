/**
 * Server-side data model for the landing page's "Trending on Solana DEXs" table:
 * tokens trending on Solana DEXs that do NOT yet have a Percolator market.
 *
 * These are THIRD-PARTY tokens. Nothing here reviews, vets or endorses them; the
 * filters below only drop tokens a Percolator market could not be created on, so a
 * row's "Create market" CTA is not a dead end. The create wizard still runs every
 * one of its own checks (pool search, USD-quote and keeper liquidity-floor
 * classification, duplicate-market check) on whatever mint the CTA hands it.
 *
 * SOURCES (all keyless, all server-side; probed 2026-10-04):
 *   1. GeckoTerminal `networks/solana/trending_pools` — primary. 200 from a UK
 *      residential IP and served from CoinGecko's public API, which Vercel's chart
 *      route already reaches. Uses lib/gecko-fetch (bounded retry on 429/5xx, and
 *      the optional server-only COINGECKO_API_KEY).
 *   2. pump.fun `frontend-api-v3/coins` — best effort. Returns 403 + a
 *      static.pump.fun/blocked redirect from the UK, and is Cloudflare-fronted, so
 *      datacenter egress may be blocked too. Kept because when it does answer it
 *      carries pump.fun's own ban / nsfw / transfer-fee / transfer-hook flags.
 *   3. DexScreener `latest/dex/tokens` — market data for every candidate, the SAME
 *      endpoint and dexId set the create wizard's pool search uses. If a DexScreener
 *      batch fails, GeckoTerminal's own pool data stands in for its mints.
 *
 * LISTING FILTERS (factual, all fail-closed; anything missing = excluded):
 *   - a PumpSwap or Meteora pool (lib/dex-constants SUPPORTED_DEX_IDS),
 *   - quoted in SOL, USDC or USDT (USD_PRICEABLE_QUOTE_MINTS — the keeper can't
 *     price anything else),
 *   - pool liquidity >= MIN_LIQUIDITY_USD, and for PumpSwap a quote-side depth at
 *     or above the keeper's floor (lib/pool-liquidity, $1000 by default),
 *   - market cap >= MIN_MARKET_CAP_USD,
 *   - a known price at or above the wizard's launch floor at its LOWEST leverage (2x, about
 *     $0.000667, lib/launch-price-floor): under it the mark would freeze once positions open, so
 *     the wizard refuses the launch at every leverage and the row's CTA would be a dead end,
 *   - pump.fun candidates additionally: graduated, not banned/nsfw, no transfer
 *     fee, no transfer hook.
 *
 * Every fetch fails soft (never throws). `sourceEmpty` is true when NO candidate
 * source produced anything — the UI shows "data unavailable" for that, distinct
 * from "nothing passed the filters".
 */
import { SUPPORTED_DEX_IDS, USD_PRICEABLE_QUOTE_MINTS } from "@/lib/dex-constants";
import { geckoFetch, getGeckoConfig } from "@/lib/gecko-fetch";
import { isLaunchablePriceUsd } from "@/lib/launch-price-floor";

/** pump.fun's public coins API (keyless). Best effort — see header. */
const PUMPFUN_COINS_URL = "https://frontend-api-v3.pump.fun/coins";
/** DexScreener batch tokens endpoint — up to 30 comma-separated mints per call, keyless. */
const DEXSCREENER_TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens";

/** How many pump.fun coins to pull as the candidate pool before filtering + ranking. */
export const TRENDING_CANDIDATE_POOL = 100;
/** How many filtered tokens to return. Headroom over the rail's 20 so the list stays
 *  full after already-listed tokens are excluded client-side. */
export const TRENDING_RETURN_LIMIT = 40;

/** Listing thresholds (USD). Tunable. */
export const MIN_MARKET_CAP_USD = 20_000;
export const MIN_LIQUIDITY_USD = 5_000;
/**
 * The keeper's PumpSwap quote-depth floor in USD. Mirrors lib/pool-liquidity's
 * DEFAULT_MIN_POOL_LIQUIDITY_USD / env MIN_POOL_LIQUIDITY_USD (not imported: that
 * module pulls in web3.js + the SDK). The wizard enforces the real check on-chain.
 */
export function keeperFloorUsd(env: string | undefined = process.env.MIN_POOL_LIQUIDITY_USD): number {
  const n = Number((env ?? "").trim() || "1000");
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

const FETCH_TIMEOUT_MS = 6_000;
const DEXSCREENER_BATCH = 30;

/** A raw pump.fun coin — only the fields we read (the response has ~50 more). */
export interface PumpFunCoin {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  image_uri?: string | null;
  usd_market_cap?: number | null;
  total_supply?: number | null;
  complete?: boolean | null;
  is_banned?: boolean | null;
  nsfw?: boolean | null;
  transfer_fee_bps?: number | null;
  transfer_hook_program?: string | null;
}

export type TrendingSource = "geckoterminal" | "pumpfun";
export type MarketDataSource = "dexscreener" | "geckoterminal";

/** Market data per mint, from its deepest SUPPORTED, USD-quoted pool. */
export interface DexMarket {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  /** USD value of the pool's QUOTE side (what the keeper floors for PumpSwap). */
  quoteDepthUsd: number | null;
  volume24hUsd: number | null;
  /** Shorter-window volumes (USD) + tx counts + price moves, used by the momentum
   *  ranking and the trend sparkline. Optional: a source that omits a window = null. */
  volume1hUsd?: number | null;
  volume6hUsd?: number | null;
  volume5mUsd?: number | null;
  priceChange1hPct?: number | null;
  priceChange24hPct?: number | null;
  /** buys + sells in the window (acceleration = this hour vs the 6h hourly average). */
  txns1h?: number | null;
  txns6h?: number | null;
  pairAddress: string | null;
  /** dexId of the chosen pool — always one of SUPPORTED_DEX_IDS once it passes. */
  dexId: string | null;
  quoteMint: string | null;
  /** Where this market data came from (decides the outbound chart link). */
  dataSource: MarketDataSource;
}

/** A trending candidate before market data is attached. */
export interface TrendingCandidate {
  mint: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  source: TrendingSource;
  /** pump.fun's raw coin, when the candidate came from pump.fun (its flag gate applies). */
  pumpfun?: PumpFunCoin;
  /** GeckoTerminal's own pool data, used only when DexScreener could not be reached. */
  geckoMarket?: DexMarket;
}

/** A token shown in the table. All money values are real USD. */
export interface TrendingToken {
  /** Mainnet mint / contract address (what the Create-Market wizard prefills on). */
  mint: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  /** The pool's DEX, one of SUPPORTED_DEX_IDS. */
  dexId: string;
  /** External chart page for the pool (DexScreener or GeckoTerminal). */
  chartUrl: string;
  source: TrendingSource;
  priceUsd: number | null;
  marketCapUsd: number;
  volume24hUsd: number;
  /** 1h volume (USD) — the column shown when the 1H timeframe is selected. */
  volume1hUsd: number;
  liquidityUsd: number;
  /** Price move over the window; null when the source didn't report it. */
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  /** Avg hourly volume rate over [24h, 6h, 1h, 5m] — the trend sparkline (oldest→newest). */
  trend: number[];
  /** Momentum scores precomputed per timeframe so the client only has to pick one. */
  score1h: number;
  score24h: number;
}

/** The two selectable timeframes (7d has no shorter-window source on DexScreener/GeckoTerminal). */
export type Timeframe = "1h" | "24h";

export type SourceStatus = "ok" | "empty" | "error";

export interface TrendingTokensResult {
  tokens: TrendingToken[];
  generatedAt: string;
  /** True when no candidate source produced anything (blocked, down, timed out) —
   *  the UI must say "unavailable", not "nothing matched". */
  sourceEmpty: boolean;
  /** Per-source outcome, for debugging from the route response. */
  sources: Record<TrendingSource, SourceStatus>;
}

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** buys + sells from a `{ buys, sells }` window object (DexScreener `txns.*`,
 *  GeckoTerminal `transactions.*`); null when neither side is present. */
const txCount = (w: unknown): number | null => {
  const o = (w ?? {}) as { buys?: unknown; sells?: unknown };
  const b = num(o.buys);
  const s = num(o.sells);
  return b == null && s == null ? null : (b ?? 0) + (s ?? 0);
};

/** Base58 mint sanity — the upstreams are semi-trusted, so never interpolate a mint
 *  into an outbound URL (or hand it to the client) unless it's a plain base58 key. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isValidMint = (m: unknown): m is string => typeof m === "string" && BASE58_RE.test(m);

/** Only https logo URLs reach the client (no javascript:, data:, ipfs:, http mixed content). */
export function safeLogoUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 2048) return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

const clean = (s: unknown, max = 32): string =>
  typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";

// ── momentum ranking (pure, unit-tested) ─────────────────────────────────────
//
// The list is ranked to catch tokens WHILE momentum is building, not just by raw
// 24h size. Per the feedback: lead with short-window volume, boosted by how much
// trading is ACCELERATING right now, and dampened for thin pools so a single wash
// trade on a near-empty pool can't top the list. The hard liquidity/market-cap
// gates still run first (passesMarketGate); this only orders what already passed.

/** Liquidity above this neither helps nor hurts the rank — it only keeps thin
 *  pools from being over-ranked on one trade. Below it, the score is damped. */
export const LIQ_REF_USD = 50_000;

/** Soft liquidity weight in [0.3, 1]: sqrt(liq / ref), capped at 1. Deep pools are
 *  neutral (1); thin pools are penalised, never rewarded (we rank by activity, not TVL). */
export function liqDampener(liquidityUsd: number | null | undefined): number {
  const liq = Math.max(0, liquidityUsd ?? 0);
  return Math.min(1, Math.max(0.3, Math.sqrt(liq / LIQ_REF_USD)));
}

/** Tx acceleration in [0.5, 2.5]: this hour's trade count vs the trailing 6h hourly
 *  average. >1 = speeding up (the "momentum building" signal). Neutral (1) without data. */
export function accelMultiplier(txns1h: number | null | undefined, txns6h: number | null | undefined): number {
  const t1 = txns1h ?? null;
  const t6 = txns6h ?? null;
  if (t1 == null || t6 == null || t6 <= 0) return 1;
  const baselinePerHour = t6 / 6;
  if (baselinePerHour <= 0) return 1;
  return Math.min(2.5, Math.max(0.5, t1 / baselinePerHour));
}

/** Per-timeframe momentum scores. 1h leads with 1h volume × acceleration × liquidity
 *  weight; 24h is 24h volume × liquidity weight (acceleration isn't meaningful over a day). */
export function momentumScores(v: {
  volume1hUsd: number | null | undefined;
  volume24hUsd: number | null | undefined;
  liquidityUsd: number | null | undefined;
  txns1h: number | null | undefined;
  txns6h: number | null | undefined;
}): { score1h: number; score24h: number } {
  const liq = liqDampener(v.liquidityUsd);
  const accel = accelMultiplier(v.txns1h, v.txns6h);
  return {
    score1h: Math.max(0, v.volume1hUsd ?? 0) * accel * liq,
    score24h: Math.max(0, v.volume24hUsd ?? 0) * liq,
  };
}

/** Avg hourly volume rate ($/h) over [24h, 6h, 1h, 5m] — the trend sparkline, oldest→newest.
 *  Rising bars = activity speeding up. Missing windows read 0. */
export function trendSeries(v: {
  volume24hUsd: number | null | undefined;
  volume6hUsd: number | null | undefined;
  volume1hUsd: number | null | undefined;
  volume5mUsd: number | null | undefined;
}): number[] {
  const rate = (vol: number | null | undefined, hours: number): number =>
    vol != null && vol > 0 && hours > 0 ? vol / hours : 0;
  return [rate(v.volume24hUsd, 24), rate(v.volume6hUsd, 6), rate(v.volume1hUsd, 1), rate(v.volume5mUsd, 5 / 60)];
}

/** The volume to show for the selected timeframe. */
export function volumeForTimeframe(t: Pick<TrendingToken, "volume1hUsd" | "volume24hUsd">, tf: Timeframe): number {
  return tf === "1h" ? (t.volume1hUsd ?? 0) : (t.volume24hUsd ?? 0);
}

/** The price-change % to show for the selected timeframe (null when unreported). */
export function changeForTimeframe(
  t: Pick<TrendingToken, "priceChange1hPct" | "priceChange24hPct">,
  tf: Timeframe,
): number | null {
  return tf === "1h" ? (t.priceChange1hPct ?? null) : (t.priceChange24hPct ?? null);
}

/** Re-order a token list by the selected timeframe's momentum score (pure; new array). */
export function rankForTimeframe(tokens: TrendingToken[], tf: Timeframe): TrendingToken[] {
  const key = tf === "1h" ? "score1h" : "score24h";
  return [...tokens].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
}

/**
 * pump.fun-only flag gate: graduated, not banned/nsfw, no transfer fee or hook.
 * Pure. (GeckoTerminal candidates carry no such flags; they get the market gate only.)
 */
export function passesCoinGate(coin: PumpFunCoin): boolean {
  if (!isValidMint(coin.mint)) return false;
  if (coin.complete !== true) return false; // must be graduated (has a real pool)
  if (coin.is_banned === true) return false;
  if (coin.nsfw === true) return false;
  if ((num(coin.transfer_fee_bps) ?? 0) > 0) return false;
  if (coin.transfer_hook_program) return false;
  return true;
}

/**
 * Could a Percolator market be created on this pool? Pure, FAIL-CLOSED: a missing
 * pool or missing numbers = reject. Mirrors the wizard's gates (supported DEX, USD
 * quote, keeper floor for PumpSwap) so a listed row's CTA is not a dead end.
 */
export function passesMarketGate(
  dex: DexMarket | undefined,
  mcFallbackUsd: number | null,
  floorUsd: number = keeperFloorUsd(),
): boolean {
  if (!dex || !isValidMint(dex.pairAddress)) return false;
  if (!dex.dexId || !SUPPORTED_DEX_IDS.has(dex.dexId)) return false;
  if (!dex.quoteMint || !USD_PRICEABLE_QUOTE_MINTS.has(dex.quoteMint)) return false;
  if ((dex.liquidityUsd ?? 0) < MIN_LIQUIDITY_USD) return false;
  if (dex.dexId === "pumpswap" && (dex.quoteDepthUsd == null || dex.quoteDepthUsd < floorUsd)) return false;
  const mc = dex.marketCapUsd ?? mcFallbackUsd;
  if (mc == null || mc < MIN_MARKET_CAP_USD) return false;
  return true;
}

/** External chart page for a pool. pairAddress is base58-validated by the market gate. */
export function chartUrlFor(dex: DexMarket): string {
  return dex.dataSource === "geckoterminal"
    ? `https://www.geckoterminal.com/solana/pools/${dex.pairAddress}`
    : `https://dexscreener.com/solana/${dex.pairAddress}`;
}

/** Fold a candidate + its market into a display row. */
export function toTrendingToken(c: TrendingCandidate, dex: DexMarket): TrendingToken {
  const coin = c.pumpfun;
  const mc = dex.marketCapUsd ?? coin?.usd_market_cap ?? 0;
  const priceFromMc =
    coin?.usd_market_cap != null && coin.total_supply ? coin.usd_market_cap / coin.total_supply : null;
  const { score1h, score24h } = momentumScores({
    volume1hUsd: dex.volume1hUsd,
    volume24hUsd: dex.volume24hUsd,
    liquidityUsd: dex.liquidityUsd,
    txns1h: dex.txns1h,
    txns6h: dex.txns6h,
  });
  return {
    mint: c.mint,
    symbol: c.symbol || c.mint.slice(0, 4),
    name: c.name || c.symbol || c.mint.slice(0, 4),
    logoUrl: c.logoUrl,
    dexId: dex.dexId as string,
    chartUrl: chartUrlFor(dex),
    source: c.source,
    priceUsd: dex.priceUsd ?? priceFromMc,
    marketCapUsd: mc,
    volume24hUsd: dex.volume24hUsd ?? 0,
    volume1hUsd: dex.volume1hUsd ?? 0,
    liquidityUsd: dex.liquidityUsd ?? 0,
    priceChange1hPct: dex.priceChange1hPct ?? null,
    priceChange24hPct: dex.priceChange24hPct ?? null,
    trend: trendSeries({
      volume24hUsd: dex.volume24hUsd,
      volume6hUsd: dex.volume6hUsd,
      volume1hUsd: dex.volume1hUsd,
      volume5mUsd: dex.volume5mUsd,
    }),
    score1h,
    score24h,
  };
}

/** pump.fun coin → candidate (null if the mint is invalid). */
export function candidateFromPumpFun(coin: PumpFunCoin): TrendingCandidate | null {
  if (!isValidMint(coin.mint)) return null;
  return {
    mint: coin.mint,
    symbol: clean(coin.symbol, 16),
    name: clean(coin.name),
    logoUrl: safeLogoUrl(coin.image_uri),
    source: "pumpfun",
    pumpfun: coin,
  };
}

/**
 * Parse a GeckoTerminal `trending_pools?include=base_token,quote_token,dex` body
 * into candidates (one per base mint, first pool wins). Pure. Pools whose base
 * token is SOL/USDC/USDT are skipped (they are the quote side of a reversed pair).
 */
export function parseGeckoTrending(body: unknown): TrendingCandidate[] {
  const b = body as { data?: unknown[]; included?: unknown[] } | null;
  if (!b || !Array.isArray(b.data)) return [];
  const tokens = new Map<string, { name?: string; symbol?: string; image_url?: string }>();
  for (const inc of (Array.isArray(b.included) ? b.included : []) as Record<string, unknown>[]) {
    if (inc?.type !== "token") continue;
    const a = (inc.attributes ?? {}) as { address?: string; name?: string; symbol?: string; image_url?: string };
    if (isValidMint(a.address)) tokens.set(a.address, a);
  }
  const idMint = (rel: unknown): string | null => {
    const id = (rel as { data?: { id?: string } } | undefined)?.data?.id;
    if (typeof id !== "string" || !id.startsWith("solana_")) return null;
    const m = id.slice("solana_".length);
    return isValidMint(m) ? m : null;
  };
  const out: TrendingCandidate[] = [];
  const seen = new Set<string>();
  for (const p of b.data as Record<string, unknown>[]) {
    const rel = (p?.relationships ?? {}) as Record<string, unknown>;
    const mint = idMint(rel.base_token);
    if (!mint || seen.has(mint) || USD_PRICEABLE_QUOTE_MINTS.has(mint)) continue;
    const a = (p.attributes ?? {}) as Record<string, unknown>;
    const dexId = clean((rel.dex as { data?: { id?: string } } | undefined)?.data?.id, 40).toLowerCase() || null;
    const liq = num(a.reserve_in_usd);
    const meta = tokens.get(mint);
    const vol = (a.volume_usd ?? {}) as Record<string, unknown>;
    const pc = (a.price_change_percentage ?? {}) as Record<string, unknown>;
    const tx = (a.transactions ?? {}) as Record<string, unknown>;
    seen.add(mint);
    out.push({
      mint,
      symbol: clean(meta?.symbol, 16),
      name: clean(meta?.name),
      logoUrl: safeLogoUrl(meta?.image_url),
      source: "geckoterminal",
      geckoMarket: {
        priceUsd: num(a.base_token_price_usd),
        marketCapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd),
        liquidityUsd: liq,
        // PumpSwap is a constant-product AMM: the two sides are worth the same, so
        // the quote side is half the reserve. Meteora DLMM is not floored.
        quoteDepthUsd: liq != null ? liq / 2 : null,
        volume24hUsd: num(vol.h24),
        volume1hUsd: num(vol.h1),
        volume6hUsd: num(vol.h6),
        volume5mUsd: num(vol.m5),
        priceChange1hPct: num(pc.h1),
        priceChange24hPct: num(pc.h24),
        txns1h: txCount(tx.h1),
        txns6h: txCount(tx.h6),
        pairAddress: typeof a.address === "string" ? a.address : null,
        dexId,
        quoteMint: idMint(rel.quote_token),
        dataSource: "geckoterminal",
      },
    });
  }
  return out;
}

/** Merge candidate lists, first occurrence of a mint wins (callers pass the preferred source first). */
export function mergeCandidates(...lists: TrendingCandidate[][]): TrendingCandidate[] {
  const seen = new Set<string>();
  const out: TrendingCandidate[] = [];
  for (const l of lists) for (const c of l) if (!seen.has(c.mint)) { seen.add(c.mint); out.push(c); }
  return out;
}

/**
 * The filter+rank pipeline over already-fetched inputs — pure. Market data per mint
 * comes from DexScreener; when DexScreener could not be reached for a mint
 * (`dexUnavailable`), the candidate's own GeckoTerminal pool data stands in. Keeps
 * candidates that pass both gates, ranks by the 24h momentum score desc (the default
 * order; the client re-ranks by the selected timeframe), returns the top `limit`.
 */
export function screenAndRank(
  candidates: TrendingCandidate[],
  dexByMint: Map<string, DexMarket>,
  limit: number = TRENDING_RETURN_LIMIT,
  dexUnavailable: ReadonlySet<string> = new Set(),
  floorUsd: number = keeperFloorUsd(),
): TrendingToken[] {
  const out: TrendingToken[] = [];
  for (const c of candidates) {
    if (c.pumpfun && !passesCoinGate(c.pumpfun)) continue;
    const dex = dexByMint.get(c.mint) ?? (dexUnavailable.has(c.mint) ? c.geckoMarket : undefined);
    if (!passesMarketGate(dex, c.pumpfun?.usd_market_cap ?? null, floorUsd)) continue;
    const token = toTrendingToken(c, dex as DexMarket);
    // Fail closed on the price too: the same number the row displays decides whether it is launchable.
    if (!isLaunchablePriceUsd(token.priceUsd)) continue;
    out.push(token);
  }
  out.sort((a, b) => b.score24h - a.score24h);
  return out.slice(0, limit);
}

// ── network (fail-soft) ──────────────────────────────────────────────────────

export interface SourceResult {
  candidates: TrendingCandidate[];
  status: SourceStatus;
}

/** GeckoTerminal Solana trending pools. Never throws. */
export async function fetchGeckoTrending(): Promise<SourceResult> {
  const url = `${getGeckoConfig().base}/trending_pools?include=base_token,quote_token,dex&duration=24h&page=1`;
  try {
    const res = await geckoFetch(url);
    if (!res || !res.ok) return { candidates: [], status: "error" };
    const candidates = parseGeckoTrending(await res.json());
    return { candidates, status: candidates.length ? "ok" : "empty" };
  } catch {
    return { candidates: [], status: "error" };
  }
}

/** pump.fun's coin list (best effort; 403 from geo/bot-blocked egress). Never throws. */
export async function fetchPumpFunCoins(limit = TRENDING_CANDIDATE_POOL): Promise<SourceResult> {
  const url = `${PUMPFUN_COINS_URL}?offset=0&limit=${limit}&sort=market_cap&order=DESC&includeNftOnly=false`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "percolator-trending/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { candidates: [], status: "error" };
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return { candidates: [], status: "error" };
    const candidates = (data as PumpFunCoin[])
      .filter(passesCoinGate)
      .map(candidateFromPumpFun)
      .filter((c): c is TrendingCandidate => c != null);
    return { candidates, status: data.length ? "ok" : "empty" };
  } catch {
    return { candidates: [], status: "error" };
  }
}

/**
 * Deepest-liquidity SUPPORTED, USD-quoted Solana pair per mint, batched — the same
 * DexScreener endpoint and dexId set the wizard's pool search uses. `unavailable`
 * holds the mints whose batch failed (network/HTTP), so the caller can fall back.
 */
export async function fetchDexMarkets(
  mints: string[],
): Promise<{ byMint: Map<string, DexMarket>; unavailable: Set<string> }> {
  const byMint = new Map<string, DexMarket>();
  const unavailable = new Set<string>();
  const safe = mints.filter(isValidMint);
  const batches: string[][] = [];
  for (let i = 0; i < safe.length; i += DEXSCREENER_BATCH) batches.push(safe.slice(i, i + DEXSCREENER_BATCH));

  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await fetch(`${DEXSCREENER_TOKENS_URL}/${batch.join(",")}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          batch.forEach((m) => unavailable.add(m));
          return;
        }
        const data = (await res.json()) as { pairs?: unknown[] | null };
        for (const p of (data.pairs ?? []) as Record<string, unknown>[]) {
          if (p.chainId !== "solana") continue;
          const dexId = String(p.dexId ?? "").toLowerCase();
          if (!SUPPORTED_DEX_IDS.has(dexId)) continue;
          const mint = (p.baseToken as { address?: string } | undefined)?.address;
          if (!mint || !batch.includes(mint)) continue;
          const quoteMint = (p.quoteToken as { address?: string } | undefined)?.address ?? null;
          if (!quoteMint || !USD_PRICEABLE_QUOTE_MINTS.has(quoteMint)) continue;
          const liqObj = (p.liquidity ?? {}) as { usd?: unknown; quote?: unknown };
          const liq = num(liqObj.usd);
          const priceUsd = num(p.priceUsd);
          const priceNative = num(p.priceNative);
          const quoteAmt = num(liqObj.quote);
          // quote price in USD = priceUsd / priceNative (priceNative is in quote units).
          const quoteDepthUsd =
            quoteAmt != null && priceUsd != null && priceNative != null && priceNative > 0
              ? quoteAmt * (priceUsd / priceNative)
              : null;
          const prev = byMint.get(mint);
          if (prev && (prev.liquidityUsd ?? 0) >= (liq ?? 0)) continue;
          const vol = (p.volume ?? {}) as Record<string, unknown>;
          const pc = (p.priceChange ?? {}) as Record<string, unknown>;
          const tx = (p.txns ?? {}) as Record<string, unknown>;
          byMint.set(mint, {
            priceUsd,
            marketCapUsd: num(p.marketCap) ?? num(p.fdv),
            liquidityUsd: liq,
            quoteDepthUsd,
            volume24hUsd: num(vol.h24),
            volume1hUsd: num(vol.h1),
            volume6hUsd: num(vol.h6),
            volume5mUsd: num(vol.m5),
            priceChange1hPct: num(pc.h1),
            priceChange24hPct: num(pc.h24),
            txns1h: txCount(tx.h1),
            txns6h: txCount(tx.h6),
            pairAddress: typeof p.pairAddress === "string" ? p.pairAddress : null,
            dexId,
            quoteMint,
            dataSource: "dexscreener",
          });
        }
      } catch {
        batch.forEach((m) => unavailable.add(m));
      }
    }),
  );
  return { byMint, unavailable };
}

/** Orchestrate the whole pipeline. Never throws. */
export async function getTrendingTokens(limit = TRENDING_RETURN_LIMIT): Promise<TrendingTokensResult> {
  const [gecko, pump] = await Promise.all([fetchGeckoTrending(), fetchPumpFunCoins()]);
  const candidates = mergeCandidates(gecko.candidates, pump.candidates);
  const sourceEmpty = gecko.status !== "ok" && pump.status !== "ok";
  const { byMint, unavailable } = candidates.length
    ? await fetchDexMarkets(candidates.map((c) => c.mint))
    : { byMint: new Map<string, DexMarket>(), unavailable: new Set<string>() };
  const tokens = screenAndRank(candidates, byMint, limit, unavailable);
  return {
    tokens,
    generatedAt: new Date().toISOString(),
    sourceEmpty,
    sources: { geckoterminal: gecko.status, pumpfun: pump.status },
  };
}

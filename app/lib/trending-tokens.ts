/**
 * Server-side data model for the landing page's "Tokens Trending" table — tokens
 * trending on a launchpad (pump.fun first) that do NOT yet have a Percolator perp.
 *
 * SAFETY (phase 1, no dedicated rug provider yet): a token is surfaced only if it
 * clears a deliberately conservative, FAIL-CLOSED bar:
 *   - GRADUATED (`complete`): the bonding curve finished and liquidity moved to a
 *     real AMM pool. This matters twice over — you can only create a Percolator
 *     perp on a token that HAS a DEX pool to price it, and bundle/sniper rugs
 *     almost always die before or at graduation, so a liquid graduated token is
 *     already past the riskiest window.
 *   - Clean pump.fun flags: not `is_banned`, not `nsfw`, no transfer fee
 *     (`transfer_fee_bps > 0`) and no transfer hook (`transfer_hook_program`) —
 *     the Token-2022 honeypot vectors.
 *   - A live DexScreener pair with liquidity and market cap above floors.
 * Anything we cannot verify (no pair, missing data, fetch error) is EXCLUDED, not
 * shown. Full bundle/insider detection, a displayed safety score and holder counts
 * are deferred to the RugCheck integration (tracked as a follow-up issue).
 *
 * All network access is server-side only and each fetch fails soft (never throws),
 * so the route can always return a list (possibly empty) and never a 500.
 *
 * (A later pass will add a Helius top-holder concentration check on MAINNET_RPC_URL
 * as a further bundle screen, alongside the RugCheck follow-up.)
 */
import { SUPPORTED_DEX_IDS } from "@/lib/dex-constants";

/** pump.fun's public coins API (keyless). v3 is the current host as of 2026-10. */
const PUMPFUN_COINS_URL = "https://frontend-api-v3.pump.fun/coins";
/** DexScreener batch tokens endpoint — up to 30 comma-separated mints per call, keyless. */
const DEXSCREENER_TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens";

/** How many pump.fun coins to pull as the candidate pool before screening + ranking. */
export const TRENDING_CANDIDATE_POOL = 100;
/** How many screened tokens to return. */
export const TRENDING_RETURN_LIMIT = 24;

/** Screen thresholds (USD). Tunable. */
export const MIN_MARKET_CAP_USD = 20_000;
export const MIN_LIQUIDITY_USD = 5_000;

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

/** DexScreener market data we keep per mint (from its deepest SUPPORTED pair). */
export interface DexMarket {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  pairAddress: string | null;
  /** DexScreener dexId of the chosen pair — always one of SUPPORTED_DEX_IDS. */
  dexId: string | null;
}

/** A token shown in the Trending table. All money values are real USD. */
export interface TrendingToken {
  /** Mainnet mint / contract address (what the Create-Market wizard prefills on). */
  mint: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
  /** Launchpad slug — only "pumpfun" in phase 1; widens later. */
  launchpad: "pumpfun";
  priceUsd: number | null;
  marketCapUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
}

export interface TrendingTokensResult {
  tokens: TrendingToken[];
  generatedAt: string;
  /** True when the upstream trending source returned nothing (e.g. Cloudflare block) — the UI can distinguish "no safe tokens" from "source down". */
  sourceEmpty: boolean;
}

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Base58 mint sanity — the upstream is semi-trusted, so never interpolate a mint
 *  into an outbound URL (or hand it to the client) unless it's a plain base58 key. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isValidMint = (m: unknown): m is string => typeof m === "string" && BASE58_RE.test(m);

/**
 * Does this coin clear the pump.fun-flag + graduation gate? Pure — no market data.
 * Rejects the Token-2022 honeypot vectors, banned/nsfw, and anything not graduated.
 */
export function passesCoinGate(coin: PumpFunCoin): boolean {
  if (!isValidMint(coin.mint)) return false; // guards outbound URLs + what we hand the client
  if (coin.complete !== true) return false; // must be graduated (has a real pool)
  if (coin.is_banned === true) return false;
  if (coin.nsfw === true) return false;
  if ((num(coin.transfer_fee_bps) ?? 0) > 0) return false; // transfer-fee trap
  if (coin.transfer_hook_program) return false; // transfer-hook trap
  return true;
}

/**
 * Does the DexScreener market clear the liquidity/market-cap floors? Pure.
 * FAIL-CLOSED: a missing pair or missing numbers = reject.
 */
export function passesMarketGate(dex: DexMarket | undefined, mcFallbackUsd: number | null): boolean {
  if (!dex || !dex.pairAddress) return false; // no priceable pool → can't make a perp, don't show
  if (!dex.dexId || !SUPPORTED_DEX_IDS.has(dex.dexId)) return false; // must be a createable pool type
  if ((dex.liquidityUsd ?? 0) < MIN_LIQUIDITY_USD) return false;
  const mc = dex.marketCapUsd ?? mcFallbackUsd;
  if (mc == null || mc < MIN_MARKET_CAP_USD) return false;
  return true;
}

/** Fold a screened coin + its DexScreener market into a display row. */
export function toTrendingToken(coin: PumpFunCoin, dex: DexMarket): TrendingToken {
  const mc = dex.marketCapUsd ?? coin.usd_market_cap ?? 0;
  const priceFromMc =
    coin.usd_market_cap != null && coin.total_supply ? coin.usd_market_cap / coin.total_supply : null;
  return {
    mint: coin.mint,
    symbol: (coin.symbol ?? "").trim() || coin.mint.slice(0, 4),
    name: (coin.name ?? "").trim() || (coin.symbol ?? "").trim() || coin.mint.slice(0, 4),
    logoUrl: coin.image_uri ?? null,
    launchpad: "pumpfun",
    priceUsd: dex.priceUsd ?? priceFromMc,
    marketCapUsd: mc,
    volume24hUsd: dex.volume24hUsd ?? 0,
    liquidityUsd: dex.liquidityUsd ?? 0,
  };
}

/**
 * The full screen+rank pipeline over already-fetched inputs — pure, so it carries
 * the test coverage. Keeps only coins that pass BOTH gates, maps to rows, ranks by
 * 24h volume desc (the "trending" signal), and returns the top `limit`.
 */
export function screenAndRank(
  coins: PumpFunCoin[],
  dexByMint: Map<string, DexMarket>,
  limit: number = TRENDING_RETURN_LIMIT,
): TrendingToken[] {
  const out: TrendingToken[] = [];
  for (const coin of coins) {
    if (!passesCoinGate(coin)) continue;
    const dex = dexByMint.get(coin.mint);
    if (!passesMarketGate(dex, coin.usd_market_cap ?? null)) continue;
    out.push(toTrendingToken(coin, dex as DexMarket));
  }
  out.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  return out.slice(0, limit);
}

// ── network (fail-soft) ──────────────────────────────────────────────────────

/** Pull the candidate pool from pump.fun. Returns [] on any failure (incl. Cloudflare 403). */
export async function fetchPumpFunCoins(limit = TRENDING_CANDIDATE_POOL): Promise<PumpFunCoin[]> {
  const url = `${PUMPFUN_COINS_URL}?offset=0&limit=${limit}&sort=market_cap&order=DESC&includeNftOnly=false`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "percolator-trending/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as PumpFunCoin[]) : [];
  } catch {
    return [];
  }
}

/**
 * Deepest-liquidity SUPPORTED Solana pair per mint, batched. Only PumpSwap/Meteora
 * pairs are considered — the SAME pools the create-market wizard can launch against
 * (lib/dex-constants) — so a token with a market here is guaranteed createable.
 * A bonding-curve-only (pre-graduation, dexId "pumpfun") token has no supported
 * pair and is simply absent → it fails the market gate (fail-closed).
 */
export async function fetchDexMarkets(mints: string[]): Promise<Map<string, DexMarket>> {
  const byMint = new Map<string, DexMarket>();
  const safe = mints.filter(isValidMint); // never interpolate an unvalidated mint into the URL
  const batches: string[][] = [];
  for (let i = 0; i < safe.length; i += DEXSCREENER_BATCH) batches.push(safe.slice(i, i + DEXSCREENER_BATCH));

  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await fetch(`${DEXSCREENER_TOKENS_URL}/${batch.join(",")}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { pairs?: unknown[] };
        for (const p of (data.pairs ?? []) as Record<string, unknown>[]) {
          if ((p.chainId as string) !== "solana") continue;
          const dexId = ((p.dexId as string) ?? "").toLowerCase();
          if (!SUPPORTED_DEX_IDS.has(dexId)) continue; // only createable pools (PumpSwap/Meteora)
          const base = p.baseToken as { address?: string } | undefined;
          const mint = base?.address;
          if (!mint || !batch.includes(mint)) continue;
          const liq = num((p.liquidity as { usd?: unknown })?.usd);
          const prev = byMint.get(mint);
          // Keep the deepest-liquidity supported pair for the mint.
          if (prev && (prev.liquidityUsd ?? 0) >= (liq ?? 0)) continue;
          byMint.set(mint, {
            priceUsd: num(p.priceUsd),
            marketCapUsd: num(p.marketCap) ?? num(p.fdv),
            liquidityUsd: liq,
            volume24hUsd: num((p.volume as { h24?: unknown })?.h24),
            pairAddress: (p.pairAddress as string) ?? null,
            dexId,
          });
        }
      } catch {
        /* this batch is simply missing → its mints fail the market gate (fail-closed) */
      }
    }),
  );
  return byMint;
}

/** Orchestrate the whole pipeline. Never throws. */
export async function getTrendingTokens(limit = TRENDING_RETURN_LIMIT): Promise<TrendingTokensResult> {
  const coins = await fetchPumpFunCoins();
  const sourceEmpty = coins.length === 0;
  // Only price-check the coins that already clear the cheap flag/graduation gate.
  const gated = coins.filter(passesCoinGate);
  const dexByMint = await fetchDexMarkets(gated.map((c) => c.mint));
  const tokens = screenAndRank(gated, dexByMint, limit);
  return { tokens, generatedAt: new Date().toISOString(), sourceEmpty };
}

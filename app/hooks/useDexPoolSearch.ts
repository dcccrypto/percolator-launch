"use client";

import { useEffect, useState, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import { SUPPORTED_DEX_IDS, BLOCKED_DEX_IDS, NON_USD_QUOTE_REASON, BELOW_LIQUIDITY_FLOOR_REASON } from "@/lib/dex-constants";
import { dexTypeLabel, isOfferable, MAX_CLASSIFY_POOLS, type PoolClass } from "@/lib/dex-pool-owner";
import type { KeeperDexType } from "@/lib/dex-type";

export interface DexPoolResult {
  poolAddress: string;
  /** DexScreener's raw dexId ("pumpswap" | "meteora"). NOT a pool type: "meteora" covers DLMM and DAMM. */
  dexId: string;
  /** The keeper dexType, from the pool's mainnet OWNER program (E2E B21). Absent on results
   *  persisted by an older build, which the wizard discards. */
  dexType?: KeeperDexType;
  /** Human label for `dexType`, e.g. "Meteora DLMM". */
  dexLabel?: string;
  pairLabel: string;   // e.g. "SOL / USDC"
  /** Base token symbol from DexScreener (e.g. "SOL"). Used to build market symbol/name. */
  baseSymbol: string;
  /** Quote token symbol from DexScreener (e.g. "USDC"). Used to build market name. */
  quoteSymbol: string;
  liquidityUsd: number;
  priceUsd: number;
}

/**
 * E2E B21: keep only pools whose mainnet owner the keeper can price, labelled by that
 * type. `classes` comes from POST /api/dex/classify-pools. A Meteora DAMM v1 pool
 * (DexScreener "meteora") is "unsupported" by owner and is dropped here.
 */
export function applyPoolClasses(results: DexPoolResult[], classes: Record<string, PoolClass>): DexPoolResult[] {
  const out: DexPoolResult[] = [];
  for (const r of results) {
    const c = classes[r.poolAddress];
    if (!isOfferable(c)) continue;
    out.push({ ...r, dexType: c, dexLabel: dexTypeLabel(c) });
  }
  return out;
}

/** Is a (possibly persisted) pool one the wizard may launch against? */
export function isVerifiedPool(p: DexPoolResult | null | undefined): p is DexPoolResult & { dexType: KeeperDexType } {
  return !!p && isOfferable(p.dexType);
}

function isValidSolanaMint(mint: string): boolean {
  try {
    new PublicKey(mint);
    return true;
  } catch {
    return false;
  }
}

export const POOL_VERIFY_FAILED = "Couldn't verify which DEX these pools are on right now. Try again in a moment.";
export const UNSUPPORTED_POOL_TYPES =
  "This token's pools are on DEX types our price feed can't read yet (for example Meteora DAMM). " +
  "Markets can launch against Meteora DLMM or PumpSwap pools.";

/** Why none of the candidate pools was offered: a non-USD quote or a too-shallow pool is the actionable reason. */
export function unverifiedReason(candidates: DexPoolResult[], classes: Record<string, PoolClass>): string {
  if (candidates.some((c) => classes[c.poolAddress] === "non-usd-quote")) return NON_USD_QUOTE_REASON;
  if (candidates.some((c) => classes[c.poolAddress] === "below-liquidity-floor")) return BELOW_LIQUIDITY_FLOOR_REASON;
  return UNSUPPORTED_POOL_TYPES;
}

/**
 * The wizard's pool lookup as a plain async function (the hook below and the cross-device
 * registration recovery, lib/launch-recovery.ts, both call it, so they see the same pools): DexScreener
 * pairs for a mint, supported DEXes only, deepest first, each classified by its mainnet OWNER program.
 * Throws on a failed lookup; `signal` aborts the requests.
 */
export async function searchVerifiedPools(
  mint: string,
  signal?: AbortSignal,
): Promise<{ pools: DexPoolResult[]; blockedReason: string | null }> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const resp = await fetch(url, {
    signal,
    headers: { "User-Agent": "percolator-app/1.0" },
  });

  if (!resp.ok) {
    // A 429/500 parses to `json.pairs === undefined` → [] → "no pools",
    // silently mis-classifying a liquid token into tier "low". Treat
    // non-2xx as a distinct error instead of falling through.
    throw new Error(`DexScreener API error: ${resp.status}`);
  }

  const json: { pairs?: Array<{
    chainId?: string;
    dexId?: string;
    pairAddress: string;
    baseToken?: { symbol?: string };
    quoteToken?: { symbol?: string };
    liquidity?: { usd?: number };
    priceUsd?: string;
  }> } = await resp.json();
  const pairs = json.pairs || [];

  const results: DexPoolResult[] = [];
  /** A blocked DEX we actually saw real liquidity on — reported only if
   *  nothing supported turns up, so a token that also trades on Meteora
   *  is never nagged about its Raydium pool. */
  let blockedHit: string | null = null;
  for (const pair of pairs) {
    if (pair.chainId !== "solana") continue;
    const dexId = (pair.dexId || "").toLowerCase();
    const liquidityRaw = pair.liquidity?.usd || 0;
    if (!SUPPORTED_DEX_IDS.has(dexId)) {
      if (BLOCKED_DEX_IDS[dexId] && liquidityRaw >= 100) {
        blockedHit ??= BLOCKED_DEX_IDS[dexId];
      }
      continue;
    }

    const liquidity = liquidityRaw;
    if (liquidity < 100) continue; // skip tiny pools

    const baseSymbol = pair.baseToken?.symbol || "?";
    const quoteSymbol = pair.quoteToken?.symbol || "?";
    results.push({
      poolAddress: pair.pairAddress,
      dexId,
      pairLabel: `${baseSymbol} / ${quoteSymbol}`,
      baseSymbol,
      quoteSymbol,
      liquidityUsd: liquidity,
      priceUsd: parseFloat(pair.priceUsd ?? "0") || 0,
    });
  }

  // Sort by liquidity descending
  results.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const candidates = results.slice(0, MAX_CLASSIFY_POOLS);

  // E2E B21: classify by mainnet OWNER before offering anything. DexScreener's
  // "meteora" covers DAMM v1 pools the keeper cannot price.
  let verified: DexPoolResult[] = [];
  let classesSeen: Record<string, PoolClass> = {};
  if (candidates.length > 0) {
    const cr = await fetch("/api/dex/classify-pools", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: candidates.map((c) => c.poolAddress) }),
    });
    if (!cr.ok) throw new Error(POOL_VERIFY_FAILED);
    const { classes } = (await cr.json()) as { classes?: Record<string, PoolClass> };
    if (!classes) throw new Error(POOL_VERIFY_FAILED);
    classesSeen = classes;
    verified = applyPoolClasses(candidates, classes);
  }


  return {
    pools: verified.slice(0, 10),
    // Only surface the block when it actually cost this token every option.
    blockedReason:
      verified.length === 0
        ? blockedHit ?? (candidates.length > 0 ? unverifiedReason(candidates, classesSeen) : null)
        : null,
  };
}

/**
 * Search DexScreener for DEX pools containing a given token mint.
 * Filters to supported DEXes (PumpSwap, Meteora) and sorts by liquidity.
 * Raydium is currently withheld — see BLOCKED_DEX_IDS for why.
 *
 * Mint must be a valid Solana address before any browser fetch — avoids noisy calls
 * and leaking malformed input to a third-party API (Prompt 87).
 */
export function useDexPoolSearch(mint: string | null): {
  pools: DexPoolResult[];
  loading: boolean;
  /** Set when the DexScreener lookup itself failed (network error, non-2xx).
   *  Distinct from an empty `pools` array, which means "no pools found" —
   *  callers computing liquidity tiers should NOT treat an error the same
   *  as "no pools" (that would silently mis-tier a liquid token as low). */
  error: string | null;
  /** Explanation when this token HAS liquidity but only on a DEX we block for
   *  new markets (see BLOCKED_DEX_IDS). Distinguishes "we won't list this yet"
   *  from "this token has no pools", which otherwise look identical: both
   *  produce an empty `pools` array and then a bare "no price" launch error. */
  blockedReason: string | null;
} {
  const [pools, setPools] = useState<DexPoolResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPools([]);
    setError(null);
    setBlockedReason(null);
    // Abort any in-flight request unconditionally, even when the new mint is
    // invalid/empty — a stale request must never resolve after this point.
    abortRef.current?.abort();

    const trimmed = mint?.trim() ?? "";
    if (!trimmed || !isValidSolanaMint(trimmed)) {
      // Bug: this branch used to leave `loading` at whatever a PRIOR in-flight
      // request left it. Combined with the aborted-fetch finally() below
      // (which used to skip resetting loading on abort), the spinner in the
      // create-market wizard could stick true forever.
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;

    setLoading(true);

    (async () => {
      try {
        const { pools: found, blockedReason: blocked } = await searchVerifiedPools(trimmed, controller.signal);
        if (cancelled) return;
        setPools(found);
        setBlockedReason(blocked);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === "AbortError") return; // genuine cancellation, not a real error
        setError(err instanceof Error ? err.message : "Failed to fetch DEX pools");
        setPools([]);
        setBlockedReason(null);
      } finally {
        // Always resolve loading for the CURRENT request — `cancelled` is
        // scoped per effect run, so a superseded/unmounted run's finally
        // can't clobber a newer run's loading state.
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [mint]);

  return { pools, loading, error, blockedReason };
}

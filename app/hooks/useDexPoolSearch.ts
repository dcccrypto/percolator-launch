"use client";

import { useEffect, useState, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import { SUPPORTED_DEX_IDS } from "@/lib/dex-constants";

export interface DexPoolResult {
  poolAddress: string;
  dexId: string;       // "pumpswap" | "raydium" | "meteora"
  pairLabel: string;   // e.g. "SOL / USDC"
  /** Base token symbol from DexScreener (e.g. "SOL"). Used to build market symbol/name. */
  baseSymbol: string;
  /** Quote token symbol from DexScreener (e.g. "USDC"). Used to build market name. */
  quoteSymbol: string;
  liquidityUsd: number;
  priceUsd: number;
}

function isValidSolanaMint(mint: string): boolean {
  try {
    new PublicKey(mint);
    return true;
  } catch {
    return false;
  }
}

/**
 * Search DexScreener for DEX pools containing a given token mint.
 * Filters to supported DEXes (PumpSwap, Raydium, Meteora) and sorts by liquidity.
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
} {
  const [pools, setPools] = useState<DexPoolResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPools([]);
    setError(null);
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
        const url = `https://api.dexscreener.com/latest/dex/tokens/${trimmed}`;
        const resp = await fetch(url, {
          signal: controller.signal,
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
        for (const pair of pairs) {
          if (pair.chainId !== "solana") continue;
          const dexId = (pair.dexId || "").toLowerCase();
          if (!SUPPORTED_DEX_IDS.has(dexId)) continue;

          const liquidity = pair.liquidity?.usd || 0;
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

        if (cancelled) return;
        setPools(results.slice(0, 10));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === "AbortError") return; // genuine cancellation, not a real error
        setError(err instanceof Error ? err.message : "Failed to fetch DEX pools");
        setPools([]);
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

  return { pools, loading, error };
}

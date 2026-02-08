"use client";

import { useEffect, useState, useRef } from "react";

export interface DexPoolResult {
  poolAddress: string;
  dexId: string;       // "pumpswap" | "raydium" | "meteora"
  pairLabel: string;   // e.g. "SOL / USDC"
  liquidityUsd: number;
  priceUsd: number;
}

const SUPPORTED_DEX_IDS = new Set(["pumpswap", "raydium", "meteora"]);

/**
 * Search DexScreener for DEX pools containing a given token mint.
 * Filters to supported DEXes (PumpSwap, Raydium, Meteora) and sorts by liquidity.
 */
export function useDexPoolSearch(mint: string | null) {
  const [pools, setPools] = useState<DexPoolResult[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPools([]);
    if (!mint || mint.length < 32) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);

    (async () => {
      try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "percolator-app/1.0" },
        });
        const json = (await resp.json()) as any;
        const pairs = json.pairs || [];

        const results: DexPoolResult[] = [];
        for (const pair of pairs) {
          if (pair.chainId !== "solana") continue;
          const dexId = (pair.dexId || "").toLowerCase();
          if (!SUPPORTED_DEX_IDS.has(dexId)) continue;

          const liquidity = pair.liquidity?.usd || 0;
          if (liquidity < 100) continue; // skip tiny pools

          results.push({
            poolAddress: pair.pairAddress,
            dexId,
            pairLabel: `${pair.baseToken?.symbol || "?"} / ${pair.quoteToken?.symbol || "?"}`,
            liquidityUsd: liquidity,
            priceUsd: parseFloat(pair.priceUsd) || 0,
          });
        }

        // Sort by liquidity descending
        results.sort((a, b) => b.liquidityUsd - a.liquidityUsd);

        if (!controller.signal.aborted) {
          setPools(results.slice(0, 10));
        }
      } catch {
        // ignore aborts and errors
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [mint]);

  return { pools, loading };
}

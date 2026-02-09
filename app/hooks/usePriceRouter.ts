"use client";

import { useEffect, useState, useRef } from "react";

export type PriceSourceType = "pyth" | "dex" | "jupiter";

export interface PriceSource {
  type: PriceSourceType;
  address: string;
  dexId?: string;
  pairLabel?: string;
  liquidity: number;
  price: number;
  confidence: number;
}

export interface PriceRouterState {
  bestSource: PriceSource | null;
  allSources: PriceSource[];
  loading: boolean;
  error: string | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4400";

/**
 * Auto-discover the best oracle source for a given token mint.
 * Queries the backend /oracle/resolve/:mint endpoint.
 */
export function usePriceRouter(mintAddress: string | null): PriceRouterState {
  const [state, setState] = useState<PriceRouterState>({
    bestSource: null,
    allSources: [],
    loading: false,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setState({ bestSource: null, allSources: [], loading: false, error: null });

    if (!mintAddress || mintAddress.length < 32) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((s) => ({ ...s, loading: true }));

    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/oracle/resolve/${mintAddress}`, {
          signal: controller.signal,
        });

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }

        const data = await resp.json();

        if (!controller.signal.aborted) {
          setState({
            bestSource: data.bestSource || null,
            allSources: data.allSources || [],
            loading: false,
            error: null,
          });
        }
      } catch (err: any) {
        if (!controller.signal.aborted) {
          setState({
            bestSource: null,
            allSources: [],
            loading: false,
            error: err.name === "AbortError" ? null : (err.message || "Failed to resolve oracle"),
          });
        }
      }
    })();

    return () => controller.abort();
  }, [mintAddress]);

  return state;
}

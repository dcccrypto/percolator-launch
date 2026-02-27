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

// Use Next.js proxy to avoid CORS — /api/oracle/* is rewritten to the backend
const API_BASE = "";

/** Maximum number of retry attempts for transient errors */
const MAX_RETRIES = 2;
/** Base delay (ms) for exponential backoff */
const BASE_DELAY_MS = 1_000;

/**
 * Auto-discover the best oracle source for a given token mint.
 * Queries the backend /oracle/resolve/:mint endpoint.
 *
 * PERC-233: On 404 (unknown token), returns immediately with error — no retries.
 * On transient errors (5xx, network), retries up to MAX_RETRIES with exponential backoff.
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
      let lastError: string | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (controller.signal.aborted) return;

        // Exponential backoff on retries (0ms for first attempt)
        if (attempt > 0) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
          if (controller.signal.aborted) return;
        }

        try {
          const resp = await fetch(`${API_BASE}/oracle/resolve/${mintAddress}`, {
            signal: controller.signal,
          });

          // 404 = unknown token — do NOT retry, show error immediately (PERC-233)
          if (resp.status === 404) {
            if (!controller.signal.aborted) {
              setState({
                bestSource: null,
                allSources: [],
                loading: false,
                error: "Unknown oracle — no price feed found for this token",
              });
            }
            return;
          }

          // 4xx client errors (other than 404) — do not retry
          if (resp.status >= 400 && resp.status < 500) {
            if (!controller.signal.aborted) {
              setState({
                bestSource: null,
                allSources: [],
                loading: false,
                error: `Oracle lookup failed (HTTP ${resp.status})`,
              });
            }
            return;
          }

          // 5xx — retry with backoff
          if (!resp.ok) {
            lastError = `HTTP ${resp.status}`;
            continue;
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
          return; // success — exit retry loop
        } catch (err: any) {
          if (err.name === "AbortError") return;
          lastError = err.message || "Failed to resolve oracle";
          // Network error — continue to retry
        }
      }

      // All retries exhausted
      if (!controller.signal.aborted) {
        setState({
          bestSource: null,
          allSources: [],
          loading: false,
          error: lastError || "Failed to resolve oracle after retries",
        });
      }
    })();

    return () => controller.abort();
  }, [mintAddress]);

  return state;
}

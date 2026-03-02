"use client";

import { useEffect, useState, useRef } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { detectOracleMode } from "@/lib/oraclePrice";

export interface PublisherInfo {
  key: string;
  name: string;
  status: "active" | "degraded" | "offline";
}

export interface OraclePublishersState {
  /** Number of currently active publishers */
  publisherCount: number | null;
  /** Total number of registered publishers */
  publisherTotal: number | null;
  /** Individual publisher info (capped at 15 for UI) */
  publishers: PublisherInfo[];
  /** Whether a fetch is in progress */
  loading: boolean;
  /** Error message if the last fetch failed */
  error: string | null;
}

/** Refresh interval for publisher data (60s — changes rarely) */
const POLL_INTERVAL_MS = 60_000;

/**
 * Fetch live oracle publisher data for the current market.
 *
 * - pyth-pinned: Reads Pythnet on-chain price account → real publisher count
 * - hyperp: Queries oracle bridge for DEX price sources
 * - admin: Returns the single oracle authority
 *
 * Replaces the former hardcoded publisher counts (7/9, 5/7) in useOracleFreshness.
 */
export function useOraclePublishers(): OraclePublishersState {
  const { config } = useSlabState();
  const [state, setState] = useState<OraclePublishersState>({
    publisherCount: null,
    publisherTotal: null,
    publishers: [],
    loading: false,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    if (!config) return;

    const mode = detectOracleMode(config);
    if (!mode) return;

    const fetchPublishers = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState((prev) => ({ ...prev, loading: true }));

      try {
        const params = new URLSearchParams({ mode });

        if (mode === "pyth-pinned") {
          const feedIdBytes = config.indexFeedId.toBytes();
          const feedIdHex = Array.from(feedIdBytes)
            .map((b: number) => b.toString(16).padStart(2, "0"))
            .join("");
          params.set("feedId", feedIdHex);
        }

        if (mode === "admin" && config.oracleAuthority) {
          params.set("authority", config.oracleAuthority.toBase58());
        }

        const resp = await fetch(`/api/oracle/publishers?${params}`, {
          signal: controller.signal,
        });

        if (!resp.ok) {
          throw new Error(`API ${resp.status}`);
        }

        const data = await resp.json();

        setState({
          publisherCount: data.publisherCount ?? null,
          publisherTotal: data.publisherTotal ?? null,
          publishers: data.publishers ?? [],
          loading: false,
          error: null,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    };

    fetchPublishers();
    intervalRef.current = setInterval(fetchPublishers, POLL_INTERVAL_MS);

    return () => {
      abortRef.current?.abort();
      clearInterval(intervalRef.current);
    };
  }, [config]);

  return state;
}

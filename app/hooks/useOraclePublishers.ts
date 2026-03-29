"use client";

import { useEffect, useMemo, useState, useRef } from "react";
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

/** Normal refresh interval for publisher data (60s — changes rarely) */
const POLL_INTERVAL_MS = 60_000;
/** Back-off interval after a failed fetch (5 minutes — avoid retry storm on 500s) */
const ERROR_BACKOFF_MS = 5 * 60_000;

/**
 * Fetch live oracle publisher data for the current market.
 *
 * - pyth-pinned: Reads Pythnet on-chain price account → real publisher count
 * - hyperp: Queries oracle bridge for DEX price sources
 * - admin: Returns the single oracle authority
 *
 * GH#1807: The effect was previously keyed on `config` (the full slab object), which
 * changes every 3s from SlabProvider. This triggered a new fetch on every poll cycle,
 * creating a continuous 500-storm when the Pythnet RPC was unreachable. Fixed by:
 *   1. Deriving a stable `fetchKey` (mode + feedId/authority) and keying the effect on that.
 *   2. Using ERROR_BACKOFF_MS (5 min) after a failed fetch instead of retrying immediately.
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

  // Derive a stable fetch key from the parts that actually matter for the API call.
  // This prevents re-mounting the effect every 3s when SlabProvider polls the slab.
  const fetchKey = useMemo(() => {
    if (!config) return null;
    const mode = detectOracleMode(config);
    if (!mode) return null;

    if (mode === "pyth-pinned" && config.indexFeedId) {
      const feedIdBytes = config.indexFeedId.toBytes();
      const feedIdHex = Array.from(feedIdBytes)
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("");
      return `pyth-pinned:${feedIdHex}`;
    }
    if (mode === "admin" && config.oracleAuthority) {
      return `admin:${config.oracleAuthority.toBase58()}`;
    }
    return mode; // "hyperp" — no extra params needed
  }, [config]);

  useEffect(() => {
    if (!fetchKey || !config) return;

    const mode = detectOracleMode(config);
    if (!mode) return;

    let nextIntervalMs = POLL_INTERVAL_MS;

    const fetchPublishers = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState((prev) => ({ ...prev, loading: true }));

      try {
        const params = new URLSearchParams({ mode });

        if (mode === "pyth-pinned" && config.indexFeedId) {
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
        nextIntervalMs = POLL_INTERVAL_MS;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // GH#1807: Back off on failure — don't hammer a broken endpoint every 60s.
        nextIntervalMs = ERROR_BACKOFF_MS;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        // Reschedule with the appropriate interval (normal or back-off)
        clearInterval(intervalRef.current);
        intervalRef.current = setInterval(fetchPublishers, nextIntervalMs);
      }
    };

    fetchPublishers();

    return () => {
      abortRef.current?.abort();
      clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey]);

  return state;
}

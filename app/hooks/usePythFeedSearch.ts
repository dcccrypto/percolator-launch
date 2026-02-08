"use client";

import { useEffect, useState, useRef } from "react";

export interface PythFeedResult {
  id: string;
  displayName: string;
}

/**
 * Search Pyth price feeds by symbol via Hermes API.
 * Debounced at 500ms.
 */
export function usePythFeedSearch(query: string): {
  feeds: PythFeedResult[];
  loading: boolean;
  error: string | null;
} {
  const [feeds, setFeeds] = useState<PythFeedResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setFeeds([]);
      setError(null);
      return;
    }

    setLoading(true);

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      try {
        const resp = await fetch(
          `https://hermes.pyth.network/v2/price_feeds?query=${encodeURIComponent(trimmed)}&asset_type=crypto`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (!resp.ok) throw new Error(`Hermes API error: ${resp.status}`);

        const json = (await resp.json()) as Array<{
          id: string;
          attributes?: { display_name?: string };
        }>;

        setFeeds(
          json.slice(0, 10).map((f) => ({
            id: f.id,
            displayName: f.attributes?.display_name ?? f.id.slice(0, 12) + "...",
          })),
        );
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setFeeds([]);
      } finally {
        setLoading(false);
      }
    }, 500);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  return { feeds, loading, error };
}

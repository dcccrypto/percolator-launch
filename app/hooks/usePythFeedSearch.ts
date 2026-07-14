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
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setFeeds([]);
      setError(null);
      // Bug: previously left `loading` stuck true if a prior debounce cycle
      // had set it — type "so" then backspace to "s" before the 500ms timer
      // fires and the spinner never clears.
      setLoading(false);
      return;
    }

    setLoading(true);

    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();

    let cancelled = false;

    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const resp = await fetch(
          `https://hermes.pyth.network/v2/price_feeds?query=${encodeURIComponent(trimmed)}&asset_type=crypto`,
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) },
        );
        if (!resp.ok) throw new Error(`Hermes API error: ${resp.status}`);

        const json = (await resp.json()) as Array<{
          id: string;
          attributes?: { display_name?: string };
        }>;

        // Guard against a slower earlier request ("sol") landing after a
        // faster later one ("solana") and stomping fresher results, and
        // against setState firing after unmount.
        if (cancelled) return;

        setFeeds(
          json.slice(0, 10).map((f) => ({
            id: f.id,
            displayName: f.attributes?.display_name ?? f.id.slice(0, 12) + "...",
          })),
        );
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setFeeds([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 500);

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [query]);

  return { feeds, loading, error };
}

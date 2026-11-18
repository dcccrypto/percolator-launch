"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { CandleData } from "@/app/api/chart/[mint]/route";
import { pollWhenVisible } from "@/lib/pollWhenVisible";
import { boundedSet } from "@/lib/bounded-map";

export type ChartDataStatus = "idle" | "loading" | "success" | "error" | "empty";

export interface UseTokenChartResult {
  candles: CandleData[];
  poolAddress: string | null;
  status: ChartDataStatus;
  error: string | null;
  refresh: () => void;
  /** #2581: fetch one page of bars OLDER than the earliest bar currently
   *  held, and prepend them. Call this when the user scrolls/pans to the
   *  left edge of the chart — it is a no-op (returns immediately) while a
   *  request for this exact (mint, timeframe) is already in flight, or once
   *  `hasMoreHistory` has gone false, so it's safe to call on every visible
   *  range change without its own guard at the call site. */
  loadOlder: () => void;
  /** True while a loadOlder() request for the current key is in flight. */
  isLoadingOlder: boolean;
  /** False once a loadOlder() page has come back empty or short for the
   *  current (mint, timeframe) — GeckoTerminal has nothing earlier to page
   *  into, so further calls are skipped rather than spending a request to
   *  re-confirm it. */
  hasMoreHistory: boolean;
}

// Phase 2: 15m added
type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "7d" | "30d";

/**
 * Timeframe → GeckoTerminal request. The selector means CANDLE SIZE (like
 * every trading terminal), not window length: "1h" = 1-hour candles with as
 * much history as one request allows, NOT "one hour of data".
 *
 * The previous mapping used window semantics with 12–42 bar limits — "1h"
 * fetched twelve 5-minute bars — so every chart was a couple of lines with
 * nothing to scroll back into (user report). GeckoTerminal serves up to
 * 1000 bars per request at no extra call cost; ask for the full depth.
 * (GT aggregates: minute 1/5/15, hour 1/4/12, day 1.)
 */
const TIMEFRAME_TO_API: Record<
  Timeframe,
  { timeframe: "minute" | "hour" | "day"; aggregate: number; limit: number }
> = {
  "1m":  { timeframe: "minute", aggregate: 1,  limit: 1000 }, // ~16h of history
  "5m":  { timeframe: "minute", aggregate: 5,  limit: 1000 }, // ~3.5d
  "15m": { timeframe: "minute", aggregate: 15, limit: 1000 }, // ~10d
  "1h":  { timeframe: "hour",   aggregate: 1,  limit: 1000 }, // ~41d
  "4h":  { timeframe: "hour",   aggregate: 4,  limit: 1000 }, // ~5.5mo
  "1d":  { timeframe: "day",    aggregate: 1,  limit: 365 },  // 1y
  "7d":  { timeframe: "day",    aggregate: 1,  limit: 730 },  // 2y of daily bars
  "30d": { timeframe: "day",    aggregate: 1,  limit: 1000 }, // ~3y of daily bars
};

/** Fetch interval: 60s for short timeframes, 5min for daily */
const POLL_INTERVAL_MS = 60 * 1000;

// Module-level (not per-component-instance) so switching timeframe and back
// within the same page session repaints instantly from cache instead of
// re-fetching. Bounded to a handful of mints x timeframes; see
// lib/bounded-map.ts for the eviction rationale. (This route's URL has no
// from/to — it's already deterministic per mint+timeframe, so no
// quantization is needed to hit its server-side/CDN cache.)
const CACHE_MAX_ENTRIES = 30;
/** How old a cached batch may be and still be PAINTED on a repeat visit.
 *  The cache is a paint accelerator, not a source of truth — every read still
 *  revalidates in the background — but painting a hours-old batch for a
 *  round-trip is misleading, so stale entries fall back to the loading state. */
const CACHE_PAINT_MAX_AGE_MS = 10 * 60_000;
/** Retry cadence for timeframes excluded from the normal poll (7d/30d) while
 *  they have no data — see the poll block for why. */
const EMPTY_RETRY_INTERVAL_MS = 20_000;
/** Only SUCCESSFUL, non-empty batches are ever cached. Caching an empty result
 *  (which is what a transient GeckoTerminal 429 looks like — the route turns
 *  an upstream 429 into an empty 200) made a timeframe render blank from cache
 *  on every revisit until the background revalidation landed, and on the
 *  non-polling timeframes (7d/30d) it never healed at all. */
const chartCache = new Map<string, { candles: CandleData[]; poolAddress: string | null; at: number }>();

/** #2581: (mint, timeframe) keys for which a loadOlder() page has already
 *  come back empty/short — GeckoTerminal has confirmed there's nothing
 *  earlier than what we hold. Module-level so it survives a timeframe
 *  switch-and-back within the page session, same rationale as chartCache. A
 *  key here is never removed — a pool's creation date doesn't move — so this
 *  can only ever prevent a request that would just be re-confirming "no",
 *  never wrongly suppress a real page. */
const exhaustedHistoryKeys = new Set<string>();

/** Merge candle batches, de-duplicating by timestamp (a later batch in the
 *  argument list wins any collision) and returning ascending order. Shared by
 *  the periodic-repoll path (preserve any older, previously-paged-in bars
 *  across a fresh page-1 fetch) and loadOlder (splice a newly-paged-in older
 *  batch onto what's already held). */
function mergeCandles(...batches: CandleData[][]): CandleData[] {
  const byTimestamp = new Map<number, CandleData>();
  for (const batch of batches) {
    for (const c of batch) byTimestamp.set(c.timestamp, c);
  }
  return Array.from(byTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * PERC-512: Hook that fetches external OHLCV candle data for a Solana token.
 *
 * Data source: /api/chart/[mint] → GeckoTerminal (free, no API key)
 * Falls back gracefully when no data is available (chart shows oracle prices).
 *
 * @param mintAddress - SPL token mint address (null/undefined = no fetch)
 * @param timeframe   - Chart timeframe (controls candle size and count)
 */
export function useTokenChart(
  mintAddress: string | null | undefined,
  timeframe: Timeframe = "1d",
  /** The market whose chart this is: its REGISTERED pool is used, never a re-resolved "best" pool. */
  slabAddress?: string | null,
): UseTokenChartResult {
  const slab = slabAddress ?? "";
  const slabRef = useRef(slab);
  slabRef.current = slab;
  const venueQs = () => (slabRef.current ? `&slab=${encodeURIComponent(slabRef.current)}` : "");
  const [candles, setCandles] = useState<CandleData[]>([]);
  const [poolAddress, setPoolAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<ChartDataStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // #2581
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);

  // Track current mint+timeframe to avoid stale updates
  const fetchKeyRef = useRef<string>("");
  // In-flight guard for loadOlder(), keyed implicitly by fetchKeyRef — only
  // one (mint, timeframe) can be "current" at a time, so a single boolean
  // suffices. Deliberately NOT reset by the periodic repoll in fetchData (only
  // by a genuine key change, in the effect below) — a poll firing while a
  // loadOlder() request for the SAME key is in flight must not clear this and
  // let a second, concurrent loadOlder() through.
  const isLoadingOlderRef = useRef(false);
  // Mirrors `candles` so the empty/error branches can check "do we already
  // have data" without taking a stale closure over `candles` state.
  const candlesRef = useRef<CandleData[]>([]);
  // WHICH key `candlesRef` holds data for. Without this, keep-last-good is
  // cross-key and renders the WRONG chart: on 1h (3 bars) → switch to 4h →
  // 4h fails/returns empty → the retained 1h bars were shown under the 4h
  // selector with a "success" status. Keep-last-good must be per-key.
  const lastGoodKeyRef = useRef<string>("");
  // Non-reactive mirror of `status` for the retry loop below (a dep on `status`
  // would tear down and re-arm the interval on every status change).
  const statusRef = useRef<ChartDataStatus>("idle");
  statusRef.current = status;

  /** Empty batch or fetch failure: keep the retained candles ONLY if they
   *  belong to this exact key; otherwise show an honest empty/error state
   *  rather than another timeframe's data. */
  const applyEmptyOrError = useCallback((key: string, errMsg: string | null) => {
    setError(errMsg);
    if (lastGoodKeyRef.current === key && candlesRef.current.length > 0) {
      setStatus("success"); // transient blip over data we already have for THIS key
      return;
    }
    candlesRef.current = [];
    setCandles([]);
    setStatus(errMsg ? "error" : "empty");
  }, []);

  const fetchData = useCallback(
    async (mint: string, tf: Timeframe) => {
      const key = `${mint}:${tf}:${slabRef.current}`;
      fetchKeyRef.current = key;

      // Stale-while-revalidate: paint any cached bars for this (mint,
      // timeframe) instantly, then refetch in the background — without this,
      // every repeat timeframe switch blanked the chart to "loading" for a
      // fresh round trip even though we fetched this exact pair moments ago.
      const cached = chartCache.get(key);
      // age < 0 means the wall clock stepped backwards since the write; the
      // entry's true age is unknowable, so treat it as stale, not fresh.
      const cacheAge = cached ? Date.now() - cached.at : Number.NaN;
      if (cached && cacheAge >= 0 && cacheAge < CACHE_PAINT_MAX_AGE_MS) {
        candlesRef.current = cached.candles;
        lastGoodKeyRef.current = key;
        setCandles(cached.candles);
        setPoolAddress(cached.poolAddress);
        setStatus("success");
        setError(null);
      } else {
        // Don't flip to loading on a repoll that already has candles — keep
        // showing them to avoid flicker every 60s. Only the very first fetch for a key sees "loading".
        setStatus((prev) => (prev === "success" ? "success" : "loading"));
        setError(null);
      }

      const { timeframe: apiTf, aggregate, limit } = TIMEFRAME_TO_API[tf];
      const url = `/api/chart/${mint}?timeframe=${apiTf}&aggregate=${aggregate}&limit=${limit}${venueQs()}`;

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        // Guard stale updates: only apply if this is still the current fetch
        if (fetchKeyRef.current !== key) return;

        const fetchedCandles: CandleData[] = json.candles ?? [];
        const pool = json.poolAddress ?? null;

        if (fetchedCandles.length > 0) {
          // #2581: this route call is always a page-1 request (fetchData never
          // passes `before`) — but the user may have already scrolled back and
          // paged in older bars via loadOlder() for this exact key. Those live
          // ONLY in chartCache/candlesRef (the fetch above knows nothing about
          // them), so a naive setCandles(fetchedCandles) here — on the very
          // next 60s poll — would silently discard the whole scrolled-back
          // extension and snap the chart back to just the live window.
          // mergeCandles keeps any held bars strictly before this fetch's
          // range and lets the fresh page-1 batch win on any overlap.
          const previouslyKnown = chartCache.get(key)?.candles ?? [];
          const merged =
            previouslyKnown.length > 0 ? mergeCandles(previouslyKnown, fetchedCandles) : fetchedCandles;
          candlesRef.current = merged;
          lastGoodKeyRef.current = key;
          setCandles(merged);
          setPoolAddress(pool);
          setStatus("success");
          boundedSet(chartCache, key, { candles: merged, poolAddress: pool, at: Date.now() }, CACHE_MAX_ENTRIES);
          return;
        }

        // Empty batch — usually a transient upstream 429 (the route maps an
        // upstream failure to an empty 200), occasionally a genuinely
        // dataless timeframe. NEVER cache it (see chartCache's comment) and
        // keep-last-good only if the retained candles belong to THIS key.
        applyEmptyOrError(key, null);
      } catch (err) {
        if (fetchKeyRef.current !== key) return;
        console.warn("[useTokenChart] fetch error:", err);
        applyEmptyOrError(key, err instanceof Error ? err.message : "Unknown error");
      }
    },
    [applyEmptyOrError]
  );

  /** #2581: page one batch OLDER than the earliest bar currently held for
   *  (mintAddress, timeframe), and prepend it. Wired to the chart's visible
   *  logical range in TradingChart — called when the user scrolls/pans to
   *  the left edge, not on any timer. Self-guarding: safe to call repeatedly
   *  (e.g. on every range-change tick while parked at the edge) without a
   *  debounce at the call site. */
  const loadOlder = useCallback(() => {
    const mint = mintAddress;
    if (!mint) return;
    const key = `${mint}:${timeframe}:${slabRef.current}`;
    // Stale caller (e.g. a range-change event that fired just after a
    // mint/timeframe switch) — the fetch effect below will do its own initial
    // fetch for the new key; loadOlder for the old one no longer applies.
    if (fetchKeyRef.current !== key) return;
    if (isLoadingOlderRef.current) return; // de-dupe in-flight (#2578 budget)
    if (exhaustedHistoryKeys.has(key)) return; // GT already confirmed no more

    // The full known series for this key lives in chartCache (fetchData keeps
    // it in sync on every successful page-1/repoll — see the merge above);
    // candlesRef is read as a fallback for the brief window before the very
    // first successful fetch has landed in the cache.
    const known = chartCache.get(key)?.candles ?? candlesRef.current;
    const oldest = known[0]?.timestamp;
    if (oldest == null || !Number.isFinite(oldest)) return; // nothing to page back from yet

    isLoadingOlderRef.current = true;
    setIsLoadingOlder(true);

    const { timeframe: apiTf, aggregate, limit } = TIMEFRAME_TO_API[timeframe];
    // GeckoTerminal's before_timestamp is unix SECONDS; our candle timestamps
    // are unix ms (see CandleData).
    const beforeSeconds = Math.floor(oldest / 1000);
    const url = `/api/chart/${mint}?timeframe=${apiTf}&aggregate=${aggregate}&limit=${limit}&before=${beforeSeconds}${venueQs()}`;

    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (fetchKeyRef.current !== key) return; // user moved on while this was in flight

        const older: CandleData[] = json.candles ?? [];
        // Empty = pool creation reached. Short (fewer bars than we asked for)
        // means GeckoTerminal had nothing further before it either — one more
        // request from this same cursor is guaranteed to also come back
        // empty, so latch now rather than spending a call to confirm it.
        if (older.length === 0 || older.length < limit) {
          exhaustedHistoryKeys.add(key);
          setHasMoreHistory(false);
        }
        if (older.length === 0) return;

        // Prepend only — never replace. De-dup defensively on timestamp
        // (before_timestamp's exact inclusive/exclusive boundary isn't a
        // contract worth trusting blindly); a boundary bar landing in both
        // pages must not double the chart.
        //
        // Re-read the held series NOW, after the await — NOT the `known`
        // snapshot taken before the fetch. A page-1 poll (fetchData) can land
        // during this request's flight and merge fresh live bars into the
        // cache/candlesRef; merging `older` against the pre-fetch snapshot and
        // writing that back would clobber those bars out until the next 60s
        // poll. fetchKeyRef is still `key` (checked above), so candlesRef.current
        // is this key's live series and the cache is its backing store. This
        // mirrors fetchData, which likewise re-reads the cache at merge time.
        const knownNow = chartCache.get(key)?.candles ?? candlesRef.current;
        const merged = mergeCandles(older, knownNow);
        candlesRef.current = merged;
        lastGoodKeyRef.current = key;
        setCandles(merged);
        boundedSet(chartCache, key, { candles: merged, poolAddress, at: Date.now() }, CACHE_MAX_ENTRIES);
      })
      .catch((err) => {
        // Transient failure — do NOT latch exhausted; leave hasMoreHistory as
        // it is so the user can scroll again for a fresh attempt.
        console.warn("[useTokenChart] loadOlder fetch error:", err);
      })
      .finally(() => {
        isLoadingOlderRef.current = false;
        setIsLoadingOlder(false);
      });
  }, [mintAddress, timeframe, poolAddress, slab]);

  // Initial fetch + timeframe changes
  useEffect(() => {
    if (!mintAddress) {
      candlesRef.current = [];
      setCandles([]);
      setPoolAddress(null);
      setStatus("idle");
      setError(null);
      isLoadingOlderRef.current = false;
      setIsLoadingOlder(false);
      setHasMoreHistory(true);
      return;
    }

    // New (mint, timeframe) key: reset the loadOlder state to match what's
    // actually known about THIS key, not whatever the previous key left
    // behind. Deliberately placed here (runs once per real key change) rather
    // than inside fetchData (which also runs on every 60s poll of the SAME
    // key, where resetting isLoadingOlderRef would defeat the in-flight
    // guard above if a poll happened to land mid-loadOlder).
    const key = `${mintAddress}:${timeframe}:${slab}`;
    isLoadingOlderRef.current = false;
    setIsLoadingOlder(false);
    setHasMoreHistory(!exhaustedHistoryKeys.has(key));

    fetchData(mintAddress, timeframe);

    // Phase 2: Poll for fresh data every 60 seconds (only short timeframes benefit).
    // Paused while the tab is hidden — a backgrounded trade tab shouldn't
    // keep re-fetching chart candles nobody is looking at.
    const POLLING_TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
    if (POLLING_TIMEFRAMES.includes(timeframe)) {
      return pollWhenVisible(() => fetchData(mintAddress, timeframe), POLL_INTERVAL_MS);
    }
    // 7d/30d are excluded from the poll above (their candles barely move), but
    // that left them with NO recovery path: a transient upstream 429 (which the
    // route surfaces as an empty batch) blanked the chart until a hard refresh.
    // Retry only while we still have nothing to show — stops as soon as data
    // lands, so a genuinely-dataless timeframe settles after one retry cycle.
    return pollWhenVisible(() => {
      if (statusRef.current !== "success") fetchData(mintAddress, timeframe);
    }, EMPTY_RETRY_INTERVAL_MS);
  }, [mintAddress, timeframe, fetchData, slab]);

  const refresh = useCallback(() => {
    if (mintAddress) fetchData(mintAddress, timeframe);
  }, [mintAddress, timeframe, fetchData, slab]);

  return { candles, poolAddress, status, error, refresh, loadOlder, isLoadingOlder, hasMoreHistory };
}

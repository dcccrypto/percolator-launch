"use client";

import { useEffect, useState } from "react";
import { pollWhenVisible } from "@/lib/pollWhenVisible";
import {
  change24h,
  marketRowStats,
  parseFunding,
  type Change24h,
  type FundingView,
  type HourBar,
} from "@/lib/chart/header-stats";
import { parsePerpHistory } from "@/lib/tv/data/perpProvider";
import { parseUdf } from "@/lib/tv/data/candlesApiProvider";
import type { PerpSeries } from "@/lib/chart/perp-types";

/** The hourly-history request for the series the user is looking at, so the 24h change shares the price's baseline. */
export function hourlyHistoryUrl(slab: string, series: PerpSeries, nowSec: number): string {
  const s = encodeURIComponent(slab);
  return series === "last"
    ? `/api/candles/${s}?resolution=60&from=${nowSec - 30 * 3600}&to=${nowSec}`
    : `/api/perp-chart/${s}?series=${series}&resolution=60&countBack=30`;
}

export function parseHourly(series: PerpSeries, body: unknown): HourBar[] {
  const bars = series === "last" ? parseUdf(body) : parsePerpHistory(body).bars;
  return bars.map((b) => ({ timeSec: b.timeSec, open: b.open, close: b.close }));
}

export interface PerpHeaderStats {
  change: Change24h | null;
  volume24hUsd: number | null;
  oiUsd: number | null;
  /** undefined = loading, null = this market has no readable funding rate. */
  funding: FundingView | null | undefined;
}

/**
 * The numbers shown with the chart: 24h change (from the market's own mark history), 24h volume
 * and open interest (existing /api/markets row), funding (existing /api/funding route).
 * Polled only while the tab is visible; every fetch is best-effort (a failure keeps the last value).
 */
export function usePerpHeaderStats(slab: string, price: number | null, series: PerpSeries = "mark"): PerpHeaderStats {
  const [hourly, setHourly] = useState<HourBar[]>([]);
  const [row, setRow] = useState<{ volume24hUsd: number | null; oiUsd: number | null } | null>(null);
  const [funding, setFunding] = useState<FundingView | null | undefined>(undefined);

  useEffect(() => {
    setHourly([]); // never compute a change for series B from series A's bars
    let alive = true;
    const get = async (url: string) => {
      try {
        const r = await fetch(url);
        return r.ok ? { status: r.status, body: (await r.json()) as unknown } : { status: r.status, body: null };
      } catch {
        return null;
      }
    };
    const loadHourly = async () => {
      const r = await get(hourlyHistoryUrl(slab, series, Math.floor(Date.now() / 1000)));
      if (!alive || !r?.body) return;
      try {
        setHourly(parseHourly(series, r.body));
      } catch { /* keep the previous */ }
    };
    const loadRow = async () => {
      const r = await get("/api/markets");
      if (!alive || !r?.body) return;
      const s = marketRowStats(r.body, slab);
      if (s) setRow(s);
    };
    const loadFunding = async () => {
      const r = await get(`/api/funding/${encodeURIComponent(slab)}`);
      if (!alive || !r) return;
      if (r.status === 404) setFunding(null);
      else if (r.body) setFunding(parseFunding(r.body));
    };
    const all = () => { void loadHourly(); void loadRow(); void loadFunding(); };
    all();
    const off = pollWhenVisible(all, 60_000);
    return () => { alive = false; off(); };
  }, [slab, series]);

  const change = change24h(hourly, price, Math.floor(Date.now() / 1000));
  return { change, volume24hUsd: row?.volume24hUsd ?? null, oiUsd: row?.oiUsd ?? null, funding };
}

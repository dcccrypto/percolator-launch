"use client";

import { useState, useEffect, useCallback } from "react";
import {
  type ChartStyle,
  DEFAULT_CHART_STYLE,
  isChartStyle,
} from "@/lib/chart-style";

export type { ChartStyle } from "@/lib/chart-style";

const STORAGE_KEY = "perc:chart:style";

/** Persisted chart-style preference. SSR-safe: returns DEFAULT_CHART_STYLE on
 * the server and during the first client render, then hydrates from
 * localStorage in an effect. Setter writes through to localStorage.
 *
 * Returns [style, setStyle]. */
export function useChartStylePref(): [ChartStyle, (next: ChartStyle) => void] {
  const [style, setStyleState] = useState<ChartStyle>(DEFAULT_CHART_STYLE);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isChartStyle(stored)) setStyleState(stored);
    } catch {
      // localStorage may be unavailable (SSR, iframes, privacy mode) — keep default
    }
  }, []);

  const setStyle = useCallback((next: ChartStyle) => {
    setStyleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // best-effort write; ignore quota / privacy errors
    }
  }, []);

  return [style, setStyle];
}

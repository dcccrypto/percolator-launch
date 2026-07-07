"use client";

import { useState, useEffect } from "react";

export interface ChartTheme {
  bg: string;
  textColor: string;
  gridColor: string;
  borderColor: string;
  upColor: string;
  downColor: string;
  volUpColor: string;
  volDownColor: string;
}

const DARK_THEME: ChartTheme = {
  bg: "#0D0D0F",
  textColor: "rgba(255,255,255,0.45)",
  // Grid bumped from 0.04 → 0.07 and border from 0.06 → 0.10 — the
  // earlier alphas sat at the very floor of what professional trading
  // UIs use (Bloomberg / TradingView / Binance run grids around 0.06–
  // 0.10) and made the chart blend into the page bg. The new values
  // give the panel a defined edge without competing with the data.
  // Indicator reference lines (RSI 30/70, MACD signal) derive from
  // textColor at ~25% / 75% alpha, which after multiplying through
  // textColor's own 0.45 lands at ~0.11 / ~0.34 effective — still
  // clearly above this 0.07 grid, so the hierarchy holds.
  gridColor: "rgba(255,255,255,0.07)",
  borderColor: "rgba(255,255,255,0.10)",
  // Brand --long/--short (globals.css), not generic Tailwind green/red-500 —
  // candles + volume bars are the single most visible color on the chart,
  // and they were the one surface still off-brand vs. MarketInfoBar /
  // PositionsDock / OrderTicket, which all use these exact tokens (canvas
  // can't read CSS custom properties, so these are the literal hex values).
  upColor: "#14F195",
  downColor: "#FF3B5C",
  volUpColor: "rgba(20,241,149,0.6)",
  volDownColor: "rgba(255,59,92,0.6)",
};

const LIGHT_THEME: ChartTheme = {
  bg: "#FAFAFD",
  textColor: "rgba(13,14,21,0.65)",
  gridColor: "rgba(0,0,0,0.05)",
  borderColor: "rgba(0,0,0,0.10)",
  upColor: "#16a34a",
  downColor: "#dc2626",
  volUpColor: "rgba(22,163,74,0.5)",
  volDownColor: "rgba(220,38,38,0.5)",
};

function getThemeFromDOM(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" ? "light" : "dark";
}

/** Returns chart colors that update whenever the pco-theme changes. */
export function useChartTheme(): ChartTheme {
  const [colors, setColors] = useState<ChartTheme>(DARK_THEME);

  useEffect(() => {
    // Set initial value
    setColors(getThemeFromDOM() === "light" ? LIGHT_THEME : DARK_THEME);

    // Watch for future theme changes
    const observer = new MutationObserver(() => {
      setColors(getThemeFromDOM() === "light" ? LIGHT_THEME : DARK_THEME);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  return colors;
}

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
  gridColor: "rgba(255,255,255,0.04)",
  borderColor: "rgba(255,255,255,0.06)",
  upColor: "#22c55e",
  downColor: "#ef4444",
  volUpColor: "rgba(34,197,94,0.6)",
  volDownColor: "rgba(239,68,68,0.6)",
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

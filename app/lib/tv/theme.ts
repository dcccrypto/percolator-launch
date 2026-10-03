/**
 * Site theme -> TradingView theme.
 *
 * Three layers, from the same tokens the lightweight-charts chart uses
 * (hooks/useChartTheme.ts):
 *   1. custom_themes: 19-step colour ramps that recolour the whole widget UI
 *      (toolbars, menus, dialogs) — accent purple instead of TradingView blue,
 *      our long/short green/red, greys that end at our page background.
 *   2. overrides: pane, grid, scales and series colours (applied above the ramps,
 *      re-applied on every site theme switch).
 *   3. public/tv-theme/percolator.css: toolbar/popup CSS variables.
 * The library's own font is kept: the site's JetBrains Mono is self-hosted by
 * next/font under hashed names the chart iframe cannot reference.
 */
import type { ChartTheme } from "@/hooks/useChartTheme";
import type { TvColorRamp, TvThemeColors } from "./types";

export type SiteThemeName = "dark" | "light";

/** Brand accent (globals.css --accent). */
export const ACCENT = "#9945FF";

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** Linear RGB mix: t=0 -> a, t=1 -> b. */
export function mixHex(a: string, b: string, t: number): string {
  const A = parseHex(a);
  const B = parseHex(b);
  return toHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/**
 * A 19-shade ramp (lightness 50…950) with `base` at 500 (index 9): indices
 * 0-8 run from near `lightEnd` to `base`, 10-18 from `base` toward `darkEnd`.
 */
export function colorRamp(base: string, lightEnd = "#FFFFFF", darkEnd = "#000000"): TvColorRamp {
  const out: string[] = [];
  for (let i = 0; i < 19; i++) {
    if (i < 9) out.push(mixHex(lightEnd, base, (i + 1) / 10));
    else if (i === 9) out.push(mixHex(base, base, 0));
    else out.push(mixHex(base, darkEnd, (i - 9) / 10));
  }
  return out as TvColorRamp;
}

/** Page background per theme (globals.css --bg). The grey ramp ends here so dark UI surfaces match the site. */
const PAGE_BG: Record<SiteThemeName, string> = { dark: "#0A0A0F", light: "#F8F8FC" };

function themeColors(name: SiteThemeName, t: ChartTheme): TvThemeColors {
  const darkEnd = PAGE_BG.dark;
  return {
    color1: colorRamp(ACCENT, "#FFFFFF", darkEnd),
    // Greys: TradingView picks dark-theme surfaces from the deep end of this ramp.
    color2: colorRamp(name === "dark" ? "#6B6F86" : "#8A8DA3", "#FFFFFF", darkEnd),
    color3: colorRamp(t.downColor, "#FFFFFF", darkEnd),
    color4: colorRamp(t.upColor, "#FFFFFF", darkEnd),
    color5: colorRamp("#F59E0B", "#FFFFFF", darkEnd),
    color6: colorRamp("#A855F7", "#FFFFFF", darkEnd),
    color7: colorRamp("#EAB308", "#FFFFFF", darkEnd),
    white: "#FFFFFF",
    black: darkEnd,
  };
}

export function customThemes(dark: ChartTheme, light: ChartTheme): { dark: TvThemeColors; light: TvThemeColors } {
  return { dark: themeColors("dark", dark), light: themeColors("light", light) };
}

/**
 * Pane/scale/series overrides for one site theme. Re-applied on every theme
 * switch (widget.applyOverrides) so a saved layout's stored colours never win.
 *
 * The main series' own last-price line and axis label are OFF: the chart's
 * price label is the live Mark line (lib/tv/positionLines.ts). Showing the
 * last candle close as a second price confused users on the old chart too.
 */
export function chartOverrides(t: ChartTheme): Record<string, string | number | boolean> {
  return {
    "paneProperties.backgroundType": "solid",
    "paneProperties.background": t.bg,
    "paneProperties.vertGridProperties.color": t.gridColor,
    "paneProperties.horzGridProperties.color": t.gridColor,
    "paneProperties.separatorColor": t.borderColor,
    "scalesProperties.textColor": t.textColor,
    "scalesProperties.lineColor": t.borderColor,
    "scalesProperties.showSeriesLastValue": false,
    "mainSeriesProperties.showPriceLine": false,
    "mainSeriesProperties.candleStyle.upColor": t.upColor,
    "mainSeriesProperties.candleStyle.downColor": t.downColor,
    "mainSeriesProperties.candleStyle.borderUpColor": t.upColor,
    "mainSeriesProperties.candleStyle.borderDownColor": t.downColor,
    "mainSeriesProperties.candleStyle.wickUpColor": t.upColor,
    "mainSeriesProperties.candleStyle.wickDownColor": t.downColor,
    "mainSeriesProperties.hollowCandleStyle.upColor": t.upColor,
    "mainSeriesProperties.hollowCandleStyle.downColor": t.downColor,
    "mainSeriesProperties.hollowCandleStyle.borderUpColor": t.upColor,
    "mainSeriesProperties.hollowCandleStyle.borderDownColor": t.downColor,
    "mainSeriesProperties.hollowCandleStyle.wickUpColor": t.upColor,
    "mainSeriesProperties.hollowCandleStyle.wickDownColor": t.downColor,
    "mainSeriesProperties.barStyle.upColor": t.upColor,
    "mainSeriesProperties.barStyle.downColor": t.downColor,
    "mainSeriesProperties.lineStyle.color": t.upColor,
    "mainSeriesProperties.areaStyle.linecolor": ACCENT,
    "mainSeriesProperties.areaStyle.color1": "rgba(153,69,255,0.40)",
    "mainSeriesProperties.areaStyle.color2": "rgba(153,69,255,0)",
    // New drawings default to the brand accent instead of TradingView blue.
    "linetooltrendline.linecolor": ACCENT,
    "linetoolhorzline.linecolor": ACCENT,
    "linetoolhorzray.linecolor": ACCENT,
    "linetoolray.linecolor": ACCENT,
  };
}

/** Volume study colours (constructor `studies_overrides`). */
export function studiesOverrides(t: ChartTheme): Record<string, string | number | boolean> {
  return {
    "volume.volume.color.0": t.volDownColor,
    "volume.volume.color.1": t.volUpColor,
  };
}

